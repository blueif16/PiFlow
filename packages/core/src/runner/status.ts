// The run-status record — a future-viz-friendly mirror of the engine's run-status digest (run.mjs
// schema + writeStatus 639–668), now published as `.pi/run.json` (D7 layout) — kept faithful enough
// that a viz/dashboard can read it unchanged.
//
// The status is the SINGLE source of truth a watcher polls: a node is `ok` only when its declared
// artifacts exist ON DISK (the driver stat()s them — "verified, not trusted"). Because parallel lanes
// and the run loop all write this one file, the writer SERIALIZES writes per dir and publishes each
// ATOMICALLY (temp file + rename) so concurrent writers never interleave and a polling reader never
// sees a torn file (see writeStatus).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ReturnMode, SandboxProviderKind, OpWhen, PolicyAction } from '../types.js';
import type { CheckResult } from '../checks.js';
import { piDir, runJsonFile } from './layout.js';

/** Per-node status enum (run.mjs ladder): the terminal verdict the driver assigns each node. */
export type NodeStatus =
  | 'pending'   // not yet run (selected window)
  | 'running'   // exec in flight
  | 'ok'        // clean exit + every declared artifact present
  | 'gap'       // self-reported non-fatal gap (honored from the node's return)
  | 'blocked'   // a required artifact is missing (contract breach) — beats any self-report
  | 'error'     // killed (timeout/stall) or nonzero exit / degenerate run
  | 'reused'    // skipped upstream node whose artifacts were reused (--from resume)
  | 'awaiting-input' // (G5) a human checkpoint is PARKED — its marker is pending, waiting for a reply
  | 'dry';      // dry-run: command built, not executed

/** One verified artifact: did it exist on the host after collection, and how big. */
export interface ArtifactState {
  path: string;
  exists: boolean;
  bytes: number;
}

/**
 * (POLICY channel) One entry in a node's authored post-node consequence chain, folded from its `op[]` (and the
 * G5 `checkpoint`). A LEGIBLE projection of the op envelope — NOT the raw op — so the single observe path can
 * render "what happens after this node / what are our set policies" without re-parsing the template.
 */
export interface GateSummaryEntry {
  /** The consequence, folded from the op body: `run`→'exec', `gate`→'check', `action.kind` (rerouteTo→'reroute'),
   *  the G5 checkpoint→'human'. */
  kind: 'exec' | 'check' | 'judge' | 'retry' | 'escalate' | 'notify' | 'reroute' | 'human';
  /** A compact human label (e.g. `non-empty`, `npm test`, `reroute→w1-design ×1`, `confirm`). */
  label: string;
  /** When it fires (default 'post'); lets a viewer split before-model (`pre`) from after-node consequences. */
  when: OpWhen;
  /** The on-fail policy of a gate/exec (`block|warn|stop|retry|escalate`). Omitted for control actions + human. */
  onFail?: PolicyAction;
  /** A non-blocking (advisory) gate — Dagster `blocking=False`. */
  advisory?: boolean;
}

/**
 * (POLICY channel) A node's authored gate/policy summary — the ordered consequence chain (`op[]` gate lane +
 * control actions) plus the human-checkpoint kind. Distilled ONCE at run time (`summarizeGates`) and mirrored
 * via `NodeConfig`, so GUI/TUI render the post-node policy legibly and the optimizer reads it without re-parsing
 * the template. Omitted entirely when a node has no gates/actions/checkpoint.
 */
export interface GateSummary {
  /** The consequence chain in authored order. */
  entries: GateSummaryEntry[];
  /** (G5) The human checkpoint kind, if this node stops for a person. */
  checkpoint?: 'confirm' | 'input' | 'select';
}

/**
 * (SKIN channel) The CURATED per-node config slice — a stable named subset of the resolved `NodeSpec`,
 * mirrored to disk so the single observe path can surface "what this node ran AS" without re-reading the
 * template. NOT the whole NodeSpec: no prompt text, no op/io envelopes. `sandbox` here is per-node SCOPING
 * (workspace/readScope/owns), NOT the chosen backend — the run-level backend is `RunStatus.sandbox`.
 * Every field is OPTIONAL/additive and absent fields are OMITTED (never written as `undefined`).
 */
export interface NodeConfig {
  /** Authored per-node model id (`node.model`). */
  model?: string | null;
  /** Per-node provider/gateway (`node.provider`). */
  provider?: string;
  /** Per-node tier alias (`node.tier`). */
  tier?: string;
  /** Per-node tool selection (`node.tools`). */
  tools?: { allow?: string[]; deny?: string[] };
  /** Hard wall-clock cap (`node.sandbox.timeoutMs`). */
  timeoutMs?: number;
  /** Per-node retry budget (`node.io.retries`). */
  retries?: number;
  /** Agent-PRESET label (`node.agentType`). */
  agentType?: string;
  /** No-pi declarative node (`node.programmatic === true`). */
  programmatic?: boolean;
  /**
   * Jail-off posture (`node.sandbox.fullAccess === true`): this node's `pi` ran OUTSIDE the local fs jail
   * (full host access). Top-level, parallel to `programmatic` — a real per-node execution knob the single
   * observe path mirrors so a viewer (the GUI skin) reads "ran unlocked" off config. Omitted ⇒ jailed.
   */
  fullAccess?: boolean;
  /** Per-node SCOPING (not the backend): workspace cwd + read scope + write-authority globs. */
  sandbox?: { workspace?: string; readScope?: string[]; owns?: string[] };
  /**
   * (POLICY channel) The node's authored post-node consequence chain — the ordered gate lane (kinds + each
   * gate's on-fail policy), control actions (retry/escalate/reroute), and the human checkpoint. A LEGIBLE
   * DISTILLED slice of `node.op` (never the raw op envelope), so a viewer renders "what happens after this
   * node" straight off config. Omitted when the node has no gates/actions/checkpoint. See `summarizeGates`.
   */
  gates?: GateSummary;
}

/**
 * (agent-neutral telemetry spine) A node's authoritative token/cost rollup, persisted from the executor's
 * OWN final report — so the observe surface has real numbers for EVERY agent type, not just pi. pi derives
 * these from its event stream (createNodeAccumulator) so it does not populate this; Claude Code stamps it
 * from the ONE `result` event (parseClaudeResult), which was previously parsed for the verdict and DISCARDED.
 * Additive/optional: absent on a pi node and on older records. When present it is the authoritative source
 * for the run-view's token spine (buildRunView prefers it over the — for Claude, blank — event replay).
 */
export interface NodeUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheCreation?: number;
  /** total cost in USD (0/absent on non-billing providers — surface tokens-first). */
  cost?: number;
  /** the model's context-window cap for THIS run (the authoritative context-pressure denominator). */
  contextWindow?: number;
  /** time-to-first-token, ms. */
  ttftMs?: number;
  /** model invocations (Claude `num_turns`) — the real count, never a per-message-line count. */
  numTurns?: number;
  stopReason?: string;
}

/** A node's record in the run status. */
export interface NodeStatusRecord {
  id: string;
  label: string;
  /** (G6) The agent-PRESET label (branding) carried verbatim from the NodeSpec → observe → GUI icon. */
  agentType?: string;
  status: NodeStatus;
  /** (agent-neutral spine) authoritative token/cost rollup from the executor's final report. See NodeUsage. */
  usage?: NodeUsage;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  artifacts: ArtifactState[];
  issues: string[];
  summary?: string;
  /** Set when a watchdog killed the node (classifies the `error`). */
  killedTimeout?: boolean;
  killedStall?: boolean;
  exitCode?: number;
  command?: string;
  /** G1 — the EFFECTIVE model this node ran on (after the routing precedence). Null/absent ⇒ pi's provider default. */
  model?: string | null;
  /** (SKIN channel) The curated per-node config slice mirrored from the resolved NodeSpec (see NodeConfig). */
  config?: NodeConfig;
  /** Declarative integrity-check results (explicit ∪ auto fill-sentinel), when any were run. */
  checks?: CheckResult[];
  /** (M5 · #11) PRE-gate results — the `when:'pre'` gate ops run over staged inputs BEFORE the model. */
  preChecks?: CheckResult[];
  /** The effective return-handshake mode this node was judged under ('optional' | 'required'). */
  returnMode?: ReturnMode;
  /** Artifacts present but VIOLATING their declared schema (a contract breach → blocked). */
  schemaInvalid?: { path: string; errors: string[] }[];
  /** How many artifacts the schema gate actually validated. */
  schemaChecked?: number;
  /** Why the schema gate skipped (no validator / unreadable schema), if it did. */
  schemaSkipped?: string;
  /**
   * The node's structured RETURN violated its declared `returnSchema` (a contract breach). Mirrors
   * `schemaInvalid` for the return-handshake side: a present-but-NON-CONFORMING result blocks the node.
   */
  returnSchemaInvalid?: string[];
  /**
   * (G8 fold) How many bounded IN-SANDBOX schema-repair turns this node took (a schema miss re-prompts
   * the live sandbox from {previousOutput, ajvErrors, schema} BEFORE any full `retry`/`escalate` re-run).
   * Absent ⇒ no repair lane fired (the default, `maxRepairAttempts:0`). A repair is NOT a retry.
   */
  repairAttempts?: number;
  /** (G8 fold) The repair budget was spent and the output STILL failed its schema — terminal `blocked`. */
  repairExhausted?: boolean;
  /**
   * (warm-resume) The MINTED per-node pi session id (= the node id) and its `--session-dir`, recorded when a
   * warm-eligible (in-place/local) node ran with a persisted session. A future `node <run> <id> --resume`
   * reads these to warm-resume without re-deriving. Absent on a cold (inmemory/cloud) or no-session node.
   */
  sessionId?: string;
  sessionDir?: string;
}

/** Run-level rollup at completion. */
export interface RunTotals {
  nodes: number;
  ok: number;
  failed: number;
}

/** The whole run-status record (faithful to run.mjs's shape for a future viz). */
export interface RunStatus {
  run: string;
  /**
   * The run's MEMORABLE identity — the Docker-style `<bake-adjective>-<pie>` name (e.g. "flaky-pecan")
   * the CLI mints when `--run/--id` is omitted, or the explicit `--run <id>` when one was passed. This
   * decouples a run's identity from any prompt id; absent on older records (additive, optional).
   */
  name?: string;
  /**
   * The originating prompt id, when the run carried one (`--arg prompt=<id>` / `--arg promptId=<id>`).
   * Carried as run METADATA so the run is traceable to its prompt WITHOUT the run id BEING the prompt id.
   */
  promptId?: string;
  source?: string;
  /** The active run PROFILE name (the reduced DAG this run reflects); null/absent ⇒ the full DAG. */
  profile?: string | null;
  provider?: string;
  model?: string | null;
  /**
   * The OS pid of the process that DROVE this run (the one that called `runWorkflow`), recorded at run
   * start so `piflowctl node <run> <id> --stop` can later signal it. The runner spawns each node's child
   * DETACHED as its own process group (sandbox/worktree.ts:128) and kills the GROUP via `kill(-pid)`; a
   * later stop targets THIS controller's group (SIGTERM→SIGKILL grace) — a per-RUN stop, since per-node
   * child pids are ephemeral and never persisted. Absent on an older run (additive, optional).
   */
  controllerPid?: number;
  /**
   * (SKIN channel) The run's EFFECTIVE sandbox BACKEND — the kind chosen ONCE at the CLI (`--sandbox`) for
   * the single provider instance, stamped run-wide. DISTINCT from `provider` (the MODEL gateway). A
   * programmatic node is always host-local regardless (carved out per-node in `NodeConfig.programmatic`).
   * Absent on older records (additive, optional).
   */
  sandbox?: SandboxProviderKind;
  startedAt: string;
  updatedAt: string;
  done: boolean;
  ok: boolean | null;
  /**
   * (P6 — mid-run migration) The run was PARKED at a node boundary by a freeze request (a pending
   * migration), not run to completion. Distinct from `done`: a frozen run has `done:false, ok:null`, its
   * completed nodes journaled and its remaining nodes still `pending`, so a target runner resumes it from
   * the same run-dir. Absent/false on a normal run (additive, optional).
   */
  frozen?: boolean;
  durationMs: number | null;
  /** While a stage runs: { index, total, nodes }. Null between/after stages. */
  stage: { index: number; total: number; nodeIds: string[] } | null;
  totals: RunTotals | null;
  nodes: Record<string, NodeStatusRecord>;
}

export const nowISO = (): string => new Date().toISOString();

// SERIALIZED + ATOMIC writer. The status file is the SINGLE source of truth a watcher polls (see the
// header), AND it is written from PARALLEL lanes (runWorkflow's per-stage Promise.all) plus the run
// loop — concurrent writers. Two hazards the naive `await fs.writeFile` has:
//   1. INTERLEAVING — two overlapping async writes to the SAME path are not ordered, so a later
//      `writeStatus` can land on disk BEFORE an earlier one's bytes finish, leaving a stale record
//      (run.mjs avoided this for free: it is single-threaded + synchronous `writeFileSync`).
//   2. TORN READS — `fs.writeFile` is not atomic; a concurrent reader (the viz/dashboard) can observe
//      a half-written, unparseable file (reproduced empirically: ~3/472 reads torn under load).
// Fix: a per-directory promise chain serializes writes (so they never overlap → last-write-wins is
// real), and each write goes to a unique temp file then `rename`s into place (atomic on POSIX/NTFS),
// so a reader sees only a complete prior or complete next file — never a partial one.
const writeChains = new Map<string, Promise<void>>();
let tmpSeq = 0;

/**
 * Write the run status to the CANONICAL `<dir>/.pi/run.json` (D7 layout; pretty-printed; mkdir -p the
 * `.pi/` namespace first). This IS the single source of truth the observe pipeline (readRunModel /
 * watchRun) and the cli/tui consumers poll — they read `runJsonFile(dir)`, the canonical `.pi/run.json`
 * digest. Writes to a given dir are SERIALIZED and each is ATOMIC (temp-file + rename in the
 * SAME `.pi/` dir, so the rename is intra-filesystem), so parallel lanes + a polling watcher never
 * interleave or read a torn file.
 */
export function writeStatus(dir: string, status: RunStatus): Promise<void> {
  status.updatedAt = nowISO();
  // SNAPSHOT the bytes NOW (synchronously), before queueing: `status` is a shared, still-mutating
  // object, so serializing only the file write is not enough — we must freeze WHAT this call writes at
  // call time, or a queued write would later serialize a future mutation and reorder records on disk.
  const body = JSON.stringify(status, null, 2);
  const prev = writeChains.get(dir) ?? Promise.resolve();
  const next = prev
    .catch(() => {}) // a prior write's failure must not poison the chain
    .then(async () => {
      const metaDir = piDir(dir);
      await fs.mkdir(metaDir, { recursive: true });
      const finalPath = runJsonFile(dir);
      const tmpPath = path.join(metaDir, `.run.${process.pid}.${tmpSeq++}.tmp`);
      await fs.writeFile(tmpPath, body);
      await fs.rename(tmpPath, finalPath); // atomic publish — a reader never sees a partial file
    });
  writeChains.set(dir, next);
  return next;
}

/** Stat a host path → { path, exists, bytes }. Never throws (missing ⇒ exists:false). */
export async function artifactState(absPath: string, displayPath: string): Promise<ArtifactState> {
  try {
    const st = await fs.stat(absPath);
    // exists = the path is present on disk (a 0-byte file like .gitkeep is legitimately present).
    return { path: displayPath, exists: true, bytes: st.isFile() ? st.size : 0 };
  } catch {
    return { path: displayPath, exists: false, bytes: 0 };
  }
}
