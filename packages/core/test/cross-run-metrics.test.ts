// cross-run-metrics.test.ts — P6 of the AgentDriver registry (docs/design/agent-driver-registry.md §5/§6 P6).
//
// FAILING tests (written BEFORE the real bodies exist) for the two cross-run metrics the improve stage
// consumes. Both are ADDITIVE — no runtime execution path change, no new persistence file. Five behaviors:
//   1. COST-SPIKE fires: a synthetic cross-run history (prior runs on disk as historyDirs) where the LATEST
//      node run has a ~3× billable-token jump vs the prior mean produces a `cost-spike` anomaly; a FLAT
//      history produces NONE. End-to-end through buildRunView (folds history via buildHistory) → projectRunDigest.
//   2. COST-SPIKE is TOKENS-FIRST: a history where cost is 0 for ALL runs (Max subscription) but billable
//      tokens spike ~3× STILL fires cost-spike (the $ is 0, the tokens are the signal).
//   3. LOOPSCORE is DISTINCT from maxToolRepeat: an accumulator fed CONSECUTIVE tool calls whose
//      first-100-arg-chars are identical but whose FULL args differ (so maxToolRepeat, keyed on full args,
//      stays < 3) yields loopScore >= 3 — asserting BOTH on the same node, proving they are different signals.
//   4. LOOPSCORE per-executor: the pi accumulator (createNodeAccumulator) AND the Claude accumulator
//      (createClaudeAccumulator) each compute loopScore on their OWN event vocabulary.
//   5. A loop-score anomaly appears in detectAnomalies (via projectRunDigest) when loopScore >= the threshold.
//
// The oracles below are hand-derived from each fixture, NOT copied from any output.
//
// Run: npx vitest run packages/core/test/cross-run-metrics.test.ts
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildRunView } from '../src/observe/runView.js';
import { projectRunDigest } from '../src/observe/telemetry.js';
import { createNodeAccumulator } from '../src/observe/distill.js';
import { createClaudeAccumulator } from '../src/observe/claude-distill.js';
import type { RunStatus, NodeStatusRecord, NodeUsage } from '../src/runner/status.js';
import { runJsonFile } from '../src/runner/layout.js';
import type { PiEvent } from '../src/runner/events.js';

// ── on-disk fixture helpers — write `.pi/run.json` per run dir (the historyDirs + latest run the fold reads) ──
async function writeRunJson(runDir: string, status: RunStatus): Promise<void> {
  const rj = runJsonFile(runDir);
  await fs.mkdir(path.dirname(rj), { recursive: true });
  await fs.writeFile(rj, JSON.stringify(status, null, 2));
}

/** A minimal single-node run.json where node `n0` carries the given usage + durationMs. */
function oneNodeRun(run: string, usage: NodeUsage, durationMs = 1000): RunStatus {
  const rec: NodeStatusRecord = {
    id: 'n0', label: 'n0', status: 'ok', artifacts: [], issues: [],
    startedAt: '2026-07-02T00:00:00.000Z', endedAt: '2026-07-02T00:00:01.000Z',
    durationMs, usage,
  };
  return {
    run, provider: 'cp', model: 'm1',
    startedAt: '2026-07-02T00:00:00.000Z', updatedAt: '2026-07-02T00:00:01.000Z',
    durationMs, done: true, ok: true,
    totals: { nodes: 1, ok: 1, failed: 0 },
    nodes: { n0: rec },
  } as RunStatus;
}

/** Build the run-view for `latest`, folding `history` dirs, then project the digest and pull n0's anomalies. */
async function anomaliesFor(latest: string, history: string[]): Promise<string[]> {
  const { view } = buildRunView(latest, { historyDirs: history });
  const digest = projectRunDigest(view);
  return digest.nodes.find((n) => n.id === 'n0')!.anomalies.sort();
}

describe('cost-spike — cross-run billable-token spike (P6, behavior 1)', () => {
  it('fires cost-spike when the latest run billable tokens are ~3× the prior-run mean', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'piflow-costspike-'));
    // Prior runs: billable = input+output = 1000 each (mean 1000).
    const h1 = path.join(root, 'h1');
    const h2 = path.join(root, 'h2');
    await writeRunJson(h1, oneNodeRun('h1', { inputTokens: 800, outputTokens: 200, cost: 0.01 }));
    await writeRunJson(h2, oneNodeRun('h2', { inputTokens: 800, outputTokens: 200, cost: 0.01 }));
    // Latest run: billable = 3000 (3× the 1000 mean) — the spike.
    const latest = path.join(root, 'latest');
    await writeRunJson(latest, oneNodeRun('latest', { inputTokens: 2400, outputTokens: 600, cost: 0.03 }));

    const kinds = await anomaliesFor(latest, [h1, h2]);
    expect(kinds).toContain('cost-spike');
  });

  it('does NOT fire cost-spike on a FLAT history (latest billable ≈ prior mean)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'piflow-costflat-'));
    const h1 = path.join(root, 'h1');
    const h2 = path.join(root, 'h2');
    await writeRunJson(h1, oneNodeRun('h1', { inputTokens: 800, outputTokens: 200, cost: 0.01 }));
    await writeRunJson(h2, oneNodeRun('h2', { inputTokens: 800, outputTokens: 200, cost: 0.01 }));
    // Latest run: billable = 1000 (== the 1000 mean) — flat, no spike.
    const latest = path.join(root, 'latest');
    await writeRunJson(latest, oneNodeRun('latest', { inputTokens: 800, outputTokens: 200, cost: 0.01 }));

    const kinds = await anomaliesFor(latest, [h1, h2]);
    expect(kinds).not.toContain('cost-spike');
  });
});

describe('cost-spike is TOKENS-FIRST — fires on token spike even when cost is 0 (P6, behavior 2)', () => {
  it('fires cost-spike when cost is 0 for ALL runs (Max subscription) but billable tokens spike ~3×', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'piflow-cost0-'));
    const h1 = path.join(root, 'h1');
    const h2 = path.join(root, 'h2');
    // Max-subscription: cost 0 everywhere. billable = 1000 mean.
    await writeRunJson(h1, oneNodeRun('h1', { inputTokens: 800, outputTokens: 200, cost: 0 }));
    await writeRunJson(h2, oneNodeRun('h2', { inputTokens: 800, outputTokens: 200, cost: 0 }));
    // Latest: cost STILL 0, but billable 3000 (3× spike).
    const latest = path.join(root, 'latest');
    await writeRunJson(latest, oneNodeRun('latest', { inputTokens: 2400, outputTokens: 600, cost: 0 }));

    const kinds = await anomaliesFor(latest, [h1, h2]);
    // The dollar signal is dead (0→0); the token signal fires — that is the whole point of tokens-first.
    expect(kinds).toContain('cost-spike');
  });
});

// ── LOOPSCORE — the DISTINCT consecutive-first-100 signal ────────────────────────────────────────────
//
// HAND-COUNT ORACLE (pi vocabulary, independently justified — NOT copied from any output):
// Four CONSECUTIVE bash calls whose FULL args differ (a distinct trailing comment each) but whose
// FIRST 100 CHARS are IDENTICAL. name+full-args fingerprint (maxToolRepeat) sees 4 DISTINCT keys ⇒ peak 1.
// name+args.slice(0,100) fingerprint (loopScore) sees ONE key, 4 back-to-back ⇒ run length 4.
const LONG = 'x'.repeat(100); // ≥100 chars so the first-100 slice is identical while the tail differs
function piBashCall(id: string, tail: string, t: number): PiEvent[] {
  return [
    { type: 'tool_execution_start', toolName: 'bash', toolCallId: id, args: { command: `echo ${LONG}${tail}` }, _t: t },
    { type: 'tool_execution_end', toolCallId: id, _t: t + 1 },
  ];
}

describe('loopScore is DISTINCT from maxToolRepeat (P6, behavior 3)', () => {
  it('pi: 4 consecutive first-100-identical / full-args-DISTINCT calls ⇒ loopScore≥3 while maxToolRepeat<3', () => {
    const acc = createNodeAccumulator();
    // Four back-to-back bash calls; the same first 100 chars, a different comment tail each (so full args differ).
    for (const e of [
      ...piBashCall('a', ' # 1', 0),
      ...piBashCall('b', ' # 2', 10),
      ...piBashCall('c', ' # 3', 20),
      ...piBashCall('d', ' # 4', 30),
    ]) acc.push(e);
    const rich = acc.finalize().rich;

    // full-args global peak: every call is a distinct key ⇒ never repeats ⇒ stays below the loop threshold.
    expect(rich.maxToolRepeat).toBeLessThan(3);
    // consecutive first-100 key: one run of 4 back-to-back ⇒ loopScore catches the stuck loop maxToolRepeat missed.
    expect(rich.loopScore).toBeGreaterThanOrEqual(3);
  });
});

// HAND-COUNT ORACLE (Claude stream-json vocabulary — assistant tool_use / user tool_result blocks):
// Same shape as pi: three CONSECUTIVE Grep tool_use blocks whose `pattern` first-100 chars are identical
// but whose full input differs by a trailing suffix. maxToolRepeat (full args) ⇒ peak 1; loopScore ⇒ 3.
function claudeGrep(id: string, suffix: string): PiEvent {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name: 'Grep', input: { pattern: LONG + suffix } }] },
  } as unknown as PiEvent;
}
function claudeResult(id: string): PiEvent {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id }] },
  } as unknown as PiEvent;
}

describe('loopScore per-executor — computed on each accumulator\'s own vocabulary (P6, behavior 4)', () => {
  it('pi accumulator computes loopScore on a consecutive-repeat pi stream', () => {
    const acc = createNodeAccumulator();
    for (const e of [
      ...piBashCall('a', ' # 1', 0),
      ...piBashCall('b', ' # 2', 10),
      ...piBashCall('c', ' # 3', 20),
    ]) acc.push(e);
    expect(acc.finalize().rich.loopScore).toBeGreaterThanOrEqual(3);
  });

  it('Claude accumulator computes loopScore on a consecutive-repeat claude stream-json stream', () => {
    const acc = createClaudeAccumulator();
    // Three consecutive Grep tool_use blocks, first-100 identical, full input distinct — each closed by a tool_result.
    for (const e of [
      claudeGrep('g1', 'A'), claudeResult('g1'),
      claudeGrep('g2', 'B'), claudeResult('g2'),
      claudeGrep('g3', 'C'), claudeResult('g3'),
    ]) acc.push(e);
    const rich = acc.finalize().rich;
    // maxToolRepeat (full-args) misses it (3 distinct keys); loopScore (first-100) catches the stuck loop.
    expect(rich.maxToolRepeat).toBeLessThan(3);
    expect(rich.loopScore).toBeGreaterThanOrEqual(3);
  });
});

describe('loop-score anomaly appears in detectAnomalies at the threshold (P6, behavior 5)', () => {
  it('a node with loopScore≥3 (and maxToolRepeat<3) trips the loop-score anomaly, NOT tool-loop', () => {
    // Build a real pi run on disk whose single node loops consecutively (first-100 identical, full-args distinct),
    // so the anomaly rides the SAME public path (buildRunView → projectRunDigest) a real run would.
    return (async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'piflow-loopanom-'));
      const runDir = path.join(root, 'run');
      await writeRunJson(runDir, oneNodeRun('run', { inputTokens: 10, outputTokens: 2, cost: 0 }));
      // Write the events.jsonl the reducer folds — four consecutive first-100-identical / full-distinct bash calls.
      const ef = path.join(runDir, '.pi', 'nodes', 'n0', 'events.jsonl');
      await fs.mkdir(path.dirname(ef), { recursive: true });
      const events: PiEvent[] = [
        ...piBashCall('a', ' # 1', 0),
        ...piBashCall('b', ' # 2', 10),
        ...piBashCall('c', ' # 3', 20),
        ...piBashCall('d', ' # 4', 30),
      ];
      await fs.writeFile(ef, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

      const { view } = buildRunView(runDir);
      const digest = projectRunDigest(view);
      const kinds = digest.nodes.find((n) => n.id === 'n0')!.anomalies;
      expect(kinds).toContain('loop-score');
      // and NOT the full-args tool-loop (it stays below threshold) — proving the two anomalies are distinct.
      expect(kinds).not.toContain('tool-loop');
    })();
  });
});
