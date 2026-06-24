// build-run-view.mjs — THE adapter. Reads the new `.pi/` tree (run.json + per-node events.jsonl +
// io.json) and emits ONE compact run-view.json — the single contract the GUI HUD renders. Because the
// HUD can only show fields this fills from real bytes, "no mock data" is enforced structurally: a
// region with no backing data simply has nothing to render.
//
// Mirrors @piflow/core/observe (RunModel/NodeView/EdgeView) but ENRICHED with the per-node telemetry
// the HUD's regions need (model, toolBreakdown, per-tool timeline, scope-bucketed reads, writes,
// tokens) — all re-derived from the event stream via the same reducer the live runner uses.
//
// Run: node gui/scripts/build-run-view.mjs [run]   (default run: e2e-m3)

import { promises as fs } from 'node:fs';
import fssync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeAccumulator } from './distill.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUI = path.resolve(HERE, '..', '..');
const RUNS = path.join(GUI, 'public', 'runs');

// Strip an absolute path down to a repo-relative display path (everything after `/game-omni/`).
function displayPath(abs) {
  if (typeof abs !== 'string') return String(abs);
  const i = abs.indexOf('/game-omni/');
  if (i >= 0) return abs.slice(i + '/game-omni/'.length);
  if (!abs.startsWith('/')) return abs; // already relative (e.g. status-record artifacts) — keep verbatim
  return abs.replace(/^.*\//, ''); // some other absolute path — fall back to basename
}

// The "different kind of scope" the user wants the LEFT region to show differently. Derived from where
// the file lives — the run's own workspace vs a loaded skill vs shared templates vs repo source.
function scopeKind(dp) {
  if (dp.startsWith('out/')) return 'run';
  if (dp.startsWith('packages/skills/')) return 'skill';
  if (dp.startsWith('templates/')) return 'template';
  if (dp.startsWith('packages/')) return 'package';
  return 'repo';
}
const SCOPE_LABEL = { run: 'Run workspace', skill: 'Skill', template: 'Templates', package: 'Packages', repo: 'Repo source' };
const SCOPE_ORDER = ['run', 'skill', 'template', 'package', 'repo'];

// Replay a node's recorded events.jsonl through the reducer, COUNTING every line and every torn line.
// `lines` (non-empty lines read) vs `acc.coverage.eventsSeen` (lines the reducer folded) vs `parseErrors`
// is the data-load ledger: lines == eventsSeen + parseErrors must hold, or events were silently lost.
function replayEvents(runDir, id) {
  const f = path.join(runDir, '.pi', 'nodes', id, 'events.jsonl');
  const acc = createNodeAccumulator();
  let lines = 0, parseErrors = 0, exists = false, bytes = 0;
  if (fssync.existsSync(f)) {
    exists = true;
    bytes = fssync.statSync(f).size;
    for (const line of fssync.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      lines += 1;
      try { acc.push(JSON.parse(line)); } catch { parseErrors += 1; }
    }
  }
  return { acc, lines, parseErrors, exists, bytes };
}

// Cross-run history: expectedMs[id] = mean durationMs across EVERY run that ran node `id`. This is the
// "average of previous runs" the live progress bar estimates against. With one run, expected == actual;
// the machinery is identical once a second run lands. `priorSamples` lets the HUD show its confidence.
function buildHistory() {
  const runs = fssync.existsSync(RUNS)
    ? fssync.readdirSync(RUNS).filter((r) => fssync.existsSync(path.join(RUNS, r, '.pi', 'run.json')))
    : [];
  const dur = {};
  for (const r of runs) {
    const rj = JSON.parse(fssync.readFileSync(path.join(RUNS, r, '.pi', 'run.json'), 'utf8'));
    for (const [id, rec] of Object.entries(rj.nodes || {})) {
      if (typeof rec.durationMs === 'number') (dur[id] = dur[id] || []).push(rec.durationMs);
    }
  }
  const expected = {}, samples = {};
  for (const [id, arr] of Object.entries(dur)) {
    expected[id] = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
    samples[id] = arr.length;
  }
  return { expected, samples };
}

async function buildRun(run) {
  const runDir = path.join(RUNS, run);
  const rj = JSON.parse(await fs.readFile(path.join(runDir, '.pi', 'run.json'), 'utf8'));
  const { expected, samples } = buildHistory();

  const nodes = [];
  const audit = []; // per-node data-load ledger (events read vs folded vs dropped) — surfaced below
  for (const [id, rec] of Object.entries(rj.nodes)) {
    const replay = replayEvents(runDir, id);
    const { rich } = replay.acc.finalize(rec);
    const cov = rich.coverage;
    audit.push({
      id, status: rec.status, exists: replay.exists, bytes: replay.bytes,
      lines: replay.lines, seen: cov.eventsSeen, dropped: replay.parseErrors,
      usageEvents: cov.usageEvents, billable: rich.tokens.billable,
    });

    // phase comes from the io.json ledger (the SDK's own source for it), falling back to the record
    let phase = rec.phase ?? null;
    const ioFile = path.join(runDir, '.pi', 'nodes', id, 'io.json');
    if (fssync.existsSync(ioFile)) { try { phase = JSON.parse(fssync.readFileSync(ioFile, 'utf8')).phase ?? phase; } catch { /* keep fallback */ } }

    const reads = rich.reads.map((r) => {
      const dp = displayPath(r.path);
      return { path: r.path, displayPath: dp, via: r.via, scope: scopeKind(dp), preview: r.preview };
    });
    // group reads into scope containers for the LEFT region
    const buckets = {};
    for (const r of reads) (buckets[r.scope] = buckets[r.scope] || []).push(r.displayPath);
    const scopes = SCOPE_ORDER.filter((k) => buckets[k]).map((kind) => ({
      kind, label: SCOPE_LABEL[kind] || kind, count: buckets[kind].length, paths: buckets[kind],
    }));

    const writes = rich.writes.map((w) => ({ path: w.path, displayPath: displayPath(w.path), verified: w.verified, bytes: w.bytes }));
    const artifacts = (rec.artifacts || []).map((a) => ({ path: a.path, displayPath: displayPath(a.path), exists: a.exists, bytes: a.bytes }));

    nodes.push({
      id, label: rec.label || id, phase, status: rec.status,
      startedAt: rec.startedAt, endedAt: rec.endedAt, durationMs: rec.durationMs,
      expectedMs: expected[id] ?? rec.durationMs ?? null, priorSamples: samples[id] ?? 0,
      model: rich.model, provider: rich.provider, api: rich.api,
      toolCalls: rich.toolCalls, toolBreakdown: rich.toolBreakdown, timeline: rich.timeline,
      reads, scopes, writes, artifacts, bash: rich.bash, tokens: rich.tokens,
      summary: rec.summary, issues: rec.issues || [],
    });
  }

  // stages: group nodes by phase in execution order (a shared phase with >1 node is a parallel lane)
  const ordered = [...nodes].sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')));
  const phaseOrder = [];
  for (const n of ordered) { const ph = n.phase || '—'; if (!phaseOrder.includes(ph)) phaseOrder.push(ph); }
  const stages = phaseOrder.map((ph, i) => {
    const ids = ordered.filter((n) => (n.phase || '—') === ph).map((n) => n.id);
    return { index: i + 1, phase: ph, parallel: ids.length > 1, nodeIds: ids };
  });
  for (const st of stages) st.nodeIds.forEach((id, lane) => { const n = nodes.find((x) => x.id === id); n.stageIndex = st.index; n.lane = lane; });

  // data-flow edges: a producer's write path read back by a consumer (the engine's only hard guarantee)
  const seen = new Set();
  const edges = [];
  for (const from of nodes) {
    const w = new Set(from.writes.map((x) => x.displayPath));
    for (const to of nodes) {
      if (from.id === to.id) continue;
      for (const r of to.reads) {
        const key = `${from.id}|${to.id}|${r.displayPath}`;
        if (w.has(r.displayPath) && !seen.has(key)) { seen.add(key); edges.push({ from: from.id, to: to.id, path: r.displayPath }); }
      }
    }
  }

  // roll the per-node token sums into a run-level total (the GUI's run header can show it).
  const tokenTotal = nodes.reduce((acc, n) => {
    const t = n.tokens || {};
    acc.input += t.input || 0; acc.output += t.output || 0; acc.cacheRead += t.cacheRead || 0;
    acc.cacheWrite += t.cacheWrite || 0; acc.cost += t.cost || 0; acc.billable += t.billable || 0;
    acc.contextPeak = Math.max(acc.contextPeak, t.contextPeak || 0);
    return acc;
  }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, billable: 0, contextPeak: 0 });

  const view = {
    run: rj.run, source: rj.source, provider: rj.provider, model: rj.model,
    startedAt: rj.startedAt, updatedAt: rj.updatedAt, durationMs: rj.durationMs,
    done: rj.done, ok: rj.ok, totals: rj.totals, tokenTotal,
    stages, edges, nodes,
    generatedFrom: 'transcoded real run (e2e-m3) — gui/scripts/transcode-run.mjs',
  };
  const outFile = path.join(runDir, 'run-view.json');
  await fs.writeFile(outFile, JSON.stringify(view, null, 2));
  return { outFile, view, audit };
}

const run = process.argv[2] || 'e2e-m3';
buildRun(run).then(({ outFile, view, audit }) => {
  console.log(`run-view → ${path.relative(GUI, outFile)}`);
  console.log(`  ${view.nodes.length} nodes · ${view.stages.length} stages · ${view.edges.length} edges · provider=${view.provider} · billable=${view.tokenTotal.billable}`);
  for (const n of view.nodes) {
    const t = n.tokens || {};
    console.log(`  ${n.id.padEnd(20)} ${String(n.status).padEnd(7)} s${n.stageIndex} model=${(n.model || '-').padEnd(11)} tools=${String(n.toolCalls).padStart(2)} reads=${String(n.reads.length).padStart(2)} bill=${String(t.billable ?? 0).padStart(7)} peak=${String(t.contextPeak ?? 0).padStart(6)} dur=${n.durationMs}`);
  }

  // ── DATA-LOAD AUDIT — the robust "we didn't lose anything" ledger ──────────────────────────────
  // For every node: lines read from events.jsonl, lines the reducer folded (seen), dropped (torn JSON),
  // and how many carried token usage. The invariant lines == seen + dropped must hold; a node that ran
  // (has events) but folded zero usage is flagged — that is exactly the token-loss symptom regressing.
  console.log('\n  data-load audit (events read → folded → tokens):');
  const warnings = [];
  for (const a of audit) {
    const lost = a.lines !== a.seen + a.dropped;
    const ranButNoTokens = a.lines > 0 && a.usageEvents === 0;
    const emptyButRan = !a.exists && a.status !== 'reused' && a.status !== 'pending' && a.status !== 'dry';
    const flag = lost || a.dropped > 0 || ranButNoTokens || emptyButRan ? ' ⚠' : '';
    console.log(`    ${a.id.padEnd(20)} ${String(a.status).padEnd(7)} lines=${String(a.lines).padStart(4)} seen=${String(a.seen).padStart(4)} dropped=${String(a.dropped).padStart(3)} usageEv=${String(a.usageEvents).padStart(3)} bill=${String(a.billable).padStart(7)}${flag}`);
    if (lost) warnings.push(`${a.id}: ${a.lines - a.seen - a.dropped} events neither folded nor counted as dropped (silent loss)`);
    if (a.dropped > 0) warnings.push(`${a.id}: ${a.dropped} torn/unparseable line(s) in events.jsonl`);
    if (ranButNoTokens) warnings.push(`${a.id}: ${a.lines} events but ZERO usage folded — token capture may be broken for this provider/shape`);
    if (emptyButRan) warnings.push(`${a.id}: status=${a.status} but no events.jsonl — the firehose never reached the canonical path`);
  }
  if (warnings.length) {
    console.error(`\n  ⚠ ${warnings.length} data-load warning(s):`);
    for (const w of warnings) console.error(`    - ${w}`);
    process.exitCode = 2; // non-zero so a CI/transcode step fails loudly on data loss
  } else {
    console.log('  ✓ no data loss: every event accounted for, every node that ran folded usage.');
  }
}).catch((e) => { console.error(e); process.exit(1); });
