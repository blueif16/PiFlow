// ─────────────────────────────────────────────────────────────────────────────
// @piflow/core — the L1 node envelope (the single-agent spec).
//
// This file IS the frozen spine. "The width" of a mature agent node is five
// concerns — work · sandbox · tools · hooks · contract — each of which compiles
// down to a `pi` invocation. `NodeSpec` is the dense executable; `NodeIntent` is
// the sparse subset the design agent authors; the SandboxProvider / ToolRegistry
// / Hook types are the horizontal seams that get filled in one impl at a time.
//
// Canon: docs/design/l1-node-envelope.md. Do not widen this spine casually — the
// whole point is that providers/tools/hooks plug in WITHOUT changing it.
// ─────────────────────────────────────────────────────────────────────────────

// ── THE AGENT NODE (dense, executable) ──────────────────────────────────────

/** A single agent node, fully described. The runner compiles this into one `pi` spawn. */
export interface NodeSpec {
  /** Stable id; SDK-filled as a slug of `label`. */
  id: string;
  /** Human-readable name (the authored handle the id derives from). */
  label: string;
  /** Generic phase label (§5 display metadata) — carried for the elision predicate; never drives the DAG. */
  phase?: string;

  // WORK — intelligence about the task (authored).
  /**
   * The realized wave prompt — recorded by `extract` (human front-end) or emitted by COMPOSE.
   * OPTIONAL on a `programmatic` node (it spawns no `pi`, so it has no prompt); REQUIRED otherwise.
   */
  prompt?: string;
  /** Skill to load and follow, if any. */
  skill?: string;
  /** Optional agent-type hint (for a custom sub-agent system prompt). */
  agentType?: string;
  /**
   * G1 ROUTING — per-node model id → `pi --model`. The runner resolves the EFFECTIVE model via
   * `runner/model-routing.ts` (the single home of the precedence): `model` > `tier` (when active) >
   * run-level model > pi's provider default. Undefined ⇒ inherit the run-level model.
   */
  model?: string;
  /** Per-node provider/gateway → `pi --provider`. Undefined ⇒ auto-resolved from the model, else the run default. */
  provider?: string;
  /** Per-node tier ALIAS resolved to a model via `~/.piflow/model-tiers.json` (when active). Undefined ⇒ none. */
  tier?: string;

  /** 1. Where it runs. */
  sandbox: SandboxSpec;
  /** 2. What it can call. */
  tools: ToolSelection;
  /** 3. Deterministic pre/post plumbing (never an LLM). */
  hooks?: { pre?: Hook[]; post?: Hook[] };
  /** 4. The filesystem contract — and the source of the inferred DAG edges. */
  io: NodeIO;
  /**
   * 6. (G5 — HITL) When present, this node is a HUMAN CHECKPOINT: it spawns NO `pi` (no tools/model), it
   * WRITES a marker, PARKS its lane (without holding a G2 limiter slot) until a reply file appears or the
   * timeout elapses, VALIDATES the reply, JOURNALS it, and finishes `ok` carrying the chosen value. With
   * no courier attached the SAFETY rule (`headless`) keeps a background run from hanging. Optional/additive
   * — a node with no `checkpoint` behaves exactly as before. See `CheckpointSpec`.
   */
  checkpoint?: CheckpointSpec;
  /**
   * 7. (G12 — M3) When present, this is a GENERATED reroute existence-gate node: it spawns NO `pi`, stat()s
   * the prior attempt's verify output, and (on a pass) copies it forward + marks the cloned re-entry body
   * `reused` so it never spawns (#17). NOT author-reachable — `expandReroute` emits it pre-compile. Optional/
   * additive: a node with no `rerouteGate` behaves exactly as before. See `RerouteGate`.
   */
  rerouteGate?: RerouteGate;
  /**
   * 8. (G13 — M5) The UNIFIED node-op envelope (design §2/§5): the ONE ordered list every deprecated
   * authoring grammar (`hooks`/`checks`/`policy`/`inject`) LOWERS into AT THE LOADER. Since U6 (op⊖ops) it
   * is the SOLE derive rep — the legacy `ops`/`NodeOps` runtime field was retired; the runner reads derives
   * from `op` via `derivesFromOp`. The dense `NodeSpec` gains EXACTLY this one field (the justified spine
   * widen — `types.ts:10-11`); the named five concerns are unchanged. Each entry DETECTS (`gate`), DERIVES
   * (`transform`), ACTS (`run`), or CONTROLS (`action`), all routing through ONE `onFailure` consequence
   * vocabulary. The per-transform executors (`seed.ts`/`project.ts`/`merge.ts`/`promote.ts`/`checks.ts`)
   * are reused UNCHANGED — the envelope changes only the authoring + dispatch frame. Optional/additive: a
   * node with no `op` behaves exactly as before (the loader still carries the byte-identical
   * `io.checks`/`io.policy`).
   */
  op?: OpSpec[];
  /**
   * 9. (PROGRAMMATIC NODE) When `true`, this node runs its DECLARATIVE ops deterministically and spawns
   * NO `pi` — no `buildCommand`, no exec. The runner runs its PRE seeds/gates → POST `run`/`merge`/
   * `project` derive ops → POST checks → promote → finishNode by REUSING the existing op executors, then
   * verifies its artifact contract by host-stat exactly like a normal node. A programmatic node needs no
   * `prompt` and no `tools`. Everything else (deps/join, contract artifacts+owns+readScope, checks, policy,
   * node-level retry/rerouteTo) is unchanged. Optional/additive — a node without it behaves exactly as
   * before (it spawns `pi`). Mirrors the `checkpoint?`/`rerouteGate?` no-pi presence flags.
   *
   * SANDBOX: ops run via host `spawnSync` (env:process.env), NOT the sandbox provider — so a programmatic
   * node is ALWAYS UNSANDBOXED on the host (no read/write jail) and ALWAYS local, even under
   * `--sandbox local`/`daytona`. Its `readScope` is vestigial (ignored). Sound: the command is fixed +
   * repo-authored, and the read-jail exists to contain an LLM, of which there is none here.
   */
  programmatic?: true;
}

// 8 ── THE UNIFIED OP ENVELOPE (G13 — M5) ───────────────────────────────────────

/** When an op fires (extends `HookWhen`): a PRE op runs before the model, a POST op after, etc. */
export type OpWhen = 'pre' | 'post' | 'on-success' | 'on-failure' | 'always';

/**
 * The consequence of an op (or check) failing — `PolicyAction` generalized to every op (design §2.4).
 * `block` fails the node + halts before the next stage; `warn` records a non-fatal issue; `stop` is the
 * documented `block` alias; `retry`/`escalate` route to the canonical M4 `NodeIO` lanes.
 */
export type OnFailure = PolicyAction;

/**
 * One discriminated node-op record (design §2.1). A node carries an ordered `op[]`; every existing grammar
 * is a PROFILE of this shape. EXACTLY ONE body is present (the discriminator — the `mergeHook` oneOf
 * precedent; the loader rejects a multi-body op). Additive: the field is optional on `NodeSpec`/`NodeIntent`.
 */
export interface OpSpec {
  /** Ledger key + resume key + the reroute target (#2). SDK-fills a slug if omitted. */
  id?: string;
  /** Firing phase/condition. Default 'post' (the dbt-`when` knob made explicit). */
  when?: OpWhen;
  /** Files READ — fold into DAG edge inference AND (for `pre` ops) into the realized prompt (#10). */
  reads?: string[];
  /** Files WRITTEN — the produced set the next node's `reads` draws an edge from (#16). */
  writes?: string[];
  /** The consequence of THIS op failing. Default 'block' (the checks⊥policy split, universal — design §2.4). */
  onFailure?: OnFailure;
  /** Skip when outputs fresh. Default true (carried from `Hook.idempotent`). */
  idempotent?: boolean;

  // EXACTLY ONE body (the discriminator; the loader rejects a multi-body op — the `mergeHook` oneOf precedent):
  /** DERIVE — declarative data transform (seed/project/merge/promote/projectRegistry). */
  transform?: TransformBody;
  /** ACT — deterministic shell/fn side-effect (the ported, now-authorable `Hook.run`). Never an LLM. */
  run?: RunBody;
  /** DETECT — pure predicate over `reads` emitting a verdict (the Check family). */
  gate?: GateBody;
  /** CONTROL — model-free control action (retry/escalate/notify/rerouteTo) — the G12 family. */
  action?: ActionBody;
}

/** The DERIVE body — one of the five transform families; the `kind` discriminates which executor runs. */
export type TransformBody =
  | { kind: 'seed'; from: string }
  | { kind: 'project'; ops?: Record<string, unknown>[]; from?: string | string[] }
  | { kind: 'merge'; ops: Record<string, unknown>[] }
  | { kind: 'promote'; from: string; to: string; reducer?: Reducer }
  | { kind: 'projectRegistry'; source: string; mapRef: string; key: string };

/** The ACT body — a deterministic shell command or an in-process fn ref. Never an LLM. */
export type RunBody = { cmd: string; args?: string[]; cwd?: string } | { fn: string };

/** The DETECT body — a `Check` predicate; `advisory` = Dagster blocking=False (a non-fatal gate). */
export type GateBody = { kind: CheckKind | string; path?: string; param?: unknown; advisory?: boolean };

/** The CONTROL body — a model-free control action (G12 owns the runtime; G13 owns the SLOT). */
export type ActionBody =
  | {
      kind: 'retry';
      onVerdict?: 'fail' | 'warn';
      max?: number;
      /**
       * (SA-B · expert-representations) The retry correction scope.
       * - `'feedback'` (DEFAULT, L1) — warm-resume: append the gate's critique as a new message to the
       *   SAME pi session and re-run. This is Reflexion / Self-Refine semantics. Bounded by `max`.
       * - `'fix'` (L2 — STUB): infer the problem, consult per-workflow fix/issue memory, patch THIS
       *   node's prompt/tool-wiring for this run instance (ephemeral, recorded, never silently promoted
       *   to the template). See docs/research/2026-06-28-loop-engineering-self-improving-systems.md and
       *   the build-spec §Self-correction. Owned by SA-D + the memory system. NOT YET IMPLEMENTED.
       */
      scope?: 'feedback' | 'fix';
    }
  | { kind: 'escalate'; via: string; evidence?: string[] }
  | { kind: 'notify'; channel: string; payload?: string[] }
  | { kind: 'rerouteTo'; node: string; max: number; evidence?: string[] };

// 6 ── HUMAN CHECKPOINT (G5 — HITL) ────────────────────────────────────────────

/**
 * A human checkpoint declared on a node (G5). The node's "work" is to ASK a human and resume on their
 * reply; it spawns no `pi`. The runner writes a marker from this spec, parks the lane watching for a
 * reply file, validates it, and journals the chosen value. Translated from PDW's `CheckpointOptions`
 * (`kind`/`choices`/`default`/`headless`/`timeoutMs`) onto the filesystem-coordinated fleet.
 */
export interface CheckpointSpec {
  /** The question shape: a yes/no `confirm`, a free-text `input`, or a one-of-`choices` `select`. */
  kind: 'confirm' | 'input' | 'select';
  /** The question shown to the human (and folded into the marker hash, so an edit re-prompts on resume). */
  prompt: string;
  /** For `select`: the allowed values. The runner rejects a reply whose value is not one of these. */
  choices?: string[];
  /** The value taken headlessly (no courier/reply) under `headless:'default'` — journaled like a real reply. */
  default?: unknown;
  /**
   * SAFETY policy when no reply arrives within `timeoutMs` (or immediately on a detached run): `'default'`
   * takes `default` and journals it (the run never hangs); `'abort'` finishes the node `error` and HALTS.
   * Default `'default'`.
   */
  headless?: 'default' | 'abort';
  /**
   * Bound on the interactive wait (ms). Omit ⇒ wait indefinitely while a courier could still reply (an
   * attended run). On elapse the `headless` policy fires. A tiny value drives the headless path in tests.
   */
  timeoutMs?: number;
}

// 1 ── SANDBOX ────────────────────────────────────────────────────────────────

/** Which execution backend a node runs in. New backends extend this union + add a SandboxProvider. */
export type SandboxProviderKind = 'inmemory' | 'local' | 'seatbelt' | 'worktree' | 'daytona' | 'e2b';

/**
 * Where a node runs. `read` is OS-enforced locally (Seatbelt: deny-all-then-allow) and a *staging
 * contract* in the cloud (empty VM, upload exactly the read set). `output` + the provider's
 * `downloadDir` is the portable contract — the one mechanism every backend supports.
 */
export interface SandboxSpec {
  /** Backend; SDK-defaulted (e.g. 'inmemory' for tests, 'seatbelt' locally). */
  provider: SandboxProviderKind;
  /** Working directory (cwd) for the spawned agent. */
  workspace: string;
  /** Read scope — OS-enforced (seatbelt) or staging contract (cloud). */
  read: string[];
  /** Owned write paths (a contract assertion on cloud; isolated via worktree locally). */
  write: string[];
  /** Dedicated owned output dir — collected back via `downloadDir`. */
  output: string;
  /** Container image (cloud providers). */
  image?: string;
  /** Extra environment for the run. */
  env?: Record<string, string>;
  /** Hard wall-clock cap for the node. */
  timeoutMs?: number;
}

// 2 ── TOOLS ─────────────────────────────────────────────────────────────────

/**
 * Per-node tool selection, addressed by `namespace:name` (e.g. 'fs:read', 'web:search',
 * 'mcp.github:create_issue'). The colon namespace is a pure SDK abstraction — the registry
 * resolves it to the bare names `pi` actually sees.
 */
export interface ToolSelection {
  /** Allowed tool addresses. Empty/undefined ⇒ the SDK's default builtin set. */
  allow?: string[];
  /** Denied tool addresses (applied after allow). */
  deny?: string[];
}

// 4 ── CONTRACT / DATA-FLOW (edges are inferred from this) ─────────────────────

/** A required output the runner stat()s and (optionally) schema-validates. */
export interface ArtifactReq {
  /** Path, relative to the node's project dir. */
  path: string;
  /** Optional JSON-Schema (draft-2020-12) path to validate the artifact against. */
  schema?: string;
}

// ── INTEGRITY CONTRACT: detection (checks) ⊥ consequence (policy) ⊥ return-handshake ──────────────
// A node declares its integrity CHECKS (pure predicates over its artifacts) SEPARATELY from the
// verdict→ACTION POLICY, so detection and consequence stay disentangled — flip an action without
// touching a check, or add a check without touching the policy. ALL fields are optional/additive: a
// node that declares none behaves exactly as before. Ported from the `run.mjs` unified node contract.

/** A pure predicate kind run over a single artifact's bytes. Unknown kinds degrade to a warn (skip). */
export type CheckKind =
  | 'exists'        // the file is present
  | 'non-empty'     // size > 0
  | 'regex-absent'  // param (a regex string) does NOT match (e.g. an unfilled <FILL:> sentinel is gone)
  | 'regex-present' // param matches
  | 'json-parses'   // the bytes are valid JSON
  | 'field-present' // param (a dotted path) resolves to a non-null value in the parsed JSON
  | 'count-floor'   // param { path, min }: the array at `path` has ≥ `min` items
  | 'fenced-tail';  // param { lang?, field?, minItems? }: the last fenced block parses and has ≥ minItems

/** The outcome of one check. `pass` is clean; otherwise the check's `severity`. */
export type Verdict = 'pass' | 'warn' | 'fail';

/**
 * What a non-pass verdict DOES to the node (G12 — M4: widened 3→5, realizing the IN-TYPE reserved
 * `retry-once`/`subagent-fix` as `retry`/`escalate`). `block` fails the node + halts before the next
 * stage; `warn` records a non-fatal issue; `retry` re-runs the node (a fresh re-seed+exec) filtered by
 * the DERIVED failure class; `escalate` re-runs on a STRONGER model fed the verified failure evidence
 * (`consultPreamble`). `stop` is a DOCUMENTED ALIAS of `block` (design §2.4 option B — both fail the
 * node, drain same-stage siblings, halt before the next stage; the name is RESERVED for a future
 * graceful-cancel primitive once a stage-cancel exists, NOT a distinct mid-stage abort today).
 */
export type PolicyAction = 'block' | 'warn' | 'stop' | 'retry' | 'escalate';

/** Verdict→action map (consequence). Default: fail→block, warn→warn. Keyed by the non-pass verdicts. */
export type Policy = Partial<Record<Exclude<Verdict, 'pass'>, PolicyAction>>;

/** Whether the node's fenced-JSON return handshake is required or advisory. */
export type ReturnMode = 'optional' | 'required';

/**
 * The AUTHORING-shape integrity checks (template node.json §3 `checks`): the DETECTION predicates split
 * into the two firing lanes — `pre` (validate staged inputs BEFORE the model) and `post` (validate the
 * produced artifacts AFTER). The runtime collapses these to the flat `NodeIO.checks` (post is what the
 * runner runs); this preserves the structure so the codec round-trips the node.json shape losslessly.
 */
export interface ChecksPrePost {
  pre?: Check[];
  post?: Check[];
}

/** One declarative integrity check over an artifact (detection only — never judges GOODNESS). */
export interface Check {
  /** The predicate to run (see CheckKind). An unknown kind is skipped with a warn. */
  kind: CheckKind | string;
  /** Artifact path the check reads, relative to the run dir. */
  path?: string;
  /** Kind-specific parameter: a regex string, a dotted field path, `{ path, min }`, or `{ lang, field, minItems }`. */
  param?: unknown;
  /** The verdict on failure (default 'fail'). */
  severity?: 'fail' | 'warn';
}

/**
 * The data contract. Edges are INFERRED from this: a node that `reads` a file another `produces`
 * gets an edge. `declared ⊇ actual` — undeclared reads/writes are a breach.
 */
export interface NodeIO {
  /** Input files this node reads → an edge FROM whoever produces each. */
  reads: string[];
  /** Output files this node writes → an edge TO whoever reads each. */
  produces: string[];
  /** Declared sources with no producer (raw inputs) — suppress the "missing producer" error. */
  externalInputs?: string[];
  /** Explicit-edge escape hatch (upstream node ids). Rarely needed; prefer data-flow. */
  dependsOn?: string[];
  /** Required outputs that gate the node's success. */
  artifacts: ArtifactReq[];
  /** Declarative integrity checks over the artifacts (detection). Empty/undefined ⇒ none. */
  checks?: Check[];
  /**
   * The AUTHORING-shape checks (template node.json §3): the same DETECTION predicates split into the
   * `pre` lane (over staged inputs, before the model) and the `post` lane (over produced artifacts).
   * SEPARATE from the flat `checks` above: `checks` is the runner's collapsed post-check list (what
   * `effectiveChecks`/the runner consume); `checksPrePost` preserves the pre/post STRUCTURE so the
   * codec round-trips the node.json shape losslessly. Additive — the runner ignores it.
   */
  checksPrePost?: ChecksPrePost;
  /** Verdict→action policy for failed checks (consequence). Undefined ⇒ the default (fail→block). */
  policy?: Policy;
  /**
   * The node's structured-result JSON-Schema (template node.json §3 `return`) — the contract for the
   * fenced-JSON tail the node returns. DISTINCT from `returnMode` (the required/optional handshake):
   * `returnMode` says WHETHER a return is mandatory, `returnSchema` says what SHAPE it must take. An
   * arbitrary draft-2020-12 schema object; carried verbatim. Undefined ⇒ no schema declared.
   */
  returnSchema?: Record<string, unknown>;
  /** Return-handshake mode. Default: 'optional' when `artifacts` is non-empty, else 'required'. */
  returnMode?: ReturnMode;
  /**
   * A sentinel string (e.g. `<FILL:`) that, if STILL present in a required artifact, marks it
   * incomplete — the engine adds an auto `regex-absent` completeness check per artifact. Undefined ⇒ off.
   */
  fillSentinel?: string;
  /**
   * Per-node RETRY budget — ADDITIONAL attempts after the first if the node ends `error`/`blocked`
   * (a transient model/timeout failure). 0/undefined ⇒ one attempt (today's behavior). Each retry is a
   * FRESH run (re-seed + re-exec); the last attempt's record wins. Worst-case wall = (retries+1) × timeout.
   * Preserved verbatim: when no `retry`/`escalate` is declared the runner reads `legacyRetry(io.retries)`
   * (max=retries, classes=['infra','degenerate']) — today's exact semantics.
   */
  retries?: number;
  /**
   * (G12 — M4 · #6) The bounded RE-RUN budget, FILTERED by the failure class the runner DERIVES (it
   * stats the files the node was required to produce — it never asks the model "are you sure"). A fresh
   * attempt = re-seed + re-exec. Undefined ⇒ `legacyRetry(io.retries)` (today's exact semantics).
   */
  retry?: RetrySpec;
  /**
   * (G12 — M4 · #4) Re-run on a STRONGER model fed the verified failure facts (`consultPreamble`) once
   * the retry budget is spent (or immediately on an escalable class). The target resolves through
   * `model-routing.ts` (`tier`/`model` → `resolveNodeModel`), NOT a new config home. Undefined ⇒ no
   * escalation (today's behavior).
   */
  escalate?: EscalateSpec;
  /**
   * (G8 fold) Bounded IN-SANDBOX schema repair: on a schema miss SOLELY (`schemaInvalid`/return-schema
   * breach), re-prompt the node up to N times in the STILL-ALIVE sandbox from {previousOutput, ajvErrors,
   * schema} BEFORE spending a full `retry`/`escalate` re-run (a repair is NOT a retry). Default 0 ⇒ a
   * schema miss SKIPS the repair lane and falls straight through to retry/escalate.
   */
  maxRepairAttempts?: number;
}

/**
 * (G12 — M4) The DERIVED failure class — an EMPIRICAL taxonomy over signals the runner already computes
 * (artifact stat, schema gate, integrity checks, watchdog kills, stderr, return parse). NEVER a model
 * self-score. `infra` = transient noise (rate-limit/ECONN) → a same-model retry; `degenerate` = no
 * parseable return → retry once then escalate; `schema` = a malformed-but-present output → the G8
 * in-sandbox repair lane first; `quality-gap`/`contract` = a real capability/contract breach → escalate;
 * `halt` = a missing upstream input escalation cannot manufacture (refuse to spin).
 */
export type FailureClass = 'infra' | 'degenerate' | 'schema' | 'quality-gap' | 'contract' | 'halt';

/** (G12 — M4 · #6) The bounded re-run spec — `max` extra attempts, filtered by failure class. */
export interface RetrySpec {
  /** ADDITIONAL attempts after the first (≥0). */
  max: number;
  /** Only retry when the derived class is in this set. Undefined ⇒ every non-halt class. */
  on?: FailureClass[];
}

/** (G12 — M4 · #4) Escalate-with-evidence — re-run on a stronger model fed the verified failure facts. */
export interface EscalateSpec {
  /** Escalate AFTER this many same-model attempts (default: after the retry budget is spent). */
  after?: number;
  /** The stronger model id (resolves through model-routing.ts; wins over `tier`). */
  model?: string;
  /** A tier alias (`~/.piflow/model-tiers.json`) the stronger target resolves through. */
  tier?: string;
  /** Only escalate when the derived class is in this set. Undefined ⇒ every escalable class. */
  on?: FailureClass[];
}

// 3 ── HOOK (deterministic; never an LLM) ──────────────────────────────────────

/** When a hook fires relative to its node's outcome. */
export type HookWhen = 'always' | 'on-success' | 'on-failure';

/** Context handed to an in-process hook fn (declared paths only — sandbox internals stay out). */
export interface HookContext {
  /** The `${WORKSPACE}` logical root — where the node's code/build runs. */
  workspace: string;
  /**
   * The `${RUN}` logical root — the per-run OUTPUT base (an opaque dir; the runner passes it). Core
   * NEVER hardcodes the consumer's `.piflow/<wf>/runs/<id>/` convention. OPTIONAL; `runHooks`
   * defaults it to `workspace` when the caller omits it.
   */
  projectBase?: string;
  inputs: string[];
  outputs: string[];
}

// 3.5 ── RUN STATE (D6) + the per-node I/O ledger (D7) ──────────────────────────

/**
 * The per-thread RunState — a LangGraph-style channel object. Each top-level key is a channel; values
 * are arbitrary. The node NEVER writes this directly — the driver merges a node's promoted update via
 * the channel's reducer at the stage barrier (`${RUN}/.pi/state.json` is the per-run checkpoint).
 */
export type RunState = Record<string, unknown>;

/**
 * Per-channel merge reducer. `set` = overwrite (DEFAULT, last-write); `append` = list concat (operands
 * coerced to arrays); `deepMerge` = recursive plain-object merge (arrays REPLACE — treated as leaves).
 */
export type Reducer = 'set' | 'append' | 'deepMerge';

/** The per-node I/O ledger record (`${RUN}/.pi/nodes/<id>/io.json`) — uniform across every project. */
export interface NodeIo {
  id: string;
  label?: string;
  phase?: string;
  /** Inputs the node read (resolved paths), each optionally tagged with HOW it was sourced. */
  reads: { path: string; via?: string }[];
  /** Outputs the node wrote — `verified` is the on-disk existence check; `bytes` the size. */
  writes: { path: string; verified: boolean; bytes?: number }[];
  /** RunState channels this node promoted into, with the merged value + the reducer used. */
  promotes: { to: string; merge: string; value: unknown }[];
  status: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
}

/**
 * Deterministic plumbing on a node boundary (pre: stage inputs · post: transform/merge/validate
 * outputs). A hook DECLARES its inputs/outputs, so the declaration is both the DAG edge and the
 * resume key. If a candidate hook needs a model, promote it to a pi node instead.
 */
export interface Hook {
  id: string;
  phase: 'pre' | 'post';
  /** Files READ (pre: gates · post: the node's artifacts). */
  inputs: string[];
  /** Files WRITTEN (pre: feed the node · post: derived). */
  outputs: string[];
  /** Explicit firing condition (dbt's implicit "post on success only" is a known foot-gun). */
  when: HookWhen;
  /** A shell command, or an in-process function. */
  run: string | ((ctx: HookContext) => Promise<void>);
  /** When true (default), skip if outputs are fresh vs inputs (stat/hash). */
  idempotent?: boolean;
  /** When true, run even on a reused/skipped node (dbt execute_hooks_on_any_reuse). Default false. */
  runOnReuse?: boolean;
  /** Whether a failing hook blocks (default 'block') or only warns. */
  failure?: 'block' | 'warn';
  /** Per-hook wall-clock cap. */
  timeoutMs?: number;
}

// ── SANDBOX PROVIDER (horizontal seam — one impl per backend) ─────────────────

/** Options to stand up a sandbox for one node run. */
export interface CreateOpts {
  readScope: string[];
  /**
   * Declared WRITE roots (= the node's `owns`/`contract.owns`). On darwin the same `enforceReadScope`
   * posture that bounds reads bounds writes to {workdir, writeScope, toolchain scratch}; a write outside
   * EPERMs (kernel-enforced, inherited by every child). Omitted/empty ⇒ writes confined to the workdir +
   * toolchain scratch only. `enforceReadScope:false` (danger-full-access) disables BOTH read and write jails.
   */
  writeScope?: string[];
  outputDir: string;
  workdir: string;
  image?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** Result of a buffered command execution. Combined-output backends fill `stdout` and leave `stderr` ''. */
export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Options for a single command execution. */
export interface ExecOpts {
  cwd?: string;
  env?: Record<string, string>;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /**
   * Cancellation. When this aborts, the provider MUST terminate the command and any process group it
   * spawned (SIGTERM→SIGKILL) — the runner's watchdog drives this on a node-timeout/stall. A provider
   * that ignores it falls back to the runner's liveness timer (which can orphan the child).
   */
  signal?: AbortSignal;
}

/** A handle to a background process (only on providers that implement `spawn`). */
export interface ProcessHandle {
  pid: number;
  wait(): Promise<ExecResult>;
  kill(signal?: string): void;
}

/** A live sandbox for one node run. The lifecycle is create → stage → exec → collect → dispose. */
export interface Sandbox {
  /** Stage files into the sandbox (read-scope inputs + pre-hook seeds). */
  putFiles(files: { path: string; data: Uint8Array | string }[]): Promise<void>;
  /** Write a single file into the sandbox. */
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  /** Run a command, buffering output (and optionally streaming via opts). */
  exec(cmd: string, opts?: ExecOpts): Promise<ExecResult>;
  /** Start a background process. Optional — background support is uneven across backends. */
  spawn?(cmd: string, opts?: ExecOpts): Promise<ProcessHandle>;
  /** Read a single file back out. */
  readFile(path: string, opts?: { encoding?: 'utf8' }): Promise<Uint8Array | string>;
  /** Copy an output directory back to the host (the portable collection contract). */
  downloadDir(remote: string, local: string): Promise<void>;
  /** Tear the sandbox down. */
  dispose(): Promise<void>;
}

/**
 * Run-level context for a provider that shares ONE backing resource across all of a run's nodes
 * (a git worktree, a cloud VM). The per-node `CreateOpts` carries no run identity; this supplies it.
 * `run` names the branch/dir/VM label, `repoRoot` is the base checkout the resource is seeded from.
 * (Historically `repoRoot` was also the anchor for a `BASE_ROOT→worktree` prompt-path text-rewrite; that
 * string-regex re-rooting is RETIRED by the U7 logical-root resolver — a `{{RUN}}`/`{{WORKSPACE}}`-rooted
 * reference is relocation-invariant by construction, so a provider only resolves the two roots, never
 * rewrites prompts. See `workflow/resolver.ts`.)
 */
export interface OpenRunOpts {
  /** Stable run id — names branch `pi/<run>`, `.pi-worktrees/<run>`, or the cloud VM label. */
  run: string;
  /** Base checkout root: the sibling-worktree path source + the prompt-rewrite anchor. */
  repoRoot: string;
  /** Host run dir (the filesystem-as-contract namespace) — where run-level collection lands. */
  outDir: string;
}

/**
 * A run-scoped sandbox lifecycle — the seam the per-node `create→dispose` could not express (a
 * worktree/VM spans ALL of a run's nodes, but a provider makes one Sandbox per node). `openRun`
 * returns one: the runner makes every node's sandbox via `create` (INSIDE the shared resource) and
 * tears the whole resource down ONCE via `dispose` after the last node.
 */
export interface RunScope {
  /** Effective execution root for this run (worktree path / VM mount; `repoRoot` for the local scope). */
  readonly root: string;
  /** Make one node's sandbox inside the run resource (same contract as `SandboxProvider.create`). */
  create(opts: CreateOpts): Promise<Sandbox>;
  /** Run-level teardown — commit+copy-back (worktree) / collect+destroy (cloud). Best-effort. */
  dispose(): Promise<void>;
}

/** A backend that can create sandboxes (inmemory/seatbelt/worktree/daytona/e2b). */
export interface SandboxProvider {
  /** The kind this provider implements (matches `SandboxSpec.provider`). */
  readonly kind: SandboxProviderKind;
  create(opts: CreateOpts): Promise<Sandbox>;
  /**
   * Optional run-level lifecycle. Providers that share ONE resource across a run (worktree/cloud)
   * implement this: open the resource and return a `RunScope` whose `create` makes per-node sandboxes
   * inside it and whose `dispose` tears it down once. Providers with no shared resource
   * (inmemory/seatbelt) OMIT it — the runner falls back to a trivial scope that forwards `create` and
   * leaves per-node `dispose` as the only teardown, so their runs stay byte-identical.
   */
  openRun?(opts: OpenRunOpts): Promise<RunScope>;
}

// ── SECRET RESOLVER (horizontal seam — scoped-token / sealing broker) ─────────

/**
 * Resolves a referenced secret var to the value injected into a node's env — the seam where a host
 * plugs a scoped-token / sealing broker so a cloud VM gets a short-lived scoped token, NOT the raw
 * long-lived credential. Called once per referenced $VAR per node. Default reads process.env.
 *
 * The refinement this exists for: NEVER put a Bearer for a long-lived credential into a cloud
 * microVM. A host mints a SHORT-LIVED, SCOPED reference HOST-SIDE (a sealing/egress broker) and
 * returns THAT here; the runner injects it as the env value and the bridge expands `$VAR` to it
 * exactly as today — so the real key never crosses into the VM. (A sealing/egress proxy that swaps
 * the scoped reference for the real credential at the gateway is the alternative the same seam
 * supports.) `ctx.isCloud` lets a resolver mint only on a cloud backend and pass the raw value
 * through locally.
 */
export type SecretResolver = (
  varName: string,
  ctx: { nodeId: string; isCloud: boolean },
) => string | undefined | Promise<string | undefined>;

/** The default resolver — preserves today's behavior: read the raw value straight from `process.env`. */
export const defaultSecretResolver: SecretResolver = (name) => process.env[name];

// ── ESCALATOR (horizontal seam — notify binding) ─────────────────────────────
// G12 — M4. The host seam where a model-free `notify` action binds to a real channel (Slack/email/…).
// Mirrors `SecretResolver`: core owns the action VOCABULARY (the `channel` key + payload paths), the host
// owns the BINDING — no product noun (no Slack URL, no channel name) ever lives in core. Default: a no-op
// that warns, so an authored `notify` never crashes a run on a host that wired no escalator.

/** A user-facing notification fired by a `notify` action: a host-seam channel key + the gathered facts. */
export interface EscalationNotice {
  /** The node that failed/notified. */
  nodeId: string;
  /** The host-seam channel key the host maps to a real destination (e.g. 'ops-alerts'). */
  channel: string;
  /** A short human summary of why it fired. */
  summary: string;
  /** The verified evidence (issue lines / artifact paths) — never a model self-score. */
  evidence?: string[];
}

/** The notify host seam. Called when a `notify` action fires. Omit ⇒ `defaultEscalator` (warn → console). */
export type Escalator = (notice: EscalationNotice) => void | Promise<void>;

/** The default escalator — preserves a no-op host: warn to console so a notify is visible but never fatal. */
export const defaultEscalator: Escalator = (notice) => {
  console.warn(`[notify:${notice.channel}] ${notice.nodeId} — ${notice.summary}`);
};

// ── TOOL REGISTRY (horizontal seam — the searchable catalog) ──────────────────

/**
 * Where a tool comes from. `builtin` is native pi (on `--tools`, no extension). `sdk`/`mcp` are
 * third-party tools bound through a generated `-e` extension (execute routes to a plugin/the bridge).
 * `contract` is a FIRST-PARTY SDK tool with its OWN inline execute (e.g. `submit_result`, the typed
 * terminating return tool) — bound by bare name like a builtin, but NOT pi-native, so it ships in the
 * generated `-e` extension with its real execute baked in (no bridge, no external plugin).
 */
export type ToolSource = 'builtin' | 'sdk' | 'mcp' | 'contract';

/** One catalog entry. `address` is SDK-facing (`ns:name`); `piName` is the bare name pi sees. */
export interface ToolEntry {
  /** SDK-facing id, `namespace:name`. */
  address: string;
  source: ToolSource;
  /** The bare name pi actually sees (conflict-guarded; sdk/mcp get a prefix). */
  piName: string;
  /** Human description, used for search/discovery. */
  description: string;
  /** Free-form tags for filtering/search. */
  tags?: string[];
  /** TypeBox parameter schema (sdk/mcp tools). Use StringEnum (not Type.Union) for enums. */
  parameters?: unknown;
  /** Provenance for the borrow story (native pi / OpenClaw plugin / MCP server). */
  origin?: { kind: 'native' | 'openclaw-plugin' | 'mcp-server'; ref?: string };
}

/** The result of resolving a node's ToolSelection against the registry. */
export interface ResolveResult {
  /** Bare names for `pi --tools`. */
  piTools: string[];
  /**
   * Generated `-e` extension SOURCE that binds the selected sdk/mcp tools (each `registerTool`'d).
   * The runner stages it to a file and passes that path to `pi -e`. Undefined when only builtins
   * are selected (pi exposes those natively, so no extension is needed).
   */
  extension?: string;
  /**
   * Bare names pi should EXCLUDE — derived from the selection's deny list (the command builder emits
   * these as `--exclude-tools`). Undefined/absent when nothing is denied.
   */
  excludeTools?: string[];
}

/**
 * Optional, ENV-FREE knobs the command builder accepts as a 4th argument — the consumer (the runner)
 * maps env/config → these, so the builder itself reads no `process.env`. Omitted ⇒ today's 3-arg
 * behavior, byte-identical.
 */
export interface PiCommandOptions {
  /** Reasoning-depth cap → `pi --thinking <v>`. Emitted only when truthy (a level string, or `true`). */
  thinking?: string | boolean;
  /** Extra `-e <path>` extensions, emitted BEFORE `ctx.extensionFile` (order is load-bearing). */
  extraExtensions?: string[];
}

/** The catalog: register tools, resolve a selection to pi flags, search, and enumerate. */
export interface ToolRegistry {
  register(entry: ToolEntry): void;
  resolve(sel: ToolSelection): ResolveResult;
  search(query: string, opts?: { source?: ToolSource; limit?: number }): ToolEntry[];
  /** All registered entries — the catalog the bind pre-check enumerates (discovery/debugging too). */
  list(): ToolEntry[];
}

// ── SA-C · AgentBase (expert-representations, decision 8) ────────────────────
//
// ONE schema for both presets and nodes (build-spec.md §"Final surfaces", decision 8).
//   • A PRESET is a partial fill: loadout (skills/tools) + display + optional default tier.
//     Sandbox and op[] are NEVER baked into a preset — they are workflow-level.
//   • A NODE is the full fill: + sandbox + op[] (the gate pipeline).
//
// `AgentBase` extends `AgentPreset`'s shape WITHOUT breaking the 6 existing presets — every preset
// field maps directly; the new fields (sandbox, op) are optional so an AgentPreset is a valid
// partial AgentBase. The compiler (`workflow/agent-base.ts`) wires SA-A skills + SA-B gates onto it.

/**
 * The unified agent description (SA-C · expert-representations). All fields optional/defaulted.
 *
 * - **Preset** = partial fill: `id`, `display?`, `skills?`, `tools?`, `tier?`, `prompt?`.
 *   Sandbox and `op` are LEFT EMPTY on a preset — they are workflow-level, not agent-level.
 * - **Node** = full fill: + `sandbox?` + `op?` (the gate pipeline, lowered by SA-B's `lowerGates`).
 *
 * Invariant: `tier` is a semantic CLASS key (resolved through `~/.piflow/model-tiers.json`);
 * NEVER a concrete model id. The three canonical tiers are 'fast' | 'balanced' | 'deep'.
 */
export interface AgentBase {
  /** Stable id — the preset's catalog key or the node's authored id. */
  id: string;
  /** Branding: surfaced by observe → GUI for the icon / label / color chip. */
  display?: { label?: string; icon?: string; color?: string };
  /** Skill loadout — the skill ids this agent runs with. */
  skills?: string[];
  /** Extra raw tool selection beyond what the skills' `requires` auto-wire. */
  tools?: ToolSelection;
  /**
   * Model CLASS (tier key) — NEVER a concrete model id. Resolved at run time through
   * `~/.piflow/model-tiers.json` via `resolveNodeModel`. The three canonical keys:
   * `'fast'` | `'balanced'` | `'deep'`. A preset sets a DEFAULT; a node's own `tier`/`model` wins.
   */
  tier?: string;
  /** The canonical role-prompt body. A node's task is appended after (ROLE first, TASK after). */
  prompt?: string;
  // ── workflow-level (PRESET: leave empty; NODE: fill in) ──
  /**
   * Where the node runs. Workflow-level — NEVER baked into a preset (portability).
   * Partial: the loader fills in provider/workspace/output defaults.
   */
  sandbox?: Partial<SandboxSpec>;
  /**
   * The gate pipeline (lowered by SA-B's `lowerGates`). Workflow-level — NEVER on a preset.
   * Each entry is a post-node op: floor checks, execution gates, judge reroutes, etc.
   */
  op?: OpSpec[];
}

// ── L1∩L2 BOUNDARY: the flat node bag the design agent fills ──────────────────

/**
 * (Phase 2) A node's FUSION activation (template `node.json` `fusion`, spec §4). This lives ONLY on the
 * authoring/intent layer: `expandFusion(spec)` consumes it BEFORE `compile`, rewriting the activated node
 * into a JUDGE and spawning N sibling producers — so by the time a node is materialized into a dense
 * `NodeSpec`, no `fusion` remains (which is why `NodeSpec` carries no `fusion` field). Each param resolves
 * `node.fusion.<param>` > `~/.piflow/fusion.json` > a built-in default.
 */
export interface FusionSpec {
  /** moa = mixture-of-agents (a panel of models → SYNTHESIZE one answer); best-of-n = one model sampled N times → SELECT. */
  mode: 'moa' | 'best-of-n';
  /** best-of-n: how many sibling samples. Omitted ⇒ default 3. (moa derives its count from `panel`.) */
  n?: number;
  /** moa: one sibling per entry — a model id or tier alias. Present ⇒ overrides `n`. */
  panel?: string[];
  /** The judge's model/tier. Omitted ⇒ the activated node's own resolved model. */
  judge?: string;
  /** Derive a coverage checklist in a pre-node the panel + judge consume (ported from pi-fusion). Default false. */
  obligations?: boolean;
  /** The judge runs a verify→revise loop (quality). false ⇒ a single pass (fast). Default true. */
  verify?: boolean;
}

/**
 * (G12 — M3) A node's bounded conditional REROUTE / self-fix activation (template `node.json` `reroute`,
 * design §3-control). Lives ONLY on the authoring/intent layer: `expandReroute(spec)` consumes it BEFORE
 * `compile`, cloning the path slice `[onFail … V]` into namespaced forward-only stages (`V__r{i}`) bounded
 * by `max` total attempts — so the QA loop is UNROLLED at compile time and `checkCycles`/`stagesOf` accept
 * an acyclic DAG (never a runtime back-edge). By the time a node is materialized into a dense `NodeSpec`,
 * no `reroute` remains (the `fusion?` precedent — `NodeSpec` carries no `reroute` field).
 */
export interface RerouteSpec {
  /** The upstream node (label or id) to re-enter on a FAIL. MUST be an ancestor of this node, else RerouteConfigError. */
  onFail: string;
  /** Total attempts (≥1): attempt 1 is the original; attempts 2..max are the cloned re-entries. `< 1` ⇒ RerouteConfigError. */
  max: number;
  /** Prior-attempt artifacts the re-entry clone READS (its failure evidence) + folds into the fix-prefix. Optional. */
  evidence?: string[];
  /** The final clone's consequence — `'block'` (default) or its documented alias `'stop'` (design §2.4). */
  onFailure?: 'block' | 'stop';
}

/**
 * (G12 — M3) The runner-facing marker on a GENERATED reroute GATE node — the zero-pi existence-gate
 * preflight (#17). `expandReroute` emits it; the runner's `runRerouteGate` consumes it: it stat()s
 * `artifact` (the prior attempt's canonical verify output) and, when present (the prior attempt PASSED),
 * SHORT-CIRCUITS — it finishes the gate `ok` WITHOUT spawning pi, COPIES the passing artifact forward to
 * each `copyTo` dest (so the next downstream node has its input), and marks every `skip` body id `reused`
 * so the cloned re-entry NEVER spawns. Carried verbatim onto the dense `NodeSpec` (the `checkpoint?`
 * precedent — a no-pi node-kind the runner specially handles). Additive: a node with no `rerouteGate`
 * runs exactly as before.
 */
export interface RerouteGate {
  /** The prior attempt's canonical verify artifact; its presence ⇒ the prior attempt PASSED ⇒ short-circuit. */
  artifact: string;
  /** On a pass, COPY the passing artifact forward to these dests (the next downstream reads them). */
  copyTo: string[];
  /** Body node ids to mark `reused` (skip-without-spawn) when the prior attempt passed. */
  skip: string[];
}

/**
 * (G9) A node's SUBWORKFLOW activation (template `node.json` `subworkflow`). Like `fusion`, it lives ONLY
 * on the authoring/intent layer: `expandSubworkflow(spec)` consumes it BEFORE `compile` (and BEFORE
 * `expandFusion`), REPLACING the activated node X with the referenced sub-template's nodes — id-namespaced
 * under X, X's upstream deps inherited by the child entry nodes, and every parent dep on X rewired to the
 * child's terminal node(s). So by the time a node is materialized into a dense `NodeSpec`, no `subworkflow`
 * remains (which is why `NodeSpec` carries no `subworkflow` field). Mirrors the fusion expansion precedent.
 */
export interface SubworkflowSpec {
  /** The sub-template to inline — a path (node-relative) or a catalog name, resolved by the injected loader. */
  ref: string;
  /**
   * RESERVED (not yet wired): parent→child input wiring `{ childExternalInput: parentArtifactPath }`. Until
   * implemented, the parent + child coordinate by the existing `{{RUN}}`-relative path convention (the child
   * terminal writes the path the parent expects). A later increment rewrites paths from this map.
   */
  inputs?: Record<string, string>;
  /** RESERVED (not yet wired): child→parent output wiring `{ parentArtifact: childArtifactPath }`. See `inputs`. */
  outputs?: Record<string, string>;
}

/**
 * The AUTHORED subset of a node — what the COMPOSE agent fills. Mechanics (id, edges, stage/lane,
 * sandbox profile, provider/workspace defaults) are SDK-filled by `compile`. `phase` is generic node
 * metadata (a display label, §5) carried through so a PROFILE predicate can select nodes by it — it
 * NEVER drives ordering/parallelism (deps + owns do).
 */
export type NodeIntent = Pick<NodeSpec, 'label' | 'prompt' | 'skill' | 'agentType' | 'tools' | 'model' | 'provider' | 'tier'> & {
  io: NodeIO;
  /** Generic phase label (display metadata; the elision predicate may select by it). Optional/additive. */
  phase?: string;
  sandbox?: Partial<SandboxSpec>;
  hooks?: NodeSpec['hooks'];
  /**
   * (G13 — M5) The unified op envelope — the loader LOWERS the deprecated `hooks`/`ops`/`checks`/`policy`/
   * `inject` aliases into this one ordered list and carries it verbatim onto the dense `NodeSpec`. Authoring
   * may also declare `op` directly. Additive — a node with none behaves exactly as before.
   */
  op?: NodeSpec['op'];
  /** (G5) A human checkpoint on this node — carried verbatim onto the dense NodeSpec. */
  checkpoint?: NodeSpec['checkpoint'];
  /** (G12 — M3) A generated reroute existence-gate marker — carried verbatim onto the dense NodeSpec. */
  rerouteGate?: NodeSpec['rerouteGate'];
  /** (PROGRAMMATIC NODE) Marks this node no-pi: it runs its declarative ops deterministically, spawning no `pi`. */
  programmatic?: NodeSpec['programmatic'];
  /** (Phase 2) Fusion activation — consumed by `expandFusion` BEFORE compile; never reaches the dense NodeSpec. */
  fusion?: FusionSpec;
  /**
   * (G12 — M3) Bounded conditional REROUTE / self-fix on a verify node: on a FAIL, re-enter the upstream
   * `onFail` node up to `max` total attempts. Lives ONLY on the authoring/intent layer — `expandReroute`
   * consumes it BEFORE `compile`, UNROLLING the bounded loop into forward-only acyclic clones (the
   * `fusion?` precedent: never reaches the dense `NodeSpec`, so no runtime back-edge / cycle). A reroute
   * to a non-ancestor target, or `max < 1`, is a loud `RerouteConfigError`.
   */
  reroute?: RerouteSpec;
  /**
   * (G11) Per-node external MCP gateway config (the authored `node.json.mcp`). Lives ONLY on the
   * authoring/intent layer: `assembleRunTools` reads `mcp.servers` off the spec to assemble the run's
   * merged `mcpConfig` and the runner stages it into a bridge-tool node's `_pi/mcp.json`. It never reaches
   * the dense `NodeSpec` (the `fusion?`/`checkpoint?` precedent). Secret-bearing values carry `$VAR` refs.
   */
  mcp?: { servers?: Record<string, unknown>; ref?: string };
  /** (G9) Subworkflow activation — consumed by `expandSubworkflow` BEFORE compile/fusion; never reaches the dense NodeSpec. */
  subworkflow?: SubworkflowSpec;
};

/**
 * A named RUN PROFILE — a GENERIC node-ELISION predicate over node metadata. The SDK applies it
 * VERBATIM (it carries NO product vocabulary — a "phase" is generic metadata, never "verify"). A profile
 * with no predicate keys (`{}`) elides nothing (the full DAG). Designed to grow: add `elideTags`/etc.
 * later WITHOUT breaking the empty-object = no-op contract.
 */
export interface ProfileSpec {
  /** Elide every node whose `phase` is in this list (then transitively bypass it in dependents' deps). */
  elidePhases?: string[];
}

/**
 * A flat bag of nodes — NO edges. `compile` derives the DAG from each node's `io`. `profiles` +
 * `defaultProfile` are OPTIONAL/additive product-declared run modes (DATA): a run resolves an active
 * profile NAME to a `ProfileSpec` predicate and elides the matched nodes before compiling. Absent ⇒ the
 * full DAG, always.
 */
export interface WorkflowSpec {
  meta: { name: string; description: string };
  nodes: NodeIntent[];
  /** Named run profiles (product vocab lives HERE, as data — never in core logic). Optional. */
  profiles?: Record<string, ProfileSpec>;
  /** The profile applied when none is named on the run. Absent ⇒ no elision (the full DAG). */
  defaultProfile?: string;
}

// ── COMPILED DAG (what the runner + viz consume) ──────────────────────────────

/** A topological stage: one or more nodes that can run together. */
export interface Stage {
  index: number;
  phase: string | null;
  parallel: boolean;
  nodeIds: string[];
}

/** A data-flow edge: `from` produces files that `to` reads. */
export interface Edge {
  from: string;
  to: string;
  files: string[];
}

/** The compiled, executable DAG: dense nodes + inferred edges + topological stages. */
export interface Workflow {
  meta: WorkflowSpec['meta'];
  nodes: Record<string, NodeSpec>;
  stages: Stage[];
  edges: Edge[];
}
