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
import { createNodeAccumulator } from './lib/distill.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUI = path.resolve(HERE, '..');
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

function replayEvents(runDir, id) {
  const f = path.join(runDir, '.pi', 'nodes', id, 'events.jsonl');
  const acc = createNodeAccumulator();
  if (fssync.existsSync(f)) {
    for (const line of fssync.readFileSync(f, 'utf8').split('\n')) {
      if (line.trim()) { try { acc.push(JSON.parse(line)); } catch { /* skip torn line */ } }
    }
  }
  return acc;
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
  for (const [id, rec] of Object.entries(rj.nodes)) {
    const { rich } = replayEvents(runDir, id).finalize(rec);

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

  const view = {
    run: rj.run, source: rj.source, provider: rj.provider, model: rj.model,
    startedAt: rj.startedAt, updatedAt: rj.updatedAt, durationMs: rj.durationMs,
    done: rj.done, ok: rj.ok, totals: rj.totals,
    stages, edges, nodes,
    generatedFrom: 'transcoded real run (e2e-m3) — gui/scripts/transcode-run.mjs',
  };
  const outFile = path.join(runDir, 'run-view.json');
  await fs.writeFile(outFile, JSON.stringify(view, null, 2));
  return { outFile, view };
}

const run = process.argv[2] || 'e2e-m3';
buildRun(run).then(({ outFile, view }) => {
  console.log(`run-view → ${path.relative(GUI, outFile)}`);
  console.log(`  ${view.nodes.length} nodes · ${view.stages.length} stages · ${view.edges.length} edges · provider=${view.provider}`);
  for (const n of view.nodes) {
    console.log(`  ${n.id.padEnd(20)} ${String(n.status).padEnd(7)} s${n.stageIndex} model=${(n.model || '-').padEnd(11)} tools=${String(n.toolCalls).padStart(2)} reads=${String(n.reads.length).padStart(2)} scopes=[${n.scopes.map((s) => s.kind).join(',')}] dur=${n.durationMs}`);
  }
}).catch((e) => { console.error(e); process.exit(1); });
