// `piflowctl telemetry <rundir> [nodeId] [--watch] [--verbose] [--json]` — the agent-facing telemetry
// surface, a THIN renderer over the shared projection (`@piflow/core` projectRunDigest / telemetryStream).
// It is the layer ABOVE observe: where `status` shows the human per-node table, `telemetry` distills the
// decision-grade subset an agent uses to self-debug — verdicts, the cost spine, loop signals, the anomaly
// worklist, and failure-onset localization.
//
// TWO MODES (the docker mental model):
//   • default (record)  → projectRunDigest(buildRunView(dir))  — the one-shot digest (`docker inspect`).
//   • --watch (stream)  → telemetryStream(watchRun(dir))       — live deltas (`docker logs -f`/`stats`),
//                          then the authoritative record once the run is done.
// --verbose adds per chat/tool `call` lines (the full span tree); default is important-only (verdicts +
// anomalies). --json emits the raw digest (or one node's) for an agent to consume directly.

import {
  buildRunView,
  watchRun,
  projectRunDigest,
  telemetryStream,
  type RunDigest,
  type NodeDigest,
  type Anomaly,
  type AnomalyKind,
  type TelemetryEvent,
  type Verbosity,
  type TurnRecord,
} from '@piflow/core';

// ── parse ───────────────────────────────────────────────────────────────────────────────────────────
export interface ParsedTelemetryArgs {
  dir: string;
  nodeId?: string;
  watch: boolean;
  verbosity: Verbosity;
  json: boolean;
}
export function parseTelemetryArgs(argv: string[]): ParsedTelemetryArgs {
  const out: ParsedTelemetryArgs = { dir: '.', nodeId: undefined, watch: false, verbosity: 'important', json: false };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--watch' || k === '-w') out.watch = true;
    else if (k === '--verbose' || k === '-v') out.verbosity = 'verbose';
    else if (k === '--json') out.json = true;
    else if (!k.startsWith('-')) positionals.push(k);
  }
  if (positionals[0]) out.dir = positionals[0];
  out.nodeId = positionals[1];
  return out;
}

// ── format helpers ────────────────────────────────────────────────────────────────────────────────────
const k = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
const usd = (c: number): string => (c >= 0.01 ? `$${c.toFixed(2)}` : c > 0 ? `$${c.toFixed(4)}` : '$0');
const pct = (p: number | null): string => (p == null ? '' : `${Math.round(p * 100)}%`);
const pad = (s: unknown, n: number): string => String(s ?? '').padEnd(n).slice(0, n);
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

const ANOM_ICON: Record<AnomalyKind, string> = { failed: '✗', truncated: '✂', 'tool-loop': '↻', 'loop-score': '⟳', 'context-pressure': '▓', 'mega-think': 'Θ', slow: '⏱', 'cost-spike': '$', retries: '↺' };
const OUTCOME_ICON: Record<string, string> = { ok: '✓', reused: '✓', running: '▶', pending: '·', gap: '~', blocked: '✗', error: '✗', 'awaiting-input': '⏸', dry: '∅' };

function anomalyLine(a: Anomaly): string {
  return `    ${ANOM_ICON[a.kind] ?? '!'} ${pad(a.kind, 17)} ${pad(a.nodeId, 16)} ${a.detail}`;
}

/** One per-turn timeline row: turn · t+s (start, relative to the first event) · dur · thinkChars · tools. */
function turnRow(t: TurnRecord): string {
  const tools = t.toolCalls.length ? t.toolCalls.map((c) => c.name).join(',') : '-';
  return `    ${pad(t.turnIndex, 4)} ${pad(secs(t.startMs), 8)} ${pad(secs(t.durMs), 8)} ${pad(k(t.thinkChars), 7)} ${tools}`;
}

type NodeOp = NonNullable<NodeDigest['ops']>[number];

/** (op-integrity WS-I3) The ops-table verdict column: "-" when the op declared no `expect` (nothing to
 *  check); "FAIL <kind,…>" naming the FAILING check kind(s) — the gate ledger's own verdict, never a raw
 *  stderr line; "PASS <kind,…>" when every declared expectation held. */
function opVerdict(o: NodeOp): string {
  if (!o.integrity?.length) return '-';
  const failing = o.integrity.filter((v) => !v.ok);
  if (failing.length) return `FAIL ${failing.map((v) => v.kind).join(',')}`;
  return `PASS ${o.integrity.map((v) => v.kind).join(',')}`;
}

/** One ops-table row: op id · exit code · duration · the integrity verdict (never the first stderr line). */
function opRow(o: NodeOp): string {
  return `    ${pad(o.id, 16)} ${pad(o.exit ?? '', 6)} ${pad(o.durationMs != null ? secs(o.durationMs) : '', 8)} ${opVerdict(o)}`;
}

/** One per-node row: outcome · model-calls · tool-calls · tokens · cost · ctx% · loop/trunc flags. */
function nodeRow(n: NodeDigest): string {
  const flags = [
    n.truncated ? '✂trunc' : '',
    n.maxToolRepeat >= 3 ? `↻${n.maxToolRepeat}` : '',
    n.retries ? `↺${n.retries}` : '',
  ].filter(Boolean).join(' ');
  return `  ${OUTCOME_ICON[n.outcome] ?? '?'} ${pad(n.id, 16)} ${pad(n.outcome, 9)} ` +
    `${pad(`${n.modelCalls}c/${n.toolCalls}t`, 9)} ${pad(`${k(n.inputTokens)}→${k(n.outputTokens)}`, 12)} ` +
    `${pad(usd(n.cost), 7)} ${pad(pct(n.contextPct), 5)} ${flags}`;
}

/** Render the full RunDigest (record mode). `nodeId` scopes to one node's detail. Pure over the digest. */
export function renderDigest(d: RunDigest, nodeId?: string): string {
  if (nodeId) {
    const n = d.nodes.find((x) => x.id === nodeId);
    if (!n) return `telemetry: no node "${nodeId}" in run "${d.run}" (have: ${d.nodes.map((x) => x.id).join(', ')})`;
    const lines = [
      `node "${n.id}" (${n.label})  ${OUTCOME_ICON[n.outcome] ?? '?'} ${n.outcome}  ·  ${n.model ?? '?'}@${n.provider ?? '?'}`,
      `  tokens:   ${k(n.inputTokens)} in / ${k(n.outputTokens)} out · ${usd(n.cost)} · ctx ${k(n.contextPeak)}${n.contextWindow ? `/${k(n.contextWindow)} (${pct(n.contextPct)})` : ''}`,
      `  calls:    ${n.modelCalls} model · ${n.toolCalls} tool${n.maxToolRepeat >= 3 ? ` · ↻ ${n.repeatedTool}×${n.maxToolRepeat}` : ''}${n.retries ? ` · ↺ ${n.retries} retries` : ''}`,
      `  timing:   ${n.durationMs ?? '?'}ms${n.expectedMs && n.slowRatio ? ` (mean ${n.expectedMs}ms, ${n.slowRatio.toFixed(1)}×)` : ''}`,
    ];
    if (n.stopReason) lines.push(`  stop:     ${n.stopReason}${n.truncated ? ' (TRUNCATED)' : ''}`);
    if (n.missing.length) lines.push(`  missing:  ${n.missing.join(', ')}`);
    if (n.issues.length) lines.push(`  issues:   ${n.issues.join('; ')}`);
    if (n.anomalies.length) lines.push(`  anomalies: ${n.anomalies.join(', ')}`);
    // (turn-dissection) the reasoning-effort summary + the per-turn timeline — "why was this node slow"
    // in one read, no manual events.jsonl archaeology.
    if (n.totalThinkChars) {
      const lt = n.largestTurn;
      lines.push(`  think:    ${k(n.totalThinkChars)} chars total${lt ? ` · largest turn #${lt.turnIndex} (${k(lt.thinkChars)} chars/${secs(lt.durMs)})` : ''}`);
    }
    if (n.turns?.length) {
      lines.push(`  turns (${n.turns.length}):`);
      lines.push(`    turn t+s      dur      think   tools`);
      lines.push(...n.turns.map(turnRow));
    }
    // (op-integrity WS-I3) The per-node ops table — every DISPATCHED run op (id · exit · duration · integrity
    // verdict), from the recorded envelope. Distinct from `issues`/`opFailures` above: this shows what RAN,
    // pass or fail, so a clean op is visible too — not just the ones that broke.
    if (n.ops?.length) {
      lines.push(`  ops (${n.ops.length}):`);
      lines.push(`    id               exit   dur      verdict`);
      lines.push(...n.ops.map(opRow));
    }
    return lines.join('\n');
  }
  const t = d.totals;
  const head = [
    `telemetry "${d.run}"  ${d.done ? (d.ok === false ? '✗ FAILED' : '✓ DONE') : '▶ running'}` +
      `  ·  ${t.nodes} nodes · ${t.ok} ok · ${t.failed} failed`,
    `  totals: ${k(t.inputTokens)} in / ${k(t.outputTokens)} out · ${usd(t.cost)} · ${t.modelCalls} model calls · ${t.toolCalls} tool calls · ctx peak ${k(t.contextPeak)}`,
  ];
  const anomalyBlock = d.anomalies.length
    ? [`  anomalies (${d.anomalies.length}) — the worklist:`, ...d.anomalies.map(anomalyLine)]
    : ['  anomalies: none'];
  const rootBlock = d.rootCauses.length
    ? ['  root cause (failure onset):', ...d.rootCauses.map((r) =>
        `    ${r.failed}${r.earliestUpstream === r.failed ? ' (originates here)' : ` ← ${r.earliestUpstream}${r.viaPath ? ` via ${r.viaPath}` : ''}  chain: ${r.chain.join(' → ')}`}`)]
    : [];
  const table = ['  nodes:', ...d.nodes.map(nodeRow)];
  return [...head, ...anomalyBlock, ...rootBlock, ...table].join('\n');
}

/** Render one live TelemetryEvent (watch mode), docker-stream style. */
export function renderEvent(e: TelemetryEvent): string {
  switch (e.kind) {
    case 'run-start':
      return `▶ run "${e.run}"`;
    case 'node-open':
      return `  ▸ ${pad(e.nodeId, 16)} open${e.model ? `  ${e.model}` : ''}`;
    case 'call':
      return `      · ${e.op} ${e.ok ? 'ok' : 'ERR'}${e.name && e.name !== e.op ? ` ${e.name}` : ''}`;
    case 'anomaly':
      return `  ${ANOM_ICON[e.anomaly.kind] ?? '!'} ${pad(e.anomaly.kind, 17)} ${pad(e.anomaly.nodeId, 16)} ${e.anomaly.detail}`;
    case 'node-close':
      return `  ■ ${pad(e.digest.id, 16)} ${pad(e.digest.outcome, 9)} ${k(e.digest.inputTokens)}→${k(e.digest.outputTokens)} ${usd(e.digest.cost)}${e.digest.anomalies.length ? `  [${e.digest.anomalies.join(',')}]` : ''}`;
    case 'run-end':
      return `■ run-end  ${e.ok === false ? 'FAILED' : 'ok'}`;
  }
}

// ── the bin body ──────────────────────────────────────────────────────────────────────────────────────
export async function runTelemetryCli(argv: string[]): Promise<void> {
  const a = parseTelemetryArgs(argv);

  // RECORD: build the authoritative digest once from the on-disk run-view.
  const record = (): RunDigest | null => {
    try {
      const { view } = buildRunView(a.dir);
      return projectRunDigest(view);
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      process.exitCode = 1;
      return null;
    }
  };

  if (!a.watch) {
    const d = record();
    if (!d) return;
    process.stdout.write((a.json ? JSON.stringify(a.nodeId ? d.nodes.find((n) => n.id === a.nodeId) ?? null : d, null, 2) : renderDigest(d, a.nodeId)) + '\n');
    return;
  }

  // STREAM: live deltas until the run is done (or Ctrl-C), then the authoritative record.
  const ac = new AbortController();
  const onSig = () => ac.abort();
  process.on('SIGINT', onSig);
  try {
    for await (const ev of telemetryStream(watchRun(a.dir, { signal: ac.signal }), { verbosity: a.verbosity })) {
      process.stdout.write(renderEvent(ev) + '\n');
    }
  } finally {
    process.off('SIGINT', onSig);
  }
  const d = record();
  if (d) process.stdout.write('\n' + (a.json ? JSON.stringify(a.nodeId ? d.nodes.find((n) => n.id === a.nodeId) ?? null : d, null, 2) : renderDigest(d, a.nodeId)) + '\n');
}
