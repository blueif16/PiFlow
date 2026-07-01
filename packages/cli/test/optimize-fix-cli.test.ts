// Contract for the `piflowctl optimize --fix --binding <module>` seam (piflow-memory-v1.5 §6 driver,
// surfaced on the CLI). The seam INVENTS the product→optimizer injection convention (no precedent existed):
// a product binding module supplies the LIVE stages that cannot live in @piflow/core — `oracle`
// (runMilestoneVerify2 + build), `copyScope`, `fixer` — and the CLI dynamic-imports it (mirroring the
// `@piflow/daytona` sandbox pattern), then COMPOSES the already-tested core pieces: scoreRun → triage →
// mineTaskFromTrace → makeReplayStages → runFixGate → writeStagingManifest. It lands nothing live; it stages.
//
// Tested at the level the seam adds: arg-parse, the dynamic-import LOADER (+ its shape validation), and one
// composition smoke that the loaded binding drives a real FIX→GATE to a staging manifest (scoreRun injected —
// the gs01 fixture carries no .pi telemetry, and scoreRun's trace read is covered elsewhere).
//
// Run: npx vitest run packages/cli/test/optimize-fix-cli.test.ts

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOptimizeFixArgs, loadBinding, runOptimizeFixCli, enrichCodeMap } from '../src/optimize-fix.js';
import { scoreNodes, triage, deriveRecurrence } from '@piflow/core';
import type { RunDigest, NodeDigest, Tier1Result, Tier1Check, Defect } from '@piflow/core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fixtures', 'fake-binding.mjs');
const BAD = path.join(HERE, 'fixtures', 'bad-binding.mjs');

describe('parseOptimizeFixArgs', () => {
  it('parses the run dir, the required --binding, and the bound/policy flags', () => {
    const a = parseOptimizeFixArgs(['runs/gs01', '--fix', '--binding', './b.mjs', '--staging-dir', '/tmp/s', '--auto-adopt', '--edit-budget', '2', '--token-budget', '500']);
    expect(a.dir).toBe('runs/gs01');
    expect(a.binding).toBe('./b.mjs');
    expect(a.stagingDir).toBe('/tmp/s');
    expect(a.autoAdopt).toBe(true);
    expect(a.editBudget).toBe(2);
    expect(a.tokenBudget).toBe(500);
  });

  it('defaults auto-adopt OFF and leaves budgets unset when not given', () => {
    const a = parseOptimizeFixArgs(['runs/gs01', '--binding', './b.mjs']);
    expect(a.autoAdopt).toBe(false);
    expect(a.editBudget).toBeUndefined();
    expect(a.tokenBudget).toBeUndefined();
  });

  it('parses --fix-cycle-ceiling (the per-node re-attempt bound), leaving it unset when absent', () => {
    const set = parseOptimizeFixArgs(['runs/gs01', '--binding', './b.mjs', '--fix-cycle-ceiling', '3']);
    expect(set.fixCycleCeiling).toBe(3);
    const unset = parseOptimizeFixArgs(['runs/gs01', '--binding', './b.mjs']);
    expect(unset.fixCycleCeiling).toBeUndefined();
  });

  it('parses --node as a worklist filter (target one node; the cost/safety scope)', () => {
    const a = parseOptimizeFixArgs(['runs/gs01', '--binding', './b.mjs', '--node', 'm3']);
    expect(a.node).toBe('m3');
  });

  it('leaves --node unset when not given (whole worklist)', () => {
    const a = parseOptimizeFixArgs(['runs/gs01', '--binding', './b.mjs']);
    expect(a.node).toBeUndefined();
  });

  it('parses --watch / --watch-json (the live progress surface), defaulting both OFF', () => {
    const off = parseOptimizeFixArgs(['runs/gs01', '--binding', './b.mjs']);
    expect(off.watch).toBe(false);
    expect(off.watchJson).toBe(false);
    const on = parseOptimizeFixArgs(['runs/gs01', '--binding', './b.mjs', '--watch']);
    expect(on.watch).toBe(true);
    expect(on.watchJson).toBe(false);
    const json = parseOptimizeFixArgs(['runs/gs01', '--binding', './b.mjs', '--watch', '--watch-json']);
    expect(json.watch).toBe(true);
    expect(json.watchJson).toBe(true);
  });
});

describe('enrichCodeMap — resolve each SKILL lesson\'s [[okf-slice]] pointer to the code-map body (resolve-at-read)', () => {
  const skillDefect = (okfSlice?: string): Defect => ({
    node: 'flaky', bucket: 'SKILL', symptom: 'recurred', evidence: [], confidence: 'medium',
    scope: { recurrence: 2, ...(okfSlice ? { okfSlice } : {}) },
  });

  it('inlines the resolved body into scope.codeMap for a defect that links a slice', () => {
    const defects = [skillDefect('runner')];
    enrichCodeMap(defects, (k) => (k === 'runner' ? 'HOW THE RUNNER WORKS' : null));
    expect(defects[0].scope?.codeMap).toEqual([{ slice: 'runner', body: 'HOW THE RUNNER WORKS' }]);
  });

  it('leaves codeMap unset when the pointer is dangling (slice resolves to null — root/prevention still flow)', () => {
    const defects = [skillDefect('gone')];
    enrichCodeMap(defects, () => null);
    expect(defects[0].scope?.codeMap).toBeUndefined();
  });

  it('skips defects with no okfSlice pointer entirely (never calls the resolver for LAPSE/FUNCTIONALITY/ARCH)', () => {
    const lapse: Defect = { node: 'x', bucket: 'LAPSE', symptom: '', evidence: [], confidence: 'low' };
    let calls = 0;
    enrichCodeMap([lapse], () => { calls++; return 'X'; });
    expect(lapse.scope).toBeUndefined();
    expect(calls).toBe(0);
  });
});

describe('loadBinding — the dynamic-import seam', () => {
  it('loads a binding module exporting { oracle, copyScope, fixer }', async () => {
    const b = await loadBinding(FAKE);
    expect(typeof b.oracle).toBe('function');
    expect(typeof b.copyScope).toBe('function');
    expect(typeof b.fixer).toBe('function');
  });

  it('rejects a module missing a required stage with a clear error', async () => {
    await expect(loadBinding(BAD)).rejects.toThrow(/fixer/i);
  });

  it('rejects an unresolvable binding path with an actionable error', async () => {
    await expect(loadBinding(path.join(HERE, 'fixtures', 'does-not-exist.mjs'))).rejects.toThrow(/binding/i);
  });
});

// ── one composition smoke: the loaded binding drives a real FIX→GATE to a staging manifest ──────────────────
const dnode = (id: string): NodeDigest => ({
  id, label: id, phase: null, outcome: 'ok', model: null, provider: null,
  durationMs: null, expectedMs: null, slowRatio: null, inputTokens: 0, outputTokens: 0, cost: 0,
  contextPeak: 0, contextWindow: null, contextPct: null, modelCalls: 0, toolCalls: 0, topTools: {},
  maxToolRepeat: 0, repeatedTool: null, retries: 0, stopReason: null, truncated: false, missing: [], issues: [], anomalies: [],
});
const t1 = (milestoneId: string, checks: Tier1Check[]): Tier1Result =>
  ({ milestoneId, marker: 'VALIDATION_FAILED', passed: false, abstained: false, checks, scalar: checks.filter((c) => c.passed).length / checks.length });

describe('runOptimizeFixCli — composition smoke (scoreRun injected)', () => {
  it('drives the loaded binding through FIX→GATE and writes a staging manifest with the accepted (staged) edit', async () => {
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'optfix-run-'));
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'optfix-stage-'));
    // the incumbent's recorded report the miner reads for baseScore (a real-shaped degraded fail → 0).
    await fs.mkdir(path.join(runDir, 'verify'), { recursive: true });
    await fs.writeFile(path.join(runDir, 'verify', 'report.M2.json'), JSON.stringify({ milestoneId: 'M2', marker: 'VALIDATION_FAILED', passed: false, fixOutcome: 'exhausted' }));

    // inject scoreRun: triage turns this into a FUNCTIONALITY defect on w4-execute-m2 (the trace read is covered elsewhere).
    const digest: RunDigest = {
      run: 'tmp', done: true, ok: true, durationMs: 1,
      totals: { nodes: 1, ok: 1, failed: 0, inputTokens: 0, outputTokens: 0, cost: 0, contextPeak: 0, modelCalls: 0, toolCalls: 0 },
      nodes: [dnode('w4-execute-m2')], anomalies: [], rootCauses: [],
    };
    const tier1ByNode = new Map([['w4-execute-m2', t1('M2', [{ id: 'M2-A3', gate: 'fidelity', passed: false }])]]);
    const fakeScoreRun = async () => ({ scores: scoreNodes({ digest, tier1ByNode }), digest });

    await runOptimizeFixCli(['--fix', runDir, '--binding', FAKE, '--staging-dir', stagingDir], { scoreRun: fakeScoreRun, print: () => {} });

    const manifest = JSON.parse(await fs.readFile(path.join(stagingDir, 'manifest.json'), 'utf8'));
    expect(manifest.summary.accepted).toBe(1); // base 0 → candidate 1.0 (fake oracle passes) → strict improvement
    expect(manifest.records[0].node).toBe('w4-execute-m2');
    expect(manifest.records[0].landed).toBe('staged'); // auto-adopt OFF → the win stages for the human
  });

  it('OPTIONALITY: a binding WITHOUT the fix-cycle port still validates and runs with --fix-cycle-ceiling (ceiling inert)', async () => {
    // The FAKE binding exports NO readFixCycles/bumpFixCycles. With --fix-cycle-ceiling set, the CLI must still
    // load it and drive FIX→GATE to completion (core no-ops the ceiling when the counter stages are absent).
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'optfix-run-'));
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'optfix-stage-'));
    await fs.mkdir(path.join(runDir, 'verify'), { recursive: true });
    await fs.writeFile(path.join(runDir, 'verify', 'report.M2.json'), JSON.stringify({ milestoneId: 'M2', marker: 'VALIDATION_FAILED', passed: false, fixOutcome: 'exhausted' }));
    const digest: RunDigest = {
      run: 'tmp', done: true, ok: true, durationMs: 1,
      totals: { nodes: 1, ok: 1, failed: 0, inputTokens: 0, outputTokens: 0, cost: 0, contextPeak: 0, modelCalls: 0, toolCalls: 0 },
      nodes: [dnode('w4-execute-m2')], anomalies: [], rootCauses: [],
    };
    const tier1ByNode = new Map([['w4-execute-m2', t1('M2', [{ id: 'M2-A3', gate: 'fidelity', passed: false }])]]);
    const fakeScoreRun = async () => ({ scores: scoreNodes({ digest, tier1ByNode }), digest });

    await runOptimizeFixCli(
      ['--fix', runDir, '--binding', FAKE, '--staging-dir', stagingDir, '--fix-cycle-ceiling', '3'],
      { scoreRun: fakeScoreRun, print: () => {} },
    );

    const manifest = JSON.parse(await fs.readFile(path.join(stagingDir, 'manifest.json'), 'utf8'));
    expect(manifest.summary.accepted).toBe(1);          // the inert ceiling didn't block the accepted edit
    expect(manifest.records[0].node).toBe('w4-execute-m2');
  });

  it('with --node, processes ONLY the matching node(s) from the worklist', async () => {
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'optfix-run-'));
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'optfix-stage-'));
    // two incumbents recorded → without a filter, triage yields two FUNCTIONALITY defects.
    await fs.mkdir(path.join(runDir, 'verify'), { recursive: true });
    await fs.writeFile(path.join(runDir, 'verify', 'report.M1.json'), JSON.stringify({ milestoneId: 'M1', marker: 'VALIDATION_FAILED', passed: false, fixOutcome: 'exhausted' }));
    await fs.writeFile(path.join(runDir, 'verify', 'report.M3.json'), JSON.stringify({ milestoneId: 'M3', marker: 'VALIDATION_FAILED', passed: false, fixOutcome: 'exhausted' }));

    const digest: RunDigest = {
      run: 'tmp', done: true, ok: true, durationMs: 1,
      totals: { nodes: 2, ok: 2, failed: 0, inputTokens: 0, outputTokens: 0, cost: 0, contextPeak: 0, modelCalls: 0, toolCalls: 0 },
      nodes: [dnode('w4-execute-m1'), dnode('w4-execute-m3')], anomalies: [], rootCauses: [],
    };
    const tier1ByNode = new Map([
      ['w4-execute-m1', t1('M1', [{ id: 'M1-A1', gate: 'fidelity', passed: false }])],
      ['w4-execute-m3', t1('M3', [{ id: 'M3-A3', gate: 'fidelity', passed: false }])],
    ]);
    const fakeScoreRun = async () => ({ scores: scoreNodes({ digest, tier1ByNode }), digest });

    await runOptimizeFixCli(['--fix', runDir, '--binding', FAKE, '--staging-dir', stagingDir, '--node', 'm3'], { scoreRun: fakeScoreRun, print: () => {} });

    const manifest = JSON.parse(await fs.readFile(path.join(stagingDir, 'manifest.json'), 'utf8'));
    expect(manifest.records.map((r: { node: string }) => r.node)).toEqual(['w4-execute-m3']); // m1 filtered OUT
  });

  it('--watch streams live OptimizeEvent lines (gated/landed visible); without --watch only the summary prints', async () => {
    const mk = async () => {
      const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'optfix-run-'));
      const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'optfix-stage-'));
      await fs.mkdir(path.join(runDir, 'verify'), { recursive: true });
      await fs.writeFile(path.join(runDir, 'verify', 'report.M2.json'), JSON.stringify({ milestoneId: 'M2', marker: 'VALIDATION_FAILED', passed: false, fixOutcome: 'exhausted' }));
      const digest: RunDigest = {
        run: 'tmp', done: true, ok: true, durationMs: 1,
        totals: { nodes: 1, ok: 1, failed: 0, inputTokens: 0, outputTokens: 0, cost: 0, contextPeak: 0, modelCalls: 0, toolCalls: 0 },
        nodes: [dnode('w4-execute-m2')], anomalies: [], rootCauses: [],
      };
      const tier1ByNode = new Map([['w4-execute-m2', t1('M2', [{ id: 'M2-A3', gate: 'fidelity', passed: false }])]]);
      const fakeScoreRun = async () => ({ scores: scoreNodes({ digest, tier1ByNode }), digest });
      return { runDir, stagingDir, fakeScoreRun };
    };

    // WITH --watch: the capturing print receives ≥1 live event line (gated/landed) BEYOND the summary.
    const watched = await mk();
    const watchedLines: string[] = [];
    await runOptimizeFixCli(
      ['--fix', watched.runDir, '--binding', FAKE, '--staging-dir', watched.stagingDir, '--watch'],
      { scoreRun: watched.fakeScoreRun, print: (s) => watchedLines.push(s) },
    );
    expect(watchedLines.some((l) => /gated|landed/.test(l))).toBe(true);

    // WITHOUT --watch: print receives ONLY the summary line — no per-event progress.
    const quiet = await mk();
    const quietLines: string[] = [];
    await runOptimizeFixCli(
      ['--fix', quiet.runDir, '--binding', FAKE, '--staging-dir', quiet.stagingDir],
      { scoreRun: quiet.fakeScoreRun, print: (s) => quietLines.push(s) },
    );
    expect(quietLines).toHaveLength(1);
    expect(quietLines[0]).toMatch(/optimize --fix:/);
    expect(quietLines.some((l) => /gated|landed/.test(l))).toBe(false);
  });

  it('--watch-json emits machine-readable JSON lines (each parses to an event with a type)', async () => {
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'optfix-run-'));
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'optfix-stage-'));
    await fs.mkdir(path.join(runDir, 'verify'), { recursive: true });
    await fs.writeFile(path.join(runDir, 'verify', 'report.M2.json'), JSON.stringify({ milestoneId: 'M2', marker: 'VALIDATION_FAILED', passed: false, fixOutcome: 'exhausted' }));
    const digest: RunDigest = {
      run: 'tmp', done: true, ok: true, durationMs: 1,
      totals: { nodes: 1, ok: 1, failed: 0, inputTokens: 0, outputTokens: 0, cost: 0, contextPeak: 0, modelCalls: 0, toolCalls: 0 },
      nodes: [dnode('w4-execute-m2')], anomalies: [], rootCauses: [],
    };
    const tier1ByNode = new Map([['w4-execute-m2', t1('M2', [{ id: 'M2-A3', gate: 'fidelity', passed: false }])]]);
    const fakeScoreRun = async () => ({ scores: scoreNodes({ digest, tier1ByNode }), digest });

    const lines: string[] = [];
    await runOptimizeFixCli(
      ['--fix', runDir, '--binding', FAKE, '--staging-dir', stagingDir, '--watch', '--watch-json'],
      { scoreRun: fakeScoreRun, print: (s) => lines.push(s) },
    );
    const events = lines.slice(0, -1).map((l) => JSON.parse(l)); // last line = the human summary
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => typeof e.type === 'string')).toBe(true);
    expect(events.some((e) => e.type === 'gated')).toBe(true);
  });
});

// ── (A) MEMORIZE wired into the single-shot path: the cross-invocation recurrence loop closes ────────────────
// The v1.5 "it-works" contract (piflow-memory-v1.5 §6): run `--fix` on run-1 → the run's tier0-signature LAPSE
// persists to <template>/nodes/<node>/memory.md at recurrence 1. A SECOND run's triage over the SAME signature
// then reads that memory.md and buckets SKILL (not LAPSE) — the two-run carry with no human hand-write. Driven
// THROUGH runOptimizeFixCli (scoreRun injected; the FAKE binding's fixer/oracle are trivial) so it proves the
// wire, not the core (memorize is unit-tested in core). The canonical layout is <base>/runs/<id> + <base>/template.
describe('runOptimizeFixCli — MEMORIZE closes the cross-run recurrence loop', () => {
  // a self-originating structural failure (anomaly `failed`, no tier1) → tier0.disqualified → a LAPSE defect
  // that memorize RECORDS. signatureOf = `<node>::failed`, shared by the writer and the run-2 reader.
  const lapseDigest = (node: string): RunDigest => ({
    run: 'r', done: true, ok: false, durationMs: 1,
    totals: { nodes: 1, ok: 0, failed: 1, inputTokens: 0, outputTokens: 0, cost: 0, contextPeak: 0, modelCalls: 0, toolCalls: 0 },
    nodes: [{ ...dnode(node), outcome: 'error', anomalies: ['failed'] }], anomalies: [], rootCauses: [],
  });

  it('run-1 --fix WRITES the lesson; run-2 triage over the same signature buckets SKILL (not LAPSE)', async () => {
    const NODE = 'w4-execute-m2';
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'optfix-base-'));
    const templateDir = path.join(base, 'template');
    const runsDir = path.join(base, 'runs');
    const run1 = path.join(runsDir, 'run-1');
    await fs.mkdir(run1, { recursive: true });
    await fs.mkdir(templateDir, { recursive: true });

    // triage of THIS run (no memory yet) → a LAPSE (recurrence index empty ⇒ stays LAPSE) — the pre-condition.
    const scores1 = scoreNodes({ digest: lapseDigest(NODE), tier1ByNode: new Map() });
    expect(triage(scores1, lapseDigest(NODE), { recurrence: deriveRecurrence({ templateDir, nodes: [NODE] }) })[0].bucket).toBe('LAPSE');

    // run-1 --fix: scoreRun injected. The binding is FAKE (fixer/oracle trivial). MEMORIZE must persist the LAPSE.
    // The memorize summary goes to stderr (like the read-only `optimize --memorize` path) — capture it there.
    const errLines: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => { errLines.push(String(s)); return true; };
    try {
      await runOptimizeFixCli(
        ['--fix', run1, '--binding', FAKE, '--staging-dir', path.join(base, 'stage')],
        { scoreRun: async () => ({ scores: scores1, digest: lapseDigest(NODE) }), print: () => {} },
      );
    } finally {
      (process.stderr as unknown as { write: typeof origWrite }).write = origWrite;
    }

    // the lesson landed in the node's memory.md at recurrence 1, keyed by the shared signature.
    const memory = await fs.readFile(path.join(templateDir, 'nodes', NODE, 'memory.md'), 'utf8');
    expect(memory).toContain(`sig: ${NODE}::failed`);
    expect(memory).toContain('recurrence: 1');
    // a one-line summary of lessons written is printed (to stderr).
    expect(errLines.some((l) => /memoriz/i.test(l))).toBe(true);

    // run-2: the SAME signature now recurs in memory (count 1 ≥ threshold 1) → the reader flips the bucket to SKILL.
    const scores2 = scoreNodes({ digest: lapseDigest(NODE), tier1ByNode: new Map() });
    const recurrence2 = deriveRecurrence({ templateDir, nodes: [NODE] });
    const defects2 = triage(scores2, lapseDigest(NODE), { recurrence: recurrence2 });
    expect(defects2[0].bucket).toBe('SKILL'); // ← the cross-invocation recurrence loop closed
  });
});
