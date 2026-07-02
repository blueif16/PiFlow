// claude-code-driver.test.ts — P2 of the AgentDriver registry (docs/design/agent-driver-registry.md §6 P2).
//
// P2 builds the SECOND real driver (`claudeCodeDriver`) — a THIN WRAPPER over the shipped claude functions,
// so wiring the runner through it (P3) is byte-identical to today's `dispatchCommand`/`effectiveModel`
// ternaries. These tests pin the acceptance bar as FAILING tests BEFORE the real bodies exist (a test has
// value iff it FAILS when the wrapping is wrong). Every oracle is a LIVE shipped function — never a pasted
// literal: byte-identity ⇒ live `claudeCommand`; model ⇒ live `effectiveModel` (claude branch); the usage
// spine ⇒ live `nodeUsageFromClaude(parseClaudeResult(...))`; the tool map ⇒ the live `CLAUDE_TOOL_BY_PI_NAME`
// const imported from command.ts (a GETTER, not a copy — §3).
import { describe, it, expect } from 'vitest';
import { claudeCodeDriver } from '../src/runner/drivers/claude-code.js';
import { builtinDrivers } from '../src/runner/drivers/table.js';
import { piDriver } from '../src/runner/drivers/pi.js';
import { conformsToParity } from '../src/runner/drivers/parity.js';
import type { RawRun } from '../src/runner/drivers/types.js';
import { claudeCommand, CLAUDE_TOOL_BY_PI_NAME, type CommandContext } from '../src/runner/command.js';
import { effectiveModel, type NodeRouting, type RunRouting } from '../src/runner/model-routing.js';
import { parseClaudeResult, nodeUsageFromClaude } from '../src/runner/claude-result.js';
import type { NodeSpec, ResolveResult, PiCommandOptions } from '../src/types.js';

// ── fixtures for the byte-identity oracle (test 1). A representative claude-code node: a model pin, a mapped
//    builtin set, a denied tool, an effort. claudeCommand reads only resolved/ctx/opts, never `node`. ──
const CLAUDE_NODE: NodeSpec = { id: 'fix', label: 'fix', prompt: 'fix the bug', executor: 'claude-code' };
const CLAUDE_RESOLVED: ResolveResult = { piTools: ['read', 'write', 'edit', 'grep', 'bash'], excludeTools: ['find'] };
const CLAUDE_CTX: CommandContext = { promptFile: '_pi/fix/prompt.md', model: 'claude-opus-4-8' };
const CLAUDE_OPTS: PiCommandOptions = { thinking: 'medium' };

const raw = (stdout: string): RawRun => ({ stdout, exitCode: 0, killed: null });

// A REAL claude `--output-format stream-json` capture (mirrors the P0 test's CLAUDE_RESULT_STDOUT): init, a
// turn, then the ONE authoritative `result` event (NOT necessarily last — trailing system events allowed).
// The token/cost/context numbers below all come straight off this event; nothing is derived.
const CLAUDE_RESULT_STDOUT = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-9' }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }),
  JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, session_id: 'sess-9',
    result: 'done', num_turns: 3, duration_ms: 4200, ttft_ms: 900, stop_reason: 'end_turn',
    total_cost_usd: 0.1234,
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
    modelUsage: { 'claude-sonnet-4': { contextWindow: 200000 } },
  }),
  JSON.stringify({ type: 'system', subtype: 'hook_response' }),
].join('\n');

describe('claudeCodeDriver — wraps the shipped claude functions with zero behavior change (P2)', () => {
  it('buildCommand is BYTE-IDENTICAL to claudeCommand for the same already-resolved inputs', () => {
    // Oracle = the LIVE claudeCommand output, computed here — never a pasted literal.
    expect(claudeCodeDriver.buildCommand(CLAUDE_NODE, CLAUDE_RESOLVED, CLAUDE_CTX, CLAUDE_OPTS)).toBe(
      claudeCommand(CLAUDE_NODE, CLAUDE_RESOLVED, CLAUDE_CTX, CLAUDE_OPTS),
    );
  });

  it('resolveModel deep-equals effectiveModel(node, run) for a claude-code node (bare pin AND a claude tier)', () => {
    // (a) an explicit claude model pin — provider is always undefined on the claude branch.
    const pinnedNode: NodeRouting = { model: 'claude-opus-4-8', executor: 'claude-code' };
    const run: RunRouting = {};
    expect(claudeCodeDriver.resolveModel(pinnedNode, run)).toEqual(effectiveModel(pinnedNode, run));

    // (b) a tier that resolves via the claude tier map — exercises the claude routing branch, not just a pass-through.
    const tierNode: NodeRouting = { tier: 'deep', executor: 'claude-code' };
    const tierRun: RunRouting = { tiers: { active: true, tiers: { deep: 'deepseek-v3' }, claude: { deep: 'opus' } } };
    expect(claudeCodeDriver.resolveModel(tierNode, tierRun)).toEqual(effectiveModel(tierNode, tierRun));
  });

  it('parseResult.usage deep-equals nodeUsageFromClaude(parseClaudeResult(stdout)) — the full token/cost/context spine', () => {
    const { verdict, usage } = claudeCodeDriver.parseResult(raw(CLAUDE_RESULT_STDOUT));
    // Oracle = the LIVE composed claude parse path, computed here from the SAME stdout.
    const cv = parseClaudeResult(CLAUDE_RESULT_STDOUT);
    expect(usage).toEqual(nodeUsageFromClaude(cv));
    // verdict.ok / sessionId come straight from the parsed cv (independently justified off the fixture).
    expect(verdict.ok).toBe(cv.ok);
    expect(verdict.sessionId).toBe(cv.sessionId);
  });

  it('conformsToParity is ok — usageRollup:true ⇒ contextWindow + cost + tokens all present', () => {
    const r = conformsToParity(claudeCodeDriver, raw(CLAUDE_RESULT_STDOUT));
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it('describe().tools.builtinMap() IS the live CLAUDE_TOOL_BY_PI_NAME const (a getter, never a copy)', () => {
    const map = claudeCodeDriver.describe().tools.builtinMap();
    // content matches the live const...
    expect(map).toEqual(CLAUDE_TOOL_BY_PI_NAME);
    // ...AND it is the SAME reference (a getter over the ONE const, not a snapshot copy that could drift).
    expect(map).toBe(CLAUDE_TOOL_BY_PI_NAME);
    // teeth: because it is the live const, a fresh getter call reflects any change to the source const.
    const before = CLAUDE_TOOL_BY_PI_NAME.read;
    try {
      (CLAUDE_TOOL_BY_PI_NAME as Record<string, string>).read = 'MUTATED';
      expect(claudeCodeDriver.describe().tools.builtinMap().read).toBe('MUTATED');
    } finally {
      (CLAUDE_TOOL_BY_PI_NAME as Record<string, string>).read = before;
    }
  });

  it('describe() carries the claude static card fields (dropped drops `ls`; claude creds inject/strip)', () => {
    const d = claudeCodeDriver.describe();
    expect(d.id).toBe('claude-code');
    expect(d.tools.grammar).toBe('claude-builtin');
    // `ls` has no Claude-native tool ⇒ it is the dropped pi name (see command.ts:97 + claude-command test).
    expect(d.tools.dropped).toContain('ls');
    // the claude credential coupling: inject the OAuth token, strip the API-key vars.
    expect(d.sandbox.authInjectEnv).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(d.sandbox.stripEnv).toEqual(expect.arrayContaining(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']));
    expect(d.telemetry.usageRollup).toBe(true);
    expect(d.costModel).toBe('subscription-flat');
  });
});

describe('builtinDrivers() — the table now holds pi AND claude-code (P2)', () => {
  it('get("claude-code") is the claudeCodeDriver and ids() contains both "pi" and "claude-code"', () => {
    const drivers = builtinDrivers();
    // ids first (a value comparison that FAILS cleanly against a mis-registered stub, before any throwing get()).
    expect(drivers.ids()).toEqual(expect.arrayContaining(['pi', 'claude-code']));
    expect(drivers.get('pi')).toBe(piDriver);
    expect(drivers.get('claude-code')).toBe(claudeCodeDriver);
  });
});
