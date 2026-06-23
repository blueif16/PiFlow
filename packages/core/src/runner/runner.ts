// The runner — M1's execution loop. Takes a compiled `Workflow` and runs each node through the
// `SandboxProvider` lifecycle (create → stage inputs → exec the agent command → collect+verify
// artifacts → run hooks → dispose), stage-by-stage with parallel lanes within a stage, writing
// `run-status.json`. A faithful PORT of templates/pi-runner/run.mjs onto the typed @piflow/core spine.
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
} from '../types.js';
import { defaultSecretResolver } from '../types.js';
import { DefaultToolRegistry } from '../tools/registry.js';
import { verifyToolBinding } from '../tools/verify.js';
import { InMemorySandboxProvider } from '../sandbox/index.js';
import { markersFromNode, emitMarkers } from '../contract.js';
import { effectiveChecks, evaluateChecks, actionForVerdict, type FileBytes } from '../checks.js';
import { validateArtifactSchemas, defaultSchemaValidator, type SchemaValidator } from './schema.js';
import { runHooks } from '../hooks/index.js';
import { NodeRecorder, recordingSandbox, type EventSink } from './events.js';
import { defaultPiCommand, type CommandBuilder } from './command.js';
import {
  type RunStatus,
  type NodeStatusRecord,
  type ArtifactState,
  nowISO,
  writeStatus,
  artifactState,
} from './status.js';

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
  /** Host-side run dir — the filesystem-as-contract namespace across sandboxes. Default `out/<run>`. */
  outDir?: string;
  /** Base checkout root for a run-scoped provider (worktree-path source / prompt-rewrite anchor). Default cwd. */
  repoRoot?: string;
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
  /** Per-node hard wall-clock cap (ms). Default 1_800_000 (30 min, matching run.mjs). */
  nodeTimeoutMs?: number;
  /** Silent-stall kill threshold (ms); 0 disables. Default 0 (off; the in-memory baseline is fast). */
  stallMs?: number;
  /** ms after SIGTERM before SIGKILL. Default 3000 (run.mjs 904–911). */
  killGraceMs?: number;
  /** Resume window: run from the first stage whose phase/label/id contains this (inclusive). */
  from?: string;
  /** Resume window: run up to the last stage whose phase/label/id contains this (inclusive). */
  until?: string;
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
   * Capture each node's agent stdout (the `pi --mode json` stream) to `<outDir>/_pi/<id>.events.jsonl`
   * — the observability backbone `./logs.ts` tails (`docker logs` for a run). Default `true`; the
   * archive is slimmed + lazy (a node that emits nothing leaves no file). Set `false` to disable.
   */
  recordEvents?: boolean;
  /**
   * Live event sink — called with `(nodeId, slimmedEvent)` as each event is parsed, the push seam a
   * TUI/GUI subscribes to (the file archive is always written regardless). Never breaks the run if it throws.
   */
  onEvent?: EventSink;
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

// ── forgiving return-parse (run.mjs lastJsonBlock 670–698) ────────────────────────────────────────

interface NodeReturn { status?: string; summary?: string; issues?: string[] }

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

// ── the per-node lifecycle ────────────────────────────────────────────────────────────────────────

interface RunContext {
  wf: Workflow;
  outDir: string;
  registry: ToolRegistry;
  buildCommand: CommandBuilder;
  execRunner: ExecRunner;
  providerName: string;
  model?: string;
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
 * Run ONE node through the full lifecycle. Returns its terminal record (already in ctx.status.nodes).
 *
 * create → stage io.reads (from the host run dir) + write the prompt file → PRE hooks → exec the
 * built command under the watchdog → downloadDir(output)→host → verify io.artifacts by host-stat →
 * POST hooks → dispose → write status.
 */
async function runNode(ctx: RunContext, node: NodeSpec, scope: RunScope): Promise<NodeStatusRecord> {
  const rec = ctx.status.nodes[node.id];
  rec.status = 'running';
  rec.startedAt = nowISO();
  const t0 = Date.now();
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
  const MCP_CONFIG_FILE = '_pi/mcp.json';
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
      CLOUD_KINDS.has(ctx.providerKind),
      node.id,
      ctx.secretResolver ?? defaultSecretResolver,
    );
  }

  let sandbox: Sandbox;
  try {
    sandbox = await scope.create({
      readScope: node.sandbox.read,
      outputDir: node.sandbox.output,
      workdir: node.sandbox.workspace,
      image: node.sandbox.image,
      // Merge the MCP env additions over the node's declared env (so PIFLOW_MCP_CONFIG + the referenced
      // secrets land in the child via the provider's exec merge). Undefined ⇒ node env unchanged.
      env: mcpEnv ? { ...node.sandbox.env, ...mcpEnv } : node.sandbox.env,
      timeoutMs: node.sandbox.timeoutMs,
    });
  } catch (e) {
    return finishNode(ctx, node, rec, t0, 'error', `sandbox create failed: ${(e as Error).message}`, []);
  }

  try {
    // STAGE io.reads from the host run dir INTO the sandbox at the same relative path (filesystem-as-
    // contract across sandboxes). A missing read is left to the node's own contract check downstream.
    for (const rel of node.io.reads) {
      const data = await readHostFile(ctx, rel);
      if (data) await sandbox.writeFile(rel, data);
    }

    // The prompt carries the machine-readable contract markers (artifacts/owns/read-scope/tools) so a
    // future node-contract extension can self-gate; we append them exactly as run.mjs does.
    const markers = emitMarkers(markersFromNode(node, resolved));
    const promptFile = '_pi/prompt.md';
    await sandbox.writeFile(promptFile, node.prompt + (markers ? `\n\n${markers}` : ''));

    // Stage the generated tool `-e` extension (binds the node's declared sdk/mcp tools) and pass its
    // in-sandbox path to the command builder. Absent when the node selected only builtins.
    let extensionFile: string | undefined;
    if (resolved.extension) {
      extensionFile = '_pi/tools.ts';
      await sandbox.writeFile(extensionFile, resolved.extension);
    }

    // Stage the node's MCP server map VERBATIM (only for MCP-tool nodes with a run-level mcpConfig). It
    // carries `$VAR` refs, never literal secrets — the bridge expands them in-child against PIFLOW_MCP_CONFIG
    // + the referenced env vars injected at create above. A node with no MCP tools writes NO `_pi/mcp.json`.
    if (stageMcp && ctx.mcpConfig) {
      await sandbox.writeFile(MCP_CONFIG_FILE, JSON.stringify(ctx.mcpConfig));
    }

    // PRE hooks (deterministic plumbing — stage inputs / seeds). A blocking failure throws → error.
    const hookCtx = { workspace: node.sandbox.workspace, inputs: node.io.reads, outputs: node.io.produces };
    try {
      await runHooks(node.hooks?.pre, hookCtx, { outcome: 'success' });
    } catch (e) {
      return finishNode(ctx, node, rec, t0, 'error', `pre-hook failed: ${(e as Error).message}`, []);
    }

    const cmd = ctx.buildCommand(node, resolved, { promptFile, model: ctx.model, provider: ctx.providerName, extensionFile });
    rec.command = cmd;

    const nodeTimeoutMs = node.sandbox.timeoutMs ?? ctx.watchdog.nodeTimeoutMs;
    // Tee the agent's stdout into a per-node slimmed events archive (additive — the wrap chains the
    // watchdog's own onStdout, so recording can never disable the stall kill). See ./events.ts.
    const recorder = ctx.recordEvents ? new NodeRecorder(ctx.outDir, node.id, ctx.onEvent) : null;
    const execSandbox = recorder ? recordingSandbox(sandbox, recorder) : sandbox;
    const { result, killed } = await ctx.execRunner(execSandbox, cmd, { ...ctx.watchdog, nodeTimeoutMs });
    await recorder?.close();
    rec.exitCode = result.code;

    // COLLECT: copy the node's sandbox output dir back to the host run dir. The convention (proven in
    // the test): a node writes each artifact at `<output>/<artifactPath>`, so downloadDir flattens
    // `<output>/*` onto `<hostRunDir>/*` and the artifact path IS the host-run-dir-relative path.
    if (killed === null && result.code === 0) {
      try {
        await sandbox.downloadDir(node.sandbox.output, ctx.outDir);
      } catch { /* nothing produced — verification below will mark blocked */ }
    }

    // VERIFY by host-stat (run.mjs: a node is `ok` only if its declared artifacts exist on disk).
    const artifacts: ArtifactState[] = await Promise.all(
      node.io.artifacts.map((a) => artifactState(path.resolve(ctx.outDir, a.path), a.path)),
    );
    const missing = artifacts.filter((a) => !a.exists).map((a) => a.path);

    // POST-NODE SCHEMA GATE: a present-but-invalid artifact (vs its declared draft-2020-12 schema) is a
    // contract breach, driver-verified — exactly like a missing one. Skips (advisory) when no schema is
    // declared or no validator resolved (run.mjs schemaCheck).
    const schema = await validateArtifactSchemas(node.io.artifacts, {
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
    const returnMode = node.io.returnMode ?? (node.io.artifacts.length ? 'optional' : 'required');
    rec.returnMode = returnMode;

    // The status ladder (run.mjs 1876–1883): kill/nonzero ⇒ error; then the driver-verified contract
    // breaches (missing → schema-invalid → blocking integrity check), each beating any self-report; then
    // a non-ok self-report is honored; then a MISSING handshake errors ONLY when it was required; else ok.
    const parsed = lastJsonBlock(result.stdout);
    let st: NodeStatusRecord['status'];
    const issues: string[] = [];
    if (killed === 'timeout' || killed === 'stall' || result.code !== 0) {
      st = 'error';
      if (killed) issues.push(`killed: ${killed === 'timeout' ? 'exceeded node timeout' : 'silent stall'}`);
      else issues.push(`nonzero exit ${result.code}`);
    } else if (missing.length) {
      st = 'blocked';
      issues.push(`contract breach — required artifact(s) missing: ${missing.join(', ')}`);
    } else if (schema.invalid.length) {
      st = 'blocked';
      issues.push(`contract breach — artifact(s) violate the declared schema: ${schema.invalid.map((x) => `${x.path} [${x.errors.join('; ')}]`).join(' | ')}`);
    } else if (blockingChecks.length) {
      st = 'blocked';
      issues.push(`integrity check FAILED — ${blockingChecks.map((c) => `${c.kind} ${c.path || ''}: ${c.reason}`).join(' | ')}`);
    } else if (parsed?.status && parsed.status !== 'ok') {
      st = parsed.status === 'gap' || parsed.status === 'blocked' ? parsed.status : 'gap';
    } else if (!parsed && returnMode === 'required') {
      st = 'error';
      issues.push('no return-protocol block parsed from output (return:required)');
    } else {
      st = 'ok';
    }
    if (warningChecks.length) issues.push(`integrity warn — ${warningChecks.map((c) => `${c.kind} ${c.path || ''}: ${c.reason}`).join(' | ')}`);
    if (schema.skipped) issues.push(`schema gate skipped — ${schema.skipped}`);
    if (parsed?.issues?.length) issues.push(...parsed.issues);

    // POST hooks — fire with the node's outcome; a blocking failure downgrades the node to error.
    try {
      await runHooks(node.hooks?.post, hookCtx, { outcome: st === 'ok' ? 'success' : 'failure' });
    } catch (e) {
      st = 'error';
      issues.push(`post-hook failed: ${(e as Error).message}`);
    }

    if (killed === 'timeout') rec.killedTimeout = true;
    if (killed === 'stall') rec.killedStall = true;
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
    recordEvents: opts.recordEvents ?? true,
    onEvent: opts.onEvent,
    validateSchema,
    mcpConfig: opts.mcpConfig,
    providerKind: provider.kind,
    secretResolver: opts.secretResolver,
    watchdog: {
      nodeTimeoutMs: opts.nodeTimeoutMs ?? 1_800_000,
      stallMs: opts.stallMs ?? 0,
      killGraceMs: opts.killGraceMs ?? 3000,
    },
    status: {
      run,
      source: wf.meta.name,
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

  // Seed the digest: skipped upstream → `reused`, the selected window → `pending`.
  const seed = (stage: Stage, status: NodeStatusRecord['status']): void => {
    for (const id of stage.nodeIds) {
      const n = wf.nodes[id];
      ctx.status.nodes[id] = { id, label: n.label, status, artifacts: [], issues: [] };
    }
  };
  for (const s of skipped) seed(s, 'reused');
  for (const s of selected) seed(s, 'pending');
  await writeStatus(outDir, ctx.status);

  // RESUME PREFLIGHT (run.mjs 1282–1305): the skipped upstream nodes were NOT re-run, so their
  // declared artifacts MUST already exist on the host or the resumed tail runs on absent inputs. Stat
  // them in plain code; HALT loudly on any miss. Also record the reused nodes' verified artifacts.
  if (fromIdx > 0) {
    const missing: string[] = [];
    for (const s of skipped) {
      for (const id of s.nodeIds) {
        const n = wf.nodes[id];
        const states = await Promise.all(
          n.io.artifacts.map((a) => artifactState(path.resolve(outDir, a.path), a.path)),
        );
        ctx.status.nodes[id].artifacts = states;
        for (const st of states) if (!st.exists) missing.push(`${st.path} (${id})`);
      }
    }
    if (missing.length) {
      ctx.status.done = true;
      ctx.status.ok = false;
      ctx.status.durationMs = Date.now() - t0;
      ctx.status.nodes['__resume__'] = {
        id: '__resume__', label: 'resume preflight', status: 'blocked', artifacts: [],
        issues: [`cannot --from "${opts.from}": missing upstream artifact(s): ${missing.join(', ')}`],
      };
      await writeStatus(outDir, ctx.status);
      return { status: ctx.status, outDir };
    }
  }

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
    ctx.status.durationMs = Date.now() - t0;
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

      // Parallel lanes within a stage (run.mjs 1313).
      const results = await Promise.all(s.nodeIds.map((id) => runNode(ctx, wf.nodes[id], scope)));

      // HALT-on-failure (run.mjs 1315–1322): first error/blocked stops the run; downstream never runs.
      if (results.some((r) => r.status === 'error' || r.status === 'blocked')) halted = true;
    }

    ctx.status.stage = null;
    ctx.status.done = true;
    ctx.status.durationMs = Date.now() - t0;
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
