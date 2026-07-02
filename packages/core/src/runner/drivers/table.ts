// table.ts — the DriverTable + builtinDrivers() factory (docs/design/agent-driver-registry.md §2.2, P1).
//
// The OPEN executor-id → AgentDriver lookup, built per run (code-as-truth; not a hand-edited data file).
// It (a) throws on a duplicate `register` (an id maps to exactly one driver), (b) `get(undefined)` defaults
// to 'pi', (c) `get(unknownId)` FAILS CLOSED — throws an error whose message LISTS the known ids, never a
// silent pi fallback (which would score/run the wrong agent blind). `builtinDrivers()` is a FACTORY
// returning a FRESH table each call (no module-level singleton — hermetic).

import type { AgentDriver } from './types.js';
import { piDriver } from './pi.js';

/** Thrown when two drivers are registered under the same id — an id maps to exactly one driver. */
export class DriverConflictError extends Error {
  constructor(id: string) {
    super(`driver id '${id}' is already registered — an executor id maps to exactly one driver`);
    this.name = 'DriverConflictError';
  }
}

/** Thrown by `get` on an unknown id — FAILS CLOSED, listing the registered ids so the miss is legible. */
export class UnknownDriverError extends Error {
  constructor(id: string, known: string[]) {
    super(`unknown driver id '${id}' — registered ids: ${known.join(', ') || 'none'}`);
    this.name = 'UnknownDriverError';
  }
}

/**
 * An executor-id → AgentDriver lookup, built per run (code-as-truth; not a hand-edited data file).
 */
export class DriverTable {
  private m = new Map<string, AgentDriver>();

  /** Register a driver under its `id`; throws `DriverConflictError` on a duplicate id. Chainable. */
  register(d: AgentDriver): this {
    if (this.m.has(d.id)) throw new DriverConflictError(d.id);
    this.m.set(d.id, d);
    return this;
  }

  /**
   * Look up a driver. `undefined` defaults to 'pi' (the design contract: `this.m.get(id ?? 'pi')`); an
   * UNKNOWN id FAILS CLOSED — throws `UnknownDriverError` listing the known ids, never a silent pi fallback.
   */
  get(id: string | undefined): AgentDriver {
    const key = id ?? 'pi';
    const d = this.m.get(key);
    if (!d) throw new UnknownDriverError(key, this.ids());
    return d;
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
