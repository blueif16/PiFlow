// G4 resume + the run-scope open seam (clusters L + K) — envelopeHashOf / seedFromJournal /
// loadPriorStatus / openRunScope. Extracted verbatim from runner.ts (the §2.1 split). Called ONLY from
// runWorkflow; imports `RunContext` from the leaf ./run-context.js (one-way edge, no cycle).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SandboxProvider, OpenRunOpts, RunScope, NodeSpec, ResolveResult } from '../types.js';
import type { RunContext } from './run-context.js';
import { resolveTokens, type ResolveCtx } from '../workflow/resolver.js';
import { markersFromNode, emitMarkers } from '../contract.js';
import {
  type Journal,
  type NodeDecision,
  envelopeHash,
  inputFilesOf,
  decideResume,
  hashFile,
} from './journal.js';
import { type RunStatus } from './status.js';
import { runJsonFile } from './layout.js';

// ── run scope: per-run resource lifecycle (worktree/cloud) or a trivial per-node forwarder ─────────

/**
 * Open the run scope. A provider that shares ONE backing resource across a run (worktree/cloud)
 * implements `openRun`; we use it. A provider with no shared resource (inmemory/seatbelt) OMITS it —
 * we synthesize a TRIVIAL scope whose `create` forwards straight to `provider.create` (each node still
 * gets its own sandbox, disposed per node in runNode's `finally`) and whose run-level `dispose` is a
 * no-op. So local runs stay byte-identical to the pre-seam path.
 */
export async function openRunScope(provider: SandboxProvider, opts: OpenRunOpts): Promise<RunScope> {
  if (provider.openRun) return provider.openRun(opts);
  return {
    root: opts.repoRoot,
    create: (createOpts) => provider.create(createOpts),
    dispose: async () => { /* no shared resource — per-node dispose is the only teardown */ },
  };
}

// ── G4 resume: envelope-hash resolution + the journal-vs-window seed decision ──────────────────────

/**
 * Compute every node's envelope hash at run-start — the SAME identity `finishNode` will journal and the
 * NEXT resume will compare against. We resolve the node's tools (the resolved `piTools`/`extension`
 * surface) and REALIZE its prompt the SAME way the runner stages it (token resolution + the contract
 * marker tail), so a prompt edit, a `{{arg}}`/`{{state}}` value change, OR a tool change flips the hash.
 *
 * Resilient by design: a node whose tools fail to resolve, or whose prompt has an unresolvable token at
 * run-start (e.g. a `{{state.*}}` an upstream hasn't promoted yet on a FRESH run), falls back to the raw
 * authored prompt / empty tool surface — that node has no journal entry on a fresh run anyway (so it
 * RUNs), and on a resume its upstream state is already persisted (so the token resolves). Never throws.
 */
function envelopeHashOf(ctx: RunContext, node: NodeSpec): string {
  let resolved: ResolveResult | { piTools: string[] };
  try {
    resolved = ctx.registry.resolve(node.tools);
  } catch {
    resolved = { piTools: [] };
  }
  // Path-INVARIANT identity: keep {{RUN}}/{{WORKSPACE}} as tokens (resolve them to themselves) so a run's
  // physical LOCATION never enters the envelope hash. A cross-host migration always lands the run-dir at a
  // DIFFERENT absolute path; resolving {{RUN}} to it would flip every done node's hash → the journal reuse
  // ("done nodes reused, the tail runs") breaks and the whole prefix re-runs on the target. Only
  // identity-bearing content ({{state}}/{{arg}}) resolves — an edited arg/state SHOULD still re-run the node.
  const resolveCtx: ResolveCtx = { run: '{{RUN}}', workspace: '{{WORKSPACE}}', state: ctx.runState, args: ctx.args };
  // A programmatic node carries no prompt — `?? ''` gives a stable empty-prompt hash (its identity is its
  // ops/contract, not a prompt); every other node realizes its prompt + marker tail exactly as before.
  let realizedPrompt = node.prompt ?? '';
  try {
    const body = resolveTokens(node.prompt ?? '', resolveCtx);
    const markers = emitMarkers(markersFromNode(node, resolved as ResolveResult));
    realizedPrompt = body + (markers ? `\n\n${markers}` : '');
  } catch {
    /* keep the authored prompt — see the resilience note above */
  }
  // Hash a node clone carrying the REALIZED prompt (envelopeHash reads node.prompt).
  return envelopeHash({ ...node, prompt: realizedPrompt }, resolved as ResolveResult, ctx.model);
}

/**
 * The JOURNAL decision per node (§4c), layered with the `--from/--until` window (§4e). Returns each
 * node's seeded status: `reused` (skip — provably unchanged or pinned by `--from`) vs `pending` (run).
 *
 * Precedence (§4e):
 *  1. JOURNAL: a node `decideResume` marked REUSE is `reused`; RUN is `pending`. (`noResume` ⇒ every
 *     selected node RUNs.)
 *  2. `--from`: every node in a stage `< fromIdx` is FORCED `reused` (manual stale-prefix pin), even if
 *     the journal said RUN.
 *  3. `--until`: every node in a stage `> untilIdx` is left OUT of `selected` (a partial run) by the
 *     caller's slice — handled by the existing window math, not here.
 *  4. SAFETY: a node FORCED `reused` (by `--from` or the journal) whose declared artifacts are MISSING
 *     on disk flips back to `pending` (re-run) — strictly safer than a hard HALT (handled at the
 *     preflight site, not here).
 */
export async function seedFromJournal(
  ctx: RunContext,
  journal: Journal | null,
  fromIdx: number,
  noResume: boolean,
): Promise<{ decisions: Map<string, NodeDecision>; reused: Set<string> }> {
  const wf = ctx.wf;
  // Compute every node's envelope hash (the SAME identity finishNode journals), recorded on ctx so the
  // run records the value the next resume compares against.
  const envHash: Record<string, string> = {};
  for (const id of Object.keys(wf.nodes)) envHash[id] = envelopeHashOf(ctx, wf.nodes[id]);
  ctx.journal.envHash = envHash;

  let decisions: Map<string, NodeDecision>;
  if (noResume || !journal) {
    // No journal (fresh run) or forced full re-run ⇒ every node RUNs.
    decisions = new Map(
      Object.keys(wf.nodes).map((id) => [id, { decision: 'RUN' as const, reason: noResume ? 'noResume' : 'no journal' }]),
    );
  } else {
    // Hash each node's CURRENT consumed-file bytes off the host run dir (content hash, the §2b fix — a
    // same-mtime hand-edit IS caught). An absent input is omitted (decideResume treats a journal-recorded
    // file now-missing as a miss → re-run).
    const inputHash: Record<string, Record<string, string>> = {};
    for (const id of Object.keys(wf.nodes)) {
      const map: Record<string, string> = {};
      for (const f of inputFilesOf(wf.nodes[id], wf)) {
        const h = await hashFile(path.resolve(ctx.outDir, f));
        if (h) map[f] = h;
      }
      inputHash[id] = map;
    }
    decisions = decideResume(wf, journal, { envHash, inputHash });
  }

  // `--from` pin: every node in a stage strictly before fromIdx is FORCED reused (manual override).
  const pinned = new Set<string>();
  if (fromIdx > 0) for (const s of wf.stages.slice(0, fromIdx)) for (const id of s.nodeIds) pinned.add(id);

  const reused = new Set<string>();
  for (const id of Object.keys(wf.nodes)) {
    const run = decisions.get(id)?.decision === 'RUN';
    if (pinned.has(id) || !run) reused.add(id);
  }
  return { decisions, reused };
}

/**
 * Load the PRIOR `.pi/run.json` — the record THIS run is about to overwrite — so a resume can carry the
 * reused nodes' completed records (timings/summary/model/checks) AND the accumulated run clock forward
 * instead of blanking them. Returns null when absent/unparseable OR from a DIFFERENT template (a `source`
 * mismatch ⇒ a wholesale swap → no carry; mirrors the journal's same-`source` guard). A fresh run sees null.
 */
export async function loadPriorStatus(outDir: string, source: string): Promise<RunStatus | null> {
  try {
    const prior = JSON.parse(await fs.readFile(runJsonFile(outDir), 'utf8')) as RunStatus;
    return prior && prior.source === source ? prior : null;
  } catch {
    return null;
  }
}
