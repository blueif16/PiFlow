// `piflow status <rundir>` — the per-node dashboard over the engine-owned `.pi/` run layout.
//
// It reads `.pi/run.json` (a RunStatus) via @piflow/core's layout helpers — NEVER a hardcoded path,
// and NEVER the legacy `run-status.json` / `_pi/` paths — and joins each node with its
// `.pi/nodes/<id>/io.json` ledger. The presentation is the legacy status.mjs table re-pointed at the
// new layout: a per-node row (id · label · status · verified/total artifacts · durationMs) + a
// stage line + a rollup foot.
//
// THE LOAD-BEARING RULE (verified, not trusted): a node's TABLE status is DERIVED from on-disk
// artifact reality, not the `status` field the writer stamped. If any declared artifact is absent on
// the host, the node reads `blocked` even when its record self-reports `ok` — the artifact contract
// beats the self-report (exactly as the runner's own verdict ladder does, runner.ts:558). So the
// dashboard can never be fooled by a stale or lying record.
//
// FAILURE-PATH NOTE (scope_fence): the legacy table showed a token/cost rollup. The new RunStatus
// (status.ts) does NOT carry tokens/cost/`live` — so this renderer shows ONLY what the new layout
// carries (status · verified-artifacts · durationMs · stage · ok/failed rollup) and does NOT fabricate
// cost numbers. Re-add a cost column once run.json carries the field. (See coreFollowUps in the return.)

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  runJsonFile,
  nodeIoFile,
  artifactState,
  type RunStatus,
  type NodeStatus,
  type NodeStatusRecord,
  type NodeIo,
} from '@piflow/core';

/** One node, with its status RE-DERIVED from on-disk artifact verification. */
export interface NodeView {
  id: string;
  label: string;
  /** The status the dashboard shows — derived, not the raw record field (see header). */
  status: NodeStatus;
  /** The status the record SELF-REPORTED (kept for transparency / the mutation test). */
  reported: NodeStatus;
  /** Declared artifacts that exist on disk RIGHT NOW. */
  verified: number;
  /** Declared artifacts total. */
  total: number;
  durationMs?: number;
  /** Declared artifacts found absent on disk (the reason a node reads blocked). */
  missing: string[];
}

/** The whole run, read + verified. */
export interface RunView {
  run: string;
  done: boolean;
  ok: boolean | null;
  durationMs: number | null;
  provider?: string;
  model?: string | null;
  stage: RunStatus['stage'];
  totals: RunStatus['totals'];
  nodes: NodeView[];
}

/** Read `.pi/run.json` (or null if absent/unparseable). */
async function readRunJson(rundir: string): Promise<RunStatus | null> {
  try {
    return JSON.parse(await fs.readFile(runJsonFile(rundir), 'utf8')) as RunStatus;
  } catch {
    return null;
  }
}

/** Read a node's `.pi/nodes/<id>/io.json` ledger (or null). */
async function readNodeIo(rundir: string, id: string): Promise<NodeIo | null> {
  try {
    return JSON.parse(await fs.readFile(nodeIoFile(rundir, id), 'utf8')) as NodeIo;
  } catch {
    return null;
  }
}

/**
 * The declared-artifact paths for a node: the io.json `writes[]` are the authoritative ledger; fall
 * back to the run-status record's `artifacts[]` paths when no ledger exists. Either way the EXISTENCE
 * is re-checked on disk below — the recorded `verified`/`exists` flags are not trusted.
 */
function declaredArtifacts(rec: NodeStatusRecord, io: NodeIo | null): string[] {
  if (io?.writes?.length) return io.writes.map((w) => w.path);
  return rec.artifacts.map((a) => a.path);
}

/** Re-derive a node's status from on-disk reality (the verified-not-trusted rule). */
function deriveStatus(reported: NodeStatus, missing: string[]): NodeStatus {
  // A killed/error verdict is terminal regardless of artifacts — never soften it.
  if (reported === 'error') return 'error';
  // Pre-terminal states (pending/running/reused/dry) pass through; they make no artifact claim yet.
  if (reported === 'pending' || reported === 'running' || reported === 'reused' || reported === 'dry') {
    return reported;
  }
  // For any verdict that CLAIMS completion (ok/gap/blocked), a missing declared artifact is a contract
  // breach → blocked, beating the self-report (runner.ts:558).
  if (missing.length) return 'blocked';
  return reported;
}

/** Read a run dir → a per-node VERIFIED view. The reader, decoupled from the renderer (testable). */
export async function readRun(rundir: string): Promise<RunView> {
  const status = await readRunJson(rundir);
  if (!status) {
    throw new Error(`piflow status: no readable .pi/run.json under ${path.resolve(rundir)}`);
  }
  const nodes: NodeView[] = [];
  for (const rec of Object.values(status.nodes)) {
    const io = await readNodeIo(rundir, rec.id);
    const declared = declaredArtifacts(rec, io);
    const states = await Promise.all(
      declared.map((rel) => artifactState(path.resolve(rundir, rel), rel)),
    );
    const missing = states.filter((s) => !s.exists).map((s) => s.path);
    const verified = states.filter((s) => s.exists).length;
    nodes.push({
      id: rec.id,
      label: rec.label,
      reported: rec.status,
      status: deriveStatus(rec.status, missing),
      verified,
      total: declared.length,
      durationMs: rec.durationMs,
      missing,
    });
  }
  return {
    run: status.run,
    done: status.done,
    ok: status.ok,
    durationMs: status.durationMs,
    provider: status.provider,
    model: status.model,
    stage: status.stage,
    totals: status.totals,
    nodes,
  };
}

const ICON: Record<NodeStatus, string> = {
  ok: '✓',
  reused: '✓',
  running: '▶',
  pending: '·',
  gap: '~',
  blocked: '✗',
  error: '✗',
  dry: '∅',
};
const sec = (ms?: number | null): string => (ms == null ? '' : `${Math.round(ms / 1000)}s`);
const pad = (s: unknown, n: number): string => String(s ?? '').padEnd(n).slice(0, n);

/** Render a RunView as the per-node table + stage + rollup. Pure over the view (deterministic). */
export function renderStatus(run: RunView): string {
  const head = [
    `run "${run.run}"  ${run.done ? (run.ok === false ? '✗ FAILED' : '✓ DONE') : '▶ running'}` +
      `  ·  provider=${run.provider ?? ''}  ·  model=${run.model ?? ''}`,
    run.stage
      ? `stage ${run.stage.index}/${run.stage.total}  ·  [${run.stage.nodeIds.join(', ')}]`
      : `run-elapsed ${sec(run.durationMs)}`,
    `  ${pad('', 2)}${pad('node', 16)} ${pad('label', 18)} ${pad('status', 9)} ${pad('artifacts', 14)} dur`,
  ];
  const rows = run.nodes.map((n) => {
    const arts = `${n.verified}/${n.total} verified`;
    return `  ${ICON[n.status] ?? '?'} ${pad(n.id, 16)} ${pad(n.label, 18)} ${pad(n.status, 9)} ${pad(arts, 14)} ${sec(n.durationMs)}`;
  });
  const t = run.totals;
  const foot = t
    ? `  └ totals: ${t.nodes} nodes · ${t.ok} ok · ${t.failed} failed`
    : `  └ ${run.nodes.length} nodes · token/cost rollup not in .pi/run.json yet (HALT-note: not fabricated)`;
  return [...head, ...rows, foot].join('\n');
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** `piflow status <rundir> [--every <s>]` — one-shot, or a live refresh-in-place loop. */
export async function runStatusCli(argv: string[]): Promise<void> {
  let dir: string | undefined;
  let every: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--every') every = Number(argv[++i]);
    else if (!k.startsWith('-')) dir = k;
  }
  const rundir = dir && dir.trim() ? dir : '.';
  const once = async (): Promise<boolean> => {
    let view: RunView;
    try {
      view = await readRun(rundir);
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      process.exitCode = 1;
      return true; // nothing to refresh into
    }
    if (every) process.stdout.write('\x1b[2J\x1b[H'); // clear+home for the live dashboard
    process.stdout.write(renderStatus(view) + '\n');
    return view.done;
  };
  if (!every) {
    await once();
    return;
  }
  for (;;) {
    const done = await once();
    if (done) break;
    await sleep(every * 1000);
  }
}
