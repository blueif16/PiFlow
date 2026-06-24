// Test for the BROWSER live-telemetry folder (gui/src/data/liveTelemetry.mjs).
//
// This is the Layer-3 proof: it simulates the SSE the GUI receives for a RUNNING run — each recorded
// events.jsonl line replayed as a `node-event` frame's `.event` — folds it through LiveTelemetry, and
// asserts the synthesized RunViewNode (what the HUD renders as `data.rv`) carries the SAME token totals
// the original engine recorded in run-status.json. ORACLE is independent of this code, so it can't be a
// copy-the-output tautology; if the live fold drops tokens or the mapper omits a field → RED.
//
// Run: node gui/src/data/liveTelemetry.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LiveTelemetry } from './liveTelemetry.mjs';

const SRC = '/Users/tk/Desktop/game-omni/out/e2e-m3';
const NODE = 'w2-scaffold';
const oracle = JSON.parse(fs.readFileSync(`${SRC}/run-status.json`, 'utf8')).nodes[NODE];

let passed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

// feed the recorded stream exactly as the SSE bridge would (one node-event frame per line)
const tele = new LiveTelemetry();
let frames = 0;
for (const line of fs.readFileSync(`${SRC}/_pi/${NODE}.events.jsonl`, 'utf8').trim().split('\n')) {
  if (line) { tele.pushEvent(NODE, JSON.parse(line)); frames += 1; }
}
const liveNode = { id: NODE, label: NODE, phase: 'W2', status: 'running', stageIndex: 5, lane: 0 };
const rv = tele.richByNode([liveNode])[NODE];

console.log(`live telemetry — fold ${frames} node-event frames vs run-status.json oracle`);

test('a running node\'s synthesized rv carries the engine token totals (live HUD shows real tokens)', () => {
  assert.equal(rv.tokens.billable, oracle.tokens.billable, `billable ${rv.tokens.billable} != ${oracle.tokens.billable}`); // 57322
  assert.equal(rv.tokens.input, oracle.tokens.input);       // 50723
  assert.equal(rv.tokens.output, oracle.tokens.output);     // 6599
  assert.equal(rv.tokens.contextPeak, oracle.tokens.contextPeak); // 54693
  assert.equal(typeof rv.tokens.cost, 'number');
});

test('toolCalls + model fold live too', () => {
  assert.equal(rv.toolCalls, oracle.toolCalls); // 35
  assert.equal(rv.model, 'MiniMax-M3');
});

test('rv is HUD-complete — every array NodeHud indexes is present (no live-node crash)', () => {
  for (const k of ['toolBreakdown', 'scopes', 'reads', 'writes', 'artifacts', 'bash', 'timeline', 'issues']) {
    assert.ok(rv[k] !== undefined, `${k} must be present so NodeHud can't read undefined`);
  }
  assert.ok(rv.reads.every((r) => r.displayPath && r.scope), 'each read carries a displayPath + scope bucket');
});

test('billableTotal sums folded nodes (the run-level live counter)', () => {
  assert.equal(tele.billableTotal(), oracle.tokens.billable); // one node folded → equals its billable
});

if (process.exitCode) console.error(`\n${passed} passed, some FAILED`);
else console.log(`\nall ${passed} passed`);
