// pi-driver.test.ts — P1 of the AgentDriver registry (docs/design/agent-driver-registry.md §6 P1).
//
// P1 builds the first REAL driver (`piDriver`, wrapping the shipped pi functions with ZERO behavior change)
// and the open table it lives in (`DriverTable` + the `builtinDrivers()` factory). These tests pin the
// acceptance bar as FAILING tests BEFORE the real bodies exist — a test has value iff it FAILS when the
// wrapping is wrong. The oracle for byte-identity is the LIVE `defaultPiCommand` (not a pasted literal); the
// oracle for parseResult is `lastJsonBlock` applied to the SAME stdout we construct.
import { describe, it, expect } from 'vitest';
import { piDriver } from '../src/runner/drivers/pi.js';
import { builtinDrivers, DriverTable } from '../src/runner/drivers/table.js';
import { conformsToParity } from '../src/runner/drivers/parity.js';
import type { AgentDriver, RawRun } from '../src/runner/drivers/types.js';
import { defaultPiCommand, type CommandContext } from '../src/runner/command.js';
import { lastJsonBlock } from '../src/runner/return-parse.js';
import type { NodeSpec, ResolveResult, PiCommandOptions } from '../src/types.js';

// ── fixtures for the byte-identity oracle (test 1). Two representative node/ctx pairs: a bare-builtin node
//    with no model pin, and a model-pinned node with a denied tool + a staged extension. ──
const NODE_A: NodeSpec = { id: 'greet', label: 'greet', prompt: 'say hi' };
const RESOLVED_A: ResolveResult = { piTools: ['read', 'write'] };
const CTX_A: CommandContext = { promptFile: '/run/greet/prompt.md' };

const NODE_B: NodeSpec = { id: 'fix', label: 'fix', prompt: 'fix the bug', model: 'deepseek-v3' };
const RESOLVED_B: ResolveResult = { piTools: ['read', 'edit', 'bash'], excludeTools: ['find'] };
const CTX_B: CommandContext = {
  promptFile: '/run/fix/prompt.md',
  model: 'deepseek-v3',
  provider: 'openrouter',
  extensionFile: '/run/fix/_pi/ext.mjs',
};
const OPTS_B: PiCommandOptions = { thinking: 'low' };

const raw = (stdout: string): RawRun => ({ stdout, exitCode: 0, killed: null });

// A pi node's stdout: log lines + a fenced self-report JSON block (pi telemetry comes from the events.jsonl
// fold, NOT this block — parseResult's usage is undefined). The independently-justified selfReport is exactly
// what `lastJsonBlock` recovers from this same text.
const PI_STDOUT =
  'starting node\nwrote src/foo.ts\n' +
  '```json\n' +
  JSON.stringify({ status: 'complete', summary: 'wrote the file', issues: [] }) +
  '\n```\n';

describe('piDriver — wraps the shipped pi functions with zero behavior change (P1)', () => {
  it('buildCommand is BYTE-IDENTICAL to defaultPiCommand for the same already-resolved inputs', () => {
    // Oracle = the LIVE defaultPiCommand output, computed here — never a pasted literal.
    expect(piDriver.buildCommand(NODE_A, RESOLVED_A, CTX_A)).toBe(
      defaultPiCommand(NODE_A, RESOLVED_A, CTX_A),
    );
    expect(piDriver.buildCommand(NODE_B, RESOLVED_B, CTX_B, OPTS_B)).toBe(
      defaultPiCommand(NODE_B, RESOLVED_B, CTX_B, OPTS_B),
    );
  });

  it('parseResult returns usage:undefined (pi telemetry rides the event fold) and a selfReport from lastJsonBlock', () => {
    const { verdict, usage } = piDriver.parseResult(raw(PI_STDOUT));
    // pi never rolls up usage in parseResult — the event fold wins (design §4, obligation 1).
    expect(usage).toBeUndefined();
    // The selfReport is independently justified: it reflects lastJsonBlock of the SAME stdout.
    const block = lastJsonBlock(PI_STDOUT);
    expect(block).not.toBeNull();
    expect(verdict.selfReport).not.toBeNull();
    expect(verdict.selfReport?.status).toBe(block?.status);
    expect(verdict.selfReport?.summary).toBe(block?.summary);
  });

  it('conformsToParity passes — pi declares usageRollup:false so it is unconstrained (regression guard)', () => {
    // NOTE: this may be GREEN against a correct-SHAPED stub (usageRollup:false + usage undefined already
    // conform). It is kept as a regression guard that the real piDriver never over-claims a rollup.
    const r = conformsToParity(piDriver, raw(PI_STDOUT));
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
  });
});

describe('DriverTable + builtinDrivers() — the open executor→strategy lookup (P1)', () => {
  it('get("pi") is the pi driver; get(undefined) defaults to pi; get("nope") THROWS listing the known ids', () => {
    const drivers = builtinDrivers();
    expect(drivers.get('pi')).toBe(piDriver);
    // undefined defaults to 'pi' (the design contract: `this.m.get(id ?? 'pi')`).
    expect(drivers.get(undefined)).toBe(piDriver);
    // an unknown id FAILS CLOSED — never a silent pi fallback.
    let thrown: unknown;
    try {
      drivers.get('nope');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    // the message must LIST the known ids so the author can see what IS registered.
    expect((thrown as Error).message).toContain('pi');
    expect((thrown as Error).message).toContain('nope');
  });

  it('builtinDrivers() is a FACTORY — two calls are DISTINCT tables and registering into one is invisible in the other', () => {
    const a = builtinDrivers();
    const b = builtinDrivers();
    expect(a).not.toBe(b); // fresh instance each call — no module-level singleton
    const fake: AgentDriver = { ...piDriver, id: 'fake' };
    a.register(fake);
    expect(a.ids()).toContain('fake');
    // hermeticity: b never saw the registration into a.
    expect(b.ids()).not.toContain('fake');
    expect(() => b.get('fake')).toThrow();
  });

  it('register throws on a duplicate id (code-as-truth: an id maps to exactly one driver)', () => {
    const t = new DriverTable().register(piDriver);
    expect(() => t.register(piDriver)).toThrow();
  });
});
