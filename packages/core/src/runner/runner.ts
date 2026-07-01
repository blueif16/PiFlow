// The runner — M1's execution loop. Takes a compiled `Workflow` and runs each node through the
// `SandboxProvider` lifecycle (create → stage inputs → exec the agent command → collect+verify
// artifacts → run hooks → dispose), stage-by-stage with parallel lanes within a stage, writing the
// `.pi/run.json` digest. A faithful PORT of templates/pi-runner/run.mjs onto the typed @piflow/core spine.
//
// Ported behaviors (run.mjs file:line): status schema + writeStatus (639–668, see ./status.ts);
// headless command flags (700–728, see ./command.ts); runNode lifecycle (730–1178); node-timeout +
// silent-stall watchdogs (1055–1065) routed through ONE killChild seam with SIGTERM→SIGKILL grace
// (904–911); lastJsonBlock forgiving return-parse (670–698); main loop + per-stage Promise.all
// (1307–1322); --from resume preflight via artifact-stat (1282–1305); halt-on-failure (1315–1322).
// Deferred (not M1 must-haves): stuck-delta repeat-kill, tool-thrash, per-turn token timeline,
// escalation ladder, real process-group reaping (a provider concern). See docs/research/
// runner-childprocess-2026-06-21.md.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  Workflow,
  SandboxProvider,
  RunScope,
  ToolRegistry,
  SecretResolver,
  Escalator,
  ReturnMode,
  RunState,
} from '../types.js';
import { defaultSecretResolver, defaultEscalator } from '../types.js';
import { DefaultToolRegistry } from '../tools/registry.js';
import { InMemorySandboxProvider } from '../sandbox/index.js';
import { defaultSchemaValidator, type SchemaValidator } from './schema.js';
import { type EventSink } from './events.js';
import { dispatchCommand, type CommandBuilder } from './command.js';
import { loadModelTiers, loadModelsIndex, type ModelTiers } from './model-routing.js';
import { resolveTokens, type ResolveCtx } from '../workflow/resolver.js';
import { barrierMerge, type NodeUpdate } from '../workflow/ops/promote.js';
import { loadState, persistState } from '../workflow/state.js';
import { createLimiter, normalizeConcurrent } from './limit.js';
import {
  type RunStatus,
  type NodeStatusRecord,
  nowISO,
  writeStatus,
  artifactState,
} from './status.js';
import { descendantsMap, loadJournal } from './journal.js';
// P6 — mid-run migration: the single-writer lease + the freeze-at-node-boundary signal.
import { acquireLease, LeaseHeldError, type Lease, type AcquireOpts } from './lease.js';
import { defaultFreezeSignal } from './migrate.js';
export { acquireLease, readLease, LeaseHeldError, lockFile } from './lease.js';
export type { Lease, LeaseInfo, AcquireOpts } from './lease.js';
export { requestFreeze, clearFreeze, freezeFile, defaultFreezeSignal } from './migrate.js';

// ── exec/checkpoint primitives + seam types — moved to ./exec-runner.ts ──────────────────────────────
// `defaultExecRunner`/`defaultCheckpointWait` + the `ExecRunner`/`ExecWatchdogOpts`/`CheckpointWaiter`
// seam interfaces now live in ./exec-runner.ts (cluster B + the A-subset seam types). Imported here for
// the runner's own use (RunOptions/RunContext reference them) AND re-exported so the barrel + the
// internal-importing tests (self-correction-l1 / warm-resume-l1) keep resolving these from runner.ts.
import { defaultExecRunner, defaultCheckpointWait } from './exec-runner.js';
import type { ExecRunner, ExecWatchdogOpts, CheckpointWaiter } from './exec-runner.js';
export { defaultExecRunner, defaultCheckpointWait } from './exec-runner.js';
export type { ExecRunner, ExecWatchdogOpts, CheckpointWaiter } from './exec-runner.js';

/** Options for `runWorkflow`. Everything below the workflow is defaulted to a live-free, offline run. */
export interface RunOptions {
  /** Run id (status `run` field + default outDir suffix). */
  run?: string;
  /**
   * The run's memorable IDENTITY recorded into `run.json`'s `name` — the Docker-style `<adjective>-<pie>`
   * the CLI mints when `--run` is omitted, or the explicit `--run` value. Defaults to `run` when unset
   * (so a library consumer that only passes `run` still gets a `name`).
   */
  name?: string;
  /** The originating prompt id (if any) recorded into `run.json`'s `promptId` — run metadata, not the id. */
  promptId?: string;
  /** Host-side run dir — the filesystem-as-contract namespace across sandboxes. Default `out/<run>`. */
  outDir?: string;
  /** Base checkout root for a run-scoped provider (worktree-path source / prompt-rewrite anchor). Default cwd. */
  repoRoot?: string;
  /**
   * `{{WORKSPACE}}` — the canonical, read-only, OUT-OF-THREAD tree (skills · templates · registry) that
   * tokens resolve against at node launch. Default `repoRoot` (the live tree for a local provider).
   */
  workspace?: string;
  /**
   * The run-level args (`--arg k=v` delivery) that `{{arg.<key>}}` tokens resolve against at node launch.
   * A `{{arg.x}}` token with no matching key fails the node loudly (MissingArgError), never a silent ''.
   */
  args?: Record<string, string>;
  /** Sandbox backend. Default the in-memory reference provider. */
  provider?: SandboxProvider;
  /** Tool registry to resolve each node's selection. Default builtin registry. */
  registry?: ToolRegistry;
  /** Agent-command builder. Default the production headless `pi` command; tests inject a stub. */
  buildCommand?: CommandBuilder;
  /** The exec primitive (carries the watchdog + kill seam). Default `defaultExecRunner`. */
  execRunner?: ExecRunner;
  /** Provider name passed to the command builder (`pi --provider`). Default 'cp'. */
  providerName?: string;
  /** Optional model pin. */
  model?: string;
  /**
   * RUN-LEVEL EXECUTOR DEFAULT — pick `pi` vs `claude-code` for EVERY node at run start, WITHOUT editing
   * the template (which is otherwise the only place `NodeSpec.executor` lives). A caller (CLI/GUI) sets
   * this to run the whole workflow on the other executor. PRECEDENCE: `executorOverride[nodeId]` (per-node)
   * wins over this; this wins over the node's authored `executor`; absent everywhere ⇒ `pi`. Omit ⇒ each
   * node keeps its authored executor (today's behavior).
   */
  executor?: 'pi' | 'claude-code';
  /**
   * PER-NODE EXECUTOR OVERRIDE — pick `pi` vs `claude-code` for SPECIFIC nodes (keyed by node id) at run
   * start, WITHOUT editing the template. A per-node entry WINS over the run-level `executor` default AND
   * over the node's authored `executor`. A node id absent from this map falls through to `executor` then to
   * its authored value. Omit ⇒ no per-node override (today's behavior).
   */
  executorOverride?: Record<string, 'pi' | 'claude-code'>;
  /**
   * (G1) Routing config injection seam — the activatable tier map + pi's models.json index. Omit ⇒ the
   * runner loads both from disk (`loadModelTiers`/`loadModelsIndex`, today's behavior). A test injects a
   * deterministic map so escalation's `escalate.tier`/`escalate.model` resolution is model-free.
   */
  modelRouting?: { tiers: ModelTiers; modelsIndex: Map<string, string> };
  /**
   * (G12 — M4) The notification host seam — where `notify` (and a `policy.fail:'notify'`-class surface)
   * binds to a real channel. Mirrors `SecretResolver`: core owns the action VOCABULARY, the host owns the
   * BINDING. Omit ⇒ `defaultEscalator` (a no-op that `console.warn`s), so a notify never crashes a run.
   */
  escalator?: Escalator;
  /** Reasoning-depth cap forwarded to the command builder as `pi --thinking <v>`. Omit ⇒ no flag. */
  thinking?: string | boolean;
  /** Extra `-e <path>` extensions forwarded to the builder, emitted BEFORE the staged tool extension. */
  extensions?: string[];
  /** Per-node hard wall-clock cap (ms). Default 1_800_000 (30 min, matching run.mjs). */
  nodeTimeoutMs?: number;
  /** Silent-stall kill threshold (ms); 0 disables. Default 0 (off; the in-memory baseline is fast). */
  stallMs?: number;
  /** ms after SIGTERM before SIGKILL. Default 3000 (run.mjs 904–911). */
  killGraceMs?: number;
  /**
   * Max node processes IN-FLIGHT at once (the G2 concurrency cap) — ONE global limiter across the whole
   * run (stages run sequentially, so global === per-stage at any instant). Bounds the stage fan-out that
   * was previously UNBOUNDED. Default 8 (a fixed, process-per-node-conservative value), clamped to
   * `[1, MAX_CONCURRENT=16]`; a 0/negative/NaN value degrades to 1 (serial). A node's retries share its
   * ONE slot (the cap counts NODES in flight, not attempts). See `./limit.ts`.
   */
  maxConcurrent?: number;
  /**
   * OPT-IN run-wide ceiling on TOTAL nodes spawned. Omit ⇒ no total cap (default). When set, the
   * (maxNodesPerRun+1)-th node to acquire a slot gets a synthetic `error` record (`total node cap …
   * exceeded`) and the run HALTS at the stage boundary (the loud-failure convention, mirroring
   * `__resume__`/`__barrier__`) — a fork-bomb safety valve, never a silent drop.
   */
  maxNodesPerRun?: number;
  /**
   * Run-level DEFAULT for the write-then-fence return handshake (any pi node needs it). PRECEDENCE: a
   * node's own `io.returnMode` wins; else THIS run default applies to every node; else the artifact
   * heuristic (a node with a satisfied artifact contract ⇒ 'optional', a zero-artifact node ⇒ 'required').
   * Omit ⇒ the artifact heuristic alone (today's behavior). Set `'required'` to enforce the fenced-JSON
   * handshake on every node regardless of artifacts; `'optional'` to make it advisory everywhere.
   */
  returnProtocol?: ReturnMode;
  /** Resume window: run from the first stage whose phase/label/id contains this (inclusive). */
  from?: string;
  /** Resume window: run up to the last stage whose phase/label/id contains this (inclusive). */
  until?: string;
  /**
   * G4 resume: when a `${RUN}/.pi/journal.json` from a prior run exists, the DEFAULT (omit / false) is
   * to consult it — a node whose envelope hash AND every consumed-input content hash match the journal
   * is REUSED; a changed node + all its DAG descendants RE-RUN. `--from/--until` layer ON TOP as a
   * manual override (force-reuse a prefix / stop early). Set `noResume:true` to IGNORE the journal and
   * re-run every selected node (a forced full re-run). A fresh run (no journal) is unaffected either way.
   */
  noResume?: boolean;
  /**
   * Active run PROFILE name — resolved against the WorkflowSpec's declared `profiles` BEFORE compile to
   * elide a subset of nodes (deps rewired transitively). The elision happens at the spec-compile sites
   * (`runFromConfig`/`runFromTemplate`), NOT here (`runWorkflow` already holds a compiled `Workflow`).
   * Absent ⇒ the spec's `defaultProfile`, or, if none, the full DAG. An unknown name errors loudly.
   */
  profile?: string;
  /**
   * Schema validator for the post-node schema gate. Omit ⇒ a best-effort ajv-2020 default (skips with
   * a warning if ajv is absent); pass `null` to disable the gate; pass a fn to inject one (tests do this).
   */
  validateSchema?: SchemaValidator | null;
  /**
   * The MCP server map the runner stages into a node's `_pi/mcp.json` when that node selected MCP tools.
   * A LOOSE JSON shape on purpose — `@piflow/tool-bridge` owns its validation (the bridge expands the
   * `$VAR` refs + shape-checks at resolution time), so the runner does NOT import the bridge's
   * `McpServerConfig`/`BridgeConfig` types (no cross-package type dependency); it writes this VERBATIM.
   * Each server config carries `$VAR`/`${VAR}` REFERENCES in its secret-bearing fields, never literals.
   */
  mcpConfig?: { servers: Record<string, unknown> };
  /**
   * Per-node secret resolver — the seam where a host plugs a scoped-token / sealing broker. The runner
   * calls it once per referenced `$VAR` per node to get the value injected into the node's env; a
   * broker returns a SHORT-LIVED SCOPED token (cloud) so the raw long-lived credential never crosses
   * into the VM. Omit ⇒ `defaultSecretResolver` (reads `process.env`, today's behavior).
   */
  secretResolver?: SecretResolver;
  /**
   * (M1 — provider-credential parity) The allowlist of provider/gateway credential env var NAMES the pi
   * agent itself needs (e.g. `ANTHROPIC_API_KEY`, `NEBIUS_API_KEY`). On a CLOUD backend (daytona/e2b) the
   * VM does NOT inherit `process.env`, and `defaultPiCommand` stamps `--provider`/`--model` but NO key — so
   * pi would boot with no model credential. The runner resolves EACH declared name through the SAME
   * `SecretResolver` and forwards EXACTLY that set into the node's VM exec env, on the SAME cloud allowlist
   * the MCP `$VAR`s ride (never a wholesale host-env spread). Omit/empty ⇒ no provider cred forwarded (a
   * LOCAL run is unaffected — the child already inherits `process.env`). The host (CLI) derives this from
   * the selected `--provider` (or an explicit `--cloud-secret NAME`).
   */
  cloudSecrets?: string[];
  /**
   * Capture each node's agent stdout (the `pi --mode json` stream) to the canonical
   * `.pi/nodes/<id>/events.jsonl` — the observability backbone the shared `watchRun` stream + `./logs.ts`
   * tail (`docker logs` for a run). Default `true`; the archive is slimmed + lazy (a node that emits
   * nothing leaves no file). Set `false` to disable.
   */
  recordEvents?: boolean;
  /**
   * Live event sink — called with `(nodeId, slimmedEvent)` as each event is parsed, the push seam a
   * TUI/GUI subscribes to (the file archive is always written regardless). Never breaks the run if it throws.
   */
  onEvent?: EventSink;
  /**
   * (G5) How a HUMAN CHECKPOINT node resolves when no `pi` is spawned. `'interactive'` (default for an
   * ATTENDED run) PARKS the lane watching for a reply file up to the node's `timeoutMs`, then applies the
   * checkpoint's `headless` policy. `'default'` (a truly DETACHED run) skips the wait and applies the
   * headless policy IMMEDIATELY — so a background run never hangs on a checkpoint. The wait is bounded
   * either way; the SAFETY invariant (a run never hangs unattended) holds for both.
   */
  checkpointReply?: 'interactive' | 'default';
  /**
   * (G5) The wait/poll seam for `waitForCheckpointReply` (test injection). The default polls the reply file
   * on `watchRun`'s 700ms cadence with a small sleep between polls; a test injects a fast/zero-sleep poller
   * so the suite stays deterministic without sleeping on real wall-clock. Receives the run dir + node id +
   * a `deadline` (epoch ms, Infinity when unbounded) and a `read` to fetch the current reply; resolves with
   * the first reply that PASSES `accept`, or `null` on deadline.
   */
  checkpointWait?: CheckpointWaiter;
  /**
   * (P6 — mid-run migration) The FREEZE predicate, consulted at each stage boundary (all lanes quiesced,
   * journal + state flushed). When it returns true AND stages remain, the runner PARKS the run
   * (`RunStatus.frozen`) instead of starting the next stage — the "flush the journal then die" hook a
   * pending migration uses to hand the run to another host. Omit ⇒ the default file-watch
   * (`defaultFreezeSignal(outDir)`: park iff `.pi/freeze` exists), so a `POST /freeze` parks a live run
   * with no wiring. A test injects a deterministic function.
   */
  freezeSignal?: () => boolean | Promise<boolean>;
  /**
   * (P6 — mid-run migration) Acquire the single-writer `run.lock` lease for the run's lifetime (default
   * ON) so two runner processes never double-write the journal across a migration. A LIVE lease held by
   * another process makes the run FAIL loudly (a synthetic `__lease__` node) rather than corrupt the
   * journal. Set `false` to skip the lease (an embedded/library run that owns the dir exclusively, or a
   * test isolating other behavior).
   */
  lease?: boolean;
  /**
   * (P6) Lease knobs (pid/host/clock/ttl/liveness) forwarded to `acquireLease` — for tests + a host that
   * wants a custom stale threshold. Ignored when `lease === false`.
   */
  leaseOpts?: AcquireOpts;
}

/** The result of a run: the final status record + the host run dir it was written to. */
export interface RunResult {
  status: RunStatus;
  outDir: string;
}

// (the default exec runner + the default checkpoint waiter now live in ./exec-runner.ts — see the import
//  + re-export block above; their seam types travel with them.)

// ── forgiving return-parse (run.mjs lastJsonBlock 670–698) — moved to ./return-parse.ts ──────────────
// `lastJsonBlock` + the `NodeReturn` type now live in ./return-parse.ts (cluster C split). Imported for
// the runner's own use AND re-exported here so `runner/index.ts` (the barrel) and any internal-importing
// test keep resolving it from runner.ts.
import { lastJsonBlock } from './return-parse.js';
export { lastJsonBlock } from './return-parse.js';

// ── stage-window selection (run.mjs selectStages 600–635) — moved to ./window.ts ────────────────────
// `selectWindow` (+ its private `stageMatches`) now lives in ./window.ts (cluster D split). Imported for
// the run loop's own use and re-exported here for completeness (an internal seam; no test/barrel import).
import { selectWindow } from './window.js';
export { selectWindow } from './window.js';

// ── MCP config staging (env/secret porting) — moved to ./env-staging.ts ──────────────────────────────
// The per-node env-allowlist additions — `CLOUD_KINDS`/`IN_PLACE_KINDS`/`selectedBridgedTool`/
// `referencedEnvVars`/`mcpEnvAdditions`/`cloudCredEnvAdditions` (cluster E) — now live in
// ./env-staging.ts. Imported for the runner's own use (runNode stages env from here) AND re-exported so
// the barrel + the internal-importing tests (runner.test.ts → selectedBridgedTool, cloud-provider-cred
// .test.ts → cloudCredEnvAdditions) keep resolving these from runner.ts.
import {
  CLOUD_KINDS,
  IN_PLACE_KINDS,
  selectedBridgedTool,
  referencedEnvVars,
  mcpEnvAdditions,
  cloudCredEnvAdditions,
} from './env-staging.js';
export {
  CLOUD_KINDS,
  IN_PLACE_KINDS,
  selectedBridgedTool,
  referencedEnvVars,
  mcpEnvAdditions,
  cloudCredEnvAdditions,
} from './env-staging.js';

// ── the per-node lifecycle ────────────────────────────────────────────────────────────────────────

// ── shared run state + host↔sandbox staging — moved to ./run-context.ts (THE PIVOT, RISK 1) ──────────
// The `RunContext` interface + `readHostFile`/`stageHostPathIntoSandbox` (cluster F) now live in a LEAF
// module (./run-context.ts) so the lane / retry / lifecycle modules import `RunContext` from there, not
// back into runner.ts — breaking the would-be cycle. runWorkflow/seedFromJournal use the `RunContext`
// type here; the staging helpers are re-exported for symmetry (the barrel never surfaced them).
import type { RunContext } from './run-context.js';
export type { RunContext } from './run-context.js';
export { readHostFile, stageHostPathIntoSandbox } from './run-context.js';

// ── the no-pi node lanes — moved to ./node-lanes.ts ──────────────────────────────────────────────────
// The three NO-PI lanes — runCheckpoint(+finishCheckpoint), runRerouteGate, runProgrammatic (cluster H) —
// now live in ./node-lanes.ts. They import `RunContext` from the leaf ./run-context.js and `finishNode`
// from this file (a runtime-only call, so no load-time cycle). Imported here for the run loop's dispatch
// and re-exported for symmetry. (The retry/escalate runtime `runNodeWithRetries` stays here — step 7.)
import { runCheckpoint, runRerouteGate, runProgrammatic } from './node-lanes.js';
export { runCheckpoint, runRerouteGate, runProgrammatic } from './node-lanes.js';

// ── the retry/escalate runtime — moved to ./retry.ts ─────────────────────────────────────────────────
// `runNodeWithRetries` (cluster G) now lives in ./retry.ts. It imports `RunContext` from the leaf
// ./run-context.js and `runNode` from this file (a runtime-only call, temporary until step 8 repoints it
// at ./node-lifecycle.js). Imported here for the run loop's gated lane and re-exported for symmetry.
import { runNodeWithRetries } from './retry.js';
export { runNodeWithRetries } from './retry.js';

// ── the pi-node lifecycle — moved to ./node-lifecycle.ts ─────────────────────────────────────────────
// `runNode` (+`AttemptOverride`), `finishNode`, and `cappedRecord` (clusters I + J) now live in
// ./node-lifecycle.ts. `finishNode` stays WITH `runNode` there so node-lanes.ts (finishNode) and
// retry.ts (runNode) import ONE-WAY into that module (RISK 2). Imported here for the run loop's dispatch
// (runNode via retry's runNodeWithRetries; cappedRecord at the total-cap gate) and re-exported for symmetry.
import { runNode, finishNode, cappedRecord } from './node-lifecycle.js';
export { runNode, finishNode, cappedRecord, buildNodeConfig, summarizeGates } from './node-lifecycle.js';
export type { AttemptOverride } from './node-lifecycle.js';

// ── G4 resume + run-scope open seam — moved to ./resume.ts ───────────────────────────────────────────
// `seedFromJournal` (+ its private `envelopeHashOf`), `loadPriorStatus`, and `openRunScope` (clusters
// L + K) now live in ./resume.ts. They import `RunContext` from the leaf ./run-context.js and are called
// only from `runWorkflow` below. Imported here for the run loop and re-exported for symmetry.
import { seedFromJournal, loadPriorStatus, openRunScope } from './resume.js';
export { seedFromJournal, loadPriorStatus, openRunScope } from './resume.js';

// ── the run loop ─────────────────────────────────────────────────────────────────────────────────

/**
 * Run a compiled `Workflow`. Stage-by-stage (parallel lanes within a stage via Promise.all); after
 * each stage, if any node is `error`/`blocked`, HALT (write final ok:false, skip downstream). Resume:
 * the [from..until] stage window runs; skipped upstream nodes register `reused` after a stat preflight
 * (a missing required upstream artifact HALTs before any node runs).
 */
export async function runWorkflow(wf: Workflow, opts: RunOptions = {}): Promise<RunResult> {
  const run = opts.run ?? 'run';
  const outDir = path.resolve(opts.outDir ?? path.join('out', run));
  const repoRoot = opts.repoRoot ?? process.cwd();
  const provider = opts.provider ?? new InMemorySandboxProvider();
  // Resolve the schema validator ONCE: explicit (incl. null=disabled) wins; else the best-effort ajv default.
  const validateSchema = opts.validateSchema !== undefined ? opts.validateSchema : await defaultSchemaValidator();
  const ctx: RunContext = {
    wf,
    outDir,
    registry: opts.registry ?? new DefaultToolRegistry(),
    buildCommand: opts.buildCommand ?? dispatchCommand, // per-node executor routing (pi | claude-code)
    execRunner: opts.execRunner ?? defaultExecRunner,
    providerName: opts.providerName ?? 'cp',
    model: opts.model,
    // Run-start executor selection (run-level default + per-node override) — resolved per node by
    // `resolveExecutor` (override wins → default → the node's authored executor). Absent ⇒ authored value.
    executorDefault: opts.executor,
    executorOverride: opts.executorOverride,
    // G1 — the global routing config (read-only; graceful absence ⇒ inactive tiers + empty index). An
    // injected `modelRouting` (tests / a host) wins so escalation's tier/model resolution stays model-free.
    modelRouting: opts.modelRouting ?? { tiers: loadModelTiers(), modelsIndex: loadModelsIndex() },
    commandOpts: { thinking: opts.thinking, extraExtensions: opts.extensions },
    recordEvents: opts.recordEvents ?? true,
    onEvent: opts.onEvent,
    validateSchema,
    mcpConfig: opts.mcpConfig,
    providerKind: provider.kind,
    secretResolver: opts.secretResolver,
    cloudSecrets: opts.cloudSecrets,
    escalator: opts.escalator ?? defaultEscalator,
    failureSignals: new Map(),
    returnProtocol: opts.returnProtocol,
    workspace: opts.workspace ?? repoRoot,
    args: opts.args ?? {},
    // Load the per-thread RunState at run start (D6): a fresh run sees `{}`; a resume sees the prior
    // barrier's persisted channels, so the resumed tail's `{{state.*}}` resolves from t=0.
    runState: await loadState(outDir),
    promotesByNode: new Map(),
    // The G2 concurrency cap: ONE global limiter, normalized (default 8, clamped [1,16], 0/NaN→1).
    limiter: createLimiter(normalizeConcurrent(opts.maxConcurrent)),
    // The collect mutex: ONE serial (1-slot) limiter per run, so the per-node `downloadDir` back into the
    // SHARED host run dir never overlaps (concurrent recursive copies into a common subdir race → EEXIST).
    collectMutex: createLimiter(1),
    maxNodesPerRun: opts.maxNodesPerRun,
    spawnedNodes: { n: 0 },
    // G4 journal meta (runId/source). `envHash` is filled by `seedFromJournal` at run-start, then read
    // by `finishNode` to record the SAME identity the resume decision consulted.
    journal: { meta: { runId: run, source: wf.meta.name }, envHash: {} },
    // G5 — checkpoint resolution mode + the wait/poll seam (test-injectable). Default ATTENDED (park for
    // a reply, bounded by the node's timeoutMs); a detached run passes `'default'` to take the headless
    // policy immediately so it never hangs.
    checkpointReply: opts.checkpointReply ?? 'interactive',
    checkpointWait: opts.checkpointWait ?? defaultCheckpointWait,
    watchdog: {
      nodeTimeoutMs: opts.nodeTimeoutMs ?? 1_800_000,
      stallMs: opts.stallMs ?? 0,
      killGraceMs: opts.killGraceMs ?? 3000,
    },
    status: {
      run,
      // The memorable run identity (Docker-style `<adjective>-<pie>`) the CLI minted, or `run` itself when
      // a consumer passed only an id — recorded so a viewer/index keys on a stable, human-friendly name.
      name: opts.name ?? run,
      // The originating prompt id, when one was supplied — run METADATA, traceable but NOT the run id.
      ...(opts.promptId ? { promptId: opts.promptId } : {}),
      source: wf.meta.name,
      profile: opts.profile ?? null,
      provider: opts.providerName ?? 'cp',
      model: opts.model ?? null,
      // The CONTROLLING process's pid — the one driving this run. Recorded so a later
      // `piflowctl node <run> <id> --stop` can signal THIS run's process group (the runner spawns each
      // node's child detached in its own group; a stop targets the controller, a per-run group-kill).
      controllerPid: process.pid,
      // (SKIN channel) Stamp the run's EFFECTIVE sandbox BACKEND ONCE — the kind of the single provider
      // instance chosen at the CLI (`--sandbox`). Run-wide (every pi node runs in this backend); the
      // per-node programmatic carve-out is recorded in each node's `config` slice (always host-local).
      sandbox: provider.kind,
      startedAt: nowISO(),
      updatedAt: nowISO(),
      done: false,
      ok: null,
      durationMs: null,
      stage: null,
      totals: null,
      nodes: {},
    },
  };
  const t0 = Date.now();
  await fs.mkdir(outDir, { recursive: true });

  // P6 — single-writer lease. Acquire BEFORE any journal write (and before booting a run scope) so a
  // migration never has two runners live on the same run-dir. A LIVE holder ⇒ fail loudly (synthetic
  // `__lease__` node) rather than corrupt the journal. `lease:false` skips it (embedded/exclusive runs).
  let lease: Lease | null = null;
  if (opts.lease !== false) {
    try {
      lease = await acquireLease(outDir, opts.leaseOpts);
    } catch (e) {
      if (e instanceof LeaseHeldError) {
        ctx.status.done = true;
        ctx.status.ok = false;
        ctx.status.durationMs = Date.now() - t0;
        ctx.status.nodes['__lease__'] = {
          id: '__lease__', label: 'run lock', status: 'blocked', artifacts: [],
          issues: [`another runner holds this run: ${e.message}`],
        };
        await writeStatus(outDir, ctx.status);
        return { status: ctx.status, outDir };
      }
      throw e;
    }
  }
  const releaseLease = async (): Promise<void> => { try { await lease?.release(); } catch { /* non-fatal */ } };
  // The freeze predicate consulted at each stage boundary — injected (tests) or the default `.pi/freeze` watch.
  const freezeReq = opts.freezeSignal ?? defaultFreezeSignal(outDir);

  const { fromIdx, untilIdx } = selectWindow(wf, opts.from, opts.until);
  const skipped = wf.stages.slice(0, fromIdx);
  const selected = wf.stages.slice(fromIdx, untilIdx + 1);

  // G4 JOURNAL DECISION (§4c) layered with the `--from` window (§4e): load the prior run's journal and
  // decide, per node, REUSE (provably unchanged — envelope + every consumed-input content hash match the
  // journal) vs RUN (changed, or a DAG descendant of a changed node). `--from` force-reuses the prefix;
  // `noResume` ignores the journal (full re-run). A fresh run (no journal) ⇒ every node RUNs.
  const journal = await loadJournal(outDir);
  const { reused: reusedSet } = await seedFromJournal(ctx, journal, fromIdx, opts.noResume ?? false);
  // The prior run.json THIS run overwrites — the source of the reused nodes' preserved records and the
  // accumulated-clock baseline below. Null on a fresh run (or a template swap), so neither carry fires.
  const prior = await loadPriorStatus(outDir, wf.meta.name);

  // Seed the digest. A node in a `--from`-skipped stage is `reused`. WITHIN the selected window, the
  // journal decides each node: `reused` (skip exec) vs `pending` (run). The run loop below skips any
  // `reused` lane, so a later-stage node the journal proved unchanged is reused even if an earlier stage
  // re-ran — the topological taint already forced every TRUE descendant to `pending`.
  //
  // RESUME CARRY-FORWARD: a node we are marking `reused` is provably UNCHANGED, so its prior run's record
  // (startedAt/endedAt/durationMs/summary/model/checks) is still TRUE — carry it VERBATIM (re-stamping only
  // the identity from the current wf + forcing `reused`) instead of blanking it. The resume preflight below
  // re-stats its artifacts. Without a usable prior record (fresh run / pending-or-running prior) we seed the
  // empty record as before. This is what stops a rerun from "falsifying" the untouched prefix's data.
  const seedNode = (id: string, status: NodeStatusRecord['status']): void => {
    const n = wf.nodes[id];
    const base = { id, label: n.label, ...(n.agentType ? { agentType: n.agentType } : {}) };
    const priorRec = status === 'reused' ? prior?.nodes[id] : undefined;
    if (priorRec && priorRec.status !== 'pending' && priorRec.status !== 'running') {
      ctx.status.nodes[id] = { ...priorRec, ...base, status: 'reused' };
    } else {
      ctx.status.nodes[id] = { ...base, status, artifacts: [], issues: [] };
    }
  };
  for (const s of skipped) for (const id of s.nodeIds) seedNode(id, 'reused');
  for (const s of selected) for (const id of s.nodeIds) seedNode(id, reusedSet.has(id) ? 'reused' : 'pending');
  await writeStatus(outDir, ctx.status);

  // ACCUMULATE THE RUN CLOCK across a resume (the §"don't reset to the rerun window" fix). The reused
  // prefix's recorded compute time is the BASELINE the rerun adds onto; back-date `startedAt` by it so BOTH
  // the live `now − startedAt` fallback AND the final `durationMs` read as baseline + this-run-elapsed —
  // the clock effectively STARTS at the earliest REDONE node and never resets, while the idle gap between
  // runs is excluded (we back-date from t0, not the prior wall-clock start). Recomputed after the safety
  // flips below (a reused→pending flip drops that node's time from the baseline). Fresh run ⇒ prior is null
  // ⇒ baseline 0, startedAt untouched ⇒ byte-identical to before.
  const sumReusedMs = (): number =>
    Object.values(ctx.status.nodes)
      .filter((r) => r.status === 'reused' && typeof r.durationMs === 'number')
      .reduce((a, r) => a + (r.durationMs ?? 0), 0);
  let baselineMs = 0;
  if (prior) {
    baselineMs = sumReusedMs();
    ctx.status.startedAt = new Date(t0 - baselineMs).toISOString();
  }

  // Persist the RESOLVED DAG (the profile already applied — elided nodes dropped, deps rewired) into the
  // self-describing run dir. `.pi/run.json` records WHAT ran; this records the SHAPE it ran as — the deck
  // of nodes, their topological stages, and their DECLARED data-flow edges. Every viewer renders the run's
  // real graph from THIS, never by reconstructing edges from runtime io/events traces.
  await fs.writeFile(
    path.join(outDir, '.pi', 'workflow.json'),
    JSON.stringify({ meta: wf.meta, profile: opts.profile ?? null, stages: wf.stages, edges: wf.edges }, null, 2) + '\n',
  );

  // RESUME PREFLIGHT (run.mjs 1282–1305) — for the `--from` MANUAL OVERRIDE (fromIdx > 0): the
  // `--from`-skipped upstream nodes were NOT re-run, so their declared artifacts MUST already exist on
  // the host or the resumed tail runs on absent inputs. Stat them; HALT loudly on any miss (the
  // documented `--from` contract — the human pinned the prefix, so a missing pinned artifact is a hard
  // error). Also record the reused nodes' verified artifacts.
  if (fromIdx > 0) {
    // Resolve each skipped node's DECLARED artifact path the SAME way the runner does when a node runs
    // (runner.ts: `resolveTokens(a.path, resolveCtx)`): `{{WORKSPACE}}`/`{{arg.*}}`/`{{state.*}}` become
    // physical against the run's workspace, args, and the resume-loaded `.pi/state.json` BEFORE we stat —
    // else any tokenized upstream artifact (every real lesson) false-reports "missing" though it exists at
    // the resolved path. Token-free paths resolve to themselves (zero behavior change). We surface the
    // RESOLVED path in the "missing" message (more actionable than the raw token path).
    const resolveCtx: ResolveCtx = { run: outDir, workspace: ctx.workspace, state: ctx.runState, args: ctx.args };
    const missing: string[] = [];
    for (const s of skipped) {
      for (const id of s.nodeIds) {
        const n = wf.nodes[id];
        const states = await Promise.all(
          n.io.artifacts.map((a) => {
            const resolved = resolveTokens(a.path, resolveCtx);
            return artifactState(path.resolve(outDir, resolved), resolved);
          }),
        );
        ctx.status.nodes[id].artifacts = states;
        for (const st of states) if (!st.exists) missing.push(`${st.path} (${id})`);
      }
    }
    if (missing.length) {
      ctx.status.done = true;
      ctx.status.ok = false;
      ctx.status.durationMs = baselineMs + (Date.now() - t0);
      ctx.status.nodes['__resume__'] = {
        id: '__resume__', label: 'resume preflight', status: 'blocked', artifacts: [],
        issues: [`cannot --from "${opts.from}": missing upstream artifact(s): ${missing.join(', ')}`],
      };
      await writeStatus(outDir, ctx.status);
      await releaseLease();
      return { status: ctx.status, outDir };
    }
  }

  // JOURNAL-REUSE SAFETY OVERRIDE (§4e.4): a node the JOURNAL marked `reused` WITHIN the selected window
  // (not pinned by `--from`) whose declared artifacts are MISSING on disk flips back to `pending` — and
  // so re-runs — instead of a hard HALT. Strictly safer than today's `__resume__` HALT: a reused node
  // whose output was deleted simply regenerates. Its DAG descendants flip too (they would consume the
  // regenerated output). Stat the verified artifacts onto the record either way.
  const flipped = new Set<string>();
  for (const s of selected) {
    for (const id of s.nodeIds) {
      if (ctx.status.nodes[id].status !== 'reused') continue;
      const n = wf.nodes[id];
      const states = await Promise.all(
        n.io.artifacts.map((a) => artifactState(path.resolve(outDir, a.path), a.path)),
      );
      ctx.status.nodes[id].artifacts = states;
      if (states.some((st) => !st.exists)) flipped.add(id);
    }
  }
  if (flipped.size) {
    const desc = descendantsMap(wf);
    for (const id of flipped) {
      for (const d of [id, ...(desc[id] ?? [])]) {
        const rec = ctx.status.nodes[d];
        if (rec && rec.status === 'reused') rec.status = 'pending';
      }
    }
    // A reused→pending flip removed that node's time from the accumulated baseline — recompute + re-back-date.
    if (prior) {
      baselineMs = sumReusedMs();
      ctx.status.startedAt = new Date(t0 - baselineMs).toISOString();
    }
  }
  await writeStatus(outDir, ctx.status);

  // Open the run scope AFTER the resume preflight (so a preflight bail never boots a VM / makes a
  // worktree). A provider with a shared per-run resource (worktree/cloud) sets it up here; a local
  // provider gets the trivial forwarding scope. A setup failure fails the run cleanly via a synthetic
  // `__runscope__` node (mirroring `__resume__`) — there is no lane to attribute it to yet.
  let scope: RunScope;
  try {
    scope = await openRunScope(provider, { run, repoRoot, outDir });
  } catch (e) {
    ctx.status.done = true;
    ctx.status.ok = false;
    ctx.status.durationMs = baselineMs + (Date.now() - t0);
    ctx.status.nodes['__runscope__'] = {
      id: '__runscope__', label: 'run scope setup', status: 'error', artifacts: [],
      issues: [`run scope setup failed: ${(e as Error).message}`],
    };
    await writeStatus(outDir, ctx.status);
    await releaseLease();
    return { status: ctx.status, outDir };
  }

  let halted = false;
  let frozen = false; // P6: set true when a freeze parks the run at a stage boundary
  try {
    for (let i = 0; i < selected.length && !halted && !frozen; i++) {
      const s = selected[i];
      ctx.status.stage = { index: fromIdx + i + 1, total: wf.stages.length, nodeIds: s.nodeIds };
      await writeStatus(outDir, ctx.status);

      // Parallel lanes within a stage (run.mjs 1313), gated by the G2 concurrency cap. The limiter
      // wraps the WHOLE `runNodeWithRetries` call (OUTSIDE the retry loop) so a node's retries share
      // ONE slot — the cap counts NODES in flight, not attempts. It only DELAYS when a lane STARTS;
      // every lane still resolves to a `NodeStatusRecord` (lane isolation), so the barrier merge + halt
      // check below read `results` exactly as before. The OPT-IN run-wide total ceiling is enforced at
      // slot-acquire: the (maxNodesPerRun+1)-th node gets a synthetic `error` (drives the halt) and its
      // real `runNodeWithRetries`/`execRunner` NEVER runs.
      const results = await Promise.all(
        s.nodeIds.map((id) => {
          // G4: a node the journal (or `--from`) decided to REUSE is SKIPPED — its seeded `reused`
          // record (with stat-verified artifacts from the preflight) stands, it never spawns a `pi`,
          // and it does NOT consume a concurrency slot or count against `maxNodesPerRun`. The
          // safety override already flipped a reused-but-missing-artifact node back to `pending`.
          if (ctx.status.nodes[id].status === 'reused') return Promise.resolve(ctx.status.nodes[id]);
          // G12 (M3 · #17): a generated REROUTE EXISTENCE-GATE spawns NO `pi` — it stat()s the prior
          // attempt's artifact and (on a pass) marks the cloned re-entry body `reused` so it never spawns.
          // Like `reused`/`checkpoint` it BYPASSES the G2 limiter (no process) and does not count against
          // `maxNodesPerRun`. It runs in an EARLIER stage than the body it skips (the gate sentinel is the
          // forward edge), so flipping the body's seeded status here takes effect when the loop reaches it.
          if (wf.nodes[id].rerouteGate) return runRerouteGate(ctx, wf.nodes[id]);
          // G5: a HUMAN CHECKPOINT spawns NO `pi` and PARKS waiting for a human — it must NOT hold a G2
          // limiter slot while parked, or a stage full of pending checkpoints deadlocks the pool. So it
          // BYPASSES the limiter entirely (like `reused`/`cappedRecord`, it never enters the gated lane)
          // and does not count against `maxNodesPerRun` (it never spawns a process). A sibling node in an
          // independent lane keeps its slot and runs concurrently.
          const cp = wf.nodes[id].checkpoint;
          if (cp) return runCheckpoint(ctx, wf.nodes[id], cp);
          // (PROGRAMMATIC NODE) a node carrying `programmatic:true` runs its DECLARATIVE ops and spawns NO
          // `pi` — no `buildCommand`, no exec. Like `reused`/`rerouteGate`/`checkpoint` it BYPASSES the G2
          // limiter (it holds no process/slot) and does not count against `maxNodesPerRun`.
          if (wf.nodes[id].programmatic) return runProgrammatic(ctx, wf.nodes[id]);
          return ctx.limiter(async () => {
            if (ctx.maxNodesPerRun !== undefined && ctx.spawnedNodes.n >= ctx.maxNodesPerRun) {
              return cappedRecord(ctx, id);
            }
            ctx.spawnedNodes.n++;
            return runNodeWithRetries(ctx, wf.nodes[id], scope);
          });
        }),
      );

      // STAGE-BARRIER MERGE (D6 / LangGraph super-step): fold every lane's promoted update into RunState
      // SERIALLY + deterministically (in node order), persist ONCE, and advance ctx.runState so the NEXT
      // stage resolves `{{state.*}}` against the merged channels. A `set` channel written by ≥2 parallel
      // lanes is a `ConflictError` → the run HALTS loudly (a synthetic node, mirroring __resume__).
      const updates: NodeUpdate[] = s.nodeIds
        .map((id) => ctx.promotesByNode.get(id))
        .filter((u): u is NodeUpdate => u !== undefined);
      if (updates.length) {
        try {
          ctx.runState = barrierMerge(ctx.runState, updates);
          await persistState(outDir, ctx.runState);
        } catch (e) {
          ctx.status.nodes['__barrier__'] = {
            id: '__barrier__', label: 'state barrier merge', status: 'error', artifacts: [],
            issues: [`stage barrier merge failed: ${(e as Error).message}`],
          };
          halted = true;
        }
        for (const id of s.nodeIds) ctx.promotesByNode.delete(id); // drain this stage's emits
      }

      // HALT-on-failure (run.mjs 1315–1322): first error/blocked stops the run; downstream never runs.
      if (results.some((r) => r.status === 'error' || r.status === 'blocked')) halted = true;

      // P6 — the NODE-BOUNDARY freeze point. All lanes have quiesced, the journal is flushed per-node,
      // and the barrier state is persisted — the one safe instant to hand the run to another host. If a
      // freeze is pending AND real work remains (not the last stage / not already halted), park the run:
      // completed nodes stay journaled, the untouched tail stays `pending`, and a target runner resumes
      // from this same run-dir via the journal. Heartbeat the lease here too (a healthy runner is never
      // mistaken for gone). A freeze on the final stage is moot — the run is finishing anyway.
      await lease?.renew();
      if (!halted && i < selected.length - 1 && (await freezeReq())) frozen = true;
    }

    ctx.status.stage = null;
    ctx.status.durationMs = baselineMs + (Date.now() - t0);
    if (frozen) {
      // PARKED, not done: the workflow is incomplete but cleanly quiesced for migration. `done:false`
      // + `ok:null` distinguishes it from both a finished run and a crash; `frozen` is the affirmative
      // signal the migration orchestrator (and the GUI) reads.
      ctx.status.frozen = true;
      ctx.status.done = false;
      ctx.status.ok = null;
      await writeStatus(outDir, ctx.status);
    } else {
      ctx.status.done = true;
      const vals = Object.values(ctx.status.nodes).filter((n) => n.id !== '__resume__');
      const failed = vals.filter((n) => n.status === 'error' || n.status === 'blocked').length;
      const okCount = vals.filter((n) => n.status === 'ok' || n.status === 'reused').length;
      ctx.status.ok = !halted && failed === 0;
      ctx.status.totals = { nodes: vals.length, ok: okCount, failed };
      await writeStatus(outDir, ctx.status);
    }
  } finally {
    // Run-level teardown — commit+copy-back (worktree) / collect+destroy (cloud). Best-effort: a
    // teardown failure must not mask the run verdict already written above.
    try { await scope.dispose(); } catch { /* non-fatal */ }
    // P6 — release the single-writer lease LAST, so the run-dir is fully quiesced (journal flushed,
    // scope disposed) before another runner can acquire it. On a freeze this is what lets the target
    // runner take over.
    await releaseLease();
  }
  return { status: ctx.status, outDir };
}
