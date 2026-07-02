// parity.ts — the telemetry-parity conformance gate (docs/design/agent-driver-registry.md §4 / §6 P0).
//
// A driver's DECLARED telemetry (describe().telemetry) is a promise; this checks it against what parseResult
// actually delivers, so a driver cannot claim a rollup it does not produce — which would silently score that
// agent BLIND (the exact hole Thrust 1 closed for Claude, now a typed obligation). Reusable by every driver's
// test (P1/P2/P5): feed it a telemetry-bearing fixture run and it returns the concrete promise-vs-reality gaps.
import type { AgentDriver, RawRun } from './types.js';

export interface ParityReport {
  ok: boolean;
  /** concrete promise-vs-delivery gaps (empty ⇒ conforms). */
  problems: string[];
}

/**
 * Assert a driver honors its own telemetry contract on a telemetry-bearing run. A driver that declares
 * `telemetry.usageRollup` MUST return a `NodeUsage` from `parseResult` carrying the spine the observe surface
 * reads: `contextWindow` (the context-pressure denominator — absent ⇒ it falls to the 200k default), `cost`
 * (when `costReported`), and at least one of input/output token counts. A driver that does NOT claim a rollup
 * (pi — telemetry rides the event fold) is unconstrained here. PURE.
 */
export function conformsToParity(
  driver: Pick<AgentDriver, 'describe' | 'parseResult'>,
  telemetryFixture: RawRun,
): ParityReport {
  const problems: string[] = [];
  const d = driver.describe();
  const t = d.telemetry;
  const { usage } = driver.parseResult(telemetryFixture);

  if (t.usageRollup) {
    if (!usage) {
      problems.push(
        `driver '${d.id}' declares telemetry.usageRollup=true but parseResult returned no usage on a telemetry-bearing run`,
      );
    } else {
      if (usage.contextWindow == null) {
        problems.push(
          `driver '${d.id}' usageRollup=true but usage.contextWindow is absent — the context-pressure denominator would fall to the default`,
        );
      }
      if (t.costReported && usage.cost == null) {
        problems.push(`driver '${d.id}' telemetry.costReported=true but usage.cost is absent`);
      }
      if (usage.inputTokens == null && usage.outputTokens == null) {
        problems.push(`driver '${d.id}' usageRollup=true but usage carries no input/output token counts`);
      }
    }
  }

  return { ok: problems.length === 0, problems };
}
