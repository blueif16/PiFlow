// ─────────────────────────────────────────────────────────────────────────────
// spawnChildRun — M1.4's REPLAY-FROM-NODE-START primitive: re-run exactly ONE node of a finished parent
// run, in a fresh sibling run-dir, as if only that node had executed. There is no snapshot/checkpoint
// mechanism to restore from (checkpoint.ts is HITL-only; retry is fix-forward by design) — this instead
// CONSTRUCTS the replay: bundle the parent's `.pi` tree (minus its journal, so the target node has no
// journal entry and unconditionally re-runs — journal.ts:219-221), reset exactly the node's own resolved
// WRITE SCOPE in the copy (the jail-enforced surface the node itself owns, `resolveNodeWriteScope` /
// node-lifecycle.ts), clear its warm session so it starts cold, then run ONLY that node's stage window
// (`--from`/`--until` pinned to it) via the SAME `runFromTemplate` join every template run uses.
//
// This module is the seam the optimize-substrate FIX phase (M6) proves a candidate edit against: it
// re-executes the node against a (possibly candidate) `{{WORKSPACE}}`, regenerating exactly what that one
// node produces, so a downstream measure pass can score the delta — never touching the nodes upstream of
// it (they are `reused`, proven-unchanged by the pinned window, not by journal content-hashing).
// ─────────────────────────────────────────────────────────────────────────────

import { promises as fs, readdirSync } from 'node:fs';
import path from 'node:path';
import type { Workflow } from '../../types.js';
import { compile } from '../../dag.js';
import { loadTemplate } from '../../workflow/template/loader.js';
import { runFromTemplate } from '../../runner/entry.js';
import type { RunResult } from '../../runner/runner.js';
import type { CommandBuilder } from '../../runner/command.js';
import type { SandboxProvider } from '../../types.js';
import { selectWindow } from '../../runner/window.js';
import { resolveNodeWriteScope } from '../../runner/node-lifecycle.js';
import type { ResolveCtx } from '../../workflow/resolver.js';
import { loadState } from '../../workflow/state.js';
import { stageBaselineRun } from '../../runner/migrate.js';
import { snapshotGitDir, snapshotExists, snapshotMaterialize, stageTag } from '../../runner/snapshot.js';
import { runJsonFile, piSessionsDir } from '../../runner/layout.js';
import { childRunName } from '../../names/child.js';

/** Who/why spawned a child run — mirrors `RunStatus.spawnedBy` (status.ts). */
export interface SpawnedBy {
  by: string;
  issue?: string;
  issueId?: string;
}

/** Options for `spawnChildRun`. */
export interface SpawnChildRunOpts {
  /** The template dir the parent (and child) were/are run from. */
  templateDir: string;
  /** Who/why this replay was minted — recorded verbatim into the child's `run.json.spawnedBy`. */
  spawnedBy: SpawnedBy;
  /** `{{WORKSPACE}}` override for the child (M6 fixes point this at a candidate copy). Omit ⇒ `process.cwd()`. */
  workspace?: string;
  /**
   * Test/offline seam — forwarded to the child's `runFromTemplate` call verbatim. Omit ⇒ the real
   * production defaults (a live `pi`/sandbox), exactly like every other `runFromTemplate` caller.
   */
  buildCommand?: CommandBuilder;
  /** Test/offline seam — forwarded to the child's `runFromTemplate` call verbatim. Omit ⇒ the core default. */
  provider?: SandboxProvider;
}

/** The result of `spawnChildRun`. */
export interface SpawnChildRunResult {
  /** The minted child run id (`<parentId>.<nodeId>`, collision-suffixed — see `childRunName`). */
  childId: string;
  /** The child's physical run dir (a sibling of the parent's, under the same runs-home). */
  childDir: string;
  /** The child run's result (status + outDir), from `runFromTemplate`. */
  result: RunResult;
}

/** List the sibling run-dir basenames under `runsHome` (mirrors the CLI's `listExistingRunNames`; '' if absent). */
function listSiblingNames(runsHome: string): string[] {
  try {
    return readdirSync(runsHome, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

/** Best-effort parse of the parent's `.pi/run.json` — `null` if absent/unreadable (never throws). */
async function readParentStatus(parentDir: string): Promise<{ provider?: string; model?: string | null } | null> {
  try {
    return JSON.parse(await fs.readFile(runJsonFile(parentDir), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Strip an owns entry's trailing glob suffix (`/**`, `/*`, `**`) to its concrete directory/file — the
 * SAME normalization `checkParallelOwns` uses for collision detection (template/checks.ts), reused here
 * to turn a resolved `contract.owns` entry into a real fs path to reset. A glob-only entry (e.g. `"**"`)
 * normalizes to `''` — the caller MUST skip it (never resolves to the run root itself).
 */
function ownsPath(glob: string): string {
  return glob.replace(/\/?\*+$/, '').replace(/\/+$/, '');
}

/** pi names a per-node warm session `<timestamp>_<sessionId>.jsonl` (session-manager.js); the session id
 *  IS the node id (node-lifecycle.ts, the warm-resume PER-NODE SESSION block). Best-effort — an absent
 *  `.pi-sessions` dir (no warm session was ever minted) is a no-op, never an error. */
async function clearNodeSession(runDir: string, nodeId: string): Promise<void> {
  const dir = piSessionsDir(runDir);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  const suffix = `_${nodeId}.jsonl`;
  await Promise.all(
    entries.filter((f) => f.endsWith(suffix)).map((f) => fs.rm(path.join(dir, f), { force: true })),
  );
}

/**
 * Resolve the EXACT `[fromIdx, untilIdx]` stage window for replaying `nodeId` alone, GUARDING against
 * `selectWindow`'s substring semantics (window.ts:6-13, a general `--from`/`--until` primitive matches
 * phase/id/label CONTAINS): first locate the node's OWN stage by exact membership, then cross-check that
 * using `nodeId` as BOTH `from` and `until` resolves to that SAME single stage — if some OTHER stage's
 * phase/id/label also contains `nodeId` as a substring, `selectWindow` would silently widen the window to
 * span (and re-run) unrelated stages between them. Throws instead of trusting the coincidence.
 */
export function resolveChildWindow(wf: Workflow, nodeId: string): { fromIdx: number; untilIdx: number } {
  const idx = wf.stages.findIndex((s) => s.nodeIds.includes(nodeId));
  if (idx < 0) {
    throw new Error(`spawnChildRun: node "${nodeId}" is not part of this template's compiled stages`);
  }
  const { fromIdx, untilIdx } = selectWindow(wf, nodeId, nodeId);
  if (fromIdx !== idx || untilIdx !== idx) {
    throw new Error(
      `spawnChildRun: node id "${nodeId}" is AMBIGUOUS under the --from/--until substring match ` +
        `(selectWindow resolved stages ${fromIdx}..${untilIdx}, but "${nodeId}" only OWNS stage ${idx}) — ` +
        `rename the colliding node/phase/label so a pinned replay window is unambiguous.`,
    );
  }
  return { fromIdx, untilIdx };
}

/**
 * Replay exactly ONE node of a finished parent run into a fresh CHILD run-dir. See the module header for
 * the full construction. Returns once the child run has finished (ok or not — the caller/gate decides).
 */
export async function spawnChildRun(
  parentRunDir: string,
  nodeId: string,
  opts: SpawnChildRunOpts,
): Promise<SpawnChildRunResult> {
  const parentDir = path.resolve(parentRunDir);
  const parentId = path.basename(parentDir);
  const runsHome = path.dirname(parentDir);

  // (1) mint the child id — a sibling of the parent, collision-checked against the runs-home's own dirs.
  const childId = childRunName(parentId, nodeId, listSiblingNames(runsHome));
  const childDir = path.join(runsHome, childId);

  // (2) load + compile the template, and PIN the replay window to nodeId's own stage (guard: ambiguous ⇒ throw).
  const spec = await loadTemplate(opts.templateDir);
  const wf = compile(spec);
  const node = wf.nodes[nodeId];
  if (!node) throw new Error(`spawnChildRun: unknown node "${nodeId}" in template ${opts.templateDir}`);
  // Resolve the node's OWN stage (throws on --from/--until substring ambiguity); its stage index IS the
  // checkpoint `pre-stage-<k>` grain — the tree at the instant this node began.
  const { fromIdx } = resolveChildWindow(wf, nodeId);

  const workspace = opts.workspace ?? process.cwd();

  // (3) CONSTRUCT the replay. PREFERRED: if the parent ran with git CHECKPOINTS, MATERIALIZE the node's
  // STAGE-ENTRY tree (`pre-stage-<k>`) straight into the fresh child dir — a whole-tree checkout, so the
  // journal + state roll back to stage-k entry AND no downstream node's output (written in a LATER stage)
  // can survive, with ZERO per-artifact reasoning. FALLBACK (a pre-feature parent with no store): the
  // SHARED baseline-seed primitive forks the parent's `.pi` tree MINUS its journal (journal.ts:219-221 then
  // makes the target node unconditionally run; the `--from`-pinned upstream prefix stays force-`reused`).
  // childDir is a freshly-minted (collision-checked) sibling — nothing to overwrite either way.
  const ckGitDir = snapshotGitDir(parentDir);
  const usedSnapshot = snapshotExists(ckGitDir);
  if (usedSnapshot) {
    const res = snapshotMaterialize(ckGitDir, childDir, stageTag(fromIdx));
    if (!res.ok) {
      throw new Error(
        `spawnChildRun: checkpoint restore of "${stageTag(fromIdx)}" for node "${nodeId}" failed: ${res.error}`,
      );
    }
  } else {
    await stageBaselineRun(parentDir, childDir);
  }

  // (4) RESET the node's resolved WRITE SCOPE in the copy (contract.owns, token-resolved) — so the node's
  // seed re-stages it from scratch (seed.ts's destFilled===false path) instead of the run seeing the
  // parent's stale output. ONLY on the FALLBACK path: a checkpoint restore already yields the exact
  // stage-ENTRY tree — the node's own output was ABSENT when it began — so no per-artifact reset is needed
  // (and the whole-tree checkout also cleared any downstream pollution the owns-reset never touched).
  // `workspace` is resolved the SAME way both here and at the runFromTemplate call below, so the token
  // resolution and the actual run agree.
  if (!usedSnapshot) {
    const resolveCtx: ResolveCtx = { run: childDir, workspace, state: await loadState(childDir) };
    const owned = resolveNodeWriteScope(node, resolveCtx);
    for (const entry of owned) {
      const rel = ownsPath(entry);
      if (!rel) continue; // a glob-only entry ("**") normalizes to '' — never nuke the run root itself
      await fs.rm(path.resolve(childDir, rel), { recursive: true, force: true });
    }
  }

  // (5) clear the node's warm session so it starts a COLD conversation (never resumes the parent's turns).
  await clearNodeSession(childDir, nodeId);

  // (6) run ONLY nodeId's stage window, carrying lineage + the parent's provider/model pin.
  const parentStatus = await readParentStatus(parentDir);
  const result = await runFromTemplate(opts.templateDir, {
    runDir: childDir,
    run: childId,
    from: nodeId,
    until: nodeId,
    parent: parentId,
    spawnedBy: opts.spawnedBy,
    workspace,
    providerName: parentStatus?.provider,
    model: parentStatus?.model ?? undefined,
    ...(opts.buildCommand ? { buildCommand: opts.buildCommand } : {}),
    ...(opts.provider ? { provider: opts.provider } : {}),
  });

  return { childId, childDir, result };
}
