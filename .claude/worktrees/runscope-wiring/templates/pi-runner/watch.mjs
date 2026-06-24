#!/usr/bin/env node
// ── pi-runner/watch.mjs ──────────────────────────────────────────────────────
// Wake-on-event watcher for a pi-runner run. Polls out/<run>/run-status.json and
// EXITS (printing ONE summary line) the moment something worth surfacing happens:
//   • run finished        (done:true)            → DONE ✅
//   • a node errored       (node.status:error)    → ERROR ❌
//   • the driver died/hung (run-status went stale) → DRIVER GONE ⚠
//   • a node DEAD-stalled  (silent past a REAL threshold, not the noisy 45s warn) → DEAD STALL ⚠
//
// Why it exists: run.mjs --debug already prints 4s heartbeats for a HUMAN. This is
// for an AGENT/console that launched the run in the background and wants to be
// pinged ONLY on the one event that needs a decision — so it stays silent (no
// context spam) until then, then re-wakes its caller by exiting.
//
// Portable by design: NO hard-coded paths and NO PID. "Driver dead" is inferred
// from run-status staleness (the driver rewrites updatedAt every ≤10s while alive),
// so this works out-of-the-box for ANY project that runs run.mjs.
//
// Stall taxonomy (baked-in lesson): the `cp` coding-plan provider can go fully
// silent mid-node for ~60–90s — a transient stream pause that self-recovers. The
// 45s `⚠ STALLED` flag in run.mjs is only a WARNING; do NOT kill on it. This
// watcher only fires DEAD STALL after --dead-stall seconds (default 600 = 10 min),
// well past any transient pause; the real hard guard remains run.mjs --node-timeout.
//
// Usage:
//   node pi-runner/watch.mjs --run <id>
//        [--out out] [--status <path>] [--poll 20]
//        [--dead-stall 600] [--driver-stale 90] [--max 5400]
//        [--notify] [--verbose]
//
//   --notify    fire a desktop notification on exit (macOS osascript / Linux notify-send)
//   --verbose   print a status line every poll (default: silent until the exit event)
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

function parseArgs(argv) {
  const a = { out: 'out', poll: 20, deadStall: 600, driverStale: 90, max: 5400, notify: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === '--run' || k === '--id' || k === '--lesson') a.run = next();
    else if (k === '--out') a.out = next();
    else if (k === '--status') a.status = next();
    else if (k === '--poll') a.poll = Number(next());
    else if (k === '--dead-stall') a.deadStall = Number(next());
    else if (k === '--driver-stale') a.driverStale = Number(next());
    else if (k === '--max') a.max = Number(next());
    else if (k === '--notify') a.notify = true;
    else if (k === '--verbose') a.verbose = true;
    else throw new Error(`unknown arg: ${k}`);
  }
  if (!a.run && !a.status) throw new Error('watch.mjs needs --run <id> (or --status <path>)');
  return a;
}

const args = parseArgs(process.argv.slice(2));
const ROOT = process.cwd();
const statusPath = path.resolve(args.status || path.join(ROOT, args.out, args.run, 'run-status.json'));
const t0 = Date.now();
const el = () => Math.round((Date.now() - t0) / 1000);
const read = () => { try { return JSON.parse(fs.readFileSync(statusPath, 'utf8')); } catch { return null; } };
const dollars = (n) => (typeof n === 'number' ? `$${n.toFixed(4)}` : '$0');

function costOf(s) {
  let cost = 0, tok = 0;
  for (const n of Object.values(s.nodes || {})) { if (n.tokens) { cost += n.tokens.cost || 0; tok += n.tokens.billable || 0; } }
  return { cost, tok };
}
function summary(s) {
  return Object.entries(s.nodes || {}).filter(([, n]) => n.status !== 'pending')
    .map(([k, n]) => `${k}:${n.status}${n.durationMs ? `(${Math.round(n.durationMs / 1000)}s)` : ''}`).join('  ');
}
function notify(title, msg) {
  if (!args.notify) return;
  try {
    if (process.platform === 'darwin') {
      spawn('osascript', ['-e', `display notification ${JSON.stringify(msg)} with title ${JSON.stringify(title)}`], { stdio: 'ignore', detached: true }).unref();
    } else if (process.platform === 'linux') {
      spawn('notify-send', [title, msg], { stdio: 'ignore', detached: true }).unref();
    }
  } catch { /* best-effort */ }
}
function done(tag, line, s) {
  const c = s ? costOf(s) : null;
  const costStr = c ? `  ·  ${dollars(c.cost)} / ${(c.tok / 1000).toFixed(1)}k tok` : '';
  console.log(`[watch +${el()}s] ${tag} ${line}${costStr}`);
  if (s) console.log(`  ${summary(s)}`);
  notify(`pi ${args.run}`, `${tag} ${line}`);
  process.exit(0);
}

console.log(`[watch] ${args.run} → ${path.relative(ROOT, statusPath)}  (poll ${args.poll}s · dead-stall ${args.deadStall}s · driver-stale ${args.driverStale}s)`);

let firstUnreadableAt = null;
while (true) {
  await new Promise((r) => setTimeout(r, args.poll * 1000));
  const s = read();

  // status file missing/unparseable → only a problem if it STAYS that way (run may not have started)
  if (!s) {
    firstUnreadableAt ??= Date.now();
    if (Date.now() - firstUnreadableAt > args.driverStale * 1000) done('⚠ NO STATUS', `run-status unreadable for >${args.driverStale}s — driver never started or died`, null);
    continue;
  }
  firstUnreadableAt = null;

  if (s.done === true) done(s.ok === false ? '❌ FAILED' : '✅ DONE', `ok=${s.ok} durationMs=${s.durationMs}`, s);

  const errNode = Object.entries(s.nodes || {}).find(([, n]) => n.status === 'error');
  if (errNode) done('❌ ERROR', `node ${errNode[0]}: ${errNode[1].summary || '(no summary)'}`, s);

  // driver hung/crashed → run-status stops advancing
  const staleMs = Date.now() - new Date(s.updatedAt).getTime();
  if (staleMs > args.driverStale * 1000) done('⚠ DRIVER GONE', `run-status not updated in ${Math.round(staleMs / 1000)}s — stage ${s.stage?.index}/${s.stage?.total} ${s.stage?.phase}`, s);

  // a genuinely DEAD node stall (not the transient ~60–90s cp pause)
  const running = Object.entries(s.nodes || {}).find(([, n]) => n.status === 'running' && n.live);
  if (running && running[1].live.stalled && (running[1].live.sinceEventMs || 0) > args.deadStall * 1000) {
    done('⚠ DEAD STALL', `${running[0]} silent ${Math.round(running[1].live.sinceEventMs / 1000)}s (>${args.deadStall}s)`, s);
  }

  if (args.verbose) {
    const st = s.stage || {};
    const r = running ? `${running[0]} Δ${Math.round((running[1].live.sinceEventMs || 0) / 1000)}s${running[1].live.stalled ? ' ⚠' : ''}` : '-';
    console.log(`[watch +${el()}s] stage ${st.index}/${st.total} ${st.phase} · running ${r} · ${dollars(costOf(s).cost)}`);
  }
  if (Date.now() - t0 > args.max * 1000) done('⏲ WATCH TIMEOUT', `still healthy after ${args.max}s — stage ${s.stage?.index}/${s.stage?.total} ${s.stage?.phase}`, s);
}
