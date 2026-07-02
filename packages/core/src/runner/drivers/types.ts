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
import type { NodeSpec, ResolveResult, PiCommandOptions, SecretResolver } from '../../types.js';
import type { NodeAccumulator } from '../../observe/distill.js';
import type { ModelCatalog } from '../../observe/models.js';
import type { CommandContext } from '../command.js';
import type { NodeRouting, RunRouting } from '../model-routing.js';

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
  /**
   * (P3, ADDITIVE — non-parity) An executor's own error report on a formally-clean exit 0 (Claude's
   * `result` event with `isError && subtype !== undefined`). Populated ONLY by drivers whose verdict rides a
   * result event (claude); pi/echo leave it undefined. The status ladder maps it to `error`, reproducing the
   * claude self-reported-error clause byte-identically. Does NOT change the frozen parseResult contract.
   */
  selfReportedError?: { subtype?: string; text?: string };
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

// ── run-side contract surfaces. These reuse the REAL runner types (NodeRouting/RunRouting from
//    model-routing.ts; ResolveResult/PiCommandOptions from types.ts; CommandContext = the CommandBuilder
//    seam, command.ts:20) so a driver's run-side methods WRAP defaultPiCommand / resolveNodeModel
//    byte-identically (design §2.3). The P0 minimal Driver* placeholders lacked resolved.piTools and
//    ctx.promptFile, so buildCommand could not call defaultPiCommand — corrected here. Only the sandbox
//    coupling keeps a driver-local shape (finalized in P2). ──
/**
 * The pre-spawn sandbox/credential coupling input. (P3) Widened from `{node,env}` to carry exactly what the
 * run-side wrapper needs — the SAME inputs the node-lifecycle:242 call site supplies to
 * `claudeExecutorEnvAdditions` (`nodeId`/`configDir`/`resolver`). A permitted RUN-SIDE alignment (like the
 * earlier `buildCommand`/CommandContext coupling), NOT a parity-contract change. `env` = the host env the
 * additions merge over.
 */
export interface DriverSandboxSpec {
  node: NodeSpec;
  /** the node id (= `claudeExecutorEnvAdditions` `nodeId`). */
  nodeId: string;
  /** the per-node config dir under the run dir (= `CLAUDE_CONFIG_DIR`). */
  configDir: string;
  /** the host env the additions merge over (never mutated). */
  env: Record<string, string | undefined>;
  /** the per-node secret resolver (scoped-token / sealing broker seam). Undefined ⇒ `defaultSecretResolver`. */
  resolver?: SecretResolver;
}
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
  /** SELECTS the resolver; never re-encodes precedence (that stays in model-routing.ts, the one home).
   *  Wraps resolveNodeModel / resolveClaudeModel — same (NodeRouting, RunRouting) inputs they take. */
  resolveModel(node: NodeRouting, run: RunRouting): { model?: string; provider?: string };
  /** the sandbox/credential coupling before spawn (pi: none — byte-identical; claude: inject/strip tokens). */
  augmentSandbox?(spec: DriverSandboxSpec): Promise<DriverSandboxAdditions>;
  /** the CommandBuilder seam (command.ts:20) — consumes the runner's resolved toolset + staged prompt,
   *  so piDriver.buildCommand IS defaultPiCommand and claudeCodeDriver.buildCommand IS claudeCommand. */
  buildCommand(node: NodeSpec, resolved: ResolveResult, ctx: CommandContext, opts?: PiCommandOptions): string;

  // ── parity-side (the load-bearing contract — frozen + tested in P0 via conformsToParity) ──
  /** parse THIS executor's stdout → the agent-neutral verdict + the NodeUsage spine (undefined ⇒ event fold wins). */
  parseResult(raw: RawRun): { verdict: AgentVerdict; usage?: NodeUsage };
  /** a STREAMING accumulator over the persisted events.jsonl (push/snapshot/finalize) — pi:
   *  createNodeAccumulator; claude: a stream-json accumulator (P5). Absent ⇒ no event decode. */
  eventAccumulator?(): NodeAccumulator | undefined;
  /** the context-window denominator when the run didn't self-report one (pi: contextWindowFor; claude: usage cap). */
  modelCaps(model: string | null, catalog: ModelCatalog): number | null;
}
