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

import { promises as fs, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type {
  Workflow,
  NodeSpec,
  Stage,
  SandboxProvider,
  Sandbox,
  RunScope,
  OpenRunOpts,
  ToolRegistry,
  ResolveResult,
  ExecResult,
  SecretResolver,
  Escalator,
  PiCommandOptions,
  ReturnMode,
  RunState,
  CheckpointSpec,
  RetrySpec,
  FailureClass,
  OnFailure,
} from '../types.js';
import { defaultSecretResolver, defaultEscalator } from '../types.js';
import { DefaultToolRegistry } from '../tools/registry.js';
import { verifyToolBinding } from '../tools/verify.js';
import { InMemorySandboxProvider } from '../sandbox/index.js';
import { markersFromNode, emitMarkers } from '../contract.js';
import { effectiveChecks, evaluateChecks, actionForVerdict, classifyFailure, consultPreamble, legacyRetry, type FileBytes, type FailureSignals } from '../checks.js';
import { validateArtifactSchemas, defaultSchemaValidator, type SchemaValidator } from './schema.js';
import { runHooks } from '../hooks/index.js';
import { NodeRecorder, recordingSandbox, type EventSink } from './events.js';
import { defaultPiCommand, type CommandBuilder } from './command.js';
import {
  resolveNodeModel,
  loadModelTiers,
  loadModelsIndex,
  type ModelTiers,
  type EffectiveModel,
} from './model-routing.js';
import { resolveTokens, resolveAll, resolveDeep, type ResolveCtx } from '../workflow/resolver.js';
import { stageSeed } from '../workflow/ops/seed.js';
import { resolveSkillStage } from '../workflow/ops/skill.js';
import { runMerge, applyMergeOp } from '../workflow/ops/merge.js';
import { applyProjectionOp, runProjection } from '../workflow/ops/project.js';
import { readJsonSafe, absUnder } from '../workflow/ops/util.js';
import { parsePromote, extractPromoteValue, barrierMerge, type NodeUpdate, type ResolvedPromote } from '../workflow/ops/promote.js';
import { derivesFromOp, gatesFromOp, runOpsFromOp, actionsFromOp } from './op-dispatch.js';
import { loadState, persistState } from '../workflow/state.js';
import { createLimiter, normalizeConcurrent, type Limiter } from './limit.js';
import {
  type RunStatus,
  type NodeStatusRecord,
  type ArtifactState,
  nowISO,
  writeStatus,
  artifactState,
} from './status.js';
import { runJsonFile } from './layout.js';
import {
  type Journal,
  type NodeDecision,
  type JournalNode,
  envelopeHash,
  inputFilesOf,
  decideResume,
  descendantsMap,
  hashFile,
  loadJournal,
  writeJournalEntry,
} from './journal.js';
import {
  type CheckpointMarker,
  type CheckpointReply,
  type CheckpointJournalSlot,
  buildMarker,
  validateReply,
  writeMarker,
  readMarker,
  readReply,
  readCheckpointJournal,
  journalCheckpoint,
} from './checkpoint.js';

/** How the runner spawns the agent command — the kill-seam-bearing exec primitive (injectable). */
export interface ExecRunner {
  /**
   * Run `cmd` in `sandbox` under a node-timeout + silent-stall watchdog. Resolves with the buffered
   * result AND how it ended (`killed`). The DEFAULT races `sandbox.exec` against the timeout and, on
   * a watchdog trip, calls `killSeam` (SIGTERM→SIGKILL semantics live there) then abandons the wait —
   * so a hung exec can never hang the run. A test can inject its own to drive the watchdog offline.
   */
  (
    sandbox: Sandbox,
    cmd: string,
    opts: ExecWatchdogOpts,
  ): Promise<{ result: ExecResult; killed: null | 'timeout' | 'stall' }>;
}

/** Watchdog knobs handed to the exec runner. */
export interface ExecWatchdogOpts {
  /** Hard wall-clock cap for the node; on exceed → kill + `error` (killedTimeout). */
  nodeTimeoutMs: number;
  /** No stdout/stderr event for this long (0 = off) → kill + `error` (killedStall). */
  stallMs: number;
  /** ms to wait after SIGTERM before SIGKILL (the kill grace). */
  killGraceMs: number;
}

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
}

/** The checkpoint wait seam — polls for a reply until `accept` passes or the deadline elapses (G5). */
export interface CheckpointWaiter {
  (args: {
    run: string;
    nodeId: string;
    /** Epoch-ms deadline; `Infinity` ⇒ wait indefinitely (an attended, untimed checkpoint). */
    deadline: number;
    /** Read the current reply file (or null when absent/torn). */
    read: () => Promise<CheckpointReply | null>;
    /** True iff this reply is a VALID resolution for the marker (the runner's authority). */
    accept: (reply: CheckpointReply) => boolean;
    /** Abort promptly when the run is torn down (none today; reserved). */
    signal?: AbortSignal;
  }): Promise<CheckpointReply | null>;
}

/** The result of a run: the final status record + the host run dir it was written to. */
export interface RunResult {
  status: RunStatus;
  outDir: string;
}

// ── the default exec runner: race sandbox.exec against the watchdogs, kill on a trip ──────────────

/**
 * The default exec primitive. Races `sandbox.exec` against (a) a node-timeout and (b) a silent-stall
 * detector that fires when no stdout/stderr chunk arrives for `stallMs`. On a trip it ABORTS the
 * exec's `AbortSignal` — a signal-honoring provider (incl. InMemorySandbox) kills the child's process
 * group, so exec resolves (no orphan) and we report it as `killed`. A `killGraceMs` liveness fallback
 * settles anyway if a provider ignores the signal, so a hung exec can never hang the run.
 */
export const defaultExecRunner: ExecRunner = (sandbox, cmd, opts) =>
  new Promise((resolve) => {
    let settled = false;
    let trippedAs: null | 'timeout' | 'stall' = null;
    let lastEventAt = Date.now();
    const ac = new AbortController();
    let graceTimer: NodeJS.Timeout | undefined;
    const settle = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearInterval(stallTimer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({ result, killed: trippedAs });
    };
    const trip = (kind: 'timeout' | 'stall'): void => {
      if (settled || trippedAs) return;
      trippedAs = kind;
      try { ac.abort(); } catch { /* no-op */ } // real kill: a signal-honoring provider reaps the group
      // Liveness fallback: if a provider ignores the signal, settle after the kill grace anyway so a
      // hung exec never hangs the run (that path can orphan; a compliant provider's exec resolves first).
      graceTimer = setTimeout(() => settle({ stdout: '', stderr: `killed: ${kind}`, code: 124 }), opts.killGraceMs);
      graceTimer.unref?.();
    };
    const timeoutTimer = setTimeout(() => trip('timeout'), opts.nodeTimeoutMs);
    const stallTimer = opts.stallMs > 0
      ? setInterval(() => { if (Date.now() - lastEventAt > opts.stallMs) trip('stall'); }, Math.max(25, Math.floor(opts.stallMs / 4)))
      : (setInterval(() => {}, 1 << 30) as NodeJS.Timeout); // inert sentinel cleared in settle()
    const touch = (): void => { lastEventAt = Date.now(); };
    sandbox
      .exec(cmd, { signal: ac.signal, onStdout: touch, onStderr: touch })
      .then((result) => settle(result))
      .catch((err) => settle({ stdout: '', stderr: String(err), code: 1 }));
  });

// ── (G5) the default checkpoint waiter: poll the reply file on the watchRun cadence until valid/deadline ──

/**
 * The default checkpoint wait seam. Polls `read()` on the `watchRun` cadence (700ms) and resolves with the
 * first reply that `accept`s; resolves `null` when the deadline elapses. This is the ONLY place that sleeps
 * on real wall-clock — tests inject a fast/zero-sleep poller via `RunOptions.checkpointWait`, so the suite
 * is deterministic. A torn/missing file simply makes `read()` return null and the wait persists.
 */
export const defaultCheckpointWait: CheckpointWaiter = async ({ deadline, read, accept, signal }) => {
  const pollMs = 700;
  for (;;) {
    if (signal?.aborted) return null;
    const reply = await read();
    if (reply && accept(reply)) return reply;
    if (Date.now() >= deadline) return null;
    const remaining = deadline === Infinity ? pollMs : Math.min(pollMs, deadline - Date.now());
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, Math.max(0, remaining));
      t.unref?.();
      signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }
};

// ── forgiving return-parse (run.mjs lastJsonBlock 670–698) ────────────────────────────────────────

// The recovered structured return: the recognized fields PLUS any arbitrary `@return:<field>` payload a
// promote may lift (§3.6 — `lastJsonBlock` already JSON.parses the WHOLE block; we just stop narrowing it).
type NodeReturn = { status?: string; summary?: string; issues?: string[] } & Record<string, unknown>;

/** Recover a node's return object from its stdout. Tries closed ```json, unclosed fence, last {…}. */
export function lastJsonBlock(text: string): NodeReturn | null {
  if (!text) return null;
  const tryParse = (s: string): NodeReturn | null => { try { return JSON.parse(s.trim()); } catch { return null; } };
  const fenced = /```json\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = fenced.exec(text))) last = m[1];
  if (last) { const o = tryParse(last); if (o) return o; }
  const open = text.lastIndexOf('```json');
  if (open >= 0) { const o = tryParse(text.slice(open + 7).replace(/```\s*$/, '')); if (o) return o; }
  for (let end = text.lastIndexOf('}'); end >= 0; end = text.lastIndexOf('}', end - 1)) {
    let depth = 0; let start = -1;
    for (let i = end; i >= 0; i--) {
      if (text[i] === '}') depth++;
      else if (text[i] === '{') { depth--; if (depth === 0) { start = i; break; } }
    }
    if (start < 0) break;
    const o = tryParse(text.slice(start, end + 1));
    if (o && typeof o === 'object' && ('status' in o || 'summary' in o)) return o;
  }
  return null;
}

// ── stage-window selection (run.mjs selectStages 600–635) ─────────────────────────────────────────

function stageMatches(stage: Stage, wf: Workflow, needle: string): boolean {
  const q = needle.toLowerCase();
  if ((stage.phase ?? '').toLowerCase().includes(q)) return true;
  return stage.nodeIds.some((id) => {
    const n = wf.nodes[id];
    return id.toLowerCase().includes(q) || (n?.label ?? '').toLowerCase().includes(q);
  });
}

function selectWindow(wf: Workflow, from?: string, until?: string): { fromIdx: number; untilIdx: number } {
  const stages = wf.stages;
  let fromIdx = 0;
  let untilIdx = stages.length - 1;
  if (from) {
    const i = stages.findIndex((s) => stageMatches(s, wf, from));
    if (i >= 0) fromIdx = i;
  }
  if (until) {
    let last = -1;
    stages.forEach((s, i) => { if (stageMatches(s, wf, until)) last = i; });
    if (last >= 0) untilIdx = last;
  }
  if (fromIdx > untilIdx) fromIdx = 0; // a from-after-until is incoherent → ignore from
  return { fromIdx, untilIdx };
}

// ── MCP config staging (env/secret porting — see docs/research/tool-bridge-env-2026-06-21.md) ───────
// When a node selected bridge tools (mcp./oc.) AND a run-level `mcpConfig` is present, the runner stages
// the server map to `_pi/mcp.json` (verbatim — the map carries `$VAR` refs, NEVER literal secrets) and
// injects, via the `CreateOpts.env` seam, `PIFLOW_MCP_CONFIG` (the ABSOLUTE in-sandbox path of that file)
// + the referenced secret env vars. The bridge inside the pi child expands the refs at resolution time.
// An `oc.*` selection stages identically: the host supplies the reserved `openclaw` server in
// `mcpConfig.servers` exactly like any MCP server, and the runner writes/forwards it verbatim.

/** Provider kinds with no host trust boundary — the host env must NOT be spread into the VM (allowlist only). */
const CLOUD_KINDS = new Set<SandboxProvider['kind']>(['daytona', 'e2b']);

/**
 * IN-PLACE provider kinds — the node runs DIRECTLY in the real workspace (no throwaway copy), so its
 * deliverable already lives at its host location and there is NOTHING to collect: `downloadDir` would be a
 * GUARDED-IDENTITY no-op when `sandbox.output` resolves to `outDir`, but the compile default `out/<id>` is
 * a WORKSPACE-root subdir ≠ the run dir, so the SAME guard THROWS "identity-only" (local.ts:208). The throw
 * is the CORRECT guard; the runner is the violating caller — so for an in-place provider we SKIP the
 * download entirely. Every OTHER kind (inmemory/seatbelt/worktree mkdtemp throwaways, daytona/e2b VMs)
 * writes to a separate `out/<id>` and MUST copy back, byte-unchanged. (`local`'s `kind` lives on the
 * instance; reading it off the recording-wrapped sandbox is unreliable — `ctx.providerKind` is the
 * already-threaded backend-policy seam, the same one CLOUD_KINDS uses.)
 */
const IN_PLACE_KINDS = new Set<SandboxProvider['kind']>(['local']);

/**
 * Did this node select at least one BRIDGE tool (mcp./oc.)? True iff an `mcp.<server>:<tool>` OR an
 * `oc.<plugin>:<tool>` address survives `allow` minus `deny`. Both families execute through the bridge,
 * which resolves its server config from the staged `_pi/mcp.json` — so either kind triggers staging.
 * Exported for direct unit testing of the staging-trigger predicate.
 */
export function selectedBridgedTool(node: NodeSpec): boolean {
  const deny = new Set(node.tools.deny ?? []);
  return (node.tools.allow ?? []).some((a) => (a.startsWith('mcp.') || a.startsWith('oc.')) && !deny.has(a));
}

/** The SET of `$VAR`/`${VAR}` names referenced anywhere in the config's string values (deep walk). */
function referencedEnvVars(config: { servers: Record<string, unknown> }): Set<string> {
  const names = new Set<string>();
  // matchAll is stateless per call (no shared lastIndex), so a fresh regex literal per string is correct.
  const ref = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(ref)) names.add(m[1] ?? m[2]);
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x);
    } else if (v && typeof v === 'object') {
      for (const x of Object.values(v)) walk(x);
    }
  };
  walk(config.servers);
  return names;
}

/**
 * Build the env additions for a node that staged `_pi/mcp.json`: `PIFLOW_MCP_CONFIG` (the absolute path)
 * plus EACH REFERENCED var resolved through the `SecretResolver` SEAM. This is a DECLARED ALLOWLIST —
 * only the `$VAR` names the config actually references cross into the node; the host env is NEVER spread
 * wholesale.
 *
 * The resolver is the broker seam. By default it reads `process.env` (today's behavior), but a host can
 * plug a scoped-token / sealing broker: it MINTS a SHORT-LIVED, SCOPED token HOST-SIDE and returns THAT
 * here, so the runner injects the scoped token as the env value and the bridge expands `$VAR` to it
 * exactly as today — the real long-lived credential NEVER crosses into the cloud VM. (A sealing/egress
 * proxy that swaps the scoped reference for the real credential at the gateway is the alternative the
 * same seam supports.) The resolver gets `{ nodeId, isCloud }` so it can mint a per-node, cloud-only token.
 *
 * The allowlist is enforced identically for every backend, but it is LOAD-BEARING on cloud: a cloud VM
 * (daytona/e2b) does NOT inherit `process.env` (the provider's exec merges only `{...this.env,...opts.env}`),
 * so these additions are the ONLY way a secret reaches the VM — and they must be exactly the referenced
 * set, nothing else, so an unrelated host secret can't ride along. On local backends the child already
 * inherits `process.env` via the provider's exec merge; forwarding the referenced (resolved) set here is
 * harmless (and correct if a var lives only in the parent process), and we still never blast the rest.
 */
export async function mcpEnvAdditions(
  configPathAbs: string,
  referenced: Set<string>,
  isCloud: boolean,
  nodeId: string,
  resolver: SecretResolver = defaultSecretResolver,
): Promise<Record<string, string>> {
  const env: Record<string, string> = { PIFLOW_MCP_CONFIG: configPathAbs };
  for (const name of referenced) {
    const value = await resolver(name, { nodeId, isCloud });
    if (value !== undefined) env[name] = value;
  }
  // Defense-in-depth against drift: on cloud the additions MUST be exactly PIFLOW_MCP_CONFIG + the
  // referenced (allowlisted) names — any other key here would be a host-env leak into the VM.
  if (isCloud) {
    for (const key of Object.keys(env)) {
      if (key !== 'PIFLOW_MCP_CONFIG' && !referenced.has(key)) delete env[key];
    }
  }
  return env;
}

/**
 * (M1 — provider-credential parity) Build the cloud env additions for the pi agent's OWN provider/gateway
 * credential — the SAME shape `mcpEnvAdditions` builds for MCP `$VAR`s, on the SAME `SecretResolver`+allowlist
 * seam. `defaultPiCommand` stamps `--provider`/`--model` but NO key; pi reads the key from its env. A local
 * child inherits `process.env`, but a cloud VM (daytona/e2b) does NOT — so the declared provider var(s) must
 * cross via the `CreateOpts.env` allowlist or pi boots with no model credential.
 *
 * Resolves EACH declared name through the resolver (which gets `{nodeId, isCloud}` so a host can mint a
 * per-node, cloud-only SCOPED token, never the raw long-lived key). Returns ONLY the resolved declared set —
 * an unknown name is simply absent, never injected as `undefined`. Empty/undefined ⇒ no additions.
 *
 * Gated to `isCloud`: on a LOCAL backend the child already inherits the parent `process.env`, so forwarding
 * here is redundant — and skipping it keeps the additive promise (a local run is byte-identical). The
 * allowlist nature is intrinsic: the returned set IS the declared names, nothing else, so an unrelated host
 * secret can never ride along into the VM.
 */
export async function cloudCredEnvAdditions(
  cloudSecrets: string[] | undefined,
  isCloud: boolean,
  nodeId: string,
  resolver: SecretResolver = defaultSecretResolver,
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  if (!isCloud || !cloudSecrets?.length) return env;
  for (const name of cloudSecrets) {
    const value = await resolver(name, { nodeId, isCloud });
    if (value !== undefined) env[name] = value;
  }
  return env;
}

// ── the per-node lifecycle ────────────────────────────────────────────────────────────────────────

interface RunContext {
  wf: Workflow;
  outDir: string;
  registry: ToolRegistry;
  buildCommand: CommandBuilder;
  execRunner: ExecRunner;
  providerName: string;
  model?: string;
  /**
   * G1 — global routing config (the activatable tier map + pi's models.json index), loaded ONCE at run start.
   * The per-node effective model/provider is resolved from this via `resolveNodeModel` at the build call.
   */
  modelRouting: { tiers: ModelTiers; modelsIndex: Map<string, string> };
  /** ENV-FREE command-builder opts (thinking / extra -e extensions) forwarded at the call site. */
  commandOpts: PiCommandOptions;
  recordEvents: boolean;
  onEvent?: EventSink;
  watchdog: ExecWatchdogOpts;
  status: RunStatus;
  /** Resolved schema validator (default ajv-2020 / injected / null=disabled) for the schema gate. */
  validateSchema: SchemaValidator | null;
  /** The MCP server map staged into `_pi/mcp.json` for bridge-tool nodes (mcp./oc.) (verbatim; bridge owns validation). */
  mcpConfig?: { servers: Record<string, unknown> };
  /** The provider's backend kind — drives the cloud (daytona/e2b) env ALLOWLIST vs local passthrough policy. */
  providerKind: SandboxProvider['kind'];
  /** Per-node secret resolver (the scoped-token / sealing-broker seam). Undefined ⇒ `defaultSecretResolver`. */
  secretResolver?: SecretResolver;
  /** (M1) Provider/gateway credential env var names forwarded into a CLOUD VM exec env (the allowlist). */
  cloudSecrets?: string[];
  /** (G12 — M4) The notify host seam. Undefined ⇒ `defaultEscalator` (warn → console). */
  escalator: Escalator;
  /**
   * (G12 — M4) The per-node FailureSignals `runNode` computed at its verdict point, keyed by node id —
   * the EMPIRICAL inputs `classifyFailure`/`consultPreamble` read in `runNodeWithRetries` (the retry /
   * escalate lanes). Set on every terminal verdict; absent ⇒ no failure to classify (the node ran ok).
   */
  failureSignals: Map<string, FailureSignals>;
  /** Run-level default for the return handshake (a node's own `returnMode` wins; else this; else the artifact heuristic). */
  returnProtocol?: ReturnMode;
  /** `{{WORKSPACE}}` — the canonical out-of-thread tree tokens resolve against (default repoRoot). */
  workspace: string;
  /** The run-level args `{{arg.<key>}}` tokens resolve against (`--arg k=v`). */
  args: Record<string, string>;
  /**
   * The per-thread RunState `{{state.<channel>}}` tokens resolve against. Loaded once at run start and
   * folded at each stage barrier (S3). MUTABLE: the barrier replaces it after each stage's merge.
   */
  runState: RunState;
  /**
   * The promote updates each node emitted this stage, keyed by node id — drained + barrier-merged at the
   * stage barrier (LangGraph super-step: independent emits, ONE serial merge). A node writes only its own
   * key (lane-safe); a non-ok node never writes (it promotes nothing).
   */
  promotesByNode: Map<string, NodeUpdate>;
  /**
   * The G2 concurrency cap — ONE global FIFO limiter for the whole run. Each stage lane's
   * `runNodeWithRetries` is wrapped in it, so no more than `maxConcurrent` real `pi` children run at
   * once (and a node's retries share the lane's single slot — the wrap is OUTSIDE the retry loop).
   */
  limiter: Limiter;
  /**
   * COLLECT MUTEX — a one-slot FIFO limiter that SERIALIZES the per-node output collection (`downloadDir`)
   * across a parallel stage. The exec runs concurrently (the expensive part), but every lane copies its
   * sandbox output dir back into the SHARED host run dir ONE-AT-A-TIME. WHY: two parallel nodes whose
   * artifacts land under a common subdir (e.g. both write `shared/*`) race in the recursive copy on
   * creating that common dir — one `fs.cp` throws EEXIST and (pre-fix) the error was swallowed, silently
   * dropping that node's file → a MISLEADING "required artifact missing". Serializing collect removes the
   * overlap entirely. (Separate from `limiter`, the G2 exec cap, which gates the `pi` spawns, not collect.)
   */
  collectMutex: Limiter;
  /** OPT-IN run-wide total-node ceiling (undefined ⇒ no cap); exceeding it HALTS via a synthetic record. */
  maxNodesPerRun?: number;
  /** Count of nodes that have ACQUIRED a slot this run (incremented once per node at admission) — for `maxNodesPerRun`. */
  spawnedNodes: { n: number };
  /**
   * G4 journal context — present whenever journaling is active (always, today). `meta` keys the
   * journal doc (runId/source); `envHash` is each node's envelope hash, computed ONCE at run-start (the
   * SAME hash `decideResume` consulted) so `finishNode` records the identity the next resume compares
   * against — never re-derived divergently. A node that RAN to a good verdict writes its entry here.
   */
  journal: { meta: { runId: string; source: string }; envHash: Record<string, string> };
  /** (G5) Whether a checkpoint PARKS for a reply (`'interactive'`) or takes the headless policy now (`'default'`). */
  checkpointReply: 'interactive' | 'default';
  /** (G5) The wait/poll seam (injectable in tests). */
  checkpointWait: CheckpointWaiter;
}

/** Read a host-side input file as bytes (for staging a downstream node's reads). */
async function readHostFile(ctx: RunContext, rel: string): Promise<Uint8Array | null> {
  try {
    return await fs.readFile(path.resolve(ctx.outDir, rel));
  } catch {
    return null;
  }
}

/**
 * Stage a host path (a seeded dest under `outDir`) INTO the sandbox at the same relative path, so the
 * model reads it (the filesystem-as-contract bridge, mirroring the io.reads staging). A FILE writes once;
 * a DIRECTORY is walked and each file written at its run-relative posix path. `rel` is run-relative;
 * `'.'` (a dir seed at the run root) stages the dir's tree directly under the sandbox root.
 */
async function stageHostPathIntoSandbox(sandbox: Sandbox, outDir: string, rel: string): Promise<void> {
  const abs = path.resolve(outDir, rel);
  let isDir = false;
  try {
    isDir = (await fs.stat(abs)).isDirectory();
  } catch {
    return; // nothing to stage (a skipped seed reaches here only when staged:true, so this is defensive)
  }
  if (!isDir) {
    const data = await fs.readFile(abs);
    await sandbox.writeFile(toPosixRel(rel), data);
    return;
  }
  // Walk the dir; stage each file at its run-relative posix path.
  const walk = async (dirAbs: string): Promise<void> => {
    for (const ent of await fs.readdir(dirAbs, { withFileTypes: true })) {
      const childAbs = path.join(dirAbs, ent.name);
      if (ent.isDirectory()) await walk(childAbs);
      else {
        const childRel = path.relative(outDir, childAbs);
        await sandbox.writeFile(toPosixRel(childRel), await fs.readFile(childAbs));
      }
    }
  };
  await walk(abs);
}

/** Normalize a host path-relative string to a posix sandbox-relative path (no leading `./`). */
function toPosixRel(rel: string): string {
  return rel.split(path.sep).join('/').replace(/^\.\//, '');
}

/**
 * Run ONE node through the full lifecycle. Returns its terminal record (already in ctx.status.nodes).
 *
 * create → stage io.reads (from the host run dir) + write the prompt file → PRE hooks → exec the
 * built command under the watchdog → downloadDir(output)→host → verify io.artifacts by host-stat →
 * POST hooks → dispose → write status.
 */
/**
 * Run a node with its per-node RETRY budget (`io.retries`): the first attempt plus up to `retries`
 * MORE attempts whenever the node ends `error`/`blocked` (a transient model/timeout failure). Each
 * attempt is a FRESH `runNode` (own sandbox, re-seed, re-exec); the LAST attempt's record is returned
 * (last-wins). `ok`/`warn` never retries; `retries` 0/undefined ⇒ exactly one attempt (today's
 * behavior). Worst-case wall = (retries+1) × the node's timeout.
 */
// ── (G5) the HUMAN CHECKPOINT lane — no `pi`, no slot held while parked ──────────────────────────────

/**
 * Run a checkpoint node: write a marker, PARK watching for a reply (no `pi`, no sandbox), validate it, and
 * resolve `ok` carrying the chosen value — or, headlessly, take the declared `default` (journaled) so a
 * background run never hangs. CRASH-SAFE: the pending wait is journaled into `.pi/state.json`
 * `__checkpoints__`; if a journaled entry is already `resolved` (a prior run answered it), this REPLAYS
 * that value and does NOT re-ask. The reply is the RUNNER's to validate — a malformed/stale reply is
 * ignored and the wait persists. Called OUTSIDE the G2 limiter (see the stage fan-out), so a parked
 * checkpoint never holds a concurrency slot.
 */
async function runCheckpoint(ctx: RunContext, node: NodeSpec, spec: CheckpointSpec): Promise<NodeStatusRecord> {
  const rec = ctx.status.nodes[node.id];
  const t0 = Date.now();

  // CRASH-RESUME REPLAY: a prior run that already journaled a `resolved` reply for THIS question replays it
  // (does NOT re-ask / re-journal). Match on the question hash so an edited question (new hash) re-prompts.
  const journalSlot = (await readCheckpointJournal(ctx.outDir))[node.id];
  const marker = buildMarker(node.id, node.label, spec, nowISO());
  if (journalSlot && journalSlot.status === 'resolved' && journalSlot.hash === marker.hash) {
    return finishCheckpoint(ctx, node, rec, t0, 'ok', journalSlot.reply, 'replayed prior reply');
  }

  // WRITE THE MARKER (status pending). Crash-safe: also journal the pending wait into `.pi/state.json`
  // `__checkpoints__` (preserve `askedAt` across a crash so the wait is stable). Reuse a prior marker's
  // `askedAt` when the question is unchanged so a re-entered wait keeps one identity.
  if (journalSlot && journalSlot.status === 'pending' && journalSlot.hash === marker.hash) {
    marker.askedAt = journalSlot.askedAt;
  }
  rec.status = 'awaiting-input';
  rec.startedAt = marker.askedAt;
  await writeMarker(ctx.outDir, marker);
  await journalCheckpoint(ctx.outDir, node.id, { status: 'pending', hash: marker.hash, askedAt: marker.askedAt });
  await writeStatus(ctx.outDir, ctx.status);

  // DECIDE: a DETACHED run (`checkpointReply:'default'`) skips the wait; an ATTENDED run parks up to
  // `timeoutMs` (Infinity ⇒ untimed). The wait/poll is the injectable seam (deterministic tests).
  let reply: CheckpointReply | null = null;
  if (ctx.checkpointReply === 'interactive') {
    const deadline = spec.timeoutMs !== undefined ? Date.now() + spec.timeoutMs : Infinity;
    reply = await ctx.checkpointWait({
      run: ctx.outDir,
      nodeId: node.id,
      deadline,
      read: () => readReply(ctx.outDir, node.id),
      // THE RUNNER IS THE AUTHORITY: only a reply that validates against the marker the runner wrote ends
      // the wait. A malformed/stale/bad-choice reply fails `accept` → the wait persists.
      accept: (r) => validateReply(marker, r).ok,
    });
  }

  // RESOLVED by a valid reply → journal the value, finish ok.
  if (reply) {
    const verdict = validateReply(marker, reply); // re-validate (authority) — accept() already passed
    if (verdict.ok) {
      return finishCheckpoint(ctx, node, rec, t0, 'ok', verdict.value, 'reply accepted');
    }
  }

  // NO (valid) reply within the bound → the headless SAFETY policy.
  const headless = marker.headless;
  if (headless === 'abort') {
    // Finish `error` so the run HALTS at the barrier (the loud-failure convention). Journal nothing.
    rec.issues = ['checkpoint aborted: no reply and headless:abort'];
    return finishCheckpoint(ctx, node, rec, t0, 'error', undefined, 'checkpoint aborted (headless:abort)');
  }
  // `headless:'default'` → take the declared default and JOURNAL it (mirrors the competitor; never hangs).
  return finishCheckpoint(ctx, node, rec, t0, 'ok', spec.default, 'headless default taken');
}

/**
 * Stamp a checkpoint node's terminal record, flip the marker + `__checkpoints__` journal to `resolved` (on
 * `ok`), and write the §G4 journal entry carrying `checkpointReply` (so a future content-hash resume
 * REPLAYS the value). On `error` (headless:abort) nothing is journaled — the next resume re-asks.
 */
async function finishCheckpoint(
  ctx: RunContext,
  node: NodeSpec,
  rec: NodeStatusRecord,
  t0: number,
  status: 'ok' | 'error',
  value: unknown,
  summary: string,
): Promise<NodeStatusRecord> {
  rec.status = status;
  rec.endedAt = nowISO();
  rec.durationMs = Date.now() - t0;
  rec.artifacts = [];
  rec.summary = summary;

  if (status === 'ok') {
    const resolvedAt = nowISO();
    const slot: CheckpointJournalSlot = {
      status: 'resolved',
      hash: ctx.journal.envHash[node.id] ?? '',
      askedAt: rec.startedAt ?? resolvedAt,
      reply: value,
      resolvedAt,
    };
    // The crash-safety journal carries the QUESTION hash (re-asked-question guard); recompute it from the
    // marker so it survives a value-only edit elsewhere. Use the marker's question hash, not the envelope.
    const marker = await readMarker(ctx.outDir, node.id);
    if (marker) {
      slot.hash = marker.hash;
      marker.status = 'resolved';
      await writeMarker(ctx.outDir, marker);
    }
    await journalCheckpoint(ctx.outDir, node.id, slot);
    rec.summary = `${summary}: ${JSON.stringify(value)}`;
  }
  await writeStatus(ctx.outDir, ctx.status);

  // §G4 journal: a checkpoint node has no inputs/outputs to hash; record the envelope hash + the reply so a
  // resume whose question is unchanged REPLAYS the value (a changed question flips the envelope hash → re-run).
  if (status === 'ok') {
    const entry: JournalNode = {
      hash: ctx.journal.envHash[node.id] ?? envelopeHash(node, { piTools: [] }, ctx.model),
      inputHashes: {},
      outputHashes: {},
      status: 'ok',
      producedAt: nowISO(),
      checkpointReply: value,
    };
    await writeJournalEntry(ctx.outDir, ctx.journal.meta, node.id, entry);
  }
  return rec;
}

/**
 * (G12 — M4) The trigger-action runtime — the bounded retry-by-failure-class + escalate-with-evidence
 * lanes around `runNode`, ported from run.mjs `runNodeWithEscalation`. ADDITIVE: a node that declares
 * NEITHER `io.retry` NOR `io.escalate` runs `legacyRetry(io.retries)` — today's EXACT semantics (max
 * extra attempts on a transient error/blocked, classes ['infra','degenerate']; no escalation).
 *
 * On each failed attempt the runner DERIVES a `FailureClass` from the signals `runNode` captured (never a
 * self-score) and routes: `halt` → stop immediately (escalation can't manufacture a missing input);
 * a same-model `retry` while the class is in the retry set AND budget remains; else, once the retry
 * budget is spent (or `escalate.after` is reached), ONE cross-family `escalate` on the stronger
 * `escalate.tier`/`escalate.model`-resolved model fed `consultPreamble` evidence. The last attempt wins.
 */
async function runNodeWithRetries(ctx: RunContext, node: NodeSpec, scope: RunScope): Promise<NodeStatusRecord> {
  const retry: RetrySpec = node.io.retry ?? legacyRetry(node.io.retries);
  const escalate = node.io.escalate;
  const retryAllows = (cls: FailureClass): boolean => (retry.on ? retry.on.includes(cls) : cls !== 'halt');
  const escAllows = (cls: FailureClass): boolean => (escalate?.on ? escalate.on.includes(cls) : cls !== 'halt');

  // ── (SA-D · expert-representations) L1 / L2 / L3 self-correction wiring ─────────────────────────
  //
  // SA-B (gate-authoring.ts:359–365) emits `op.action { kind:'retry', scope:'feedback'|'fix', max }` as
  // canonical op[] entries on the node. We read them here ONCE and use them to override/supplement the
  // per-node `io.retry`/`io.retries` budget with the gate's feedback-aware semantics.
  //
  // L1 (scope:'feedback', DEFAULT, BUILD): on each failed attempt, inject the gate's critique — the
  // EMPIRICAL failure evidence (`consultPreamble`) — as a `promptPrefix` into the NEXT cold re-invocation.
  // This is Reflexion / Self-Refine semantics: the producer receives its failure reason and is asked to
  // fix it in a FRESH pi process (NOT a warm session resume — that infra is absent on this branch; see the
  // flag below). The feedback MUST reach the retry attempt; a blind same-input retry is the WRONG default.
  //
  // NOTE: TRUE WARM-RESUME is not available here. `pi` is invoked with `--no-session` (command.ts:71);
  // there is no `--resume-session`/`--session-id`/`--mode rpc` on this branch. The control-session /
  // companion work (pi rpc-mode, session continuation) likely lives on main. When that infra merges, the
  // warm-resume path here should: (a) persist the session id from the first invocation's event stream,
  // (b) invoke pi with `--resume <sessionId>` + the feedback as an appended message, NOT a fresh @prompt.
  // FLAG: search for TODO[warm-resume] to find the exact point to upgrade.
  //
  // L2 (scope:'fix') — STUB. When the gate emits `scope:'fix'`, the intended behavior is:
  //   1. Infer the problem class from the failure signals (classifyFailure already does this).
  //   2. Consult the per-workflow fix/issue memory (a run-scoped, recorded structure — NOT yet built).
  //   3. Patch THIS node's prompt/tool-wiring for this run instance ONLY (ephemeral, recorded).
  //   4. Resume with the patched node — still a cold re-invocation until warm-resume lands.
  //   Best-effort, no guarantee. Promotion of the patch to the template = L3 (held-out check + human gate).
  //   Reference: docs/research/2026-06-28-loop-engineering-self-improving-systems.md (loop engineering,
  //   §"Memory-augmented loops" / "Reflexion" / "per-run fix memory"); build-spec §Self-correction.
  //   Owned by SA-D + the memory system. NOT YET IMPLEMENTED — falls through to L1 feedback for now.
  //
  // L3 — STUB. Between-run DAG-level optimization (patch promotion to template, held-out check, human
  //   gate). Owned by Hermes / `piflow-enhance` (between-runs, human-gated). NOT in scope for SA-D.
  //   Reference: docs/design/expert-representations-build-spec.md §Self-correction (decision 6).
  const { retryAction } = actionsFromOp(node.op);
  // Determine the effective retry budget: the op[] action op's `max` wins over `io.retry`/`io.retries`
  // when a gate-authored retry action is present (the gate author set an explicit budget).
  const opRetryMax = retryAction?.max;
  const effectiveRetryMax = opRetryMax !== undefined ? Math.max(0, opRetryMax) : Math.max(0, retry.max);
  // Only L1 (scope:'feedback') and the default (undefined = 'feedback') are wired. L2 (scope:'fix') stubs
  // through to L1 feedback: the scope is read, logged implicitly via the seam comment, but NOT executed.
  const l1Active = retryAction !== undefined && (retryAction.scope === 'feedback' || retryAction.scope === undefined || retryAction.scope === 'fix');
  // ── end SA-D wiring header ─────────────────────────────────────────────────────────────────────────

  let rec = await runNode(ctx, node, scope);
  let retriesLeft = opRetryMax !== undefined ? effectiveRetryMax : Math.max(0, retry.max);
  let escalatedYet = false;
  // `escalate.after` (default: after the retry budget is spent) gates how many same-model attempts run
  // before the consult. With no explicit `after`, escalation waits until `retriesLeft` reaches 0.
  let attemptsRun = 1;

  while (rec.status === 'error' || rec.status === 'blocked') {
    const sig = ctx.failureSignals.get(node.id);
    if (!sig) break; // no captured signals (e.g. a pre-exec bind/stage error) — nothing to classify.
    const cls = classifyFailure(sig);
    if (cls === 'halt') break; // a missing upstream input — refuse to spin a retry/escalate.

    const afterReached = escalate?.after !== undefined ? attemptsRun >= escalate.after : retriesLeft <= 0;
    if (retriesLeft > 0 && retryAllows(cls) && !(escalate && afterReached && escAllows(cls))) {
      retriesLeft--;
      attemptsRun++;
      if (l1Active) {
        // L1 — scope:'feedback': inject the gate critique as a promptPrefix on the cold re-invocation.
        // This is the FEEDBACK-INJECTED cold path (not warm-resume; see TODO[warm-resume] above).
        // consultPreamble builds a DRIVER-VERIFIED evidence block (missing artifacts, schema errors,
        // failed checks, stderr tail, watchdog kills) — NEVER a model self-score. The producer sees
        // EXACTLY what failed and is asked to fix it. This is the Reflexion / Self-Refine pattern.
        //
        // L2 NOTE: if retryAction.scope === 'fix', the fix memory lookup would happen HERE before
        // invoking runNode — patch the node's prompt/tool-wiring, then call runNode with the patched
        // node. The stub falls through to feedback (same cold re-invocation, same evidence prefix).
        // TODO[warm-resume]: when pi session-resume infra is available, replace the runNode call below
        // with: persist sessionId from the first attempt's event stream, then invoke pi with
        // `--resume <sessionId>` and the feedback appended as a NEW message (not a fresh @prompt file).
        rec = await runNode(ctx, node, scope, { promptPrefix: consultPreamble(sig) });
      } else {
        // Same-model retry: a FRESH attempt (re-seed + re-exec), no consult prefix, the node's own model.
        rec = await runNode(ctx, node, scope);
      }
    } else if (escalate && !escalatedYet && escAllows(cls)) {
      // Cross-family CONSULT: resolve the stronger target through model-routing, prepend the verified
      // evidence. ONE escalation only (a second would just re-spend on the same class).
      escalatedYet = true;
      attemptsRun++;
      let eff: EffectiveModel;
      try {
        eff = resolveNodeModel(
          { model: escalate.model, tier: escalate.tier },
          { model: ctx.model, provider: ctx.providerName, tiers: ctx.modelRouting.tiers, modelsIndex: ctx.modelRouting.modelsIndex },
        );
      } catch {
        break; // an unresolvable escalation tier ⇒ keep the failed record (loud via its own issue).
      }
      rec = await runNode(ctx, node, scope, { promptPrefix: consultPreamble(sig), model: eff.model, provider: eff.provider });
    } else {
      break; // budget spent and no escalation applies — the failed record stands.
    }
  }
  return rec;
}

/**
 * (G12 — M3 · #17) Run a GENERATED reroute EXISTENCE-GATE node: stat the prior attempt's canonical verify
 * artifact and SHORT-CIRCUIT the bounded re-entry when it is present. Spawns NO `pi`, holds no sandbox. On a
 * PASS (the artifact exists): COPY it forward to each `copyTo` dest (so the downstream that was re-pointed
 * onto this attempt's output has its input), MARK every cloned body id `reused` so it never spawns, write
 * the gate's own `gate.ok` sentinel (the forward edge the re-entry root reads), and finish `ok`. On a MISS
 * (the prior attempt failed): write the sentinel and finish `ok`, leaving the cloned body `pending` so the
 * fix attempt runs. Mirrors `runCheckpoint` as a no-pi node-kind; the run loop calls it OUTSIDE the G2 limiter.
 */
async function runRerouteGate(ctx: RunContext, node: NodeSpec): Promise<NodeStatusRecord> {
  const gate = node.rerouteGate!;
  const rec = ctx.status.nodes[node.id];
  rec.status = 'running';
  rec.startedAt = nowISO();
  const t0 = Date.now();

  const priorOk = gate.artifact ? (await artifactState(path.resolve(ctx.outDir, gate.artifact), gate.artifact)).exists : false;
  // The forward-edge sentinel (the re-entry root reads it, so the gate orders BEFORE the clones).
  const sentinel = node.io.produces[0];
  if (sentinel) {
    const dest = path.resolve(ctx.outDir, sentinel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, priorOk ? 'pass' : 'fix');
  }

  if (priorOk) {
    // Short-circuit: copy the passing artifact forward to this attempt's output(s), so the downstream node
    // (re-pointed onto this attempt) reads it WITHOUT the clone running.
    for (const to of gate.copyTo) {
      const src = path.resolve(ctx.outDir, gate.artifact);
      const dst = path.resolve(ctx.outDir, to);
      await fs.mkdir(path.dirname(dst), { recursive: true });
      try { await fs.copyFile(src, dst); } catch { /* best-effort: a missing src is the gate's own miss */ }
    }
    // Mark every cloned body `reused` — the run loop SKIPS a `reused` lane (it never spawns `pi`, never holds
    // a slot). The bodies live in LATER stages (the gate is upstream), so flipping their seeded status here
    // takes effect when the loop reaches them. This is the #17 short-circuit: the cloned bodies provably do
    // not spawn on a passing attempt.
    for (const id of gate.skip) {
      const r = ctx.status.nodes[id];
      if (r && r.status !== 'ok') r.status = 'reused';
    }
  }

  const states = await Promise.all(
    node.io.artifacts.map((a) => artifactState(path.resolve(ctx.outDir, a.path), a.path)),
  );
  rec.status = 'ok';
  rec.endedAt = nowISO();
  rec.durationMs = Date.now() - t0;
  rec.artifacts = states;
  rec.summary = priorOk ? 'reroute gate: prior attempt PASSED — re-entry short-circuited' : 'reroute gate: prior attempt failed — running fix';
  await writeStatus(ctx.outDir, ctx.status);
  return rec;
}

// ── (PROGRAMMATIC NODE) the no-pi DECLARATIVE-OPS lane ──────────────────────────────────────────────

/**
 * Run a PROGRAMMATIC node: a node carrying `programmatic:true` runs its DECLARATIVE ops deterministically
 * and spawns NO `pi` — NO `buildCommand`, NO exec. It is the no-pi twin of `runCheckpoint`/`runRerouteGate`,
 * for a purely-deterministic step (e.g. a render) that should be an honest DAG vertex with no vestigial
 * agent. The lifecycle MIRRORS `runNode` but DROPS everything model-specific (sandbox, prompt staging,
 * skill/MCP/tool resolution, the command build + exec, COLLECT/downloadDir, the return handshake, the G8
 * schema-repair loop): PRE seeds (staged onto the host run dir = `{{RUN}}`) → PRE gates → POST DERIVE ops
 * (project/registryProject/merge/`run`) → POST checks → status ladder → POST hooks → promote → finishNode.
 * The op executors (`stageSeed`/`applyProjectionOp`/`runProjection`/`runMerge`/`applyMergeOp`/`evaluateChecks`)
 * and `finishNode` are REUSED UNCHANGED — this lane only changes the dispatch frame (no model, no pi). Called
 * OUTSIDE the G2 limiter (it holds no process/slot), exactly like the other no-pi node kinds.
 */
async function runProgrammatic(ctx: RunContext, srcNode: NodeSpec): Promise<NodeStatusRecord> {
  const rec = ctx.status.nodes[srcNode.id];
  rec.status = 'running';
  rec.startedAt = nowISO();
  const t0 = Date.now();
  // A re-run STARTS FRESH (mirrors runNode): clear the prior attempt's signals.
  ctx.failureSignals.delete(srcNode.id);
  await writeStatus(ctx.outDir, ctx.status);

  // IO TOKEN RESOLUTION AT LAUNCH (U7, mirrors runNode): make `{{arg.*}}`/`{{WORKSPACE}}`/`{{RUN}}`/
  // `{{state.*}}` PHYSICAL in the node's CONTRACT paths (io.artifacts[].path, io.checks[].path) so the
  // artifact/check gates stat the resolved path, never a raw `{{…}}`. A missing arg/channel throws loudly.
  const resolveCtx: ResolveCtx = { run: ctx.outDir, workspace: ctx.workspace, state: ctx.runState, args: ctx.args };
  let node = srcNode;
  try {
    node = {
      ...srcNode,
      io: {
        ...srcNode.io,
        artifacts: srcNode.io.artifacts.map((a) => ({ ...a, path: resolveTokens(a.path, resolveCtx) })),
        checks: srcNode.io.checks?.map((c) => (c.path ? { ...c, path: resolveTokens(c.path, resolveCtx) } : c)),
      },
    };
  } catch (e) {
    return finishNode(ctx, srcNode, rec, t0, 'error', `io token resolution failed: ${(e as Error).message}`, [], [(e as Error).message]);
  }

  // (U1a/U1b) The derive DISPATCH now reads the canonical `op[]` (via `derivesFromOp`), NOT `node.ops`.
  // One reconstruction per node; each derive site below iterates the matching family list. The resolution +
  // executor calls are byte-identical to the legacy `node.ops?.{…}` sites — only the SOURCE changed.
  const derived = derivesFromOp(node.op);

  try {
    // PRE SEED ops (S2): stage each declared starting artifact onto the host run dir (= `{{RUN}}`). No
    // sandbox mirror (a programmatic node spawns no pi). A `{{state.*}}` naming a not-yet-promoted channel
    // throws → fail loudly (a real wiring error), never a silent skip.
    try {
      for (const seed of derived.seeds) {
        await stageSeed(seed, resolveCtx, ctx.outDir);
      }
    } catch (e) {
      return finishNode(ctx, node, rec, t0, 'error', `seed staging failed: ${(e as Error).message}`, [], [(e as Error).message]);
    }

    // PRE-GATE — fire the node's `when:'pre'` gate ops over the staged inputs (mirrors runNode's #11 block).
    // A blocking pre-gate failure fails the node here. Each gate's `onFailure` (default 'block') decides;
    // an `advisory`/`warn` gate records but does not block.
    const preChecks = gatesFromOp(node.op).pre; // (C2) the SINGLE gate→Check reconstruction (was inlined here).
    if (preChecks.length) {
      const preReadBytes = (rel: string): FileBytes => {
        try {
          const absPath = path.resolve(ctx.outDir, rel);
          return { bytes: readFileSync(absPath, 'utf8'), size: statSync(absPath).size };
        } catch {
          return { bytes: null, size: 0 };
        }
      };
      const preResults = evaluateChecks(preChecks, preReadBytes);
      rec.preChecks = preResults;
      const blockingPre = preResults.filter((c, i) => c.verdict !== 'pass' && preChecks[i].severity !== 'warn');
      if (blockingPre.length) {
        const detail = blockingPre.map((c) => `${c.kind} ${c.path || ''}: ${c.reason}`).join(' | ');
        return finishNode(ctx, node, rec, t0, 'blocked', `pre-gate FAILED — ${detail}`, [], [`pre-gate: ${detail}`]);
      }
    }

    // PRE hooks — deterministic plumbing; a blocking failure throws → error (mirrors runNode).
    const hookCtx = { workspace: node.sandbox.workspace, inputs: node.io.reads, outputs: node.io.produces };
    try {
      await runHooks(node.hooks?.pre, hookCtx, { outcome: 'success' });
    } catch (e) {
      return finishNode(ctx, node, rec, t0, 'error', `pre-hook failed: ${(e as Error).message}`, []);
    }

    // POST DERIVE ops (project → registryProject → merge → `run`). The SAME executors runNode reuses, in the
    // SAME order — only there is no model exit to gate on (the deterministic ops always run). A `run`/`merge`
    // op's non-zero exit routes through the op's `onFailure` (default 'block'), collected here and applied in
    // the status ladder below.
    const opFailures: { detail: string; onFailure: OnFailure }[] = [];
    // project: derive from a FROZEN source JSON read once (graceful no-op on an authoring-only spec).
    for (const rawOp of derived.projects) {
      const op = resolveDeep(rawOp as Record<string, unknown>, resolveCtx);
      const srcRel = (op.source as string) ?? (Array.isArray(op.from) ? (op.from[0] as string) : (op.from as string));
      const spec = srcRel ? await readJsonSafe(absUnder(ctx.outDir, srcRel)) : undefined;
      const name = String(op.op ?? Object.keys(op).find((k) => k === 'copy' || k === 'assemble' || k === 'merge') ?? 'project');
      await applyProjectionOp(name, op, spec, ctx.outDir);
    }
    // registryProject: the op-map lives in the registry record (mapRef), resolved by `key`. The single
    // `derived.registryProjects` loop covers BOTH hooks- and op[]-authored nodes (the legacy `if` arm folded in).
    for (const rp of derived.registryProjects) {
      const pg = resolveDeep({ source: rp.source, mapRef: rp.mapRef, key: rp.key }, resolveCtx) as { source: string; mapRef: string; key: string };
      await runProjection({ source: pg.source, mapRef: pg.mapRef, key: pg.key }, ctx.outDir);
    }
    // merge: the `{ ops:[...] }` MergeSpec (fold|concat|reconcile|run) — incl. a gen-hook `run` op.
    for (const m of derived.merges) {
      const mergeOnFailure = ((node.op ?? []).find((o) => o.transform?.kind === 'merge')?.onFailure ?? 'block') as OnFailure;
      const merged = await runMerge(resolveDeep(m, resolveCtx), ctx.outDir);
      for (const r of merged?.ops ?? []) {
        if (r.failed) opFailures.push({ detail: `merge ${r.op} failed${r.exit != null ? ` (exit ${r.exit})` : ''}${r.stderr ? `: ${r.stderr}` : ''}`, onFailure: mergeOnFailure });
      }
    }
    // AUTHORABLE `run` body — a POST `op` with a `run:{cmd,args,cwd}` body is a deterministic derive/side-
    // effect step. Reuse the merge executor's `run` impl, then route a non-zero exit through `onFailure`.
    const runOps = runOpsFromOp(node.op); // (C2) the SINGLE run→executor-input adapter (was inlined here).
    for (const { body, onFailure } of runOps.runnable) {
      const r = await applyMergeOp({ run: { cmd: body.cmd, args: body.args, cwd: body.cwd } }, ctx.outDir);
      if (r.failed) {
        opFailures.push({ detail: `run ${r.cmd ?? body.cmd} failed${r.exit != null ? ` (exit ${r.exit})` : ''}${r.stderr ? `: ${r.stderr}` : ''}`, onFailure });
      }
    }
    // (B-fix) FAIL LOUD: a run op the runner has NO executor for (when:'pre'/'on-failure', the {fn} variant, or
    // a cmd-less body) is surfaced as an op failure here — never the old silent `continue` that dropped it.
    for (const rej of runOps.rejected) opFailures.push(rej);

    // VERIFY by host-stat (mirrors runNode): a node is `ok` only if its declared artifacts exist on disk.
    const artifacts: ArtifactState[] = await Promise.all(
      node.io.artifacts.map((a) => artifactState(path.resolve(ctx.outDir, a.path), a.path)),
    );
    const missing = artifacts.filter((a) => !a.exists).map((a) => a.path);

    // POST-NODE SCHEMA GATE — a present-but-invalid artifact (vs its declared schema) is a contract breach.
    const schema = await validateArtifactSchemas(node.io.artifacts, {
      outDir: ctx.outDir,
      roots: [ctx.outDir],
      validate: ctx.validateSchema,
    });
    if (schema.invalid.length) rec.schemaInvalid = schema.invalid;
    if (schema.checked) rec.schemaChecked = schema.checked;
    if (schema.skipped) rec.schemaSkipped = schema.skipped;

    // DECLARATIVE INTEGRITY CHECKS (explicit ∪ the auto fill-sentinel completeness check) through the
    // verdict→action POLICY — IDENTICAL to runNode.
    const readBytes = (rel: string): FileBytes => {
      try {
        const absPath = path.resolve(ctx.outDir, rel);
        return { bytes: readFileSync(absPath, 'utf8'), size: statSync(absPath).size };
      } catch {
        return { bytes: null, size: 0 };
      }
    };
    const checkResults = evaluateChecks(
      effectiveChecks(node.io.checks, node.io.fillSentinel, node.io.artifacts.map((a) => a.path)),
      readBytes,
    );
    if (checkResults.length) rec.checks = checkResults;
    const failedChecks = checkResults.filter((c) => c.verdict !== 'pass');
    const blockingChecks = failedChecks.filter((c) => actionForVerdict(c.verdict as 'fail' | 'warn', node.io.policy) !== 'warn');
    const warningChecks = failedChecks.filter((c) => actionForVerdict(c.verdict as 'fail' | 'warn', node.io.policy) === 'warn');

    const blockingOpFailures = opFailures.filter((f) => f.onFailure !== 'warn');
    const warningOpFailures = opFailures.filter((f) => f.onFailure === 'warn');

    // The status ladder — the driver-verified contract breaches (no model exit to read, no return handshake:
    // a programmatic node proves its work by its artifacts + checks, never a fenced-JSON tail). missing →
    // schema-invalid → blocking integrity check → blocking op failure → ok.
    let st: NodeStatusRecord['status'];
    const issues: string[] = [];
    if (missing.length) {
      st = 'blocked';
      issues.push(`contract breach — required artifact(s) missing: ${missing.join(', ')}`);
    } else if (schema.invalid.length) {
      st = 'blocked';
      issues.push(`contract breach — artifact(s) violate the declared schema: ${schema.invalid.map((x) => `${x.path} [${x.errors.join('; ')}]`).join(' | ')}`);
    } else if (blockingChecks.length) {
      st = 'blocked';
      issues.push(`integrity check FAILED — ${blockingChecks.map((c) => `${c.kind} ${c.path || ''}: ${c.reason}`).join(' | ')}`);
    } else if (blockingOpFailures.length) {
      st = 'blocked';
      issues.push(`op FAILED — ${blockingOpFailures.map((f) => f.detail).join(' | ')}`);
    } else {
      st = 'ok';
    }
    if (warningChecks.length) issues.push(`integrity warn — ${warningChecks.map((c) => `${c.kind} ${c.path || ''}: ${c.reason}`).join(' | ')}`);
    if (warningOpFailures.length) issues.push(`op warn — ${warningOpFailures.map((f) => f.detail).join(' | ')}`);
    if (schema.skipped) issues.push(`schema gate skipped — ${schema.skipped}`);

    // POST hooks — fire with the node's outcome; a blocking failure downgrades the node to error.
    try {
      await runHooks(node.hooks?.post, hookCtx, { outcome: st === 'ok' ? 'success' : 'failure' });
    } catch (e) {
      st = 'error';
      issues.push(`post-hook failed: ${(e as Error).message}`);
    }

    // PROMOTE POST op (S3): on an OK node, LIFT each declared output into a RunState channel (the driver
    // merges it at the stage barrier). A programmatic node has no parsed return, so an `@return:` source has
    // no value to drill — an artifact source reads under `{{RUN}}`. A promote of nothing throws → error.
    if (st === 'ok' && derived.promotes.length) {
      try {
        const promotes: ResolvedPromote[] = [];
        for (const raw of derived.promotes) {
          const spec = parsePromote(raw);
          const value = await extractPromoteValue(spec, { run: ctx.outDir, returnValue: undefined });
          promotes.push({ to: spec.to, value, merge: spec.merge });
        }
        ctx.promotesByNode.set(node.id, { nodeId: node.id, promotes });
      } catch (e) {
        st = 'error';
        issues.push(`promote failed: ${(e as Error).message}`);
      }
    }

    // CAPTURE the EMPIRICAL failure signals (mirrors runNode) so a node-level retry/rerouteTo can classify
    // a programmatic node's failure. Set ONLY on a non-ok verdict (a clean node leaves none).
    if (st !== 'ok') {
      ctx.failureSignals.set(node.id, {
        status: st,
        issues: [...issues],
        summary: '',
        missing,
        schemaInvalid: schema.invalid,
        returnSchemaInvalid: [],
        failedChecks: failedChecks.map((c) => ({ kind: c.kind, path: c.path, reason: c.reason })),
        killedTimeout: false,
        killedStall: false,
        exitCode: 0,
        stderrTail: '',
        parsedOk: false,
      });
    }

    const summary = st === 'ok' ? 'programmatic ops ran' : issues[0] ?? 'programmatic node failed';
    return finishNode(ctx, node, rec, t0, st, summary, artifacts, issues);
  } catch (e) {
    // Anything thrown is contained to THIS node as `error` — never a rejected lane (mirrors runNode).
    return finishNode(ctx, node, rec, t0, 'error', `node failed: ${(e as Error).message}`, []);
  }
}

/**
 * (G12 — M4) A per-attempt OVERRIDE for an ESCALATION/CONSULT re-run: prepend the verified-evidence
 * `promptPrefix` (consultPreamble) and route to a STRONGER `model`/`provider`. Absent on the cheap first
 * attempt and on a same-model `retry` (those re-run with the node's own prompt + resolved model).
 */
interface AttemptOverride {
  promptPrefix?: string;
  model?: string;
  provider?: string;
}

async function runNode(ctx: RunContext, node: NodeSpec, scope: RunScope, over: AttemptOverride = {}): Promise<NodeStatusRecord> {
  const rec = ctx.status.nodes[node.id];
  rec.status = 'running';
  rec.startedAt = nowISO();
  const t0 = Date.now();
  // A re-run STARTS FRESH: clear the prior attempt's signals so a successful re-run leaves none.
  ctx.failureSignals.delete(node.id);
  await writeStatus(ctx.outDir, ctx.status);

  // PRE-NODE BIND CHECK ("Verified, not trusted", spine #8): the node DECLARED its toolset; confirm
  // it actually GETS every declared function — each address binds to a unique bare name — BEFORE we
  // stand up a sandbox or spawn pi. A miss (declared tool not in the catalog) or a collision (two
  // tools sharing one bare name, which pi silently skips) is a contract breach → `blocked`.
  const bind = verifyToolBinding(node.tools, ctx.registry.list());
  if (!bind.ok) {
    return finishNode(ctx, node, rec, t0, 'blocked', `tool bind check failed: ${bind.issues.join('; ')}`, [], bind.issues);
  }

  let resolved: ResolveResult;
  try {
    resolved = ctx.registry.resolve(node.tools);
  } catch (e) {
    return finishNode(ctx, node, rec, t0, 'error', `tool resolution failed: ${(e as Error).message}`, []);
  }

  // LANE ISOLATION (run.mjs runNode 851–1176 always RESOLVES to a record, never rejects): standing up
  // the sandbox can throw (scope.create on a cloud backend: image pull / quota / network). That
  // throw is OUTSIDE the try/finally below, so unguarded it would reject this lane's promise and —
  // since the stage uses Promise.all — fail-fast the WHOLE run, discarding the sibling lanes' already-
  // completed work (MDN "Promise.all fail-fast"; javascript.info "Dangerous Promise.all": an uncaught
  // rejection can crash a Node process). Mark this node `error` and let the run halt cleanly instead.
  // MCP CONFIG STAGING (decided BEFORE create so the env additions reach the `CreateOpts.env` seam):
  // a node that selected bridge tools (mcp./oc.) + a run-level mcpConfig gets `_pi/mcp.json` (written
  // below, after the sandbox exists) and, injected here, `PIFLOW_MCP_CONFIG` (absolute in-sandbox path) +
  // the referenced secret env vars. CLOUD providers forward ONLY the referenced (allowlisted) vars — never
  // the host env.
  // Per-node staging dir: the prompt, the generated tool extension, and the MCP config all land under
  // `_pi/<id>/` so parallel nodes that SHARE a workspace (the in-place local case) never clobber each
  // other's staged files. This is the root fix for the OPEN-1 prompt-clobber that a consumer otherwise
  // works around three ways (an execCwd split + an absolute @prompt ref + a per-node `wf.nodes` mutation).
  const nodeStage = path.posix.join('_pi', node.id);
  const MCP_CONFIG_FILE = path.posix.join(nodeStage, 'mcp.json');
  const isCloud = CLOUD_KINDS.has(ctx.providerKind);
  const stageMcp = Boolean(resolved.extension) && selectedBridgedTool(node) && Boolean(ctx.mcpConfig);
  let mcpEnv: Record<string, string> | undefined;
  if (stageMcp && ctx.mcpConfig) {
    // Absolute in-sandbox path: the run root + the node's workdir + the staged file. posix join keeps it
    // valid in a cloud VM; on local providers scope.root is the host repoRoot under which the node resolves.
    const configPathAbs = path.posix.join(scope.root, node.sandbox.workspace || '.', MCP_CONFIG_FILE);
    // Resolve each referenced $VAR through the broker seam (default: process.env). A host-plugged broker
    // mints a scoped token here so the raw credential never reaches the (cloud) VM.
    mcpEnv = await mcpEnvAdditions(
      configPathAbs,
      referencedEnvVars(ctx.mcpConfig),
      isCloud,
      node.id,
      ctx.secretResolver ?? defaultSecretResolver,
    );
  }
  // (M1) PROVIDER-CREDENTIAL PARITY — on a CLOUD VM, pi's OWN gateway key (`ANTHROPIC_API_KEY`, …) must
  // cross too: the command stamps `--provider`/`--model` but no key, and the VM does NOT inherit host env.
  // Resolve the declared provider-cred allowlist through the SAME resolver and forward EXACTLY that set
  // (no-op on local — the child already inherits process.env; no-op when no cloudSecrets declared).
  const credEnv = await cloudCredEnvAdditions(
    ctx.cloudSecrets,
    isCloud,
    node.id,
    ctx.secretResolver ?? defaultSecretResolver,
  );

  // The per-node resolver ctx — ONE ctx threads the prompt resolve, the seed/op resolution, AND the io/
  // sandbox/checks PATH resolution (U7). `{{RUN}}` is the host run dir (the collection namespace); state is
  // the barrier-merged RunState loaded for this stage.
  const resolveCtx: ResolveCtx = { run: ctx.outDir, workspace: ctx.workspace, state: ctx.runState, args: ctx.args };

  // IO/SANDBOX TOKEN RESOLUTION AT LAUNCH (U7): make `{{arg.*}}`/`{{WORKSPACE}}`/`{{RUN}}`/`{{state.*}}`
  // PHYSICAL in the node's CONTRACT paths — io.artifacts[].path, sandbox.read (read-scope), sandbox.write
  // (owns), and checks[].path — so the existence gate stat()s, the DRIVER-* markers, and scope.create all
  // consume the resolved path, never a raw `{{…}}` joined under the run dir with braces intact. SAME loud
  // discipline as the prompt below: a missing arg/channel throws (MissingArgError/MissingChannelError) →
  // the node fails cleanly with a clear issue, never a silently-unresolved io path. We resolve ONCE into a
  // local `node` clone and thread it; the runner consumes `node.*` from here on (raw `srcNode` is untouched).
  const srcNode = node;
  try {
    node = {
      ...srcNode,
      io: {
        ...srcNode.io,
        artifacts: srcNode.io.artifacts.map((a) => ({ ...a, path: resolveTokens(a.path, resolveCtx) })),
        checks: srcNode.io.checks?.map((c) => (c.path ? { ...c, path: resolveTokens(c.path, resolveCtx) } : c)),
      },
      sandbox: {
        ...srcNode.sandbox,
        read: resolveAll(srcNode.sandbox.read, resolveCtx),
        write: resolveAll(srcNode.sandbox.write, resolveCtx),
      },
    };
  } catch (e) {
    return finishNode(ctx, srcNode, rec, t0, 'error', `io token resolution failed: ${(e as Error).message}`, [], [(e as Error).message]);
  }

  // Resolve the node's hard wall-clock cap ONCE — explicit node timeout else the run watchdog default
  // (30 min). The runner watchdog enforces it locally; the CLOUD backends (e2b/daytona) ALSO take it as the
  // per-command exec `timeoutMs`. E2B's `commands.run` defaults to 60_000ms when unset (verified against the
  // SDK: CommandStartOpts.timeoutMs default 60000), so passing `undefined` here KILLS any node generating
  // >60s. Local/seatbelt/worktree backends ignore CreateOpts.timeoutMs (watchdog-only). Threading the SAME
  // value into both create and the watchdog (below) keeps the two caps from diverging.
  const nodeTimeoutMs = node.sandbox.timeoutMs ?? ctx.watchdog.nodeTimeoutMs;
  let sandbox: Sandbox;
  try {
    sandbox = await scope.create({
      readScope: node.sandbox.read,
      writeScope: node.sandbox.write, // = contract.owns; bounds file-write* to the node's lane (darwin jail)
      outputDir: node.sandbox.output,
      workdir: node.sandbox.workspace,
      image: node.sandbox.image,
      // Merge the MCP env additions + the cloud provider-cred additions over the node's declared env (so
      // PIFLOW_MCP_CONFIG + the referenced MCP secrets + the pi gateway key land in the child via the
      // provider's exec merge). Both additions are {} when inapplicable, so a local/keyless run is unchanged.
      env: mcpEnv || Object.keys(credEnv).length
        ? { ...node.sandbox.env, ...mcpEnv, ...credEnv }
        : node.sandbox.env,
      timeoutMs: nodeTimeoutMs, // cloud per-command cap = the watchdog cap (NOT undefined → E2B's 60s default)
    });
  } catch (e) {
    return finishNode(ctx, node, rec, t0, 'error', `sandbox create failed: ${(e as Error).message}`, []);
  }

  // (U1a/U1b) The derive DISPATCH now reads the canonical `op[]` (via `derivesFromOp`), NOT `node.ops`.
  // One reconstruction per node; each derive site below iterates the matching family list. The resolution +
  // executor calls are byte-identical to the legacy `node.ops?.{…}` sites — only the SOURCE changed.
  const derived = derivesFromOp(node.op);

  try {
    // STAGE io.reads from the host run dir INTO the sandbox at the same relative path (filesystem-as-
    // contract across sandboxes). A missing read is left to the node's own contract check downstream.
    for (const rel of node.io.reads) {
      const data = await readHostFile(ctx, rel);
      if (data) await sandbox.writeFile(rel, data);
    }

    // SEED PRE op (S2): stage each declared starting artifact onto the host run dir (= `{{RUN}}`), then
    // mirror the staged dest INTO the sandbox so the model reads it. A token-bearing `from` (incl
    // `{{state.*}}`) resolves through the seed-token resolver; an absent source is a graceful skip, an
    // already-filled dest is not re-staged (idempotent). A `{{state.*}}` naming a not-yet-promoted channel
    // throws → fail the node loudly (a real wiring error), never a silent skip.
    try {
      for (const seed of derived.seeds) {
        const res = await stageSeed(seed, resolveCtx, ctx.outDir);
        if (res.staged) await stageHostPathIntoSandbox(sandbox, ctx.outDir, seed.to);
      }
    } catch (e) {
      return finishNode(ctx, node, rec, t0, 'error', `seed staging failed: ${(e as Error).message}`, [], [(e as Error).message]);
    }

    // (M5 · #11) PRE-GATE — fire the node's `when:'pre'` gate ops over the STAGED inputs BEFORE the model.
    // The deprecated `checks.pre` lowered to these; today's render flattened pre→post so a pre-check never
    // ran before the model. Here a blocking pre-gate failure fails the node WITHOUT ever spawning pi — the
    // real firing site #11 needs. Each gate's `onFailure` (default 'block') gives its consequence; an
    // `advisory`/`warn` gate is recorded but does not block. Reads the host run dir (= the staged inputs).
    const preChecks = gatesFromOp(node.op).pre; // (C2) the SINGLE gate→Check reconstruction (was inlined here).
    if (preChecks.length) {
      const preReadBytes = (rel: string): FileBytes => {
        try {
          const absPath = path.resolve(ctx.outDir, rel);
          return { bytes: readFileSync(absPath, 'utf8'), size: statSync(absPath).size };
        } catch {
          return { bytes: null, size: 0 };
        }
      };
      const preResults = evaluateChecks(preChecks, preReadBytes);
      rec.preChecks = preResults;
      const blockingPre = preResults.filter((c, i) => c.verdict !== 'pass' && preChecks[i].severity !== 'warn');
      if (blockingPre.length) {
        const detail = blockingPre.map((c) => `${c.kind} ${c.path || ''}: ${c.reason}`).join(' | ');
        return finishNode(ctx, node, rec, t0, 'blocked', `pre-gate FAILED (before the model) — ${detail}`, [], [`pre-gate: ${detail}`]);
      }
    }

    // TOKEN RESOLUTION AT LAUNCH (U7): make `{{arg.*}}`/`{{WORKSPACE}}`/`{{RUN}}`/`{{state.*}}` PHYSICAL
    // in the prompt before staging. A missing arg/channel throws loudly (MissingArgError/MissingChannelError)
    // → the node fails with a clear issue, never a silently-unresolved prompt handed to the model.
    let resolvedPrompt: string;
    try {
      // A pi-lane node always carries a prompt (the schema requires it for a non-programmatic node); the
      // `?? ''` only satisfies the now-optional `prompt` type (a programmatic node never reaches this lane).
      resolvedPrompt = resolveTokens(node.prompt ?? '', resolveCtx);
    } catch (e) {
      return finishNode(ctx, node, rec, t0, 'error', `prompt token resolution failed: ${(e as Error).message}`, [], [(e as Error).message]);
    }

    // The prompt carries the machine-readable contract markers (artifacts/owns/read-scope/tools) so a
    // future node-contract extension can self-gate; we append them exactly as run.mjs does. An escalation
    // attempt PREPENDS the verified-evidence consult prefix (M4 — runNodeWithEscalation's promptPrefix).
    const markers = emitMarkers(markersFromNode(node, resolved));
    const promptFile = path.posix.join(nodeStage, 'prompt.md');
    await sandbox.writeFile(promptFile, (over.promptPrefix ?? '') + resolvedPrompt + (markers ? `\n\n${markers}` : ''));

    // Stage the generated tool `-e` extension (binds the node's declared sdk/mcp tools) and pass its
    // in-sandbox path to the command builder. Absent when the node selected only builtins.
    let extensionFile: string | undefined;
    if (resolved.extension) {
      extensionFile = path.posix.join(nodeStage, 'tools.ts');
      await sandbox.writeFile(extensionFile, resolved.extension);
    }

    // Stage the node's MCP server map VERBATIM (only for MCP-tool nodes with a run-level mcpConfig). It
    // carries `$VAR` refs, never literal secrets — the bridge expands them in-child against PIFLOW_MCP_CONFIG
    // + the referenced env vars injected at create above. A node with no MCP tools writes NO `_pi/mcp.json`.
    if (stageMcp && ctx.mcpConfig) {
      await sandbox.writeFile(MCP_CONFIG_FILE, JSON.stringify(ctx.mcpConfig));
    }

    // SKILL stage: a node's `skill` (an Agent-Skill dir) is a forced read-only PRE-stage — so it REUSES the
    // seed seam. Copy the source onto the host run dir at `.pi/skills/<name>/` (pi's native discovery dir),
    // mirror it INTO the sandbox via `stageHostPathIntoSandbox`, and point `--skill` at the in-sandbox path.
    // Staged UNDER the workdir ⇒ jail-readable by construction (no readScope widening); the bytes ride into a
    // cloud VM like every other staged input. An ABSENT source is a graceful skip (mirrors a missing seed);
    // a real staging failure fails the node loudly (never a silent half-stage).
    let skillPath: string | undefined;
    try {
      const skillStage = resolveSkillStage(node.skill, resolveCtx);
      const exists = skillStage && (await fs.stat(skillStage.source).then(() => true, () => false));
      if (skillStage && exists) {
        const skillRel = path.posix.join('.pi', 'skills', skillStage.name);
        await fs.cp(skillStage.source, path.resolve(ctx.outDir, skillRel), { recursive: true, force: true });
        await stageHostPathIntoSandbox(sandbox, ctx.outDir, skillRel);
        skillPath = path.posix.join(scope.root, node.sandbox.workspace || '.', skillRel);
      }
    } catch (e) {
      return finishNode(ctx, node, rec, t0, 'error', `skill staging failed: ${(e as Error).message}`, [], [(e as Error).message]);
    }

    // PRE hooks (deterministic plumbing — stage inputs / seeds). A blocking failure throws → error.
    const hookCtx = { workspace: node.sandbox.workspace, inputs: node.io.reads, outputs: node.io.produces };
    try {
      await runHooks(node.hooks?.pre, hookCtx, { outcome: 'success' });
    } catch (e) {
      return finishNode(ctx, node, rec, t0, 'error', `pre-hook failed: ${(e as Error).message}`, []);
    }

    // G1 — resolve THIS node's effective model/provider (the §2 precedence lives in model-routing.ts). An
    // unresolvable tier throws → fail the node cleanly (never crash the run, never silently mis-route).
    let eff: EffectiveModel;
    try {
      eff = resolveNodeModel(node, {
        model: ctx.model,
        provider: ctx.providerName,
        tiers: ctx.modelRouting.tiers,
        modelsIndex: ctx.modelRouting.modelsIndex,
      });
    } catch (e) {
      return finishNode(ctx, node, rec, t0, 'error', (e as Error).message, []);
    }
    // M4 — an escalation attempt overrides the resolved model/provider with the stronger target.
    const effModel = over.model ?? eff.model;
    const effProvider = over.provider ?? eff.provider;
    rec.model = effModel ?? null; // record the effective model (null ⇒ pi's provider default)
    const cmd = ctx.buildCommand(node, resolved, { promptFile, model: effModel, provider: effProvider, extensionFile, skillPath }, ctx.commandOpts);
    rec.command = cmd;

    // `nodeTimeoutMs` is resolved ONCE above (shared with the cloud per-command cap at scope.create).
    // Tee the agent's stdout into a per-node slimmed events archive (additive — the wrap chains the
    // watchdog's own onStdout, so recording can never disable the stall kill). See ./events.ts.
    const recorder = ctx.recordEvents ? new NodeRecorder(ctx.outDir, node.id, ctx.onEvent) : null;
    const execSandbox = recorder ? recordingSandbox(sandbox, recorder) : sandbox;
    // `let result` (not `const`): the G8 repair loop re-execs in the live sandbox and re-binds it.
    const exec0 = await ctx.execRunner(execSandbox, cmd, { ...ctx.watchdog, nodeTimeoutMs });
    let result = exec0.result;
    const { killed } = exec0;
    await recorder?.close();
    rec.exitCode = result.code;

    // COLLECT: copy the node's sandbox output dir back to the host run dir. The convention (proven in
    // the test): a node writes each artifact at `<output>/<artifactPath>`, so downloadDir flattens
    // `<output>/*` onto `<hostRunDir>/*` and the artifact path IS the host-run-dir-relative path.
    //
    // CONCURRENCY CONTRACT: collection is SERIALIZED across the stage via `ctx.collectMutex` (a one-slot
    // FIFO). Every parallel lane copies into the SAME shared host run dir, and two recursive copies that
    // both create a common destination subdir (e.g. siblings under `shared/`) race → one `fs.cp` throws
    // EEXIST. The mutex removes the overlap so neither collides; the costly exec already ran concurrently
    // OUTSIDE this gate. (fusion keeps its disjoint-top-level-dir workaround, cb16658 — this is the
    // general safety net underneath it.)
    //
    // ERROR CONTRACT: a collection failure is RECORDED, never swallowed. ENOENT (the source output dir
    // genuinely does not exist ⇒ the node produced nothing) is a LEGITIMATE quiet no-op — the artifact
    // gate below marks it blocked on its own. ANY OTHER error (EEXIST race, ENOSPC, EACCES, …) is a REAL
    // collection failure captured into `collectError` and surfaced on the node's `issues` in the verdict
    // block below — so a blocked node EXPLAINS that its file was lost in collection, not merely "missing".
    // IN-PLACE SKIP: a `local` node ran in the real workspace, so its deliverable is ALREADY at its host
    // location — there is no `out/<id>` throwaway to copy back and `downloadDir(out/<id> → outDir)` would
    // hit the guarded-identity THROW (the compile-default output ≠ the run dir). Skip the download; the
    // artifact gate below stat()s the real run dir directly. (Isolated providers are untouched.)
    const inPlace = IN_PLACE_KINDS.has(ctx.providerKind);
    let collectError: string | null = null;
    if (killed === null && result.code === 0 && !inPlace) {
      try {
        await ctx.collectMutex(() => sandbox.downloadDir(node.sandbox.output, ctx.outDir));
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err?.code !== 'ENOENT') collectError = `output collection failed: ${err?.message ?? String(e)}`;
        // ENOENT ⇒ nothing produced — stay quiet; the artifact gate below marks it blocked.
      }
    }

    // DERIVE ops (project → registryProject → merge), the mechanical "derive an output from frozen
    // on-disk inputs" families. Run them HERE — after COLLECT, STRICTLY BEFORE the artifact/schema
    // gates below (canonical run.mjs order: "the AUTHORITY for them … strictly BEFORE the gates
    // verify them"). They are gated on a CLEAN MODEL EXIT (killed === null && code === 0), NOT on the
    // node verdict: a node whose REQUIRED artifact is GENERATED by its own merge `run` op (the asset
    // gen hook → public/assets/asset-manifest.json) would deadlock if verified first (missing →
    // blocked → the op that produces it never runs). `promote` stays AFTER the verdict (it lifts a
    // GOOD node's output into a state channel). Each op's tokens are resolved per the node ctx; a
    // missing input degrades gracefully inside the executors.
    // (M5 · #18) POST-op failures whose exit code ROUTES to status via the lowered op's `onFailure`. Today
    // a merge `run` op's non-zero exit is DISCARDED (the `runMerge` return is dropped); now it routes — a
    // `block`/`stop` op blocks the node, a `warn` op surfaces an issue but stays ok. Collected here, applied
    // in the status ladder below. The legacy `ops`/`op` executors are reused UNCHANGED; only the exit is read.
    const opFailures: { detail: string; onFailure: OnFailure }[] = [];
    if (killed === null && result.code === 0) {
      // project: derive from a FROZEN source JSON read once (graceful no-op on an authoring-only spec).
      for (const rawOp of derived.projects) {
        const op = resolveDeep(rawOp as Record<string, unknown>, resolveCtx);
        const srcRel = (op.source as string) ?? (Array.isArray(op.from) ? (op.from[0] as string) : (op.from as string));
        const spec = srcRel ? await readJsonSafe(absUnder(ctx.outDir, srcRel)) : undefined;
        const name = String(op.op ?? Object.keys(op).find((k) => k === 'copy' || k === 'assemble' || k === 'merge') ?? 'project');
        await applyProjectionOp(name, op, spec, ctx.outDir);
      }
      // registryProject: the op-map lives in the registry record (mapRef), resolved by `key`. The single
      // `derived.registryProjects` loop covers BOTH hooks- and op[]-authored nodes (the legacy `if` arm folded
      // into the `else` op[] dispatch — #12, project.ts:184: without this the built `union` path / `index.json`
      // was silently dropped for an op[]-authored node).
      for (const rp of derived.registryProjects) {
        const pg = resolveDeep({ source: rp.source, mapRef: rp.mapRef, key: rp.key }, resolveCtx) as { source: string; mapRef: string; key: string };
        await runProjection({ source: pg.source, mapRef: pg.mapRef, key: pg.key }, ctx.outDir);
      }
      // merge: the `{ ops:[...] }` MergeSpec (fold|concat|reconcile|run) — incl. the gen-hook `run` op. The
      // merge transform's lowered `op` carries the onFailure that a failing `run` sub-op now routes through.
      for (const m of derived.merges) {
        const mergeOnFailure = ((node.op ?? []).find((o) => o.transform?.kind === 'merge')?.onFailure ?? 'block') as OnFailure;
        const merged = await runMerge(resolveDeep(m, resolveCtx), ctx.outDir);
        for (const r of merged?.ops ?? []) {
          if (r.failed) opFailures.push({ detail: `merge ${r.op} failed${r.exit != null ? ` (exit ${r.exit})` : ''}${r.stderr ? `: ${r.stderr}` : ''}`, onFailure: mergeOnFailure });
        }
      }
      // (M5 · #9/#18) AUTHORABLE `run` body — a POST `op` with a `run:{cmd,args,cwd}` body is a deterministic
      // derive/side-effect step (the now-authorable Hook.run). Reuse the merge executor's `run` impl, then
      // route a non-zero exit through the op's `onFailure` (default 'block').
      const runOps = runOpsFromOp(node.op); // (C2) the SINGLE run→executor-input adapter (was inlined here).
      for (const { body, onFailure } of runOps.runnable) {
        const r = await applyMergeOp({ run: { cmd: body.cmd, args: body.args, cwd: body.cwd } }, ctx.outDir);
        if (r.failed) {
          opFailures.push({ detail: `run ${r.cmd ?? body.cmd} failed${r.exit != null ? ` (exit ${r.exit})` : ''}${r.stderr ? `: ${r.stderr}` : ''}`, onFailure });
        }
      }
      // (B-fix) FAIL LOUD: a run op the runner has NO executor for (when:'pre'/'on-failure', the {fn} variant,
      // or a cmd-less body) is surfaced as an op failure here — never the old silent `continue` that dropped it.
      for (const rej of runOps.rejected) opFailures.push(rej);
    }

    // VERIFY by host-stat (run.mjs: a node is `ok` only if its declared artifacts exist on disk).
    // `let` (not `const`): the G8 in-sandbox repair loop (below) re-execs + re-validates in place, so a
    // repaired-good node re-binds these to the corrected results the status ladder then reads.
    let artifacts: ArtifactState[] = await Promise.all(
      node.io.artifacts.map((a) => artifactState(path.resolve(ctx.outDir, a.path), a.path)),
    );
    let missing = artifacts.filter((a) => !a.exists).map((a) => a.path);

    // POST-NODE SCHEMA GATE: a present-but-invalid artifact (vs its declared draft-2020-12 schema) is a
    // contract breach, driver-verified — exactly like a missing one. Skips (advisory) when no schema is
    // declared or no validator resolved (run.mjs schemaCheck).
    let schema = await validateArtifactSchemas(node.io.artifacts, {
      outDir: ctx.outDir,
      roots: [ctx.outDir, scope.root],
      validate: ctx.validateSchema,
    });
    if (schema.invalid.length) rec.schemaInvalid = schema.invalid;
    if (schema.checked) rec.schemaChecked = schema.checked;
    if (schema.skipped) rec.schemaSkipped = schema.skipped;

    // DECLARATIVE INTEGRITY CHECKS (explicit ∪ the auto fill-sentinel completeness check) folded through
    // the verdict→action POLICY (detection ⊥ consequence). A failed check at block severity is a breach.
    const readBytes = (rel: string): FileBytes => {
      try {
        const absPath = path.resolve(ctx.outDir, rel);
        return { bytes: readFileSync(absPath, 'utf8'), size: statSync(absPath).size };
      } catch {
        return { bytes: null, size: 0 };
      }
    };
    const checkResults = evaluateChecks(
      effectiveChecks(node.io.checks, node.io.fillSentinel, node.io.artifacts.map((a) => a.path)),
      readBytes,
    );
    if (checkResults.length) rec.checks = checkResults;
    const failedChecks = checkResults.filter((c) => c.verdict !== 'pass');
    const blockingChecks = failedChecks.filter((c) => actionForVerdict(c.verdict as 'fail' | 'warn', node.io.policy) !== 'warn');
    const warningChecks = failedChecks.filter((c) => actionForVerdict(c.verdict as 'fail' | 'warn', node.io.policy) === 'warn');

    // GENERALIZED RETURN HANDSHAKE: a node that declares a (satisfied) artifact contract proves its work
    // by the FILE on disk, so a missing return block is advisory (optional). A node that declares NO
    // artifact (its structured return IS its only output) still REQUIRES the handshake. `returnMode`
    // overrides per node. This releases the redundant-handshake false-error (the W1-class defect) while
    // real corruption is still caught by the missing/schema/checks gates above.
    // PRECEDENCE: per-node override → run-level default (ctx.returnProtocol) → the artifact heuristic.
    const returnMode = node.io.returnMode ?? ctx.returnProtocol ?? (node.io.artifacts.length ? 'optional' : 'required');
    rec.returnMode = returnMode;

    // The status ladder (run.mjs 1876–1883): kill/nonzero ⇒ error; then the driver-verified contract
    // breaches (missing → schema-invalid → blocking integrity check), each beating any self-report; then
    // a non-ok self-report is honored; then a MISSING handshake errors ONLY when it was required; else ok.
    let parsed = lastJsonBlock(result.stdout);

    // POST-NODE RETURN-SCHEMA GATE (mirrors the artifact schema gate, runner.ts above): a node's authored
    // `returnSchema` (node.json top-level `return`) constrains the SHAPE of its structured result. We
    // validate the PARSED return — VALIDATE-IF-PRESENT — with the SAME injected validator the artifact gate
    // uses. A present-but-NON-CONFORMING result is a contract breach under `required` (it BLOCKS, like a
    // present-but-invalid artifact); under `optional` it is advisory (recorded as a warn, never blocks; a
    // missing result is the existing handshake clause's job, never this gate's). Skips when no return
    // schema is declared, no result was parsed, or no validator resolved.
    // RETURN-SCHEMA IS OPT-IN — a CHOICE, never forced. We validate the structured return ONLY when the
    // node CHOOSES to force one (returnMode === 'required'). A filesystem-write node (returnMode 'optional'
    // or the artifact-backed default) proves its work by the artifact ON DISK, so its structured return is
    // NEVER gated — the return-schema mechanism stays available for rigid workflows without ever blocking
    // (or warning on) a node that simply writes its files. Under 'required' a non-conforming result is a
    // contract breach that BLOCKS (mirrors the artifact schema gate).
    // The return-schema validation, factored so the G8 repair loop can RE-RUN it on the repaired output.
    const validateReturn = (): string[] => {
      if (returnMode === 'required' && node.io.returnSchema && Object.keys(node.io.returnSchema).length && parsed && ctx.validateSchema) {
        const r = ctx.validateSchema(node.io.returnSchema, parsed);
        if (!r.ok) return r.errors;
      }
      return [];
    };
    let returnSchemaInvalid: string[] = validateReturn();
    let returnSchemaBreach = returnSchemaInvalid.length > 0 && returnMode === 'required';

    // ── G8 fold — bounded IN-SANDBOX schema repair (composed in M4) ────────────────────────────────────
    // When the node would block SOLELY on a schema miss (artifact-schema OR return-schema breach, with the
    // exec CLEAN, NO missing artifact, NO blocking integrity check) and `maxRepairAttempts > 0`, re-prompt
    // the STILL-ALIVE sandbox from {previousOutput, ajvErrors, schema} up to N times BEFORE the verdict
    // ladder runs — a CHEAP correction that reuses the node's ONE slot. A repair is NOT a retry: it does
    // NOT re-seed a fresh sandbox and does NOT touch the `retry`/`escalate` budget (it runs entirely
    // inside this single `runNode`). Default `maxRepairAttempts:0` ⇒ this whole block is skipped and a
    // schema miss falls straight through to `blocked` (today's exact behavior).
    const maxRepair = Math.max(0, node.io.maxRepairAttempts ?? 0);
    const schemaOnlyBreach = (): boolean =>
      killed === null && result.code === 0 && !missing.length && !blockingChecks.length &&
      (schema.invalid.length > 0 || returnSchemaBreach);
    if (maxRepair > 0 && schemaOnlyBreach()) {
      let repairs = 0;
      while (repairs < maxRepair && schemaOnlyBreach()) {
        repairs++;
        // Build the repair prompt from the in-hand failing facts (the G8 §"Repair-prompt template" shape):
        // the declared schema + the ajv errors + the previous output — fix EXACTLY these, invent nothing.
        const ajvErrors = [
          ...schema.invalid.flatMap((x) => x.errors.map((e) => `${x.path}: ${e}`)),
          ...returnSchemaInvalid.map((e) => `return: ${e}`),
        ];
        const declaredSchema = schema.invalid.length
          ? JSON.stringify(node.io.artifacts.find((a) => schema.invalid.some((x) => x.path === a.path))?.schema ?? {})
          : JSON.stringify(node.io.returnSchema ?? {});
        const target = schema.invalid.length ? schema.invalid.map((x) => x.path).join(', ') : 'the fenced-JSON return tail';
        const repairPrompt = [
          'You fix a structured output that FAILED its schema. Output ONLY the corrected result — no prose.',
          'Produce a CORRECTED version that conforms exactly. Change ONLY what the errors require; preserve all valid content.',
          `<schema>${declaredSchema}</schema>`,
          `<validation_errors>${ajvErrors.join(' | ')}</validation_errors>`,
          `<your_previous_output>${result.stdout.slice(-2000)}</your_previous_output>`,
          `<output_spec>Write the corrected result to ${target}. It MUST validate against <schema>. Use only values present in your previous output or logically implied by it — do NOT fabricate.</output_spec>`,
          '',
        ].join('\n');
        const repairFile = path.posix.join(nodeStage, `repair-${repairs}.md`);
        await sandbox.writeFile(repairFile, repairPrompt);
        const repairCmd = ctx.buildCommand(node, resolved, { promptFile: repairFile, model: effModel, provider: effProvider, extensionFile, skillPath }, ctx.commandOpts);
        const repairExec = await ctx.execRunner(execSandbox, repairCmd, { ...ctx.watchdog, nodeTimeoutMs });
        result = repairExec.result;
        // Re-collect (a fresh artifact may have been rewritten) under the same serialized collect mutex.
        // In-place skips for the same reason as the first collect: the repaired artifact is already on the
        // real run dir, and a download would hit the guarded-identity throw.
        if (repairExec.killed === null && result.code === 0 && !inPlace) {
          try {
            await ctx.collectMutex(() => sandbox.downloadDir(node.sandbox.output, ctx.outDir));
          } catch { /* a collect miss is caught by the re-stat below */ }
        }
        // Re-validate the WHOLE gate set (artifacts present + schema + return) on the corrected output.
        artifacts = await Promise.all(node.io.artifacts.map((a) => artifactState(path.resolve(ctx.outDir, a.path), a.path)));
        missing = artifacts.filter((a) => !a.exists).map((a) => a.path);
        schema = await validateArtifactSchemas(node.io.artifacts, { outDir: ctx.outDir, roots: [ctx.outDir, scope.root], validate: ctx.validateSchema });
        parsed = lastJsonBlock(result.stdout);
        returnSchemaInvalid = validateReturn();
        returnSchemaBreach = returnSchemaInvalid.length > 0 && returnMode === 'required';
      }
      rec.repairAttempts = repairs;
      // Refresh the recorded breach fields off the post-repair state (so a cleared breach leaves no stale record).
      rec.schemaInvalid = schema.invalid.length ? schema.invalid : undefined;
      rec.returnSchemaInvalid = returnSchemaInvalid.length ? returnSchemaInvalid : undefined;
      // Budget spent and STILL a schema miss ⇒ terminal, surfaced loudly (the run halts at the barrier).
      if (schemaOnlyBreach()) rec.repairExhausted = true;
    }
    if (returnSchemaInvalid.length) rec.returnSchemaInvalid = returnSchemaInvalid;

    // (M5 · #18) Partition the routed op failures by their `onFailure`: `block`/`stop` are blocking, `warn`
    // (or any non-blocking consequence) only surfaces an issue. `retry`/`escalate` are blocking at the
    // node-status level here (the M4 retry/escalate lanes then act on the blocked verdict).
    const blockingOpFailures = opFailures.filter((f) => f.onFailure !== 'warn');
    const warningOpFailures = opFailures.filter((f) => f.onFailure === 'warn');

    let st: NodeStatusRecord['status'];
    const issues: string[] = [];
    if (killed === 'timeout' || killed === 'stall' || result.code !== 0) {
      st = 'error';
      if (killed) issues.push(`killed: ${killed === 'timeout' ? 'exceeded node timeout' : 'silent stall'}`);
      else issues.push(`nonzero exit ${result.code}`);
    } else if (missing.length) {
      st = 'blocked';
      // If collection FAILED (not a quiet ENOENT), say so HERE — the lost copy is the REAL cause of the
      // "missing" artifact (the swallowed-EEXIST footgun), not a model that produced nothing.
      issues.push(
        collectError
          ? `${collectError} → required artifact(s) missing: ${missing.join(', ')}`
          : `contract breach — required artifact(s) missing: ${missing.join(', ')}`,
      );
    } else if (schema.invalid.length) {
      st = 'blocked';
      issues.push(`contract breach — artifact(s) violate the declared schema: ${schema.invalid.map((x) => `${x.path} [${x.errors.join('; ')}]`).join(' | ')}`);
    } else if (blockingChecks.length) {
      st = 'blocked';
      issues.push(`integrity check FAILED — ${blockingChecks.map((c) => `${c.kind} ${c.path || ''}: ${c.reason}`).join(' | ')}`);
    } else if (blockingOpFailures.length) {
      // (M5 · #18) A post `run`/`merge.run` op failed with a blocking `onFailure` — the exit code now routes
      // to status (today it was swallowed: the `runMerge` return was discarded). The node blocks.
      st = 'blocked';
      issues.push(`op FAILED — ${blockingOpFailures.map((f) => f.detail).join(' | ')}`);
    } else if (returnSchemaBreach) {
      st = 'blocked';
      issues.push(`contract breach — return violates the declared returnSchema: ${returnSchemaInvalid.join('; ')}`);
    } else if (parsed?.status && parsed.status !== 'ok') {
      st = parsed.status === 'gap' || parsed.status === 'blocked' ? parsed.status : 'gap';
    } else if (!parsed && returnMode === 'required') {
      st = 'error';
      issues.push('no return-protocol block parsed from output (return:required)');
    } else {
      st = 'ok';
    }
    // A collection failure that did NOT already mask a missing artifact (the branch above) is still
    // recorded — never let a real `downloadDir` error vanish (it may have dropped a non-required file).
    if (collectError && !missing.length) issues.push(collectError);
    if (warningChecks.length) issues.push(`integrity warn — ${warningChecks.map((c) => `${c.kind} ${c.path || ''}: ${c.reason}`).join(' | ')}`);
    // (M5 · #18) A `warn`-routed op failure surfaces an issue but never blocks (NOT swallowed, NOT fatal).
    if (warningOpFailures.length) issues.push(`op warn — ${warningOpFailures.map((f) => f.detail).join(' | ')}`);
    if (schema.skipped) issues.push(`schema gate skipped — ${schema.skipped}`);
    if (parsed?.issues?.length) issues.push(...parsed.issues);

    // POST hooks — fire with the node's outcome; a blocking failure downgrades the node to error.
    try {
      await runHooks(node.hooks?.post, hookCtx, { outcome: st === 'ok' ? 'success' : 'failure' });
    } catch (e) {
      st = 'error';
      issues.push(`post-hook failed: ${(e as Error).message}`);
    }

    // (project / registryProject / merge DERIVE ops ran ABOVE — after COLLECT, before the verify gate —
    // so a node whose required artifact is GENERATED by a merge `run` op verifies green. See that block.)

    // PROMOTE POST op (S3): on an OK node, LIFT each declared output into a RunState channel (the value
    // extracted now; the DRIVER merges it at the stage barrier — the "mechanical → driver hook" law, D6).
    // An artifact source reads under `{{RUN}}` (= outDir); an `@return:<field>` source drills the parsed
    // structured return (lastJsonBlock, widened). A promote of nothing throws → downgrade the node to error
    // (a real wiring breach, surfaced loudly), and emit no update.
    if (st === 'ok' && derived.promotes.length) {
      try {
        const promotes: ResolvedPromote[] = [];
        for (const raw of derived.promotes) {
          const spec = parsePromote(raw);
          const value = await extractPromoteValue(spec, { run: ctx.outDir, returnValue: parsed ?? undefined });
          promotes.push({ to: spec.to, value, merge: spec.merge });
        }
        ctx.promotesByNode.set(node.id, { nodeId: node.id, promotes });
      } catch (e) {
        st = 'error';
        issues.push(`promote failed: ${(e as Error).message}`);
      }
    }

    if (killed === 'timeout') rec.killedTimeout = true;
    if (killed === 'stall') rec.killedStall = true;

    // (G12 — M4) CAPTURE the EMPIRICAL failure signals for `runNodeWithRetries` (the retry / escalate
    // lanes). Set ONLY on a non-ok verdict so a clean node leaves none — `classifyFailure`/`consultPreamble`
    // read EXACTLY these (artifact stat, schema gate, integrity checks, watchdog kills, stderr, return
    // parse), never a model self-score. The schema-only-breach flag drives the G8 repair lane below.
    if (st !== 'ok') {
      ctx.failureSignals.set(node.id, {
        status: st,
        issues: [...issues],
        summary: parsed?.summary ?? '',
        missing,
        schemaInvalid: schema.invalid,
        returnSchemaInvalid,
        failedChecks: failedChecks.map((c) => ({ kind: c.kind, path: c.path, reason: c.reason })),
        killedTimeout: killed === 'timeout',
        killedStall: killed === 'stall',
        exitCode: result.code,
        stderrTail: (result.stderr || '').slice(-400),
        parsedOk: parsed != null,
      });
    }

    const summary = killed
      ? `killed (${killed})`
      : parsed?.summary ?? result.stdout.trim().slice(-200);
    return finishNode(ctx, node, rec, t0, st, summary, artifacts, issues);
  } catch (e) {
    // Anything thrown AFTER the sandbox exists (staging a read, the exec primitive, downloadDir, the
    // host-stat) is contained to THIS node as `error` — never a rejected lane (see LANE ISOLATION).
    return finishNode(ctx, node, rec, t0, 'error', `node failed: ${(e as Error).message}`, []);
  } finally {
    // Dispose is best-effort: a teardown failure must not reject the lane either. With a signal-
    // honoring provider (incl. InMemorySandbox) the watchdog aborts ExecOpts.signal → the child's
    // process group is killed → exec resolves before we reach here, so there is NO orphan/dispose race.
    // The only residual orphan is a provider that ignores the signal (the liveness-fallback path).
    try {
      await sandbox.dispose();
    } catch { /* teardown failure is non-fatal — the node verdict already stands */ }
  }
}

/** Stamp a node's terminal fields, write status, and return the record. */
async function finishNode(
  ctx: RunContext,
  node: NodeSpec,
  rec: NodeStatusRecord,
  t0: number,
  status: NodeStatusRecord['status'],
  summary: string,
  artifacts: ArtifactState[],
  issues: string[] = [],
): Promise<NodeStatusRecord> {
  rec.status = status;
  rec.endedAt = nowISO();
  rec.durationMs = Date.now() - t0;
  rec.artifacts = artifacts;
  rec.issues = issues;
  rec.summary = summary;
  // AWAIT the write (was a fire-and-forget `void`): a node's terminal record must be durable on disk
  // before its lane resolves, so the halt decision + final rollup never race an in-flight write. The
  // write is serialized + atomic (see writeStatus), so awaiting here cannot deadlock parallel lanes.
  await writeStatus(ctx.outDir, ctx.status);

  // G4 JOURNAL — write this node's entry ONLY on a terminal-GOOD verdict (`ok`). A `running`/`error`/
  // `blocked`/`gap` node writes NOTHING, so a crash mid-exec leaves the prior (or absent) entry and the
  // next resume sees "no/stale entry" → re-runs. Record: the envelope hash (computed once at run-start),
  // each CONSUMED input file's content hash, and each PRODUCED artifact's content hash (post-verify, so a
  // half-produced output is never recorded). Atomic tmp+rename + .bak, serialized per dir (see journal.ts).
  if (status === 'ok') {
    const inputHashes: Record<string, string> = {};
    for (const f of inputFilesOf(node, ctx.wf)) {
      const h = await hashFile(path.resolve(ctx.outDir, f));
      if (h) inputHashes[f] = h;
    }
    const outputHashes: Record<string, string> = {};
    for (const a of artifacts) {
      if (!a.exists) continue;
      const h = await hashFile(path.resolve(ctx.outDir, a.path));
      if (h) outputHashes[a.path] = h;
    }
    await writeJournalEntry(ctx.outDir, ctx.journal.meta, node.id, {
      hash: ctx.journal.envHash[node.id] ?? envelopeHash(node, { piTools: [] }, ctx.model),
      inputHashes,
      outputHashes,
      status: 'ok',
      producedAt: nowISO(),
    });
  }
  return rec;
}

/**
 * The synthetic terminal record for a node REFUSED ADMISSION by the run-wide total cap (`maxNodesPerRun`).
 * It NEVER ran (no sandbox, no `execRunner`, no `pi`): the cap was hit at slot-acquire. We stamp the
 * node's existing seeded record to `error` with a loud `total node cap … exceeded` issue and persist —
 * so the existing `results.some(... 'error')` halt at the stage boundary stops the run (the loud-failure
 * convention, mirroring `__resume__`/`__barrier__`). Returns the record so the stage map's `results`
 * array carries it like any lane.
 */
async function cappedRecord(ctx: RunContext, nodeId: string): Promise<NodeStatusRecord> {
  const rec = ctx.status.nodes[nodeId];
  rec.status = 'error';
  rec.endedAt = nowISO();
  rec.artifacts = [];
  rec.issues = [`total node cap (maxNodesPerRun=${ctx.maxNodesPerRun}) exceeded — node not started`];
  rec.summary = 'skipped: run-wide node cap reached';
  await writeStatus(ctx.outDir, ctx.status);
  return rec;
}

// ── run scope: per-run resource lifecycle (worktree/cloud) or a trivial per-node forwarder ─────────

/**
 * Open the run scope. A provider that shares ONE backing resource across a run (worktree/cloud)
 * implements `openRun`; we use it. A provider with no shared resource (inmemory/seatbelt) OMITS it —
 * we synthesize a TRIVIAL scope whose `create` forwards straight to `provider.create` (each node still
 * gets its own sandbox, disposed per node in runNode's `finally`) and whose run-level `dispose` is a
 * no-op. So local runs stay byte-identical to the pre-seam path.
 */
async function openRunScope(provider: SandboxProvider, opts: OpenRunOpts): Promise<RunScope> {
  if (provider.openRun) return provider.openRun(opts);
  return {
    root: opts.repoRoot,
    create: (createOpts) => provider.create(createOpts),
    dispose: async () => { /* no shared resource — per-node dispose is the only teardown */ },
  };
}

// ── G4 resume: envelope-hash resolution + the journal-vs-window seed decision ──────────────────────

/**
 * Compute every node's envelope hash at run-start — the SAME identity `finishNode` will journal and the
 * NEXT resume will compare against. We resolve the node's tools (the resolved `piTools`/`extension`
 * surface) and REALIZE its prompt the SAME way the runner stages it (token resolution + the contract
 * marker tail), so a prompt edit, a `{{arg}}`/`{{state}}` value change, OR a tool change flips the hash.
 *
 * Resilient by design: a node whose tools fail to resolve, or whose prompt has an unresolvable token at
 * run-start (e.g. a `{{state.*}}` an upstream hasn't promoted yet on a FRESH run), falls back to the raw
 * authored prompt / empty tool surface — that node has no journal entry on a fresh run anyway (so it
 * RUNs), and on a resume its upstream state is already persisted (so the token resolves). Never throws.
 */
function envelopeHashOf(ctx: RunContext, node: NodeSpec): string {
  let resolved: ResolveResult | { piTools: string[] };
  try {
    resolved = ctx.registry.resolve(node.tools);
  } catch {
    resolved = { piTools: [] };
  }
  const resolveCtx: ResolveCtx = { run: ctx.outDir, workspace: ctx.workspace, state: ctx.runState, args: ctx.args };
  // A programmatic node carries no prompt — `?? ''` gives a stable empty-prompt hash (its identity is its
  // ops/contract, not a prompt); every other node realizes its prompt + marker tail exactly as before.
  let realizedPrompt = node.prompt ?? '';
  try {
    const body = resolveTokens(node.prompt ?? '', resolveCtx);
    const markers = emitMarkers(markersFromNode(node, resolved as ResolveResult));
    realizedPrompt = body + (markers ? `\n\n${markers}` : '');
  } catch {
    /* keep the authored prompt — see the resilience note above */
  }
  // Hash a node clone carrying the REALIZED prompt (envelopeHash reads node.prompt).
  return envelopeHash({ ...node, prompt: realizedPrompt }, resolved as ResolveResult, ctx.model);
}

/**
 * The JOURNAL decision per node (§4c), layered with the `--from/--until` window (§4e). Returns each
 * node's seeded status: `reused` (skip — provably unchanged or pinned by `--from`) vs `pending` (run).
 *
 * Precedence (§4e):
 *  1. JOURNAL: a node `decideResume` marked REUSE is `reused`; RUN is `pending`. (`noResume` ⇒ every
 *     selected node RUNs.)
 *  2. `--from`: every node in a stage `< fromIdx` is FORCED `reused` (manual stale-prefix pin), even if
 *     the journal said RUN.
 *  3. `--until`: every node in a stage `> untilIdx` is left OUT of `selected` (a partial run) by the
 *     caller's slice — handled by the existing window math, not here.
 *  4. SAFETY: a node FORCED `reused` (by `--from` or the journal) whose declared artifacts are MISSING
 *     on disk flips back to `pending` (re-run) — strictly safer than a hard HALT (handled at the
 *     preflight site, not here).
 */
async function seedFromJournal(
  ctx: RunContext,
  journal: Journal | null,
  fromIdx: number,
  noResume: boolean,
): Promise<{ decisions: Map<string, NodeDecision>; reused: Set<string> }> {
  const wf = ctx.wf;
  // Compute every node's envelope hash (the SAME identity finishNode journals), recorded on ctx so the
  // run records the value the next resume compares against.
  const envHash: Record<string, string> = {};
  for (const id of Object.keys(wf.nodes)) envHash[id] = envelopeHashOf(ctx, wf.nodes[id]);
  ctx.journal.envHash = envHash;

  let decisions: Map<string, NodeDecision>;
  if (noResume || !journal) {
    // No journal (fresh run) or forced full re-run ⇒ every node RUNs.
    decisions = new Map(
      Object.keys(wf.nodes).map((id) => [id, { decision: 'RUN' as const, reason: noResume ? 'noResume' : 'no journal' }]),
    );
  } else {
    // Hash each node's CURRENT consumed-file bytes off the host run dir (content hash, the §2b fix — a
    // same-mtime hand-edit IS caught). An absent input is omitted (decideResume treats a journal-recorded
    // file now-missing as a miss → re-run).
    const inputHash: Record<string, Record<string, string>> = {};
    for (const id of Object.keys(wf.nodes)) {
      const map: Record<string, string> = {};
      for (const f of inputFilesOf(wf.nodes[id], wf)) {
        const h = await hashFile(path.resolve(ctx.outDir, f));
        if (h) map[f] = h;
      }
      inputHash[id] = map;
    }
    decisions = decideResume(wf, journal, { envHash, inputHash });
  }

  // `--from` pin: every node in a stage strictly before fromIdx is FORCED reused (manual override).
  const pinned = new Set<string>();
  if (fromIdx > 0) for (const s of wf.stages.slice(0, fromIdx)) for (const id of s.nodeIds) pinned.add(id);

  const reused = new Set<string>();
  for (const id of Object.keys(wf.nodes)) {
    const run = decisions.get(id)?.decision === 'RUN';
    if (pinned.has(id) || !run) reused.add(id);
  }
  return { decisions, reused };
}

/**
 * Load the PRIOR `.pi/run.json` — the record THIS run is about to overwrite — so a resume can carry the
 * reused nodes' completed records (timings/summary/model/checks) AND the accumulated run clock forward
 * instead of blanking them. Returns null when absent/unparseable OR from a DIFFERENT template (a `source`
 * mismatch ⇒ a wholesale swap → no carry; mirrors the journal's same-`source` guard). A fresh run sees null.
 */
async function loadPriorStatus(outDir: string, source: string): Promise<RunStatus | null> {
  try {
    const prior = JSON.parse(await fs.readFile(runJsonFile(outDir), 'utf8')) as RunStatus;
    return prior && prior.source === source ? prior : null;
  } catch {
    return null;
  }
}

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
    buildCommand: opts.buildCommand ?? defaultPiCommand,
    execRunner: opts.execRunner ?? defaultExecRunner,
    providerName: opts.providerName ?? 'cp',
    model: opts.model,
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
    return { status: ctx.status, outDir };
  }

  let halted = false;
  try {
    for (let i = 0; i < selected.length && !halted; i++) {
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
    }

    ctx.status.stage = null;
    ctx.status.done = true;
    ctx.status.durationMs = baselineMs + (Date.now() - t0);
    const vals = Object.values(ctx.status.nodes).filter((n) => n.id !== '__resume__');
    const failed = vals.filter((n) => n.status === 'error' || n.status === 'blocked').length;
    const okCount = vals.filter((n) => n.status === 'ok' || n.status === 'reused').length;
    ctx.status.ok = !halted && failed === 0;
    ctx.status.totals = { nodes: vals.length, ok: okCount, failed };
    await writeStatus(outDir, ctx.status);
  } finally {
    // Run-level teardown — commit+copy-back (worktree) / collect+destroy (cloud). Best-effort: a
    // teardown failure must not mask the run verdict already written above.
    try { await scope.dispose(); } catch { /* non-fatal */ }
  }
  return { status: ctx.status, outDir };
}
