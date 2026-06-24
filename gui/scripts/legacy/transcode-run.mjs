// transcode-run.mjs — the "fake run": take a REAL completed run and re-house its REAL telemetry into
// the new @piflow/core `.pi/` layout (D7). No value is invented — model, tool calls, file reads,
// timestamps, artifacts all come straight from the source run. This gives the GUI ground-truth
// new-schema data to build against WITHOUT spawning a costly live `pi` run, and doubles as a fixture.
//
// Source : /Users/tk/Desktop/game-omni/out/e2e-m3  (old run-status.json + _pi/<id>.events.jsonl)
// Target : gui/public/runs/e2e-m3/.pi/{run.json, state.json, nodes/<id>/{events.jsonl, io.json, prompt.md}}
//
// The new run.json is deliberately LEAN (status/contract/artifacts only) — exactly as the real SDK
// writes it. The rich telemetry lives in events.jsonl, and io.json is produced by the SAME stream
// reducer the live runner would use (lib/distill.mjs). Run: node gui/scripts/transcode-run.mjs

import { promises as fs } from 'node:fs';
import fssync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeAccumulator } from './distill.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUI = path.resolve(HERE, '..', '..');
const SRC = '/Users/tk/Desktop/game-omni/out/e2e-m3';
const RUN = 'e2e-m3';
const OUT = path.join(GUI, 'public', 'runs', RUN);

// old run.mjs status ladder → new @piflow/core NodeStatus
const STATUS_MAP = { ok: 'ok', reused: 'reused', failed: 'error', error: 'error', blocked: 'blocked', gap: 'gap', dry: 'dry', running: 'running', pending: 'pending' };
const mapStatus = (s) => STATUS_MAP[s] || 'ok';

function replayNode(id) {
  const f = path.join(SRC, '_pi', `${id}.events.jsonl`);
  const acc = createNodeAccumulator();
  let raw = '';
  if (fssync.existsSync(f)) {
    raw = fssync.readFileSync(f, 'utf8');
    for (const line of raw.split('\n')) { if (line.trim()) { try { acc.push(JSON.parse(line)); } catch { /* skip torn line */ } } }
  }
  return { raw, acc };
}

async function main() {
  const oldStatus = JSON.parse(await fs.readFile(path.join(SRC, 'run-status.json'), 'utf8'));
  const ids = Object.keys(oldStatus.nodes);
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(path.join(OUT, '.pi', 'nodes'), { recursive: true });

  const newNodes = {};
  let ok = 0, failed = 0;
  for (const id of ids) {
    const old = oldStatus.nodes[id];
    const { raw, acc } = replayNode(id);
    const { io } = acc.finalize(old);
    const nodeDir = path.join(OUT, '.pi', 'nodes', id);
    await fs.mkdir(nodeDir, { recursive: true });

    // 1. events.jsonl — the raw stream, copied verbatim (the SOURCE both listeners consume)
    if (raw) await fs.writeFile(path.join(nodeDir, 'events.jsonl'), raw);
    // 2. io.json — produced by the stream reducer (NodeIo shape), the "io listens to the source" output
    await fs.writeFile(path.join(nodeDir, 'io.json'), JSON.stringify({
      id, label: old.label, phase: old.phase ?? null, status: mapStatus(old.status),
      reads: io.reads, writes: io.writes, promotes: io.promotes,
      startedAt: io.startedAt, endedAt: io.endedAt, durationMs: io.durationMs,
    }, null, 2));
    // 3. prompt.md — copy the realized prompt if the source kept it
    const promptSrc = path.join(SRC, '_pi', `${id}.prompt.md`);
    if (fssync.existsSync(promptSrc)) await fs.copyFile(promptSrc, path.join(nodeDir, 'prompt.md'));

    // 4. the LEAN run.json record (new RunStatus/NodeStatusRecord shape — no model/tools/tokens here)
    const status = mapStatus(old.status);
    if (status === 'ok' || status === 'reused') ok += 1; else if (status === 'error' || status === 'blocked') failed += 1;
    newNodes[id] = {
      id, label: old.label, status,
      startedAt: io.startedAt, endedAt: io.endedAt, durationMs: io.durationMs,
      artifacts: old.artifacts || [],
      issues: old.contractMissing && old.contractMissing.length ? old.contractMissing : (old.issues || []),
      summary: old.summary,
      exitCode: old.exitCode,
      returnMode: old.returnMode,
      checks: old.verdict && old.verdict.checks ? old.verdict.checks : undefined,
    };
  }

  const runJson = {
    run: RUN,
    source: oldStatus.source,
    provider: oldStatus.provider,
    model: oldStatus.model ?? null,
    startedAt: oldStatus.startedAt,
    updatedAt: oldStatus.updatedAt,
    done: oldStatus.done ?? true,
    ok: oldStatus.ok ?? null,
    durationMs: oldStatus.durationMs ?? null,
    stage: oldStatus.stage ?? null,
    totals: { nodes: ids.length, ok, failed },
    nodes: newNodes,
  };
  await fs.writeFile(path.join(OUT, '.pi', 'run.json'), JSON.stringify(runJson, null, 2));
  await fs.writeFile(path.join(OUT, '.pi', 'state.json'), '{}\n');

  console.log(`transcoded ${ids.length} nodes → ${path.relative(GUI, OUT)}/.pi/`);
  console.log(`  run.json: ${ids.length} nodes (${ok} ok/reused, ${failed} failed), provider=${runJson.provider}`);
  // io.json populated for nodes that had an event stream:
  const withIo = ids.filter((id) => fssync.existsSync(path.join(OUT, '.pi', 'nodes', id, 'io.json')));
  console.log(`  io.json: ${withIo.length}/${ids.length} populated (reads/writes derived from the stream)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
