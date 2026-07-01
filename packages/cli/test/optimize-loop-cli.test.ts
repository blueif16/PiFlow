// Contract for the multi-round `piflowctl optimize --rounds N --binding <module>` seam (piflow-memory-v1.5 §6
// overlord, surfaced on the CLI). The seam COMPOSES the product-agnostic core driver `runOptimizeLoop` with the
// SAME injected stages the single-shot `--fix` path uses — run → score+triage+enrich → fix+gate → memorize —
// but the `run` stage is PRODUCT-side (the binding's `run(round)` produces each round's run dir): @piflow/core
// cannot know how to run a workflow (boundary law). The CLI only SEQUENCES; no product logic lives here.
//
// Tested at the level this seam adds: the new flag parse (--rounds/--stalled-patience/--error-budget), the
// fully-FAKE binding driving N rounds through the loop to a printed trajectory, and the clean error when
// --rounds > 1 but the binding exports no `run` (do not fake it). scoreRun is injected — the trace read is
// covered elsewhere; the FAKE binding's oracle/fixer/copyScope are trivial.
//
// Run: npx vitest run packages/cli/test/optimize-loop-cli.test.ts

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOptimizeLoopArgs, runOptimizeLoopCli } from '../src/optimize-loop.js';
import { scoreNodes, deriveRecurrence } from '@piflow/core';
import type { RunDigest, NodeDigest, Tier1Result, Tier1Check } from '@piflow/core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fixtures', 'fake-binding.mjs');       // exports { oracle, copyScope, fixer } — NO `run`
const FAKE_RUN = path.join(HERE, 'fixtures', 'fake-loop-binding.mjs'); // ALSO exports `run(round)` → a fresh run dir
// A2: a `--rounds` binding with a `distill` stage + the canonical <base>/runs/<id> + <base>/template layout.
const DISTILL_LOOP = path.join(HERE, 'fixtures', 'distill-loop-binding.mjs');

const dnode = (id: string): NodeDigest => ({
  id, label: id, phase: null, outcome: 'ok', model: null, provider: null,
  durationMs: null, expectedMs: null, slowRatio: null, inputTokens: 0, outputTokens: 0, cost: 0,
  contextPeak: 0, contextWindow: null, contextPct: null, modelCalls: 0, toolCalls: 0, topTools: {},
  maxToolRepeat: 0, repeatedTool: null, retries: 0, stopReason: null, truncated: false, missing: [], issues: [], anomalies: [],
});
const t1 = (milestoneId: string, checks: Tier1Check[]): Tier1Result =>
  ({ milestoneId, marker: 'VALIDATION_FAILED', passed: false, abstained: false, checks, scalar: checks.filter((c) => c.passed).length / checks.length });

// a FUNCTIONALITY-defect digest (a clean node whose tier-1 outcome failed) — the fake oracle passes the
// candidate (base 0 → cand 1.0) so every round accepts one edit.
const failingDigest = (node: string): RunDigest => ({
  run: node, done: true, ok: true, durationMs: 1,
  totals: { nodes: 1, ok: 1, failed: 0, inputTokens: 0, outputTokens: 0, cost: 0, contextPeak: 0, modelCalls: 0, toolCalls: 0 },
  nodes: [dnode(node)], anomalies: [], rootCauses: [],
});
const fakeScoreRun = (node: string) => async () => ({
  scores: scoreNodes({ digest: failingDigest(node), tier1ByNode: new Map([[node, t1('M2', [{ id: 'M2-A3', gate: 'fidelity', passed: false }])]]) }),
  digest: failingDigest(node),
});

describe('parseOptimizeLoopArgs — the multi-round flag surface', () => {
  it('parses --rounds and the loop bounds --stalled-patience / --error-budget', () => {
    const a = parseOptimizeLoopArgs(['--binding', './b.mjs', '--rounds', '5', '--stalled-patience', '2', '--error-budget', '3']);
    expect(a.rounds).toBe(5);
    expect(a.stalledPatience).toBe(2);
    expect(a.errorBudget).toBe(3);
    expect(a.binding).toBe('./b.mjs');
  });

  it('defaults rounds to 1 and leaves the optional bounds unset when absent', () => {
    const a = parseOptimizeLoopArgs(['--binding', './b.mjs']);
    expect(a.rounds).toBe(1);
    expect(a.stalledPatience).toBeUndefined();
    expect(a.errorBudget).toBeUndefined();
  });

  it('carries the shared --watch / --watch-json flags (round-boundary events stream too)', () => {
    const off = parseOptimizeLoopArgs(['--binding', './b.mjs', '--rounds', '2']);
    expect(off.watch).toBe(false);
    expect(off.watchJson).toBe(false);
    const json = parseOptimizeLoopArgs(['--binding', './b.mjs', '--rounds', '2', '--watch-json']);
    expect(json.watch).toBe(true);
    expect(json.watchJson).toBe(true);
  });
});

describe('runOptimizeLoopCli — composes runOptimizeLoop over a fully-FAKE binding', () => {
  it('runs N rounds (binding.run produces each round dir) and prints the round-by-round trajectory + stop reason', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'optloop-'));
    process.env.PIFLOW_FAKE_LOOP_BASE = base; // the fake binding mkdtemps a run dir per round under here

    const lines: string[] = [];
    await runOptimizeLoopCli(
      ['--binding', FAKE_RUN, '--rounds', '2', '--staging-dir', path.join(base, 'stage')],
      { scoreRun: fakeScoreRun('w4-execute-m2'), print: (s) => lines.push(s) },
    );

    const out = lines.join('\n');
    // the trajectory: two rounds, each accepting the one FUNCTIONALITY edit (base 0 → cand 1.0).
    expect(out).toMatch(/round\s*1.*accepted=1\/1/i);
    expect(out).toMatch(/round\s*2.*accepted=1\/1/i);
    // the stop reason + rounds-run summary (budget-exhausted after N rounds with no convergence/stall).
    expect(out).toMatch(/budget-exhausted/);
    expect(out).toMatch(/2 round/);
  });

  it('errors cleanly and exits 2 when --rounds > 1 but the binding exports no `run` (does NOT fake a run)', async () => {
    const prevExit = process.exitCode;
    process.exitCode = 0;
    const errLines: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => { errLines.push(String(s)); return true; };
    let printed = 0;
    try {
      await runOptimizeLoopCli(
        ['--binding', FAKE, '--rounds', '3'], // FAKE has oracle/copyScope/fixer but NO run
        { scoreRun: fakeScoreRun('w4-execute-m2'), print: () => { printed++; } },
      );
    } finally {
      (process.stderr as unknown as { write: typeof origWrite }).write = origWrite;
    }
    expect(process.exitCode).toBe(2);
    expect(errLines.some((l) => /run/i.test(l) && /binding/i.test(l))).toBe(true);
    expect(printed).toBe(0); // it did NOT run any round
    process.exitCode = prevExit;
  });

  it('--watch-json streams round-boundary events (round-started / round-complete / loop-stopped) as JSON lines', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'optloop-'));
    process.env.PIFLOW_FAKE_LOOP_BASE = base;

    const lines: string[] = [];
    await runOptimizeLoopCli(
      ['--binding', FAKE_RUN, '--rounds', '2', '--staging-dir', path.join(base, 'stage'), '--watch-json'],
      { scoreRun: fakeScoreRun('w4-execute-m2'), print: (s) => lines.push(s) },
    );
    // every non-summary line parses to an event object with a `type`; the round-boundary types are present.
    const events = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as { type: string }[];
    const types = new Set(events.map((e) => e.type));
    expect(types.has('round-started')).toBe(true);
    expect(types.has('round-complete')).toBe(true);
    expect(types.has('loop-stopped')).toBe(true);
  });

  // ── (A2) the LOOP's memorize stage distills too — the round's appended lesson gets real prose ────────────────
  it('the loop\'s memorize stage fills each round\'s appended lesson with the injected distiller\'s prose (keyed off foundRoot)', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'optloop-distill-'));
    process.env.PIFLOW_DISTILL_LOOP_BASE = base; // the fake binding lays out <base>/runs/<id> + <base>/template
    const NODE = 'w4-execute-m2';

    // a LAPSE-shaped run (anomaly `failed`, no tier1) → MEMORIZE APPENDS a lesson with (pending) placeholders.
    const lapseDigest: RunDigest = {
      run: 'r', done: true, ok: false, durationMs: 1,
      totals: { nodes: 1, ok: 0, failed: 1, inputTokens: 0, outputTokens: 0, cost: 0, contextPeak: 0, modelCalls: 0, toolCalls: 0 },
      nodes: [{ ...dnode(NODE), outcome: 'error', anomalies: ['failed'] }], anomalies: [], rootCauses: [],
    };
    const scoreRun = async () => ({ scores: scoreNodes({ digest: lapseDigest, tier1ByNode: new Map() }), digest: lapseDigest });

    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
    try {
      await runOptimizeLoopCli(
        ['--binding', DISTILL_LOOP, '--rounds', '1', '--staging-dir', path.join(base, 'stage')],
        { scoreRun, print: () => {} },
      );
    } finally {
      (process.stderr as unknown as { write: typeof orig }).write = orig;
    }

    // the ORACLE: the template's memory.md carries the DISTILLED prose (Root echoes the fixer's foundRoot), not the placeholder.
    const hit = deriveRecurrence({ templateDir: path.join(base, 'template'), nodes: [NODE] }).get(`${NODE}::failed`);
    expect(hit?.lesson?.root).toBe('R:traced: loop root cause');
    expect(hit?.lesson?.prevention).toBe('P');
  });
});
