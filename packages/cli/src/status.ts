// `piflow status <rundir>` — the per-node dashboard, a THIN renderer over the shared observability
// source (`@piflow/core/observe`). It reads the run through `readRunModel(dir)` — the ONE reader the
// CLI, the TUI, and a future GUI all share — and lays its `RunModel` out as a per-node table (id ·
// label · status · verified/total artifacts · durationMs) + a stage line + a rollup foot. There is NO
// bespoke `.pi/` reader here anymore: model-building (status derivation, stage/lane reconstruction, io
// edges) lives entirely in the shared source; this file only RENDERS + lays out.
//
// THE LOAD-BEARING RULE (verified, not trusted) is enforced IN the shared reader: a node's `status` is
// DERIVED from on-disk artifact reality, not the `status` field the writer stamped — a node whose
// declared artifact is absent reads `blocked` even when its record self-reports `ok`. The table shows
// that derived verdict, so it can never be fooled by a stale or lying record.
//
// FAILURE-PATH NOTE (scope_fence): the legacy table showed a token/cost rollup. The shared `RunModel`
// (status.ts) does NOT carry tokens/cost — so this renderer shows ONLY what the source carries (status ·
// verified-artifacts · durationMs · stage · ok/failed rollup) and does NOT fabricate cost numbers.

import { readRunModel, type RunModel, type NodeStatus } from '@piflow/core';

const ICON: Record<NodeStatus, string> = {
  ok: '✓',
  reused: '✓',
  running: '▶',
  pending: '·',
  gap: '~',
  blocked: '✗',
  error: '✗',
  'awaiting-input': '⏸',
  dry: '∅',
};
const sec = (ms?: number | null): string => (ms == null ? '' : `${Math.round(ms / 1000)}s`);
const pad = (s: unknown, n: number): string => String(s ?? '').padEnd(n).slice(0, n);

/** Render a `RunModel` as the per-node table + stage + rollup. Pure over the model (deterministic). */
export function renderStatus(run: RunModel): string {
  const head = [
    `run "${run.run}"  ${run.done ? (run.ok === false ? '✗ FAILED' : '✓ DONE') : '▶ running'}` +
      `  ·  provider=${run.provider ?? ''}  ·  model=${run.model ?? ''}`,
    run.stage
      ? `stage ${run.stage.index}/${run.stage.total}  ·  [${run.stage.nodeIds.join(', ')}]`
      : `run-elapsed ${sec(run.durationMs)}`,
    `  ${pad('', 2)}${pad('node', 16)} ${pad('label', 18)} ${pad('status', 9)} ${pad('artifacts', 14)} dur`,
  ];
  const rows = run.nodes.map((n) => {
    const arts = `${n.artifactsVerified}/${n.artifactsTotal} verified`;
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
    let model: RunModel;
    try {
      model = await readRunModel(rundir);
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      process.exitCode = 1;
      return true; // nothing to refresh into
    }
    if (every) process.stdout.write('\x1b[2J\x1b[H'); // clear+home for the live dashboard
    process.stdout.write(renderStatus(model) + '\n');
    return model.done;
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
