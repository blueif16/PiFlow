// types.ts — the AgentDriver contract (docs/design/agent-driver-registry.md §2.3). P0 FREEZES the shape; NO
// runtime is wired here (that is P1+). A driver is the per-node RUNTIME STRATEGY for one executor — the ONE
// object the four hardcoded `node.executor === 'claude-code'` ternaries (command build, model resolution,
// credential staging, verdict/telemetry parse) collapse into, keyed in an open DriverTable by a string id.
//
// The load-bearing member is the TELEMETRY-PARITY surface (parseResult + describe().telemetry + eventAccumulator
// + modelCaps): a registered agent must produce the exact NodeUsage / RichNode shapes the observe surface already
// reads, so cost/context/anomalies/cross-run metrics light up for EVERY executor — the precondition for the
// optimizer to score/improve/swap agents without being blind. `conformsToParity` (parity.ts) is the gate.

import type { NodeUsage } from '../status.js';
import type { NodeSpec } from '../../types.js';
import type { NodeAccumulator } from '../../observe/distill.js';
import type { ModelCatalog } from '../../observe/models.js';

/** The raw output of one node's executor run, as the runner has it at the spawn seam. */
export interface RawRun {
  /** the executor's FULL stdout (un-slimmed) — `parseResult` reads THIS (node-lifecycle.ts:613). */
  stdout: string;
  /** path to the persisted, SLIMMED events.jsonl — the streaming decoder reads this, NOT stdout (§4.2). */
  eventsPath?: string;
  exitCode: number;
  /** the watchdog outcome, if the run was killed. */
  killed: 'timeout' | 'stall' | null;
}

/** The agent-neutral verdict `parseResult` yields — replaces the `isClaude` fork at node-lifecycle.ts:612. */
export interface AgentVerdict {
  ok: boolean;
  /** the executor's own self-report (pi's `lastJsonBlock`; null for Claude, whose verdict rides isError + gates). */
  selfReport: { status: string; summary?: string; issues?: string[] } | null;
  sessionId?: string;
}

/** The static "what this driver brings" card — product-agnostic, a-priori, node-independent (§2.5). */
export interface AgentDriverDescriptor {
  id: string;
  label: string;
  version: number;
  runtime: 'cli' | 'sdk';
  binary: string;
  model: { tierAware: boolean; providerRouting: boolean; aliases?: string[]; resolvesThrows: boolean };
  tools: {
    grammar: 'pi-bare' | 'claude-builtin' | string;
    supportsCustom: boolean;
    supportsMcp: boolean;
    supportsSkills: boolean;
    /** a GETTER over the ONE tool-name map (never a copy); `{}` when the executor uses bare pi names. */
    builtinMap: () => Record<string, string>;
    dropped?: string[];
  };
  sandbox: { providers: string[]; authInjectEnv?: string[]; stripEnv?: string[]; configDir?: string };
  telemetry: {
    /** `parseResult` writes a NodeUsage spine (Claude); false ⇒ telemetry rides the event fold (pi). */
    usageRollup: boolean;
    /** 'full' (pi — real durMs) · 'count-only' (Claude — no tool_execution_end) · 'none' (§4.1). */
    perToolTimeline: 'full' | 'count-only' | 'none';
    loopSignal: boolean;
    costReported: boolean;
  };
  costModel: 'per-token' | 'subscription-flat' | 'unknown';
}

// ── run-side contract surfaces (minimal; P1/P2 map the real runner values onto these when wrapping) ──
/** Routing inputs `resolveModel` reads (P1/P2 pass the node/run routing view). */
export interface DriverRunRouting { model?: string; provider?: string; tier?: string; }
/** The already-resolved model `buildCommand` consumes (produced by resolveModel earlier in the fixed order). */
export interface DriverResolvedModel { model?: string; provider?: string; }
/** The run-scoped context `buildCommand` needs (paths + the resolved model). */
export interface DriverCommandContext { model?: string; provider?: string; runDir: string; nodeDir: string; }
/** The pre-spawn sandbox/credential coupling input. */
export interface DriverSandboxSpec { node: NodeSpec; env: Record<string, string | undefined>; }
export interface DriverSandboxAdditions { read?: string[]; write?: string[]; env?: Record<string, string | undefined>; }

/**
 * The per-node RUNTIME STRATEGY for one executor. Run-side methods are called in the fixed order
 * `resolveModel → augmentSandbox → buildCommand → exec → parseResult → decode` (§2.3). Each run-side method
 * wraps an existing function (P1/P2); the parity-side methods are the frozen, tested contract (P0).
 */
export interface AgentDriver {
  readonly id: string;
  /** bumped when buildCommand/eventAccumulator OUTPUT shape changes (sealing — §2.6). */
  readonly version: number;

  /** the static capability card (§2.5). */
  describe(): AgentDriverDescriptor;

  // ── run-side (wired P1–P3; each wraps an existing function) ──
  /** SELECTS the resolver; never re-encodes precedence (that stays in model-routing.ts, the one home). */
  resolveModel(node: NodeSpec, run: DriverRunRouting): { model?: string; provider?: string };
  /** the sandbox/credential coupling before spawn (pi: none — byte-identical; claude: inject/strip tokens). */
  augmentSandbox?(spec: DriverSandboxSpec): Promise<DriverSandboxAdditions>;
  /** the CommandBuilder seam (command.ts:20) — consumes the already-resolved model. */
  buildCommand(node: NodeSpec, resolved: DriverResolvedModel, ctx: DriverCommandContext): string;

  // ── parity-side (the load-bearing contract — frozen + tested in P0 via conformsToParity) ──
  /** parse THIS executor's stdout → the agent-neutral verdict + the NodeUsage spine (undefined ⇒ event fold wins). */
  parseResult(raw: RawRun): { verdict: AgentVerdict; usage?: NodeUsage };
  /** a STREAMING accumulator over the persisted events.jsonl (push/snapshot/finalize) — pi:
   *  createNodeAccumulator; claude: a stream-json accumulator (P5). Absent ⇒ no event decode. */
  eventAccumulator?(): NodeAccumulator | undefined;
  /** the context-window denominator when the run didn't self-report one (pi: contextWindowFor; claude: usage cap). */
  modelCaps(model: string | null, catalog: ModelCatalog): number | null;
}
