#!/usr/bin/env node
// ── pi-runner/status.mjs ─────────────────────────────────────────────────────
// One-shot (or live) snapshot of a pi-runner run: the per-node table + current
// stage + a token/cost rollup, read from out/<run>/run-status.json. This is the
// "where is it right now?" dashboard — the clean version of an ad-hoc `node -e`
// dump. Pairs with watch.mjs (which only fires on the exit event).
//
// Usage:
//   node pi-runner/status.mjs --run <id> [--out out] [--status <path>] [--every 5]
//
//   --every <s>   refresh in place every <s>s (live dashboard); omit for one-shot.
//
// Stall taxonomy: a running node silent <120s is flagged "pause" (the transient
// cp stream stall self-recovers); ≥120s as "STALL?" — but the real guard is
// run.mjs --node-timeout, and watch.mjs only declares a DEAD stall past 10 min.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'fs';
import path from 'path';

function parseArgs(argv) {
  const a = { out: 'out' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === '--run' || k === '--id' || k === '--lesson') a.run = next();
    else if (k === '--out') a.out = next();
    else if (k === '--status') a.status = next();
    else if (k === '--every') a.every = Number(next());
    else throw new Error(`unknown arg: ${k}`);
  }
  if (!a.run && !a.status) throw new Error('status.mjs needs --run <id> (or --status <path>)');
  return a;
}

const args = parseArgs(process.argv.slice(2));
const ROOT = process.cwd();
const statusPath = path.resolve(args.status || path.join(ROOT, args.out, args.run, 'run-status.json'));

const sec = (ms) => (ms == null ? '' : `${Math.round(ms / 1000)}s`);
const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
const icon = (st) => ({ ok: '✓', running: '▶', error: '✗', pending: '·' }[st] || '?');

function render() {
  let s;
  try { s = JSON.parse(fs.readFileSync(statusPath, 'utf8')); }
  catch { return `no readable run-status at ${path.relative(ROOT, statusPath)} (run not started yet?)`; }

  const stale = Math.round((Date.now() - new Date(s.updatedAt).getTime()) / 1000);
  let totCost = 0, totTok = 0, totTools = 0;
  const rows = [];
  for (const [k, n] of Object.entries(s.nodes || {})) {
    const cost = n.tokens?.cost || 0, tok = n.tokens?.billable || 0;
    totCost += cost; totTok += tok; totTools += n.toolCalls || n.live?.toolCalls || 0;
    let dur = '', live = '';
    if (n.status === 'running' && n.live) {
      dur = sec(n.live.elapsedMs);
      const q = Math.round((n.live.sinceEventMs || 0) / 1000);
      live = n.live.stalled ? `Δ${q}s ${q >= 120 ? 'STALL?' : 'pause'}` : `Δ${q}s ${n.live.currentTool || ''}`.trim();
    } else if (n.durationMs != null) dur = sec(n.durationMs);
    // Per-node timeline x-ray (additive — only when run.mjs recorded n.timeline): the single
    // slowest tool call + turn count, so the dashboard shows WHERE a node's wall-clock went.
    let tl = '';
    if (n.timeline && Array.isArray(n.timeline.tools) && n.timeline.tools.length) {
      const top = n.timeline.tools.reduce((a, b) => ((b.durMs || 0) > (a.durMs || 0) ? b : a));
      tl = `· ${n.timeline.tools.length}tools/${(n.timeline.turns || []).length}turns top:${top.name}${sec(top.durMs)}`;
    }
    rows.push(`  ${icon(n.status)} ${pad(k, 20)} ${pad(n.status, 8)} ${pad(dur, 7)} ${pad(cost ? '$' + cost.toFixed(4) : '', 9)} ${pad(tok ? (tok / 1000).toFixed(1) + 'k' : '', 7)} ${live}${tl ? '  ' + tl : ''}`);
  }
  const st = s.stage || {};
  const head = [
    `run "${s.run}"  ${s.done ? (s.ok === false ? '❌ FAILED' : '✅ DONE') : '▶ running'}  ·  ${s.source || ''}  ·  provider=${s.provider || ''}`,
    `stage ${st.index}/${st.total} ${st.phase || ''}  ·  run-elapsed ${sec(s.elapsedMs)}  ·  status written ${stale}s ago${stale > 90 && !s.done ? '  ⚠ DRIVER MAY BE GONE' : ''}`,
    `  ${pad('', 2)}${pad('node', 20)} ${pad('status', 8)} ${pad('dur', 7)} ${pad('cost', 9)} ${pad('tok', 7)} live`,
  ];
  const foot = `  └ totals: ${rows.length} nodes · ${totTools} tool-calls · ${(totTok / 1000).toFixed(1)}k tok · $${totCost.toFixed(4)}`;
  return [...head, ...rows, foot].join('\n');
}

if (args.every) {
  // live dashboard: clear + redraw
  // eslint-disable-next-line no-constant-condition
  while (true) {
    process.stdout.write('\x1b[2J\x1b[H');
    console.log(render());
    const s = (() => { try { return JSON.parse(fs.readFileSync(statusPath, 'utf8')); } catch { return null; } })();
    if (s?.done) break;
    await new Promise((r) => setTimeout(r, args.every * 1000));
  }
} else {
  console.log(render());
}
