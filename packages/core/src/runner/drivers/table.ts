// table.ts — the DriverTable + builtinDrivers() factory (docs/design/agent-driver-registry.md §2.2, P1).
//
// STUB (P1 test-first): the shape compiles and the tests run RED for the missing-behavior reason. The REAL
// table (a) throws a DriverConflictError on a duplicate `register`, (b) `get(undefined)` defaults to 'pi',
// (c) `get(unknownId)` FAILS CLOSED — throws an error whose message LISTS the known ids (never a silent pi
// fallback). `builtinDrivers()` is a FACTORY returning a FRESH table each call (no module-level singleton).
// The next agent replaces the placeholder bodies.

import type { AgentDriver } from './types.js';
import { piDriver } from './pi.js';

/**
 * An executor-id → AgentDriver lookup, built per run (code-as-truth; not a hand-edited data file). STUB
 * bodies do NOT fail-closed and do NOT throw on a duplicate — so the P1 tests fail on the assertion, not on
 * an import/type error.
 */
export class DriverTable {
  private m = new Map<string, AgentDriver>();

  // STUB: the real body throws DriverConflictError when `d.id` is already registered.
  register(d: AgentDriver): this {
    this.m.set(d.id, d);
    return this;
  }

  // STUB: does NOT fail-closed — returns piDriver on any miss (unknown OR undefined) instead of throwing
  // with the known-id list. The real body: get(undefined) → 'pi'; get(unknownId) → throw (lists known ids).
  get(id: string | undefined): AgentDriver {
    return this.m.get(id ?? '') ?? piDriver;
  }

  ids(): string[] {
    return [...this.m.keys()];
  }

  list(): AgentDriver[] {
    return [...this.m.values()];
  }
}

/**
 * A FRESH table of the built-in drivers — a FACTORY, not a shared mutable singleton (hermeticity). In P1 it
 * registers ONLY piDriver (claude-code is P2).
 */
export function builtinDrivers(): DriverTable {
  return new DriverTable().register(piDriver);
}
