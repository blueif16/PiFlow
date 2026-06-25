// G4 — content-hash journal/replay resume. The per-node envelope hash + input-hash map, the atomic
// `.pi/journal.json`, and the resume DECISION (REUSE an unchanged node; RUN a changed node AND all its
// DAG descendants) that replaces the existence-only artifact preflight's staleness blind spot.
//
// Two halves, kept apart (so the decision is pure + unit-testable, the I/O mirrors status.ts):
//   PURE: envelopeHash · inputFilesOf · descendantsMap · decideResume.
//   I/O:  hashFile · loadJournal · writeJournalEntry (atomic tmp+rename + .bak, serialized per dir,
//         copied from writeStatus's pattern in status.ts).
//
// Design contract: docs/specs/wiring-g4-resume-journal.md. Locked decisions: content hash (sha256 of
// file bytes); topological/conservative descendant invalidation; the envelope includes what exists
// TODAY (realized prompt, resolved tools/extension, return schema/mode, contract/checks/policy, ops)
// plus the run-level `ctx.model` — with a commented extension point where G1 (per-node model) + G6
// (agentType def) fold in later.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { NodeSpec, Workflow, ResolveResult } from '../types.js';
import { piDir } from './layout.js';

// ── schema (matches §4b) ─────────────────────────────────────────────────────────────────────────

/** One node's journaled record — written ONLY on a terminal-good verdict (never running/error/blocked). */
export interface JournalNode {
  /** The envelope hash (§4a) — `sha256:<hex>`. */
  hash: string;
  /** path → content hash of each consumed input file at run time. */
  inputHashes: Record<string, string>;
  /** path → content hash of each produced artifact (post-run, post-verify). */
  outputHashes: Record<string, string>;
  /** ONLY a terminal-good status is journaled. */
  status: 'ok';
  producedAt: string;
}

/** The whole `${RUN}/.pi/journal.json` document. */
export interface Journal {
  version: number;
  runId: string;
  /** `wf.meta.name`, for a sanity check on resume (refuse a journal from a different template). */
  source: string;
  nodes: Record<string, JournalNode>;
}

/** The journal schema version. Bumped when the envelope-hash inputs change (G1/G6 fold-in). */
export const JOURNAL_VERSION = 1;

// ── layout helpers ───────────────────────────────────────────────────────────────────────────────

/** `${run}/.pi/journal.json` — the per-node content-hash journal (sibling of state.json/run.json). */
export const journalFile = (run: string): string => path.join(piDir(run), 'journal.json');
/** `${run}/.pi/journal.bak` — the prior good journal, the fallback on a truncated primary. */
export const journalBakFile = (run: string): string => path.join(piDir(run), 'journal.bak');

// ── PURE: the envelope hash (§4a) ──────────────────────────────────────────────────────────────────

/** The minimal resolve shape the envelope hash reads (a subset of ResolveResult). */
type EnvelopeResolve = Pick<ResolveResult, 'piTools'> & Partial<Pick<ResolveResult, 'excludeTools' | 'extension'>>;

/** sha256 of `data` as `sha256:<hex>`. */
function sha256(data: string | Uint8Array): string {
  return 'sha256:' + createHash('sha256').update(data).digest('hex');
}

/**
 * The per-node envelope hash — `sha256` over a canonical JSON of the resolved work definition. A node
 * re-runs iff this OR any consumed input-file hash differs from the journaled run.
 *
 * Inputs (each already produced by the runner before exec — `journal.ts` reads values in hand):
 *  - prompt: the AUTHORED prompt string (the realized-at-launch text is hashed at the call site by
 *            passing the resolved prompt as `node.prompt` is NOT done here; the runner resolves tokens
 *            then hands the realized node — see the runner wiring). Hashing `node.prompt` flips on any
 *            prompt edit / marker change / token-value change once the runner resolves before hashing.
 *  - piTools / excludeTools / extension: the resolved tool surface (a tool add/remove or a binding/
 *            schema change flips `extension`).
 *  - model: the run-level model pin (ctx.model) TODAY.
 *  - returnSchema / returnMode: the structured-return contract.
 *  - artifacts / checks / policy / fillSentinel: the artifact contract (a tightening must re-verify).
 *  - ops: seed/project/merge/promote/registryProject (derive-from-input behavior).
 *
 * EXTENSION POINT (G1/G6): once per-node `node.model`/`node.tier` (G1) and a resolved `agentType`
 * definition (G6) land, fold the RESOLVED per-node model + agentType def into `envelope` below (and bump
 * JOURNAL_VERSION) — a per-node model swap or an agent-.md edit must then invalidate the node.
 */
export function envelopeHash(node: NodeSpec, resolved: EnvelopeResolve, model: string | undefined): string {
  const envelope = {
    prompt: node.prompt,
    piTools: resolved.piTools ?? [],
    excludeTools: resolved.excludeTools ?? null,
    extension: resolved.extension ?? null,
    model: model ?? null,
    // G1/G6 extension point: add `perNodeModel: node.model ?? null` and `agentTypeDef: <resolved def>`
    // here when those gaps land. Until then we hash the raw agentType string (cheap, still flips on a
    // retarget) and the run-level model above.
    agentType: node.agentType ?? null,
    returnSchema: node.io.returnSchema ?? null,
    returnMode: node.io.returnMode ?? null,
    artifacts: node.io.artifacts ?? [],
    checks: node.io.checks ?? null,
    policy: node.io.policy ?? null,
    fillSentinel: node.io.fillSentinel ?? null,
    ops: node.ops ?? null,
  };
  return sha256(JSON.stringify(envelope));
}

// ── PURE: the consumed-file set + the descendant map (§4c) ─────────────────────────────────────────

/**
 * The set of files a node CONSUMES (its inputs), for the input-hash check. Handles BOTH paths:
 *  - the inferred-edge (compiled) path: `node.io.reads` is populated.
 *  - the TEMPLATE/deps path (⚠ load-bearing discrepancy, doc §4a): `io.reads` is hardcoded `[]` and
 *    edges come from `dependsOn`; so the consumed set = the UNION of every DAG-parent's `produces`.
 * Using BOTH is the safe superset — "the files that feed this node". Deduped, stable order.
 */
export function inputFilesOf(node: NodeSpec, wf: Workflow): string[] {
  const files = new Set<string>(node.io.reads ?? []);
  for (const e of wf.edges) {
    if (e.to !== node.id) continue;
    const parent = wf.nodes[e.from];
    if (!parent) continue;
    for (const f of parent.io.produces ?? []) files.add(f);
  }
  return [...files];
}

/**
 * Transitive closure of `wf.edges` (forward adjacency): nodeId → the set of ALL reachable descendant
 * nodeIds. This is the topology over which a changed node taints its downstream ("first miss → it +
 * everything after run live", translated from PDW's linear callSeq suffix to DAG reachability).
 */
export function descendantsMap(wf: Workflow): Record<string, Set<string>> {
  const adj = new Map<string, string[]>();
  for (const id of Object.keys(wf.nodes)) adj.set(id, []);
  for (const e of wf.edges) adj.get(e.from)?.push(e.to);

  const out: Record<string, Set<string>> = {};
  for (const id of Object.keys(wf.nodes)) {
    const seen = new Set<string>();
    const stack = [...(adj.get(id) ?? [])];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const nxt of adj.get(cur) ?? []) if (!seen.has(nxt)) stack.push(nxt);
    }
    out[id] = seen;
  }
  return out;
}

// ── PURE: the resume decision (§4c steps 3-5) ──────────────────────────────────────────────────────

export type Decision = 'RUN' | 'REUSE';

export interface NodeDecision {
  decision: Decision;
  /** Why this node RUNs (empty for REUSE). For diagnostics + the input-changed assertion. */
  reason: string;
}

/** The realized envelope hash + the on-disk input-file hashes for each node, computed by the caller. */
export interface ResumeInputs {
  /** nodeId → its envelope hash (the SAME `envelopeHash` the runner will compute pre-exec). */
  envHash: Record<string, string>;
  /** nodeId → { consumed-file path → its CURRENT on-disk content hash } (`sha256:…`, or omit if absent). */
  inputHash: Record<string, Record<string, string>>;
}

/**
 * The §4c algorithm. INTRINSIC staleness first (no journal entry · envelope changed · a consumed file's
 * content changed vs the journal), then PROPAGATE — a changed node taints every DAG descendant. A node
 * NOT tainted is provably unchanged ⇒ REUSE; else RUN.
 *
 * The journal's `source` must match the workflow's `meta.name` — a journal from a different template is
 * IGNORED (every node RUNs), guarding a wholesale template swap (§5.7).
 */
export function decideResume(wf: Workflow, journal: Journal | null, inputs: ResumeInputs): Map<string, NodeDecision> {
  const ids = Object.keys(wf.nodes);
  const mustRun = new Map<string, string>(); // nodeId → reason

  const usable = journal && journal.source === wf.meta.name ? journal : null;

  // Pass 1 — intrinsic staleness.
  for (const id of ids) {
    const j = usable?.nodes[id];
    if (!j) {
      mustRun.set(id, 'no journal entry');
      continue;
    }
    if (j.hash !== inputs.envHash[id]) {
      mustRun.set(id, 'envelope changed');
      continue;
    }
    const cur = inputs.inputHash[id] ?? {};
    let inputMiss: string | null = null;
    for (const [file, hash] of Object.entries(cur)) {
      if (j.inputHashes[file] !== hash) { inputMiss = file; break; }
    }
    // A consumed file the journal recorded but that is now ABSENT (no current hash) is also a miss.
    if (!inputMiss) {
      for (const file of Object.keys(j.inputHashes)) {
        if (!(file in cur)) { inputMiss = file; break; }
      }
    }
    if (inputMiss) mustRun.set(id, `input changed: ${inputMiss}`);
  }

  // Pass 2 — propagate: a changed node taints every DAG descendant (topological/conservative, v1).
  const descendants = descendantsMap(wf);
  for (const id of [...mustRun.keys()]) {
    for (const d of descendants[id] ?? []) {
      if (!mustRun.has(d)) mustRun.set(d, `upstream re-ran: ${id}`);
    }
  }

  // Decide.
  const out = new Map<string, NodeDecision>();
  for (const id of ids) {
    const reason = mustRun.get(id);
    out.set(id, reason ? { decision: 'RUN', reason } : { decision: 'REUSE', reason: '' });
  }
  return out;
}

// ── I/O: content hashing + the atomic journal writer (mirrors status.ts) ──────────────────────────

/** Content hash of a host file → `sha256:<hex>`, or `null` if it is missing/unreadable. */
export async function hashFile(absPath: string): Promise<string | null> {
  try {
    const data = await fs.readFile(absPath);
    return sha256(data);
  } catch {
    return null;
  }
}

/**
 * Read `${run}/.pi/journal.json`. Falls back to the `.bak` on a truncated/unparseable primary (PDW's
 * crash-safety fallback). Returns `null` when neither exists (a fresh run / no prior journal).
 */
export async function loadJournal(run: string): Promise<Journal | null> {
  for (const file of [journalFile(run), journalBakFile(run)]) {
    try {
      const raw = await fs.readFile(file, 'utf8');
      return JSON.parse(raw) as Journal;
    } catch {
      /* try the next */
    }
  }
  return null;
}

// SERIALIZED + ATOMIC writer (the exact writeStatus pattern, status.ts:129): the journal is written
// from PARALLEL stage lanes (each finished node appends its entry) — concurrent writers. A per-directory
// promise chain serializes writes (no overlap → real last-write-wins), each goes to a unique temp file
// then `rename`s into place (atomic on POSIX/NTFS), and the prior good primary is copied to `.bak`
// BEFORE the rename so a crash mid-write leaves a recoverable fallback.
const writeChains = new Map<string, Promise<void>>();
let tmpSeq = 0;

/**
 * Atomically record (or overwrite) ONE node's journal entry. The caller passes the full entry; this
 * read-modify-writes the whole `journal.json` under the per-dir serialization (so the in-flight chain
 * orders the read AND the write — two lanes never lose each other's entry). Writing is gated by the
 * caller to a TERMINAL-GOOD verdict only — a crashed/started-but-unfinished node is never journaled.
 */
export function writeJournalEntry(
  run: string,
  meta: { runId: string; source: string },
  nodeId: string,
  entry: JournalNode,
): Promise<void> {
  const prev = writeChains.get(run) ?? Promise.resolve();
  const next = prev
    .catch(() => {}) // a prior write's failure must not poison the chain
    .then(async () => {
      const metaDir = piDir(run);
      await fs.mkdir(metaDir, { recursive: true });
      const finalPath = journalFile(run);
      // Read-modify-write inside the serialized chain (so concurrent lanes accumulate, not clobber).
      let doc: Journal;
      try {
        doc = JSON.parse(await fs.readFile(finalPath, 'utf8')) as Journal;
        // A journal from a DIFFERENT template (or version) is replaced wholesale, not merged.
        if (doc.source !== meta.source || doc.version !== JOURNAL_VERSION) {
          doc = { version: JOURNAL_VERSION, runId: meta.runId, source: meta.source, nodes: {} };
        }
      } catch {
        doc = { version: JOURNAL_VERSION, runId: meta.runId, source: meta.source, nodes: {} };
      }
      doc.nodes[nodeId] = entry;
      const body = JSON.stringify(doc, null, 2);
      // .bak the prior good primary, then atomic temp+rename the new one.
      try { await fs.copyFile(finalPath, journalBakFile(run)); } catch { /* no prior primary yet */ }
      const tmpPath = path.join(metaDir, `.journal.${process.pid}.${tmpSeq++}.tmp`);
      await fs.writeFile(tmpPath, body);
      await fs.rename(tmpPath, finalPath); // atomic publish
    });
  writeChains.set(run, next);
  return next;
}
