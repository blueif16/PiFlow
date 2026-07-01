// parseClaudeResult — parses the stdout of a headless `claude -p --output-format stream-json --verbose`
// run into the normalized ClaudeRunResult (result + telemetry). PURE LOGIC gate (test-discipline §0).
//
// The load-bearing behavior: the stream is NDJSON and the single `type==="result"` event is NOT
// necessarily the last line — trailing `system` events (e.g. hook_response) can follow it. So the
// parser must SCAN for the result event, never `tail -1`. Test (b) below is the teeth: a last-line
// impl MUST fail it. Each test asserts ONE behavior, against realistic captured fixtures.

import { describe, it, expect } from 'vitest';
import { parseClaudeResult, nodeUsageFromClaude } from '../src/runner/claude-result.js';

// The authentic `result` line from a real captured run (verbatim from the executor design fixture).
const RESULT_LINE =
  '{"type":"result","subtype":"success","is_error":false,"api_error_status":null,"duration_ms":6165,"duration_api_ms":6010,"ttft_ms":1712,"num_turns":2,"result":"Created `hello.txt` with the exact contents `piflow-claude-ok`.","stop_reason":"end_turn","session_id":"e6a04f17-212b-450b-9fdf-5c6d47d85267","total_cost_usd":0.6869200000000001,"usage":{"input_tokens":3,"cache_creation_input_tokens":68268,"cache_read_input_tokens":0,"output_tokens":169,"service_tier":"standard"},"modelUsage":{"claude-opus-4-8[1m]":{"inputTokens":3,"outputTokens":169,"cacheReadInputTokens":0,"cacheCreationInputTokens":68268,"costUSD":0.6869200000000001}},"terminal_reason":"completed","uuid":"b0f2e38a-182d-4164-8c85-82296ae7212f"}';

// A realistic `system` init line (first NDJSON line of a real run).
const SYSTEM_INIT =
  '{"type":"system","subtype":"init","session_id":"e6a04f17-212b-450b-9fdf-5c6d47d85267","model":"claude-opus-4-8[1m]","cwd":"/tmp/work","tools":["Read","Write","Bash"],"uuid":"aaaa1111-0000-0000-0000-000000000000"}';

// A trailing `system` event that, in a real run, came AFTER the result line.
const SYSTEM_TRAILING =
  '{"type":"system","subtype":"hook_response","session_id":"e6a04f17-212b-450b-9fdf-5c6d47d85267","uuid":"cccc3333-0000-0000-0000-000000000000"}';

describe('parseClaudeResult — stream-json stdout parser', () => {
  it('(a) parses the authentic result line: ok + telemetry + cost', () => {
    const r = parseClaudeResult(RESULT_LINE);
    expect(r.ok).toBe(true);
    expect(r.isError).toBe(false);
    expect(r.subtype).toBe('success');
    expect(r.sessionId).toBe('e6a04f17-212b-450b-9fdf-5c6d47d85267');
    expect(r.text).toBe('Created `hello.txt` with the exact contents `piflow-claude-ok`.');
    expect(r.model).toBe('claude-opus-4-8[1m]');
    expect(r.numTurns).toBe(2);
    expect(r.durationMs).toBe(6165);
    expect(r.cost?.usd).toBeCloseTo(0.68692, 5);
    expect(r.cost?.inputTokens).toBe(3);
    expect(r.cost?.outputTokens).toBe(169);
    expect(r.cost?.cacheRead).toBe(0);
    expect(r.cost?.cacheCreation).toBe(68268);
    // (spine) the result event carries these natively — lift them so the observe surface can source them.
    expect(r.ttftMs).toBe(1712);
    expect(r.stopReason).toBe('end_turn');
  });

  it('(a2) lifts the per-run context window from modelUsage[model].contextWindow', () => {
    // A real result line whose modelUsage block carries the context window (+ max output) as Claude emits.
    const withCaps =
      '{"type":"result","subtype":"success","is_error":false,"num_turns":2,"result":"Done.","stop_reason":"end_turn","session_id":"s1","total_cost_usd":0.013,"usage":{"input_tokens":18,"cache_creation_input_tokens":4790,"cache_read_input_tokens":17172,"output_tokens":337},"modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":18,"outputTokens":337,"cacheReadInputTokens":17172,"cacheCreationInputTokens":4790,"costUSD":0.013,"contextWindow":200000,"maxOutputTokens":32000}}}';
    const r = parseClaudeResult(withCaps);
    expect(r.model).toBe('claude-haiku-4-5-20251001');
    expect(r.contextWindow).toBe(200000);
    // num_turns is the REAL invocation count — never a per-assistant-line count.
    expect(r.numTurns).toBe(2);
  });

  it('(b) finds the result even when it is NOT the last line (trailing system event)', () => {
    // Order matches a real run: init, result, THEN a trailing hook_response system event.
    const stdout = [SYSTEM_INIT, RESULT_LINE, SYSTEM_TRAILING].join('\n');
    const r = parseClaudeResult(stdout);
    expect(r.ok).toBe(true);
    expect(r.isError).toBe(false);
    expect(r.sessionId).toBe('e6a04f17-212b-450b-9fdf-5c6d47d85267');
    expect(r.text).toBe('Created `hello.txt` with the exact contents `piflow-claude-ok`.');
  });

  it('(c) no result event (only system / empty) → ok=false, isError=true, no session', () => {
    const onlySystem = parseClaudeResult(SYSTEM_INIT);
    expect(onlySystem.ok).toBe(false);
    expect(onlySystem.isError).toBe(true);
    expect(onlySystem.sessionId).toBeUndefined();

    const empty = parseClaudeResult('');
    expect(empty.ok).toBe(false);
    expect(empty.isError).toBe(true);
    expect(empty.sessionId).toBeUndefined();
  });

  it('(d) non-success result (error_max_turns, is_error:true) → not ok, subtype preserved', () => {
    const errLine =
      '{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":50,"session_id":"f00d","result":"Reached max turns.","uuid":"dddd"}';
    const r = parseClaudeResult([SYSTEM_INIT, errLine].join('\n'));
    expect(r.ok).toBe(false);
    expect(r.isError).toBe(true);
    expect(r.subtype).toBe('error_max_turns');
    expect(r.sessionId).toBe('f00d');
  });

  it('(e) interleaved blank + malformed lines are skipped (does not throw)', () => {
    const stdout = ['', '   ', 'not json at all {{{', SYSTEM_INIT, '}}} also broken', RESULT_LINE, ''].join('\n');
    expect(() => parseClaudeResult(stdout)).not.toThrow();
    const r = parseClaudeResult(stdout);
    expect(r.ok).toBe(true);
    expect(r.text).toBe('Created `hello.txt` with the exact contents `piflow-claude-ok`.');
  });

  it('(f) nodeUsageFromClaude maps the result telemetry into the agent-neutral NodeUsage spine', () => {
    const withCaps =
      '{"type":"result","subtype":"success","is_error":false,"num_turns":2,"result":"Done.","stop_reason":"end_turn","session_id":"s1","total_cost_usd":0.013,"usage":{"input_tokens":18,"cache_creation_input_tokens":4790,"cache_read_input_tokens":17172,"output_tokens":337},"modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":18,"outputTokens":337,"cacheReadInputTokens":17172,"cacheCreationInputTokens":4790,"costUSD":0.013,"contextWindow":200000,"maxOutputTokens":32000}}}';
    const u = nodeUsageFromClaude(parseClaudeResult(withCaps));
    expect(u).toBeDefined();
    expect(u!.inputTokens).toBe(18);
    expect(u!.outputTokens).toBe(337);
    expect(u!.cacheRead).toBe(17172);
    expect(u!.cacheCreation).toBe(4790);
    expect(u!.cost).toBeCloseTo(0.013, 5);
    expect(u!.contextWindow).toBe(200000);
    expect(u!.numTurns).toBe(2);
    expect(u!.stopReason).toBe('end_turn');
  });

  it('(g) nodeUsageFromClaude returns undefined when the run had no result telemetry', () => {
    expect(nodeUsageFromClaude(parseClaudeResult(''))).toBeUndefined();
    expect(nodeUsageFromClaude(parseClaudeResult(SYSTEM_INIT))).toBeUndefined();
  });
});
