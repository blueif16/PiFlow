// driver-detect.test.ts — Defect E1 (driver-format detection for UNSTAMPED records).
//
// A legacy run (game-omni's old engine) never stamped `driverId` on ANY node, so `drivers.get(undefined)`
// (table.ts's documented default) always resolves to 'pi' — even for a node whose events.jsonl is REAL
// Claude stream-json. pi's accumulator silently no-ops on Claude's vocabulary (distill.ts's `default: break`),
// so the node renders model:null + all-zero tokens. The fix: `DriverTable.detectUnstamped(sample)` sniffs the
// parsed event sample's VOCABULARY (via each driver's `sniffsEvents`) and picks the matching driver, falling
// back to 'pi' only when no driver recognizes the sample — so an UNSTAMPED pi run (also historically common
// pre-P3) keeps folding through pi exactly as before.
//
// This is a NEW seam (`DriverTable.detectUnstamped`), distinct from `get()`: `get()`'s contract (undefined→pi,
// unknown id→FAIL CLOSED) is UNCHANGED — these tests pin that guarantee alongside the new detection.
//
// Run: npx vitest run packages/core/test/driver-detect.test.ts

import { describe, it, expect } from 'vitest';
import { builtinDrivers, UnknownDriverError } from '../src/runner/drivers/table.js';
import { piDriver } from '../src/runner/drivers/pi.js';
import { claudeCodeDriver } from '../src/runner/drivers/claude-code.js';
import type { PiEvent } from '../src/runner/events.js';

describe('DriverTable.detectUnstamped — format-sniffs an UNSTAMPED sample (Defect E1)', () => {
  it('picks claude-code when the sample carries an "assistant" event (Claude stream-json vocabulary)', () => {
    const drivers = builtinDrivers();
    const sample: PiEvent[] = [
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', usage: { input_tokens: 1 } } },
    ];
    expect(drivers.detectUnstamped(sample).id).toBe('claude-code');
  });

  it('picks claude-code when the sample carries a "result" event (the terminal Claude event)', () => {
    const drivers = builtinDrivers();
    const sample: PiEvent[] = [{ type: 'result', subtype: 'success', is_error: false }];
    expect(drivers.detectUnstamped(sample).id).toBe('claude-code');
  });

  it('falls back to pi when the sample is pi vocabulary (message_start/tool_execution_*)', () => {
    const drivers = builtinDrivers();
    const sample: PiEvent[] = [
      { type: 'message_start', message: { role: 'assistant', model: 'm1' } },
      { type: 'tool_execution_start', toolName: 'read', toolCallId: 'a', args: { path: '/p' } },
    ];
    expect(drivers.detectUnstamped(sample).id).toBe('pi');
  });

  it('falls back to pi when the sample is empty (no events yet / a never-started node)', () => {
    const drivers = builtinDrivers();
    expect(drivers.detectUnstamped([]).id).toBe('pi');
  });
});

describe('claudeCodeDriver.sniffsEvents — recognizes Claude vocabulary; piDriver does not claim it', () => {
  it('claudeCodeDriver.sniffsEvents(sample) is true for assistant/result, false for pi vocabulary', () => {
    expect(claudeCodeDriver.sniffsEvents?.([{ type: 'assistant' }])).toBe(true);
    expect(claudeCodeDriver.sniffsEvents?.([{ type: 'result' }])).toBe(true);
    expect(claudeCodeDriver.sniffsEvents?.([{ type: 'message_start' }, { type: 'tool_execution_start' }])).toBe(false);
    expect(claudeCodeDriver.sniffsEvents?.([])).toBe(false);
  });

  it('piDriver does not implement sniffsEvents (it is the table-level fallback, not a sniffer)', () => {
    expect(piDriver.sniffsEvents).toBeUndefined();
  });
});

describe('DriverTable.get — UNCHANGED by the new detectUnstamped seam (guard)', () => {
  it('get(undefined) still defaults to pi', () => {
    expect(builtinDrivers().get(undefined).id).toBe('pi');
  });
  it('get("claude-code") / get("pi") still resolve directly by stamped id (no sniffing involved)', () => {
    const drivers = builtinDrivers();
    expect(drivers.get('claude-code').id).toBe('claude-code');
    expect(drivers.get('pi').id).toBe('pi');
  });
  it('get(unknown id) still FAILS CLOSED — never silently defaults to pi', () => {
    const drivers = builtinDrivers();
    expect(() => drivers.get('some-third-executor')).toThrow(UnknownDriverError);
  });
});
