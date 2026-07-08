// optimize/substrate/fix.ts — the M6 FIX phase (docs/specs/optimize-substrate-plan.md §M6). Per ONE issue:
// activate → candidate copy → fixer agent → (prove) → gate → stage; then ADOPT is a SEPARATE exported human
// step. Everything here is core-GENERIC (no product binding): the candidate closure, the oracle exclusion, the
// edits-applied diff, and the graded-delta fold are all mechanical, derived from the node's own `node.json`.
//
// ── CANDIDATE CLOSURE (M6.1) ──────────────────────────────────────────────────────────────────────────────
// The candidate copy is the node's `{{WORKSPACE}}`-READ closure MINUS the oracle: collect every `{{WORKSPACE}}`
// path referenced by `contract.readScope` + `contract.execReads` + `hooks` + `op` (the INCLUDE set), then copy
// each into the candidate dir at its same relative path — SKIPPING any path referenced by `optimize.measure`
// or `optimize.judge` (the EXCLUDE set). The exclusion is enforced during the copy WALK (a measure-script that
// lives inside an included readScope DIR is skipped when the walk reaches it), so the fixer physically cannot
// edit the scorer. Both sets are read straight off `node.json` (the block is optimizer-facing — never on the
// compiled NodeSpec, M0). A bare `{{WORKSPACE}}` (no sub-path) is IGNORED — copying the whole product root is
// never the intent and the exclusion could not protect it.
//
// ── GRADED-DELTA FOLD RULE (M6.3 — the accept decision) ──────────────────────────────────────────────────
// After a prove-rerun, compare ONLY the numeric keys present in BOTH the parent's and the child's
// `measure.<node>.json` `.graded` map (the SHARED keys). Direction is higher-is-better by default; a key
// matched by the injectable `lowerIsBetter` predicate is inverted. Per key, `adj = lowerIsBetter ? base−cand :
// cand−base`; `improved = adj > 0`, `regressed = adj < −tolerance`. The multi-key verdict is FOLDED onto the
// scalar (base, candidate) pair that `evaluateGate` (gate.ts) already ratchets on (`candidate > base` = strict
// improvement), so we REUSE its two load-bearing rules verbatim:
//   • NO shared keys ⇒ base=null, candidate=null ⇒ evaluateGate ⇒ stage-for-human (NEVER auto-accept).
//   • any key regressed beyond tolerance ⇒ base=0, candidate=−1 ⇒ reject.
//   • else ≥1 key improved ⇒ base=0, candidate=+1 ⇒ accept (strict improvement).
//   • else all flat within tolerance ⇒ base=0, candidate=0 ⇒ reject (no improvement).
//   • editsApplied < 1 ⇒ evaluateGate rejects first (gate.ts:47), before any of the above.
// The scalar is an internal accept SIGNAL only; the human-facing per-key RAW deltas ride the manifest's
// `deltaSummary`. The gate `bucket` is pinned to `SKILL` — a non-ARCH, non-FUNCTIONALITY bucket — so we get
// ONLY the two rules above, never the ARCH always-stage or the FUNCTIONALITY product-checks gate (neither
// models a substrate fix). ADOPTION stays a SEPARATE human step regardless of landPolicy: `fixIssue` NEVER
// auto-adopts — the strongest a fix reaches here is `staged`.
//
// ── PROVE / ORACLE IMMUTABILITY (M6.3) ───────────────────────────────────────────────────────────────────
// Prove re-runs the node against the CANDIDATE workspace (spawnChildRun), then measures the CHILD run with
// `workspace = the LIVE product root` — so pristine, un-copied scorer scripts grade a candidate-produced
// artifact. The candidate never contains a scorer (the exclusion above); the live root is never edited (only
// adopt touches it). Oracle immutability is mechanical, not a promise.
//
// ── RESTING STATE AFTER THE GATE (the issue's status is never stranded) ──────────────────────────────────
// The prove path moves the issue to `verifying` before the rerun. After the gate decides, the issue must land
// on an honest resting state — a proven-REJECT must NOT strand it at `verifying` (M2 originally had no back-edge
// out of `verifying` for a rejected candidate; TASK 0 added `verifying → open`). So: a `discarded` decision that
// went through a prove-rerun (childId !== null) walks the issue BACK to `open` — reason stays null, NO attempt is
// stamped (nothing landed), so a later triage/fix re-attempts it. A `staged` candidate stays at `verifying`
// awaiting the human adopt (verifying → resolved); the skip-proof/unmeasured/no-edit paths never entered
// `verifying` (they rest at `fix-landed`/`active`), so they need no walk-back.

import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import type { DefectBucket } from '../types.js';
import { evaluateGate, type GateVerdict, type LandPolicy } from '../gate.js';
import { adoptFromManifest, type AdoptManifest } from '../land.js';
import { parseIssueFile, stampAttempt, transitionIssue, type Issue } from './issues.js';
import {
  inheritedAgentOpts, runBaseAgent,
  type RunBaseAgentOpts, type RunBaseAgentResult, type BaseAgentChildOpts,
} from './agent.js';
import { spawnChildRun, type SpawnChildRunOpts, type SpawnChildRunResult } from './child-run.js';
import { runSubstrateMeasure, type RunSubstrateMeasureOpts, type MeasureReport } from './measure.js';
import {
  runSubstrateGate,
  type RunSubstrateGateOpts, type RunSubstrateGateResult, type GateVerdictFile, type GateRejectCategory,
} from './gate.js';
import { safeEmit, type SubstrateEvent, type SubstrateEventSink } from './events.js';

/** The gate bucket every substrate fix uses — a non-ARCH, non-FUNCTIONALITY bucket, so `evaluateGate` applies
 *  ONLY the editsApplied<1 and null⇒stage-for-human rules (see the fold-rule header). */
const SUBSTRATE_GATE_BUCKET: DefectBucket = 'SKILL';

/** Sentinel `verifiedByRun` for the skip-proof path (no child run verified the fix). The Issue attempt schema
 *  requires a NON-EMPTY string (issues.ts `validateIssue`), so `null` cannot be stored — this documents it. */
export const UNPROVEN_BY_RUN = 'unproven';

// ── the {{WORKSPACE}}-ref closure (mechanical; the whole M6.1 include/exclude derivation) ───────────────────

/** Matches `{{WORKSPACE}}` optionally followed by `/a/path` (path chars only — never swallows trailing quotes,
 *  whitespace, or arg separators, so it works whether the token is a bare readScope entry or embedded in an
 *  op `run.args` string). Capture group 1 is the `/path` suffix (or undefined for a bare `{{WORKSPACE}}`). */
const WORKSPACE_REF = /\{\{\s*WORKSPACE\s*\}\}(\/[A-Za-z0-9._\-/]*)?/g;

/** Normalize a captured `/path` suffix into a clean POSIX workspace-relative path, or `null` to DROP it (a
 *  bare `{{WORKSPACE}}`, an empty/`.`/workspace-escaping path — none of which is a safe copy target). */
function normalizeRel(raw: string | undefined): string | null {
  if (!raw) return null; // bare {{WORKSPACE}} → the whole product root; never a copy target
  let rel = path.posix.normalize(raw.replace(/^\/+/, ''));
  if (!rel || rel === '.' || rel === '..' || rel.startsWith('../')) return null;
  rel = rel.replace(/\/+$/, '');
  return rel || null;
}

/** Recursively collect every normalized `{{WORKSPACE}}`-relative path referenced by any STRING inside `value`
 *  (walks arrays/objects). Product-agnostic — it inspects only the token, never a field name. */
export function collectWorkspaceRefs(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (value == null) return into;
  if (typeof value === 'string') {
    for (const m of value.matchAll(WORKSPACE_REF)) {
      const rel = normalizeRel(m[1]);
      if (rel) into.add(rel);
    }
    return into;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectWorkspaceRefs(v, into);
    return into;
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectWorkspaceRefs(v, into);
  }
  return into;
}

/** `<templateDir>/nodes/<id>/node.json`'s raw shape — the optimizer-facing block the loader never wires on. */
interface RawNodeJson {
  contract?: { readScope?: unknown; execReads?: unknown };
  hooks?: unknown;
  op?: unknown;
  optimize?: { measure?: unknown; judge?: unknown };
}

/** Read + parse the node's `node.json` off disk. Throws (naming the file) if it is missing or invalid — the
 *  node MUST exist to fix it (this is not a degrade-to-default read like the measure/judge stages). */
async function readNodeJsonRaw(templateDir: string, nodeId: string): Promise<RawNodeJson> {
  const file = path.join(templateDir, 'nodes', nodeId, 'node.json');
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e) {
    throw new Error(`fixIssue: cannot read "${file}" for node "${nodeId}": ${(e as Error).message}`);
  }
  try {
    return JSON.parse(raw) as RawNodeJson;
  } catch (e) {
    throw new Error(`fixIssue: "${file}" is not valid JSON: ${(e as Error).message}`);
  }
}

/** Does the node declare an `optimize.judge` — a SOFT bar the gate agent can judge a fix against when there is
 *  no numeric oracle? Reads `node.json` off disk (throws only if the node is unreadable, which fixIssue already
 *  requires). Drives the gate ROUTING: unmeasurable + a judge ⇒ the gate agent, not "unmeasurable → human". */
async function nodeHasJudge(templateDir: string, nodeId: string): Promise<boolean> {
  const nj = await readNodeJsonRaw(templateDir, nodeId);
  return typeof nj.optimize?.judge === 'string' && (nj.optimize.judge as string).length > 0;
}

export interface CandidateClosure {
  /** the candidate dir the closure was copied into (`opts.candidateDir`). */
  candidateRef: string;
  /** the INCLUDE set (readScope/execReads/hooks/op {{WORKSPACE}} refs) — for telemetry. */
  included: string[];
  /** the EXCLUDE set (optimize.measure/judge {{WORKSPACE}} refs — the oracle) — for telemetry. */
  excluded: string[];
}

/** Copy one real workspace path (`rel`) into the candidate at the same relative path, skipping any file/dir
 *  the exclusion predicate rejects (the oracle). Symlinks are NEVER followed (mirrors land.ts's walk). */
async function copyInto(workspace: string, candidateDir: string, rel: string, isExcluded: (rel: string) => boolean): Promise<void> {
  if (isExcluded(rel)) return; // an oracle path (or under one) — never lands in the candidate
  const src = path.resolve(workspace, rel);
  let st: import('node:fs').Stats;
  try {
    st = await fs.lstat(src);
  } catch {
    return; // a declared read root that does not exist on disk — nothing to copy (best-effort)
  }
  if (st.isSymbolicLink()) return; // never follow a link into an unbounded tree
  if (st.isFile()) {
    const dest = path.join(candidateDir, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
    return;
  }
  if (st.isDirectory()) {
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const e of entries) await copyInto(workspace, candidateDir, path.posix.join(rel, e.name), isExcluded);
  }
}

/**
 * Prepare the candidate copy for `nodeId`: the node's `{{WORKSPACE}}`-read closure MINUS the oracle exclusions
 * (see the module header). Reads `node.json` off disk, copies each included path into `opts.candidateDir`, and
 * returns the include/exclude sets. Deterministic given the same inputs (no timestamps/random in the copy).
 */
export async function prepareCandidateClosure(
  templateDir: string,
  nodeId: string,
  opts: { workspace: string; candidateDir: string },
): Promise<CandidateClosure> {
  const nodeJson = await readNodeJsonRaw(templateDir, nodeId);
  const include = new Set<string>();
  collectWorkspaceRefs(nodeJson.contract?.readScope, include);
  collectWorkspaceRefs(nodeJson.contract?.execReads, include);
  collectWorkspaceRefs(nodeJson.hooks, include);
  collectWorkspaceRefs(nodeJson.op, include);

  const exclude = new Set<string>();
  collectWorkspaceRefs(nodeJson.optimize?.measure, exclude);
  collectWorkspaceRefs(nodeJson.optimize?.judge, exclude);

  const excludeList = [...exclude];
  const isExcluded = (rel: string): boolean => exclude.has(rel) || excludeList.some((ex) => rel.startsWith(`${ex}/`));

  await fs.mkdir(opts.candidateDir, { recursive: true });
  for (const rel of include) await copyInto(opts.workspace, opts.candidateDir, rel, isExcluded);

  return { candidateRef: opts.candidateDir, included: [...include], excluded: excludeList };
}

// ── editsApplied — a core-generic before/after content-hash diff of the candidate dir ───────────────────────

/** Hash every REAL file (symlinks skipped) under `dir` → `Map<relPath, sha256hex>`. Absent dir ⇒ empty map. */
export async function hashCandidateTree(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(rel: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? path.posix.join(rel, e.name) : e.name;
      const st = await fs.lstat(path.join(dir, childRel));
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) await walk(childRel);
      else if (st.isFile()) out.set(childRel, createHash('sha256').update(await fs.readFile(path.join(dir, childRel))).digest('hex'));
    }
  }
  await walk('');
  return out;
}

/** Count the files that were added, removed, or content-changed between two `hashCandidateTree` snapshots. */
export function countChangedFiles(before: Map<string, string>, after: Map<string, string>): number {
  let n = 0;
  for (const k of new Set([...before.keys(), ...after.keys()])) if (before.get(k) !== after.get(k)) n++;
  return n;
}

// ── the graded-delta fold (the accept signal; see the module header) ────────────────────────────────────────

export interface FoldGradedOpts {
  /** Allowed regression margin per key (default 0 — no regression tolerated). Absorbs noisy replay deltas. */
  tolerance?: number;
  /** Keys for which a LOWER value is better (span ms, token totals, …). Default: none (all higher-is-better). */
  lowerIsBetter?: (key: string) => boolean;
}

export interface FoldGradedResult {
  /** the scalar pair `evaluateGate` ratchets on — null/null when unmeasurable (no shared keys). */
  base: number | null;
  candidate: number | null;
  /** count of numeric keys present in BOTH maps. */
  sharedKeys: number;
  /** human-facing RAW per-key delta (`candidate − base`), keyed by graded metric name. */
  deltaSummary: Record<string, number>;
  improved: boolean;
  regressed: boolean;
}

/**
 * Fold the multi-key graded comparison into the scalar (base, candidate) pair `evaluateGate` accepts, per the
 * module-header rule. PURE. `deltaSummary` carries the RAW `cand − base` per shared key (direction implied by
 * the metric name); `improved`/`regressed` are computed on the direction-ADJUSTED delta.
 */
export function foldGradedDelta(
  base: Record<string, number>,
  candidate: Record<string, number>,
  opts: FoldGradedOpts = {},
): FoldGradedResult {
  const tol = opts.tolerance ?? 0;
  const lowerIsBetter = opts.lowerIsBetter ?? (() => false);
  const shared = Object.keys(base).filter(
    (k) => k in candidate && Number.isFinite(base[k]) && Number.isFinite(candidate[k]),
  );
  const deltaSummary: Record<string, number> = {};
  let improved = false;
  let regressed = false;
  for (const k of shared) {
    const raw = candidate[k] - base[k];
    deltaSummary[k] = raw;
    const adj = lowerIsBetter(k) ? -raw : raw;
    if (adj > 0) improved = true;
    if (adj < -tol) regressed = true;
  }
  if (shared.length === 0) return { base: null, candidate: null, sharedKeys: 0, deltaSummary, improved, regressed };
  const cand = regressed ? -1 : improved ? 1 : 0;
  return { base: 0, candidate: cand, sharedKeys: shared.length, deltaSummary, improved, regressed };
}

// ── commitAdoption — the NET-NEW git commit helper (M6.4) ───────────────────────────────────────────────────

export interface CommitAdoptionResult {
  /** false when there was nothing staged to commit (a no-op — e.g. every adopted file was gitignored). */
  committed: boolean;
  /** the new commit SHA, or '' when `committed` is false. */
  sha: string;
  subject: string;
  trailer: string;
}

/** The identity a commit references — its node + the issue's name/id/title (the trailer + subject inputs). */
export interface CommitIssueRef {
  node: string;
  name: string;
  /** the issue's `sha256:<hex>` id (the trailer uses its first 7 hex chars). */
  id: string;
  title: string;
}

/**
 * Stage `files` (repo-root-relative) and commit them with the SUBJECT `optimize(<node>): <title>` (greppable
 * per node, mirroring game-omni's `skillsys(<node>)`) + the TRAILER `Issue: <node>/<name> — "<title>"
 * (<hash7>)` (commit ⇄ issue, no message discipline needed in either direction). Argv-array `execFileSync`
 * (no shell → no escaping). NO-OP when nothing is staged (empty diff): returns `committed:false, sha:''`.
 */
export function commitAdoption(repoRoot: string, files: string[], issue: CommitIssueRef): CommitAdoptionResult {
  const root = path.resolve(repoRoot);
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();

  const hash7 = issue.id.replace(/^sha256:/, '').slice(0, 7);
  const subject = `optimize(${issue.node}): ${issue.title}`;
  const trailer = `Issue: ${issue.node}/${issue.name} — "${issue.title}" (${hash7})`;

  if (files.length) git('add', '--', ...files);
  // `git diff --cached --quiet` EXITS 1 when there IS a staged diff (execFileSync throws), 0 when clean.
  let hasStaged = false;
  try {
    git('diff', '--cached', '--quiet');
  } catch {
    hasStaged = true;
  }
  if (!hasStaged) return { committed: false, sha: '', subject, trailer };

  git('commit', '-m', subject, '-m', trailer);
  const sha = git('rev-parse', 'HEAD').trim();
  return { committed: true, sha, subject, trailer };
}

// ── the per-issue substrate manifest (writeStagingManifest-shaped, deterministic; M6.5) ─────────────────────

export interface SubstrateManifestRecord {
  /** the issue's pie name (the human handle + the `<name>.md` filename). */
  issue: string;
  /** the issue's `sha256:<hex>` id (the manifest upsert key). */
  issueId: string;
  node: string;
  decision: 'staged' | 'discarded';
  /** the candidate copy the fixer edited (adopt lands its real files onto `liveRoot`). */
  candidateRef: string;
  /** the LIVE product root the candidate mirrors (adopt maps candidate→live here). */
  liveRoot: string;
  landPolicy: LandPolicy;
  /** `verdict.reason` — the flattened gate rationale (a reader needn't re-derive the gate). */
  reason: string;
  /** the child run that proved the fix, or `null` on the skip-proof path. */
  verifiedByRun: string | null;
  /** human-facing RAW per-key graded delta (empty on the skip path / when unmeasurable). */
  deltaSummary: Record<string, number>;
  /** SOFT-gate reject only: the drop-back packet (coarse category + steer) for the outer loop's next fixer. */
  dropback?: { category: GateRejectCategory; steer?: string };
}

export interface SubstrateManifest {
  records: SubstrateManifestRecord[];
}

/** `<stagingDir>/manifest.json`. */
function manifestPathOf(stagingDir: string): string {
  return path.join(stagingDir, 'manifest.json');
}

/** Read the substrate manifest at `stagingDir` (or an empty one if absent/unreadable — never throws). */
export async function readSubstrateManifest(stagingDir: string): Promise<SubstrateManifest> {
  try {
    const parsed = JSON.parse(await fs.readFile(manifestPathOf(stagingDir), 'utf8'));
    return Array.isArray(parsed?.records) ? (parsed as SubstrateManifest) : { records: [] };
  } catch {
    return { records: [] };
  }
}

/** Upsert `record` (keyed by issueId) into the manifest and write it DETERMINISTICALLY (records sorted by
 *  issue name, no timestamp/random — identical decisions render identical bytes). Returns the manifest path. */
async function upsertSubstrateManifest(stagingDir: string, record: SubstrateManifestRecord): Promise<string> {
  const current = await readSubstrateManifest(stagingDir);
  const records = [...current.records.filter((r) => r.issueId !== record.issueId), record].sort((a, b) =>
    a.issue < b.issue ? -1 : a.issue > b.issue ? 1 : 0,
  );
  await fs.mkdir(stagingDir, { recursive: true });
  await fs.writeFile(manifestPathOf(stagingDir), JSON.stringify({ records }, null, 2));
  return manifestPathOf(stagingDir);
}

// ── the fixer prompt (agentic-prompt-design: the issue file IS the dispatch; a tight fix contract) ──────────

/** The DEFAULT fixer playbook skill — staged for EVERY fixer spawn (fixed id, no per-node knob in v1). The
 *  runner resolves it via `locateSkillStage` (Ring 1 `<piflowHome>/skills/piflow-fixer`); a miss is advisory. */
export const FIXER_SKILL = 'piflow-fixer';

/** A rejected prior attempt's residue, threaded into the NEXT fixer so a retry DIVERSIFIES instead of repeating.
 *  Carries ONLY the gate's coarse category + an optional diversification steer + what the prior fixer tried —
 *  NEVER the gate's rubric/criteria (passing rejection as context ≠ optimizing the fixer against the gate;
 *  the latter teaches hiding, not fixing — see docs/design/optimize-verification-loop.md §8). */
export interface RetryContext {
  /** 1-based attempt this fixer is on (2 = the first retry). A value ≤ 1 renders NO diversification block. */
  attempt: number;
  /** prior rejected attempts, OLDEST→NEWEST: the gate's coarse category + optional steer (no rubric). */
  priorDropbacks: { category: GateRejectCategory; steer?: string }[];
  /** each prior fixer's self-account (what it tried), oldest→newest — so the retry does not repeat the approach. */
  priorAccounts: string[];
}

/** Build the fixer agent's FULL prompt: the issue FILE verbatim (its context brief is the specification) + a
 *  root-cause fix contract, plus — on a RETRY (`retry.attempt > 1`) — a diversification block listing what the
 *  prior attempts tried and why they were rejected, ordering a genuinely DIFFERENT approach. Exported so a test
 *  can pin the contract's load-bearing MUST/MUST-NOT lines (agent behaviour itself is proven by the M7 live
 *  demo — eval, not unit). */
export function buildFixerPrompt(issueFileText: string, node: string, retry?: RetryContext): string {
  const parts = [
    `<role>You are the FIXER agent for the "${node}" node — a senior engineer who ROOT-CAUSES a quality defect and repairs it at the source, inside an ISOLATED candidate copy of the node's read closure.</role>`,
    `<playbook>Your fixer PLAYBOOK — the issue lifecycle (open→closed) and the two-foot quality/harness routing — is staged as the "${FIXER_SKILL}" skill for this turn; it is the procedure this contract assumes. Follow it.</playbook>`,
    `<issue>\nThe issue below is the WHOLE dispatch contract — its context brief is your specification. Read it in full before editing.\n\n${issueFileText}\n</issue>`,
    `<task>Root-cause the defect described in <issue>, then EDIT the files in your working directory (the candidate copy) to fix it at its ROOT — not its surface symptom.</task>`,
    [
      '<constraints>',
      '- MUST edit only files inside your working directory (the candidate copy). It is a throwaway copy proven by a re-run before anything reaches the live product.',
      '- MUST NOT run git, commit, stage, or push — landing is a SEPARATE, human-gated step. Leave your edited files in place; do nothing else.',
      '- MUST NOT edit any measurement / judge / oracle file. Those were deliberately EXCLUDED from your copy so you cannot game the score; if a file you need is absent, HALT and say so — never recreate it.',
      '- MUST fix the ROOT CAUSE. A minimal edit that only silences the symptom FAILS the re-run gate that follows this turn.',
      '</constraints>',
    ].join('\n'),
    `<self_check>Before finishing, re-read <issue> and confirm your edits address its ROOT cause (not just its symptom) and that you touched only candidate files. State, in one sentence, the root cause you fixed.</self_check>`,
  ];

  // On a retry, the block goes RIGHT BEFORE the self-check so it is the last thing read before acting — the
  // procedural-fence position that binds. It is the ONLY channel for the prior verdicts; the gate's rubric is
  // deliberately absent (Goodhart fence).
  if (retry && retry.attempt > 1) {
    const priors = retry.priorDropbacks
      .map((d, i) => {
        const tried = retry.priorAccounts[i] ? ` — it tried: ${retry.priorAccounts[i]}` : '';
        const steer = d.steer ? ` Steer for a different angle: ${d.steer}` : '';
        return `  - attempt ${i + 1} was REJECTED (category: ${d.category})${tried}.${steer}`;
      })
      .join('\n');
    const block = [
      '<prior_attempts>',
      `This is attempt ${retry.attempt}. ${retry.priorDropbacks.length} prior attempt(s) on this issue were REJECTED by the gate:`,
      priors,
      'Do NOT repeat any approach above — it has already failed. Root-cause from a genuinely DIFFERENT angle (a different harness lever, or a different root hypothesis). These notes are the ONLY carry-over: there is no scoring rubric to satisfy — fix the defect, do not tune to a gate.',
      '</prior_attempts>',
    ].join('\n');
    parts.splice(parts.length - 1, 0, block); // insert before <self_check>
  }

  return parts.join('\n\n');
}

// ── fixIssue — the per-issue orchestration ──────────────────────────────────────────────────────────────────

/** The fixer's opts = its OWN specialization (dirs/prove/fold/staging/events + the child-run seams) + the
 *  base agent's whole inherited field surface + the `runAgent` test seam, EMBEDDED via
 *  `BaseAgentChildOpts` (agent.ts) — never a re-declared subset (anything left off a copy is silently
 *  lost; `dryRun` and every future base field arrive here automatically). */
export interface FixIssueOpts extends BaseAgentChildOpts {
  /** the parent run being optimized (`spawnChildRun` replays a node of it; measure reports live under it). */
  parentRunDir: string;
  /** the product template dir (`nodes/<id>/{node.json,issues/}`). */
  templateDir: string;
  /** the LIVE product root — `{{WORKSPACE}}` for the candidate copy AND the pristine oracle for measuring. */
  workspace: string;
  /** run the prove-rerun (default true). false ⇒ skip straight to staging (skip-proof path). */
  prove?: boolean;
  /** graded-delta regression tolerance (default 0). */
  tolerance?: number;
  /** keys where LOWER is better, for the graded fold (default none). */
  lowerIsBetter?: (key: string) => boolean;
  /** where the candidate copy + manifest live. Default `<parentRunDir>/optimize/substrate/staging`. */
  stagingDir?: string;
  /** OUTER-LOOP retry only: scope this attempt's candidate dir to `candidates/<issue>/<attemptTag>` so each
   *  attempt's copy is preserved side-by-side (the retry loop can keep the best; a bare default overwrites). */
  attemptTag?: string;
  /** OUTER-LOOP retry only: the prior rejected attempts, threaded into the fixer prompt so it DIVERSIFIES
   *  (categories + steers + accounts — NEVER the gate's rubric). Absent/attempt≤1 ⇒ no diversification block. */
  retry?: RetryContext;
  /** live progress sink (fire-and-forget). */
  onEvent?: SubstrateEventSink;
  // ── test/offline seams for the CHILD prove-run (default the real functions; never live-spawn in a test) ──
  spawnChild?: (parentRunDir: string, nodeId: string, opts: SpawnChildRunOpts) => Promise<SpawnChildRunResult>;
  measure?: (runDir: string, nodeId: string, opts: RunSubstrateMeasureOpts) => Promise<MeasureReport>;
  /** Test/offline seam for the SOFT gate agent (default the real `runSubstrateGate`; never live-spawn a test). */
  gate?: (runDir: string, nodeId: string, opts: RunSubstrateGateOpts) => Promise<RunSubstrateGateResult>;
}

export interface FixIssueResult {
  issue: string;
  node: string;
  candidateRef: string;
  editsApplied: number;
  /** did a prove-rerun happen (editsApplied>=1 AND prove on)? */
  proved: boolean;
  /** the child run id that proved the fix, or null. */
  childId: string | null;
  /** The NUMERIC gate verdict. ABSENT on a dry-run — and on the SOFT-gate path (where `gateVerdict` carries it). */
  verdict?: GateVerdict;
  /** SOFT-gate path ONLY (no numeric oracle + the node has an optimize.judge): the independent gate agent's
   *  verdict. On this path `verdict` (the numeric gate) is absent and this carries the accept/reject instead. */
  gateVerdict?: GateVerdictFile;
  /** SOFT-gate REJECT ONLY: the drop-back packet (coarse category + a diversification steer) the outer loop
   *  hands a FRESH fixer — never the gate's rubric/criteria (that would teach the retry to the test). */
  dropback?: { category: GateRejectCategory; steer?: string };
  /** ABSENT on a dry-run — nothing was decided. */
  decision?: 'staged' | 'discarded';
  deltaSummary: Record<string, number>;
  /** ABSENT on a dry-run — no manifest was staged. */
  manifestPath?: string;
  /** ABSENT on a dry-run — no manifest was staged. */
  record?: SubstrateManifestRecord;
  /** Present ONLY on a dry-run: the BASE agent's composed spec (`plan`) the fixer WOULD have been spawned
   *  with — the full issue-dispatch `prompt` + the resolved candidate jail/skill/tier/model/tools. Forwarded
   *  verbatim from the base agent's preview seam. */
  dryRun?: RunBaseAgentResult['plan'];
  /** The fixer spawn's PERSISTED run dir (present ONLY when the caller passed `outDir` to the base agent) —
   *  point the existing observe instruments at it (`piflowctl telemetry|status|trace <dir>`), exactly like a
   *  workflow node's own run. Absent on the ephemeral default (already deleted) and on a dry-run. */
  fixerRunDir?: string;
}

/** Read the parent run's already-persisted graded metrics (`.graded` of its measure report), or `{}` if the
 *  triage measure pass never ran / is unreadable (⇒ no shared keys ⇒ the gate stages for a human). */
async function readParentGraded(parentRunDir: string, nodeId: string): Promise<Record<string, number>> {
  try {
    const report = JSON.parse(
      await fs.readFile(path.join(parentRunDir, 'optimize', 'substrate', `measure.${nodeId}.json`), 'utf8'),
    ) as { graded?: Record<string, number> };
    return report.graded && typeof report.graded === 'object' ? report.graded : {};
  } catch {
    return {};
  }
}

/**
 * Fix ONE issue end-to-end (activate → candidate → fixer → prove → gate → stage). ADOPT is the SEPARATE
 * `adoptSubstrateManifest` step. Never mutates the live product (only the candidate copy + the ledger's own
 * status/manifest). The node id is derived from the issue path (`…/nodes/<node>/issues/<name>.md`).
 */
export async function fixIssue(issuePath: string, opts: FixIssueOpts): Promise<FixIssueResult> {
  const issuePathAbs = path.resolve(issuePath);
  const node = path.basename(path.dirname(path.dirname(issuePathAbs)));
  const { templateDir, workspace, parentRunDir } = opts;
  const prove = opts.prove ?? true;
  const emit = (e: SubstrateEvent): void => safeEmit(opts.onEvent, e);
  const runAgent = opts.runAgent ?? runBaseAgent;
  const spawnChild = opts.spawnChild ?? spawnChildRun;
  const measure = opts.measure ?? runSubstrateMeasure;

  const issue = await parseIssueFile(issuePathAbs);
  const stagingDir = opts.stagingDir ?? path.join(parentRunDir, 'optimize', 'substrate', 'staging');
  // On a retry the candidate is scoped per-attempt (`candidates/<issue>/<attemptTag>`) so attempts don't
  // clobber each other; the default (no tag) keeps the original `candidates/<issue>` path.
  const candidateRef = opts.attemptTag
    ? path.join(stagingDir, 'candidates', issue.name, opts.attemptTag)
    : path.join(stagingDir, 'candidates', issue.name);

  // The ONE fixer spawn composition — shared VERBATIM by the dry-run preview and the live spawn (never two
  // hand-copies that can drift apart).
  const fixerSpawn = (issueFileText: string): RunBaseAgentOpts => ({
    prompt: buildFixerPrompt(issueFileText, node, opts.retry),
    cwd: candidateRef,
    readScope: [candidateRef],
    owns: [candidateRef],
    // Pass the EXACT resolved skill path, NOT the bare id: the runner uses a path-like ref DIRECTLY (no ring
    // search — skill-locate.ts), so it doesn't matter that the fixer's exec `cwd` is the isolated candidate copy
    // (which carries no skills). The playbook lives in the LIVE product root's installed-skills ring
    // (`<workspace>/.claude/skills`, where `piflowctl skills install` lands piflow-fixer + piflow-triage). A miss
    // still degrades to the promptless playbook (advisory), never a hard fail.
    skill: path.join(workspace, '.claude', 'skills', FIXER_SKILL),
    // The base agent's WHOLE inherited surface (tier/model/timeoutMs/provider/seams/dryRun/…), forwarded as one
    // projection — never a hand-enumerated subset (the old copy here silently dropped `dryRun`).
    ...inheritedAgentOpts(opts),
  });

  // DRY-RUN — the inherited base-agent preview: compose the exact spawn the fixer WOULD get (the candidateRef
  // paths are computed, never created) and return its `plan` WITHOUT mutating ANYTHING — no issue transition,
  // no candidate copy, no spawn, no prove/gate/stage, no events. Read-only throughout.
  if (opts.dryRun) {
    const preview = await runAgent(fixerSpawn(await fs.readFile(issuePathAbs, 'utf8')));
    return {
      issue: issue.name,
      node,
      candidateRef,
      editsApplied: 0,
      proved: false,
      childId: null,
      deltaSummary: {},
      dryRun: preview.plan,
    };
  }

  // (a) activate — guarded by the status machine (open|regressed → active).
  await transitionIssue(issuePathAbs, 'active');
  emit({ type: 'issue-activated', issue: issue.name, node });

  // (b) candidate copy = the {{WORKSPACE}}-read closure minus the oracle exclusions.
  const closure = await prepareCandidateClosure(templateDir, node, { workspace, candidateDir: candidateRef });
  emit({ type: 'candidate-prepared', issue: issue.name, candidateRef, included: closure.included.length, excluded: closure.excluded.length });

  // (c) fixer — edits the candidate; editsApplied = a before/after content-hash diff of the candidate dir.
  const before = await hashCandidateTree(candidateRef);
  emit({ type: 'fixer-started', issue: issue.name });
  const fixerResult = await runAgent(fixerSpawn(await fs.readFile(issuePathAbs, 'utf8')));
  const editsApplied = countChangedFiles(before, await hashCandidateTree(candidateRef));
  emit({ type: 'fixer-done', issue: issue.name, editsApplied });
  if (editsApplied >= 1) await transitionIssue(issuePathAbs, 'fix-landed'); // "candidate edit staged"

  // (d) prove (self-rewind) — or skip (fix-landed → resolved on adopt). Unmeasurable ⇒ base/cand stay null.
  let childId: string | null = null;
  let childDir: string | null = null;
  let base: number | null = null;
  let candidate: number | null = null;
  let deltaSummary: Record<string, number> = {};
  if (editsApplied >= 1 && prove) {
    await transitionIssue(issuePathAbs, 'verifying');
    const child = await spawnChild(parentRunDir, node, {
      templateDir,
      workspace: candidateRef, // the node re-runs against the CANDIDATE
      spawnedBy: { by: 'substrate-fix', issue: issue.name, issueId: issue.id },
      provider: opts.provider,
      buildCommand: opts.buildCommand,
    });
    childId = child.childId;
    childDir = child.childDir;
    emit({ type: 'prove-started', issue: issue.name, childId });
    // measure the CHILD with workspace = the LIVE product root → pristine scorer grades a candidate artifact.
    const childReport = await measure(child.childDir, node, { workspace });
    const fold = foldGradedDelta(await readParentGraded(parentRunDir, node), childReport.graded, {
      tolerance: opts.tolerance,
      lowerIsBetter: opts.lowerIsBetter,
    });
    base = fold.base;
    candidate = fold.candidate;
    deltaSummary = fold.deltaSummary;
    emit({ type: 'measured', issue: issue.name, sharedKeys: fold.sharedKeys });
  }

  // (e) GATE — two decision surfaces on ONE proved candidate:
  //   • NUMERIC (evaluateGate) wherever a graded oracle produced shared keys — deterministic, drift-proof.
  //   • the INDEPENDENT GATE AGENT wherever the fix was proved but the node has NO number, only an
  //     `optimize.judge` bar (the SOFT path). It judges the candidate artifact against the node's OWN criteria
  //     — the same bar a regular run applies, no invented "fix contract" — and STAGES its accept for the human
  //     (never a judge-gated auto-accept). A node with neither a number nor a judge falls to evaluateGate's
  //     stage-for-human, exactly as before.
  let decision: 'staged' | 'discarded';
  let landPolicy: LandPolicy;
  let reason: string;
  let numericVerdict: GateVerdict | undefined;
  let gateVerdict: GateVerdictFile | undefined;
  let dropback: { category: GateRejectCategory; steer?: string } | undefined;

  const numericMeasured = base !== null && candidate !== null; // shared graded keys existed
  const softGate = editsApplied >= 1 && childDir !== null && !numericMeasured && (await nodeHasJudge(templateDir, node));

  if (softGate && childDir !== null) {
    const runGate = opts.gate ?? runSubstrateGate;
    const gateRes = await runGate(childDir, node, {
      workspace,
      templateDir,
      issueFileText: await fs.readFile(issuePathAbs, 'utf8'),
      fixerDiff: '', // v1: the gate inspects the candidate harness (candidateRef, in its read scope) directly
      fixerAccount: fixerResult.text ?? '',
      candidateRef,
      ...inheritedAgentOpts(opts),
    });
    gateVerdict = gateRes.verdict;
    if (!gateVerdict) throw new Error(`fixIssue: the gate agent for node "${node}" returned no verdict`);
    decision = gateVerdict.decision === 'accept' ? 'staged' : 'discarded';
    landPolicy = 'stage-for-human'; // a model judgment STAGES; the human adopts (never judge-gated auto-accept).
    reason = gateVerdict.rationale;
    if (gateVerdict.decision === 'reject' && gateVerdict.category) {
      dropback = { category: gateVerdict.category, ...(gateVerdict.steer ? { steer: gateVerdict.steer } : {}) };
    }
    emit({ type: 'gated', issue: issue.name, accept: gateVerdict.decision === 'accept', reason });
  } else {
    // NUMERIC / degenerate path — REUSE evaluateGate's editsApplied<1 + null⇒stage-for-human rules (fold header).
    numericVerdict = evaluateGate({ bucket: SUBSTRATE_GATE_BUCKET, base, candidate, editsApplied });
    emit({ type: 'gated', issue: issue.name, accept: numericVerdict.accept, reason: numericVerdict.reason });
    decision =
      editsApplied < 1
        ? 'discarded'
        : numericVerdict.accept
          ? 'staged'
          : numericVerdict.landPolicy === 'stage-for-human'
            ? 'staged' // unmeasurable/abstained with no judge → route to a human, never auto
            : 'discarded'; // a measured regression / flat result
    landPolicy = numericVerdict.landPolicy;
    reason = numericVerdict.reason;
  }

  // (e2) a PROVEN-REJECT (we entered `verifying` — childId !== null — and the gate discarded it) must not
  // strand the issue at `verifying`: walk it back to `open` (reason null, NO attempt stamped — nothing landed),
  // so a later triage/fix can re-attempt it (the `verifying → open` back-edge). A staged candidate stays
  // at `verifying` awaiting adopt; the no-edit / skip-proof paths never entered `verifying` (nothing to undo).
  if (childId !== null && decision === 'discarded') await transitionIssue(issuePathAbs, 'open');

  // (f) stage the substrate manifest (adopt is the separate human step).
  const record: SubstrateManifestRecord = {
    issue: issue.name,
    issueId: issue.id,
    node,
    decision,
    candidateRef,
    liveRoot: workspace,
    landPolicy,
    reason,
    verifiedByRun: childId,
    deltaSummary,
    ...(dropback ? { dropback } : {}),
  };
  const manifestPath = await upsertSubstrateManifest(stagingDir, record);
  emit({ type: 'staged', issue: issue.name, decision, manifestPath });
  emit({ type: 'stopped', issue: issue.name, reason: decision === 'staged' ? 'staged for adopt' : `discarded (${reason})` });

  return {
    issue: issue.name,
    node,
    candidateRef,
    editsApplied,
    proved: childId !== null,
    childId,
    verdict: numericVerdict,
    ...(gateVerdict ? { gateVerdict } : {}),
    ...(dropback ? { dropback } : {}),
    decision,
    deltaSummary,
    manifestPath,
    record,
    fixerRunDir: fixerResult.runDir,
  };
}

// ── adoptSubstrateManifest — the SEPARATE human ADOPT step (M6.4/M6.6) ───────────────────────────────────────

export interface AdoptSubstrateManifestOpts {
  /** the template dir — to reconstruct each issue's `<templateDir>/nodes/<node>/issues/<name>.md` path. */
  templateDir: string;
  /** where `adoptFile` writes its `<basename>.bak` backups. Default a fresh tmp dir (reversible-enough). */
  backupDir?: string;
  onEvent?: SubstrateEventSink;
  // ── seams (default the real functions) ──
  commit?: (repoRoot: string, files: string[], issue: CommitIssueRef) => CommitAdoptionResult;
  adopt?: (manifest: AdoptManifest, opts: { backupDir: string; dryRun?: boolean }) => Promise<import('../land.js').AdoptReport>;
}

export interface AdoptSubstrateManifestResult {
  adopted: { issue: string; node: string; commit: string; files: string[] }[];
  skipped: { issue: string; reason: string }[];
}

/**
 * Adopt every `staged` record of a substrate manifest into the live product: land its candidate's real files
 * (reusing land.ts's symlink-safe, backup-first, idempotent walk), then `commitAdoption` (subject+trailer),
 * `stampAttempt({commit, verifiedByRun})`, and transition the issue → `resolved` (reason `fixed`) — the
 * fix-landed→resolved (skip) or verifying→resolved (prove) edge. A record that lands NO files (already
 * adopted, or every file gitignored) is SKIPPED, never a throw — so a re-adopt is a natural no-op.
 */
export async function adoptSubstrateManifest(
  manifest: SubstrateManifest,
  opts: AdoptSubstrateManifestOpts,
): Promise<AdoptSubstrateManifestResult> {
  const emit = (e: SubstrateEvent): void => safeEmit(opts.onEvent, e);
  const commitFn = opts.commit ?? commitAdoption;
  const adoptFn = opts.adopt ?? adoptFromManifest;
  const backupDir = opts.backupDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-substrate-adopt-')));

  const result: AdoptSubstrateManifestResult = { adopted: [], skipped: [] };
  for (const record of manifest.records) {
    if (record.decision !== 'staged') {
      result.skipped.push({ issue: record.issue, reason: `decision is "${record.decision}" (not staged)` });
      continue;
    }
    // Physical landing via land.ts's walk (symlink-safe, backup-first, byte-equal ⇒ skip = idempotent).
    const report = await adoptFn(
      { records: [{ node: record.node, landed: 'adopted', candidateRef: record.candidateRef, liveRoot: record.liveRoot }] },
      { backupDir },
    );
    const files = report.adopted.map((a) => a.file);
    if (files.length === 0) {
      result.skipped.push({ issue: record.issue, reason: 'no files to land (already adopted or missing candidate)' });
      continue;
    }

    const issuePath = path.join(opts.templateDir, 'nodes', record.node, 'issues', `${record.issue}.md`);
    const issue: Issue = await parseIssueFile(issuePath);
    const commit = commitFn(record.liveRoot, files, { node: record.node, name: record.issue, id: record.issueId, title: issue.title });
    if (!commit.committed) {
      result.skipped.push({ issue: record.issue, reason: 'nothing staged to commit (adopted files may be gitignored)' });
      continue;
    }

    await stampAttempt(issuePath, { commit: commit.sha, verifiedByRun: record.verifiedByRun ?? UNPROVEN_BY_RUN });
    await transitionIssue(issuePath, 'resolved', { reason: 'fixed' }); // fix-landed→resolved | verifying→resolved
    emit({ type: 'adopted', issue: record.issue, commit: commit.sha, files: files.length });
    result.adopted.push({ issue: record.issue, node: record.node, commit: commit.sha, files });
  }
  return result;
}
