// driver-parity.test.ts — P0 of the AgentDriver registry (docs/design/agent-driver-registry.md §6 P0).
//
// This FREEZES the telemetry-parity contract every future driver must obey, BEFORE any driver exists. The
// contract: a driver whose descriptor claims `telemetry.usageRollup` MUST return a `NodeUsage` from `parseResult`
// carrying the token spine the observe surface reads (contextWindow — the context-pressure denominator; cost when
// costReported; the input/output token counts) — otherwise a registered agent would be scored BLIND (the exact
// hole Thrust 1 closed for Claude, now a typed obligation). A driver that does NOT claim usageRollup (pi — its
// telemetry comes from the event replay) may leave usage undefined.
//
// The teeth: `conformsToParity` returns problems iff a driver's descriptor over-claims vs what parseResult
// delivers. The test-the-test cases mutate a conforming driver to DROP cost / DROP contextWindow and assert the
// check goes RED — a conformance gate that can't fail is theater. No runtime is wired in P0.
import { describe, it, expect } from 'vitest';
import { conformsToParity } from '../src/runner/drivers/parity.js';
import type { AgentDriver, AgentDriverDescriptor, RawRun } from '../src/runner/drivers/types.js';
import { parseClaudeResult, nodeUsageFromClaude } from '../src/runner/claude-result.js';
import { lastJsonBlock } from '../src/runner/return-parse.js';

// A realistic Claude `--output-format stream-json` capture: init, a turn, then the ONE authoritative `result`
// event (NOT necessarily last — trailing system events are allowed). This is the only line the parity numbers
// come from.
const CLAUDE_RESULT_STDOUT = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }),
  JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1',
    result: 'done', num_turns: 3, duration_ms: 4200, ttft_ms: 900, stop_reason: 'end_turn',
    total_cost_usd: 0.1234,
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
    modelUsage: { 'claude-sonnet-4': { contextWindow: 200000 } },
  }),
  JSON.stringify({ type: 'system', subtype: 'hook_response' }),
].join('\n');

// A pi node's stdout: a self-report JSON block, NO `result` event (pi telemetry comes from the events.jsonl fold).
const PI_STDOUT = 'some log line\n' + JSON.stringify({ status: 'complete', summary: 'wrote the file' });

const raw = (stdout: string): RawRun => ({ stdout, exitCode: 0, killed: null });

// ── proto drivers — P0 has no REAL drivers (those are P1/P2); these minimal shapes exercise the contract ──
type ParityFace = Pick<AgentDriver, 'describe' | 'parseResult'>;

function descriptor(id: string, telemetry: AgentDriverDescriptor['telemetry']): AgentDriverDescriptor {
  return {
    id, label: id, version: 1, runtime: 'cli', binary: id,
    model: { tierAware: true, providerRouting: false, resolvesThrows: false },
    tools: { grammar: 'pi-bare', supportsCustom: true, supportsMcp: true, supportsSkills: true, builtinMap: () => ({}) },
    sandbox: { providers: ['local'] },
    telemetry,
    costModel: 'per-token',
  };
}

// The composed Claude parity path (what claudeCodeDriver.parseResult will wrap in P2): parseClaudeResult → NodeUsage.
function claudeProto(over?: { parseResult?: ParityFace['parseResult'] }): ParityFace {
  return {
    describe: () => descriptor('claude-code', { usageRollup: true, perToolTimeline: 'count-only', loopSignal: true, costReported: true }),
    parseResult: over?.parseResult ?? ((r) => {
      const cv = parseClaudeResult(r.stdout);
      return { verdict: { ok: cv.ok, selfReport: null, sessionId: cv.sessionId }, usage: nodeUsageFromClaude(cv) };
    }),
  };
}

// The pi parity path (P1): a self-report verdict, usage undefined (telemetry rides the event fold, not parseResult).
function piProto(): ParityFace {
  return {
    describe: () => descriptor('pi', { usageRollup: false, perToolTimeline: 'full', loopSignal: true, costReported: true }),
    parseResult: (r) => {
      const sr = lastJsonBlock(r.stdout);
      return { verdict: { ok: true, selfReport: sr ? { status: 'complete', summary: sr.summary } : null }, usage: undefined };
    },
  };
}

describe('conformsToParity — the AgentDriver telemetry-parity contract (P0)', () => {
  it('a usageRollup driver that returns the full NodeUsage CONFORMS', () => {
    const r = conformsToParity(claudeProto(), raw(CLAUDE_RESULT_STDOUT));
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it('FREEZES the Claude parity shape — the exact token/cost/context spine reaches NodeUsage', () => {
    const { usage } = claudeProto().parseResult(raw(CLAUDE_RESULT_STDOUT));
    // independently justified: every field is read straight off the fixture's result event, no derivation.
    expect(usage).toEqual({
      inputTokens: 1000, outputTokens: 200, cacheRead: 50, cacheCreation: 10,
      cost: 0.1234, contextWindow: 200000, ttftMs: 900, numTurns: 3, stopReason: 'end_turn',
    });
  });

  it('a usageRollup driver that DROPS cost FAILS the contract (test-the-test teeth)', () => {
    const broken = claudeProto({
      parseResult: (r) => {
        const cv = parseClaudeResult(r.stdout);
        return { verdict: { ok: cv.ok, selfReport: null }, usage: { ...nodeUsageFromClaude(cv)!, cost: undefined } };
      },
    });
    const r = conformsToParity(broken, raw(CLAUDE_RESULT_STDOUT));
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/cost/);
  });

  it('a usageRollup driver that DROPS contextWindow FAILS (the denominator would fall to the 200k default)', () => {
    const broken = claudeProto({
      parseResult: (r) => {
        const cv = parseClaudeResult(r.stdout);
        return { verdict: { ok: cv.ok, selfReport: null }, usage: { ...nodeUsageFromClaude(cv)!, contextWindow: undefined } };
      },
    });
    const r = conformsToParity(broken, raw(CLAUDE_RESULT_STDOUT));
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/contextWindow/);
  });

  it('a usageRollup driver that returns NO usage at all FAILS', () => {
    const broken = claudeProto({ parseResult: () => ({ verdict: { ok: true, selfReport: null }, usage: undefined }) });
    const r = conformsToParity(broken, raw(CLAUDE_RESULT_STDOUT));
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/usageRollup/);
  });

  it('a pi driver (usageRollup:false) may leave usage undefined and CONFORMS', () => {
    const r = conformsToParity(piProto(), raw(PI_STDOUT));
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
  });
});
