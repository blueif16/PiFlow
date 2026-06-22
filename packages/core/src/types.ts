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

  // WORK — intelligence about the task (authored).
  /** The realized wave prompt — recorded by `extract` (human front-end) or emitted by COMPOSE. */
  prompt: string;
  /** Skill to load and follow, if any. */
  skill?: string;
  /** Optional agent-type hint (for a custom sub-agent system prompt). */
  agentType?: string;

  /** 1. Where it runs. */
  sandbox: SandboxSpec;
  /** 2. What it can call. */
  tools: ToolSelection;
  /** 3. Deterministic pre/post plumbing (never an LLM). */
  hooks?: { pre?: Hook[]; post?: Hook[] };
  /** 4. The filesystem contract — and the source of the inferred DAG edges. */
  io: NodeIO;
}

// 1 ── SANDBOX ────────────────────────────────────────────────────────────────

/** Which execution backend a node runs in. New backends extend this union + add a SandboxProvider. */
export type SandboxProviderKind = 'inmemory' | 'seatbelt' | 'worktree' | 'daytona' | 'e2b';

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

/** What a non-pass verdict DOES to the node. (`retry-once`/`subagent-fix` are reserved; treated as block.) */
export type PolicyAction = 'block' | 'warn' | 'stop';

/** Verdict→action map (consequence). Default: fail→block, warn→warn. Keyed by the non-pass verdicts. */
export type Policy = Partial<Record<Exclude<Verdict, 'pass'>, PolicyAction>>;

/** Whether the node's fenced-JSON return handshake is required or advisory. */
export type ReturnMode = 'optional' | 'required';

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
  /** Verdict→action policy for failed checks (consequence). Undefined ⇒ the default (fail→block). */
  policy?: Policy;
  /** Return-handshake mode. Default: 'optional' when `artifacts` is non-empty, else 'required'. */
  returnMode?: ReturnMode;
  /**
   * A sentinel string (e.g. `<FILL:`) that, if STILL present in a required artifact, marks it
   * incomplete — the engine adds an auto `regex-absent` completeness check per artifact. Undefined ⇒ off.
   */
  fillSentinel?: string;
}

// 3 ── HOOK (deterministic; never an LLM) ──────────────────────────────────────

/** When a hook fires relative to its node's outcome. */
export type HookWhen = 'always' | 'on-success' | 'on-failure';

/** Context handed to an in-process hook fn (declared paths only — sandbox internals stay out). */
export interface HookContext {
  workspace: string;
  inputs: string[];
  outputs: string[];
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
 * `run` names the branch/dir/VM label, `repoRoot` is the base checkout the resource is seeded from
 * AND the anchor a worktree provider rewrites node-prompt paths against (`BASE_ROOT→worktree`).
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

// ── TOOL REGISTRY (horizontal seam — the searchable catalog) ──────────────────

/** Where a tool comes from. `builtin` is native pi; `sdk`/`mcp` need a generated `-e` extension. */
export type ToolSource = 'builtin' | 'sdk' | 'mcp';

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
}

/** The catalog: register tools, resolve a selection to pi flags, search, and enumerate. */
export interface ToolRegistry {
  register(entry: ToolEntry): void;
  resolve(sel: ToolSelection): ResolveResult;
  search(query: string, opts?: { source?: ToolSource; limit?: number }): ToolEntry[];
  /** All registered entries — the catalog the bind pre-check enumerates (discovery/debugging too). */
  list(): ToolEntry[];
}

// ── L1∩L2 BOUNDARY: the flat node bag the design agent fills ──────────────────

/**
 * The AUTHORED subset of a node — what the COMPOSE agent fills. Mechanics (id, edges, stage/lane,
 * sandbox profile, provider/workspace defaults) are SDK-filled by `compile`.
 */
export type NodeIntent = Pick<NodeSpec, 'label' | 'prompt' | 'skill' | 'agentType' | 'tools'> & {
  io: NodeIO;
  sandbox?: Partial<SandboxSpec>;
  hooks?: NodeSpec['hooks'];
};

/** A flat bag of nodes — NO edges. `compile` derives the DAG from each node's `io`. */
export interface WorkflowSpec {
  meta: { name: string; description: string };
  nodes: NodeIntent[];
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
