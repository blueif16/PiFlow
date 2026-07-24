// `piflowctl trace <run> [node] [--json]` — the "element tree" renderer: EXACTLY what reached the model
// for a node run, in order — the force-injected prompt (`op:'inject'`) plus every agent `read`/`grep`,
// each with range · COVERAGE · sha(short) · order — plus the roll-up `composition` block (injectedBytes,
// advertised, the `advertisedUnread` BLIND-SPOT, partialReads). See docs/design/context-composition-telemetry.md.
//
// NOTE ON THE NAME: the design doc's working title was `piflowctl context <run> [node]`, but `context`
// is ALREADY the control-plane endpoint switch (packages/cli/src/context.ts — `context use/ls/add/rm/
// host/worker/migrate`). Reusing that verb would overload one name across two unrelated concerns (local⇄
// cloud plane selection vs. per-run context-composition introspection), so this ships as a new verb,
// `trace`, instead — same CLI shape the design specifies, no collision.
//
// THIN renderer only: it resolves the run dir (`resolveNodeRunDir`, the same helper `node.ts` uses),
// calls `buildRunView` — the ONE data path — and renders `node.context`/`node.composition` verbatim. No
// data logic lives here; the reducer is `@piflow/core/observe/contextComposition.ts`.

import { buildRunView, type ContextOp, type NodeComposition, type RunViewNode } from '@piflow/core';
import { resolveNodeRunDir } from './node.js';

export interface ParsedTraceArgs {
  run: string;
  nodeId?: string;
  json: boolean;
}

export function parseTraceArgs(argv: string[]): ParsedTraceArgs {
  const positionals: string[] = [];
  let json = false;
  for (const a of argv) {
    if (a === '--json') json = true;
    else if (!a.startsWith('-')) positionals.push(a);
  }
  return { run: positionals[0], nodeId: positionals[1], json };
}

const pad = (s: unknown, n: number): string => String(s ?? '').padEnd(n).slice(0, n);
const shortSha = (sha: string | null): string => (sha ? sha.replace(/^sha256:/, '').slice(0, 8) : '');
const isRead = (op: ContextOp): boolean => op.op === 'read' || op.op === 'grep';
/** range column: a read's line window — `off-off+limit` for a bounded read, `off-end` for an offset-only
 *  continuation (no limit), `whole` when unpaged; `whole` for the inject; `—` for edit/write/etc. */
const rangeStr = (op: ContextOp): string => {
  if (!isRead(op)) return op.op === 'inject' ? 'whole' : '—';
  if (!op.range) return 'whole';
  return op.range.limit != null ? `${op.range.offset}-${op.range.offset + op.range.limit}` : `${op.range.offset}-end`;
};
/** coverage column: a FAILED op shows `✗ <error>` (delivered nothing); coverage only applies to reads + inject. */
const covStr = (op: ContextOp): string => {
  if (op.ok === false) return `✗ ${op.errorType ?? 'failed'}`;
  if (!isRead(op) && op.op !== 'inject') return '—';
  return op.coverage == null ? `?(${op.covered})` : `${Math.round(op.coverage * 100)}%(${op.covered})`;
};
/** (op-integrity WS-I4) the readContract marker verdict, when a declared contract matched this read —
 *  `✓ <marker>` (present) / `✗ <marker> missing` — the in-turn staging backstop, rendered so it never
 *  hides behind coverage/sha (which only prove BYTES arrived, not that the REQUIRED content was among them). */
const contractStr = (op: ContextOp): string => (op.contract ? (op.contract.ok ? `✓ ${op.contract.marker}` : `✗ ${op.contract.marker} missing`) : '');

/** One `context` row: seq · op · displayPath · range · coverage(covered) · sha-short · via(toolCallId|inject)
 *  · the readContract marker verdict when declared (blank otherwise — byte-identical layout to today). */
function opRow(op: ContextOp): string {
  const via = op.toolCallId ?? 'inject';
  const base = `  ${pad(op.seq, 3)} ${pad(op.op, 6)} ${pad(op.displayPath, 40)} ${pad(rangeStr(op), 9)} ` +
    `${pad(covStr(op), 14)} ${pad(shortSha(op.sha256), 8)} ${via}`;
  return op.contract ? `${base}  ${contractStr(op)}` : base;
}

/** The `composition` roll-up block — injectedBytes, advertised, the `advertisedUnread` BLIND-SPOT, partialReads. */
function compositionBlock(c: NodeComposition): string[] {
  const lines = [
    `  composition: injectedBytes=${c.injectedBytes} readFiles=${c.readFiles}`,
    `    advertised (${c.advertised.length}): ${c.advertised.join(', ') || '(none)'}`,
    `    advertisedUnread (${c.advertisedUnread.length}) — BLIND SPOT: ${c.advertisedUnread.join(', ') || '(none)'}`,
    `    partialReads (${c.partialReads.length}): ${c.partialReads.join(', ') || '(none)'}`,
  ];
  return lines;
}

/** Render one node's `context`/`composition`.
 *
 *  HONESTY GATE (transcript port): when the node's executor adapter declares it CANNOT enumerate ops, this
 *  prints `SKIP: <reason>` and NOTHING ELSE. Rendering the composition block for a blind source would emit
 *  `readFiles=0` and list every advertised file as a BLIND SPOT — numbers that read like findings but only
 *  mean "this executor's record was not read". That false report is the defect this verb had for every
 *  claude-code node, and the gate is what makes it structurally impossible for the next executor too. */
function renderNode(n: RunViewNode): string {
  const head = `node "${n.id}" (${n.label})`;
  const tr = n.transcript;
  if (tr && !tr.capabilities.ops) {
    return `${head}\n  SKIP: ${tr.limitations.ops ?? 'this executor record could not be read'}`;
  }
  if (!n.context?.length && !n.composition) return `${head} — no context recorded`;
  const provenance = tr ? [`  source: ${tr.executorId} · ${tr.origin.kind}${tr.origin.path ? ` (${tr.origin.path})` : ''}`] : [];
  const rows = (n.context ?? []).map(opRow);
  const comp = n.composition ? compositionBlock(n.composition) : [];
  return [head, ...provenance, ...rows, ...comp].join('\n');
}

/** Render every node that carries `context`/`composition` (a run may have nodes with none — skip silently
 *  only when NEITHER is present, matching `renderNode`'s own per-node fallback line for the rest). */
export function renderTrace(view: { nodes: RunViewNode[] }, nodeId?: string): string {
  if (nodeId) {
    const n = view.nodes.find((x) => x.id === nodeId);
    if (!n) return `trace: no node "${nodeId}" (have: ${view.nodes.map((x) => x.id).join(', ')})`;
    return renderNode(n);
  }
  return view.nodes.map(renderNode).join('\n\n');
}

export async function runTraceCli(argv: string[]): Promise<void> {
  const { run, nodeId, json } = parseTraceArgs(argv);
  if (!run) {
    process.stderr.write('usage: piflowctl trace <run> [node] [--json]\n');
    process.exitCode = 1;
    return;
  }
  let runDir: string;
  try {
    runDir = resolveNodeRunDir({ run });
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exitCode = 1;
    return;
  }
  const { view } = buildRunView(runDir);

  if (json) {
    if (nodeId) {
      const n = view.nodes.find((x) => x.id === nodeId);
      if (!n) {
        process.stderr.write(`trace: no node "${nodeId}" (have: ${view.nodes.map((x) => x.id).join(', ')})\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(JSON.stringify({ context: n.context ?? [], composition: n.composition ?? null }, null, 2) + '\n');
      return;
    }
    const out = Object.fromEntries(
      view.nodes.map((n) => [n.id, { context: n.context ?? [], composition: n.composition ?? null }]),
    );
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }

  process.stdout.write(renderTrace(view, nodeId) + '\n');
}
