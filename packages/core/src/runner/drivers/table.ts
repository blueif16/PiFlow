// table.ts — the DriverTable + builtinDrivers() factory (docs/design/agent-driver-registry.md §2.2, P1).
//
// The OPEN executor-id → AgentDriver lookup, built per run (code-as-truth; not a hand-edited data file).
// It (a) throws on a duplicate `register` (an id maps to exactly one driver), (b) `get(undefined)` defaults
// to 'pi', (c) `get(unknownId)` FAILS CLOSED — throws an error whose message LISTS the known ids, never a
// silent pi fallback (which would score/run the wrong agent blind). `builtinDrivers()` is a FACTORY
// returning a FRESH table each call (no module-level singleton — hermetic).

import type { AgentDriver } from './types.js';
import type { PiEvent } from '../events.js';
import { nullTranscriptSource, transcriptFor, type TranscriptRef, type TranscriptSource } from '../../observe/transcript.js';
import { piDriver } from './pi.js';
import { claudeCodeDriver } from './claude-code.js';

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

  /**
   * (Defect E1) Pick a driver for an UNSTAMPED record (`driverId` absent — mid-run, or a run written before
   * P3 stamped it) by sniffing the parsed event SAMPLE's vocabulary via each registered driver's
   * `sniffsEvents`. Falls back to 'pi' (via `get(undefined)`, the historical default) when no driver
   * recognizes the sample — an empty or pi-vocabulary sample behaves exactly as it always did. Distinct from
   * `get`: this is the ONLY seam that inspects event shape, so a STAMPED record's lookup never format-sniffs.
   */
  detectUnstamped(sample: PiEvent[]): AgentDriver {
    for (const d of this.list()) {
      if (d.sniffsEvents?.(sample)) return d;
    }
    return this.get(undefined);
  }

  /**
   * (transcript port) The ONE routing seam every inspection verb goes through: a node's stamped executor id
   * → that executor's `TranscriptSource` (observe/transcript.ts). No verb, projection or renderer ever
   * branches on an executor id; they all call this and then read the returned source's `capabilities()`.
   *
   * Deliberately FAIL-SOFT where `get` fails closed: an UNKNOWN id (a run stamped by a build that knew an
   * executor this one does not) yields the honest `nullTranscriptSource` — every verb prints
   * `SKIP: <reason>` — because refusing to render a run's OTHER nodes over one unknown id would be a worse
   * answer than saying which node cannot be read. Routing (choosing a driver) must never be fatal to
   * INSPECTION, only to EXECUTION.
   */
  transcriptFor(id: string | undefined, runDir: string, nodeId: string, ref?: TranscriptRef): TranscriptSource {
    let driver: AgentDriver;
    try {
      driver = this.get(id);
    } catch (e) {
      if (!(e instanceof UnknownDriverError)) throw e;
      return nullTranscriptSource(id ?? 'unknown', `${e.message} — this build cannot read that executor's record`);
    }
    return transcriptFor(driver, runDir, nodeId, ref);
  }
}

/**
 * A FRESH table of the built-in drivers — a FACTORY, not a shared mutable singleton (hermeticity). P2 adds
 * claudeCodeDriver, so the table now holds pi AND claude-code.
 */
export function builtinDrivers(): DriverTable {
  return new DriverTable().register(piDriver).register(claudeCodeDriver);
}
