// The OpenClaw in-process tool HOST — the execute-driver (substrate step S0).
//
// WHY this exists (load-bearing forensic finding — docs/design/openclaw-substrate-adoption.md "Wiring
// plan"): OpenClaw's registry/loader only STORE tool factories; there is NO free "run this tool"
// entrypoint — the `factory(ctx)` → `tool.execute(...)` call lives in OpenClaw's agent runtime, which we
// do NOT vendor. So to HOST a plugin's tool we DRIVE execution ourselves:
//   1. run the plugin's `register(api)` against an `api` WE build (real-or-stub `runtime`, capturing
//      `registerTool`),
//   2. capture the registered tool FACTORY (OpenClaw registers `(ctx) => tool`, not a bare tool def),
//   3. build the tool `ctx`, call `factory(ctx)` to obtain the (lazy) tool,
//   4. call the tool's OWN `execute(toolCallId, params, signal, onUpdate)` and return its result.
//
// This is the EXECUTE side of `openclaw-shim.ts`'s capture side: the shim learns tool DEFS against a
// no-op `api` (its missing `api.runtime` is the purity gate); this host adds a real-enough `runtime` so a
// keyless tool's execute actually runs. S0 proves the driver on `memory-core`'s `memory_get` — an
// fs-backed read of a file under the agent's memory dir that touches NO live gateway.
//
// Scope: S0 only. The `runtime` here is minimal — `state.openKeyedStore` is a real in-memory KV store
// (stored lazily by `memory-core` at register time; never invoked by `memory_get`), and the rest is a
// loud-throwing stub so any unexpected reach surfaces instead of silently no-oping. Later steps
// (S1 breadth, S2 provider-wire, S3 the `runEmbeddedAgent` seam) extend this same driver.

import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { defaultPiCommand } from '../runner/command.js';
import { type NodeSpec, type ResolveResult, type SecretResolver, defaultSecretResolver } from '../types.js';
import { resolveEntry, type OpenClawPluginEntry } from './openclaw-shim.js';

/** A captured `registerTool` call: the FACTORY `(ctx) => tool` and the opts (e.g. `{ names: [...] }`). */
interface CapturedFactory {
  factory: (ctx: unknown) => OpenClawTool | null | undefined;
  opts?: { names?: string[] } & Record<string, unknown>;
}

/** The (possibly lazy) tool a factory returns — we only need its `execute`. */
interface OpenClawTool {
  name?: string;
  execute(
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: (...a: unknown[]) => void,
  ): unknown;
}

/**
 * One key-gated secret a host call must route from the `SecretResolver` into the place the plugin's tool
 * reads it (S2 provider-wire). The resolver resolves `varName` (e.g. `'TAVILY_API_KEY'`); the host writes
 * the resolved value into the plugin's run config at `plugins.entries.<pluginId>.config.<configPath>` — the
 * SAME field the tool consumes (tavily reads `plugins.entries.tavily.config.webSearch.apiKey`, dist
 * `tavily-client-*.js:23`). This mirrors the runner's env seam (`mcpEnvAdditions`, `runner.ts:291`),
 * carried into the in-process host path: resolve via the broker, inject where the consumer reads.
 */
export interface OpenClawSecretRoute {
  /** Manifest plugin id whose config entry receives the secret (e.g. `'tavily'`). */
  pluginId: string;
  /** The env var name resolved through the `SecretResolver` (e.g. `'TAVILY_API_KEY'`). */
  varName: string;
  /**
   * Dotted path UNDER `plugins.entries.<pluginId>.config` where the resolved value lands — the field the
   * tool reads (e.g. `'webSearch.apiKey'`). Created (with intermediate objects) when absent.
   */
  configPath: string;
}

/** Arguments to drive one keyless OpenClaw tool through the host. */
export interface HostOpenClawToolParams {
  /** The imported plugin module (the `definePluginEntry` default export, or its `{ default }` wrapper). */
  mod: unknown;
  /** The registered tool to run — matched against `registerTool` opts `names` (e.g. `'memory_get'`). */
  toolName: string;
  /** The agent workspace dir; the memory file is read relative to it (`<workspaceDir>/<params.path>`). */
  workspaceDir: string;
  /** The tool params, passed verbatim to `execute` (e.g. `{ path: 'memory/note.md' }`). */
  params: Record<string, unknown>;
  /** Optional agent id / session key threaded into the tool `ctx` (default agent when omitted). */
  agentId?: string;
  sessionKey?: string;
  /** Optional explicit toolCallId (defaults to a stable host id). */
  toolCallId?: string;
  /**
   * Key-gated secrets to route into the plugin config before execute (S2). For each route, the resolver
   * resolves `varName` and the host writes it at `plugins.entries.<pluginId>.config.<configPath>`. Empty
   * for keyless tools (`memory_get`); no resolver is called and the config is untouched.
   */
  secrets?: OpenClawSecretRoute[];
  /**
   * The broker seam (same type as `types.ts:319`) that resolves each route's `varName`. Defaults to the
   * env-reading `defaultSecretResolver` — so a real `TAVILY_API_KEY` in env flows through unchanged, and a
   * host can inject a scoped-token broker (or a fake) without the tool knowing. Resolves `undefined` ⇒ that
   * route is skipped (the tool then hits its own "needs a key" gate, never a fabricated value).
   */
  secretResolver?: SecretResolver;
  /**
   * The INJECTABLE pi-spawn seam used by `runtime.agent.runEmbeddedAgent` (S3). The default
   * (`defaultRunPiCommand`) really spawns the nested headless pi; a test injects a fake that returns a
   * recorded-shape pi stdout so the deterministic case never spawns a subprocess. Only consumed by tools
   * whose execute reaches `runEmbeddedAgent` (e.g. `llm-task`); keyless tools never touch it.
   */
  runPiCommand?: RunPiCommand;
}

const noop = (): void => {};

/**
 * Resolve each key-gated secret through the `SecretResolver` and write it into `cfg` at the exact path the
 * plugin's tool reads (`plugins.entries.<pluginId>.config.<configPath>`). This is the S2 provider-wire: the
 * value is SOURCED from the resolver (never hardcoded here) and LANDS where the consumer reads — proving the
 * secret routes through our broker seam into the in-process tool, mirroring the runner's env seam.
 *
 * A route whose resolver returns `undefined` is skipped (no key written), so the tool falls through to its
 * own "needs a key" gate rather than receiving a fabricated value. Mutates and returns `cfg`.
 */
async function injectSecrets(
  cfg: Record<string, unknown>,
  secrets: OpenClawSecretRoute[],
  resolver: SecretResolver,
  nodeId: string,
): Promise<Record<string, unknown>> {
  for (const route of secrets) {
    const value = await resolver(route.varName, { nodeId, isCloud: false });
    if (value === undefined) continue;
    // Build (or extend) plugins.entries.<pluginId>.config and walk `configPath` to its leaf, creating
    // intermediate plain objects, then set the resolved value at the final segment.
    const plugins = (cfg.plugins ??= {}) as Record<string, unknown>;
    const entries = (plugins.entries ??= {}) as Record<string, unknown>;
    const entry = (entries[route.pluginId] ??= {}) as Record<string, unknown>;
    const config = (entry.config ??= {}) as Record<string, unknown>;
    const segments = route.configPath.split('.');
    let cursor: Record<string, unknown> = config;
    for (let i = 0; i < segments.length - 1; i++) {
      cursor = (cursor[segments[i]] ??= {}) as Record<string, unknown>;
    }
    cursor[segments[segments.length - 1]] = value;
  }
  return cfg;
}

/** A real-enough in-memory keyed store matching `PluginStateKeyedStore<T>` (async CRUD over a Map). */
function makeInMemoryKeyedStore<T>(): unknown {
  const map = new Map<string, T>();
  return {
    async register(key: string, value: T): Promise<void> {
      map.set(key, value);
    },
    async registerIfAbsent(key: string, value: T): Promise<void> {
      if (!map.has(key)) map.set(key, value);
    },
    async update(key: string, updater: (prev: T | undefined) => T): Promise<void> {
      map.set(key, updater(map.get(key)));
    },
    async lookup(key: string): Promise<T | undefined> {
      return map.get(key);
    },
    async consume(key: string): Promise<T | undefined> {
      const value = map.get(key);
      map.delete(key);
      return value;
    },
    async delete(key: string): Promise<void> {
      map.delete(key);
    },
    async entries(): Promise<Array<[string, T]>> {
      return [...map.entries()];
    },
    async clear(): Promise<void> {
      map.clear();
    },
  };
}

/**
 * A loud-throwing stub for any `runtime.*` path we did NOT wire. Reaching one means the tool needs a
 * runtime service beyond S0's keyless scope — we WANT that to throw with a precise path, not no-op.
 */
function loudRuntimeStub(pathSoFar: string): unknown {
  return new Proxy(
    () => {
      throw new Error(`openclaw-host: unsupported runtime call \`${pathSoFar}()\` (out of S0 keyless scope)`);
    },
    {
      get(_t, prop) {
        if (typeof prop === 'symbol') return undefined;
        return loudRuntimeStub(`${pathSoFar}.${String(prop)}`);
      },
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// S3 — THE AGENT SEAM. `runtime.agent.runEmbeddedAgent` is the ONE deep-runtime service an OpenClaw tool
// (`llm-task`) reaches at EXECUTE time. The doc's "no duplicate runtime" claim (openclaw-substrate-
// adoption.md "Wiring plan"): pi supplies the agent loop; we translate ONLY at this seam. We DROP
// OpenClaw's internalized `embedded-agent-*.js` loop entirely and bind the seam to the SAME headless pi CLI
// the runner already shells out to (`defaultPiCommand`, runner/command.ts:53) — a nested pi run, parsed
// back into OpenClaw's `EmbeddedAgentRunResult` shape. CLI-backed (doc S3 option B): zero new deps.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The subset of OpenClaw `RunEmbeddedAgentParams` the adapter consumes (llm-task uses ~13 of ~150). */
export interface RunEmbeddedAgentParamsSubset {
  prompt: string;
  /** The agent workspace; used as the nested pi run's cwd. */
  workspaceDir?: string;
  /** Pin the model (`pi --model`). When absent, pi's provider default is used. */
  model?: string;
  /** Provider for `pi --provider` (default 'cp', matching the runner). */
  provider?: string;
  /** Hard wall-clock cap for the nested run (ms). */
  timeoutMs?: number;
  /** llm-task always passes `true` (LLM-only). True ⇒ NO `--tools` flag on the nested pi. */
  disableTools?: boolean;
  // The rest of RunEmbeddedAgentParams (sessionId/sessionFile/runId/streamParams/…) is accepted but unused
  // by the CLI-backed adapter — pi owns the session lifecycle internally.
  [k: string]: unknown;
}

/** The `{ text?, isError?, isReasoning?, mediaUrl? }` payloads + `meta` shape llm-task reads (and the SDK). */
export interface EmbeddedAgentRunResultShape {
  payloads?: Array<{ text?: string; isError?: boolean; isReasoning?: boolean; mediaUrl?: string }>;
  meta: { durationMs: number; [k: string]: unknown };
}

/**
 * The INJECTABLE pi-spawn seam. Runs the headless pi `command` (built by the adapter) and returns its
 * buffered result. The DEFAULT (`defaultRunPiCommand`) is a real `child_process.spawn` under `shell: true`
 * with a hard timeout; a test supplies a fake that returns a recorded-shape pi stdout. This is the SAME
 * boundary the runner's `ExecRunner` isolates — kept as its own seam so the deterministic test never
 * spawns a real subprocess.
 */
export type RunPiCommand = (req: {
  command: string;
  cwd: string;
  timeoutMs: number;
}) => Promise<{ stdout: string; stderr: string; code: number | null }>;

/** The real pi-spawn: run `command` under a shell with a hard timeout; buffer stdout/stderr. */
export const defaultRunPiCommand: RunPiCommand = (req) =>
  new Promise((resolveP) => {
    const child = spawn(req.command, {
      cwd: req.cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'], // closed stdin (a headless CLI with an open stdin + no TTY hangs)
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP({ stdout, stderr, code });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* no-op */ }
      settle(124); // timeout exit, matching the runner's watchdog convention
    }, req.timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { stderr += String(e); settle(1); });
    child.on('close', (code) => settle(code));
  });

/**
 * Extract the FINAL assistant text from pi's `--mode json` stdout (a per-line JSON event stream — recorded
 * shape: session → agent_start → … → message_end/turn_end/agent_end, each carrying an assistant `message`
 * whose `content[]` mixes `{type:'thinking'}` and `{type:'text'}` parts). We take the LAST event that
 * carries a full assistant message and join its `text` parts (excluding `thinking`) — that is the model's
 * answer. This is NOT the runner's `lastJsonBlock` (which recovers a `{status,summary}` return-handshake);
 * llm-task wants the model's RAW text answer (a bare JSON value), so the two parsers are deliberately
 * distinct. Returns '' when no assistant text is present.
 */
export function finalAssistantTextFromPiJson(stdout: string): string {
  if (!stdout) return '';
  let lastText = '';
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: unknown;
    try { ev = JSON.parse(trimmed); } catch { continue; } // tolerate non-JSON noise lines
    // A complete assistant message can live on `message` (message_end/turn_end) or the last of `messages`
    // (agent_end). Prefer whichever the line carries; later lines overwrite earlier (terminal wins).
    const msg = pickAssistantMessage(ev);
    if (!msg) continue;
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((p): p is { type?: string; text?: string } => Boolean(p) && typeof p === 'object')
      .filter((p) => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('');
    if (text) lastText = text;
  }
  return lastText.trim();
}

/** From one pi event, return the assistant `message` it carries (from `message` or last of `messages`), if any. */
function pickAssistantMessage(ev: unknown): unknown {
  if (!ev || typeof ev !== 'object') return undefined;
  const e = ev as { message?: unknown; messages?: unknown };
  const isAssistant = (m: unknown): boolean =>
    Boolean(m) && typeof m === 'object' && (m as { role?: unknown }).role === 'assistant';
  if (isAssistant(e.message)) return e.message;
  if (Array.isArray(e.messages)) {
    for (let i = e.messages.length - 1; i >= 0; i--) if (isAssistant(e.messages[i])) return e.messages[i];
  }
  return undefined;
}

/**
 * THE ADAPTER. Map an OpenClaw `runEmbeddedAgent` call → a nested headless `pi` run → an
 * `EmbeddedAgentRunResult`. Stage `prompt` as a `@file`, build the command with the runner's
 * `defaultPiCommand` (reused — NOT re-implemented; `disableTools` ⇒ no `--tools`), run it via the injectable
 * `runPi`, parse the final assistant text out of pi's JSON event stream → `payloads:[{text}]`. On a non-zero
 * exit OR an unparseable/empty stream, return `payloads:[{ text:<diagnostic>, isError:true }]` (NOT a throw
 * that crashes the tool) so the caller (llm-task) sees a structured error. `meta.durationMs` is always set.
 */
export async function runEmbeddedAgentViaPi(
  params: RunEmbeddedAgentParamsSubset,
  runPi: RunPiCommand = defaultRunPiCommand,
): Promise<EmbeddedAgentRunResultShape> {
  const t0 = Date.now();
  const provider = typeof params.provider === 'string' && params.provider ? params.provider : 'cp';
  const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : 1_800_000;

  const err = (text: string): EmbeddedAgentRunResultShape => ({
    payloads: [{ text, isError: true }],
    meta: { durationMs: Date.now() - t0 },
  });

  // Stage the prompt into a temp dir so the nested pi reads it as `@<file>` (a headless invariant — multi-KB
  // prompts are robust as a file ref, brittle as an argv string). Cleaned up in `finally`.
  const stageDir = mkdtempSync(join(tmpdir(), 'oc-s3-embed-'));
  const promptFile = join(stageDir, 'prompt.md');
  // cwd for the nested run: the agent workspace IF it exists on disk, else the stage dir (a missing
  // workspaceDir must NOT crash the run — an LLM-only nested pi reads only the staged prompt, and
  // `spawn` ENOENTs instantly on a non-existent cwd). llm-task derives workspaceDir from config and the
  // host's tests pass throwaway `/tmp/...` paths that need not exist, so we degrade gracefully.
  const cwd =
    params.workspaceDir && params.workspaceDir.length && existsSync(params.workspaceDir)
      ? params.workspaceDir
      : stageDir;
  try {
    writeFileSync(promptFile, params.prompt ?? '', 'utf8');

    // Reuse the runner's command builder. `disableTools` ⇒ no selected tools ⇒ no `-e`, no `--tools`. We feed
    // a minimal synthetic node/resolved (the builder reads only `resolved.piTools` + `ctx`).
    const node = {} as unknown as NodeSpec;
    const resolved: ResolveResult = { piTools: [] };
    const command = defaultPiCommand(node, resolved, {
      promptFile,
      model: typeof params.model === 'string' && params.model ? params.model : undefined,
      provider,
    });

    const { stdout, stderr, code } = await runPi({ command, cwd, timeoutMs });
    if (code !== 0) {
      return err(`pi exited ${code ?? 'null'}${stderr ? `: ${stderr.trim().slice(-400)}` : ''}`);
    }
    const text = finalAssistantTextFromPiJson(stdout);
    if (!text) {
      return err(`pi produced no assistant text${stderr ? `: ${stderr.trim().slice(-400)}` : ''}`);
    }
    return { payloads: [{ text }], meta: { durationMs: Date.now() - t0 } };
  } catch (e) {
    return err(`runEmbeddedAgent adapter failed: ${(e as Error).message}`);
  } finally {
    try { rmSync(stageDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

/**
 * Build the `runtime.agent` object: `runEmbeddedAgent` bound to the pi adapter (closing over the injectable
 * `runPi`), and EVERYTHING ELSE a loud-throwing stub (`runtime.agent.subagent`, `session.*`, `defaults`,
 * `resolveThinkingPolicy`, …). S3 wires exactly ONE method — an un-wired reach still surfaces its exact path.
 */
function makeRuntimeAgent(runPi: RunPiCommand): unknown {
  const runEmbeddedAgent = (params: RunEmbeddedAgentParamsSubset): Promise<EmbeddedAgentRunResultShape> =>
    runEmbeddedAgentViaPi(params, runPi);
  return new Proxy(
    () => {
      throw new Error('openclaw-host: unsupported runtime call `runtime.agent()` (only runEmbeddedAgent is wired)');
    },
    {
      get(_t, prop) {
        if (prop === 'runEmbeddedAgent') return runEmbeddedAgent;
        if (typeof prop === 'symbol') return undefined;
        // Anything else under runtime.agent.* throws loudly with its path (S3 scope: one method only).
        return loudRuntimeStub(`runtime.agent.${String(prop)}`);
      },
    },
  );
}

/** Test-only constructor for the wired `runtime.agent` object (so a test can assert the loud-throw guard). */
export function makeRuntimeAgentForTest(runPi: RunPiCommand): unknown {
  return makeRuntimeAgent(runPi);
}

/**
 * Build the host `api` an OpenClaw plugin's `register(api)` receives, plus the `captured` factories its
 * `registerTool` pushes into. The `runtime` is real where `memory-core` needs it at register time
 * (`state.openKeyedStore`, `config.current`) and a loud-throwing stub elsewhere — EXCEPT `runtime.agent`,
 * whose `runEmbeddedAgent` is now bound to the pi adapter (S3). Every non-tool registration verb is a
 * graceful no-op (per the doc: stubbing them still registers + runs the tool).
 */
function makeHostApi(
  cfg: Record<string, unknown>,
  runPi: RunPiCommand = defaultRunPiCommand,
): { api: Record<string, unknown>; captured: CapturedFactory[] } {
  const captured: CapturedFactory[] = [];
  const logger = { info: noop, warn: noop, error: noop, debug: noop, log: noop };

  const runtime: Record<string, unknown> = {
    state: {
      openKeyedStore: () => makeInMemoryKeyedStore(),
      openSyncKeyedStore: () => makeInMemoryKeyedStore(),
    },
    config: { current: () => cfg },
    // S3: `runtime.agent.runEmbeddedAgent` is bound to the pi adapter; every OTHER `runtime.agent.*` path
    // (subagent/session/defaults/resolveThinkingPolicy/…) still throws loudly with its exact path.
    agent: makeRuntimeAgent(runPi),
    // Anything else under runtime.* that a plugin reaches throws loudly with its path.
    subagent: loudRuntimeStub('runtime.subagent'),
  };

  const api: Record<string, unknown> = {
    runtime,
    // The one verb we CAPTURE: OpenClaw registers a tool in three shapes (resolved by `captureToolName`):
    //   registerTool(factory, { names:[...] })  — memory-core/memory-wiki/tavily/llm-task/workboard
    //   registerTool(def, undefined)            — codex-supervisor/file-transfer (name on the def object)
    //   registerTool(factory, undefined)        — browser/canvas (name on the factory's produced tool)
    registerTool: (factory: CapturedFactory['factory'], opts?: CapturedFactory['opts']) => {
      captured.push(opts === undefined ? { factory } : { factory, opts });
    },
    // Graceful no-ops — register-time DECLARATION verbs the installed tool-bearing plugins call. Each is
    // register-time-SAFE: it takes a declaration and returns void; NONE returns a service the tool's own
    // `execute` consumes, so no-op'ing it registers the plugin without breaking the tool later (S1 bar).
    // Stubbing a verb that DID return an execute-time service would hide an S3 problem — none of these do.
    registerMemoryCapability: noop,
    registerMemoryEmbeddingProvider: noop,
    registerProvider: noop,
    registerEmbeddingProvider: noop,
    registerWebSearchProvider: noop,
    registerChannel: noop,
    registerCommand: noop,
    registerCli: noop,
    registerService: noop,
    registerHook: noop,
    // S1 breadth additions — declaration verbs reached by browser/canvas/codex-supervisor/file-transfer/
    // memory-wiki/workboard/xai at register time (probed against the real dist). All void-returning.
    registerGatewayMethod: noop, // browser, workboard, memory-wiki: gateway RPC method declarations
    registerHttpRoute: noop, // canvas: HTTP route declaration (the L3 daemon lives elsewhere)
    registerNodeInvokePolicy: noop, // canvas, file-transfer: node.invoke allow-policy declaration
    registerNodeCliFeature: noop, // canvas: node CLI feature declaration
    registerHostedMediaResolver: noop, // canvas: hosted-media URL resolver declaration
    registerMemoryPromptSupplement: noop, // memory-wiki: MEMORY.md prompt-section supplement
    registerMemoryCorpusSupplement: noop, // memory-wiki: corpus supplement
    registerModelCatalogProvider: noop, // xai: model-catalog declaration
    registerImageGenerationProvider: noop, // xai
    registerMediaUnderstandingProvider: noop, // xai
    registerRealtimeTranscriptionProvider: noop, // xai
    registerSpeechProvider: noop, // xai
    registerVideoGenerationProvider: noop, // xai
    // codex-supervisor registers a SHUTDOWN hook at register time via `api.lifecycle.registerRuntimeLifecycle`
    // ({ id, description, dispose }) — caches a dispose callback for daemon teardown; the tool's execute
    // never reads it. A no-op here is register-time-safe (we are not running a daemon to tear down).
    lifecycle: { registerRuntimeLifecycle: noop },
    on: noop,
    emitAgentEvent: noop,
    logger,
    config: cfg,
    pluginConfig: {},
    resolvePath: (p: unknown) => p,
  };

  return { api, captured };
}

/**
 * Drive ONE keyless OpenClaw tool end-to-end through the in-process host: register the real plugin,
 * capture the named tool factory, build a tool `ctx`, and call the tool's OWN `execute` — returning its
 * result verbatim. The value is produced by the PLUGIN (e.g. `memory_get`'s fs read), not by this host.
 *
 * Throws if the plugin entry has no `register`, or if no registered tool matches `toolName`.
 */
export async function hostOpenClawTool(args: HostOpenClawToolParams): Promise<unknown> {
  const entry: OpenClawPluginEntry = resolveEntry(args.mod);

  // Minimal cfg: pin the agent workspace so the memory read resolves under OUR dir. memory-search is
  // enabled by default (so the tool is not gated off) and the memory backend defaults to "builtin" (the
  // fs read path) — both verified in openclaw's config-utils / backend-config.
  const cfg: Record<string, unknown> = {
    agents: { defaults: { workspace: args.workspaceDir } },
  };

  // S2 provider-wire: route any key-gated secret through the SecretResolver broker into the plugin config
  // path the tool reads. Keyless tools pass no `secrets` ⇒ the resolver is never called. The default
  // resolver reads process.env, so a real key in env flows through unchanged.
  if (args.secrets?.length) {
    await injectSecrets(
      cfg,
      args.secrets,
      args.secretResolver ?? defaultSecretResolver,
      args.agentId ?? args.toolName,
    );
  }

  const { api, captured } = makeHostApi(cfg, args.runPiCommand ?? defaultRunPiCommand);

  // 1. Run the plugin's real register(api) — synchronous; stores factories + capability/embedding/CLI.
  entry.register(api as never);

  // 2. Capture the named tool's factory. OpenClaw passes the name as either the plural `names: string[]`
  //    opt (memory-core) OR the singular `name: string` opt (tavily registers
  //    `registerTool((ctx)=>..., { name: 'tavily_search' })`, dist `tavily/index.js:123`). Match both.
  const optNames = (c: CapturedFactory): string[] => {
    const names = c.opts?.names;
    if (Array.isArray(names)) return names.filter((n): n is string => typeof n === 'string');
    const single = (c.opts as { name?: unknown } | undefined)?.name;
    return typeof single === 'string' ? [single] : [];
  };
  const found = captured.find((c) => optNames(c).includes(args.toolName));
  if (!found) {
    const available = captured.flatMap(optNames).join(', ') || '(none)';
    throw new Error(
      `openclaw-host: tool \`${args.toolName}\` not registered by this plugin (registered: ${available})`,
    );
  }

  // 3. Build the tool ctx the factory reads (resolveMemoryToolOptions: config/getRuntimeConfig, agentId,
  //    sessionKey, sandboxed) and instantiate the (lazy) tool.
  const ctx = {
    config: cfg,
    getRuntimeConfig: () => cfg,
    runtimeConfig: cfg,
    agentId: args.agentId,
    sessionKey: args.sessionKey,
    sandboxed: false,
    oneShotCliRun: false,
  };
  const tool = found.factory(ctx);
  if (!tool || typeof tool.execute !== 'function') {
    throw new Error(`openclaw-host: factory for \`${args.toolName}\` did not yield a tool with execute()`);
  }

  // 4. Drive the tool's OWN execute — THIS is the execute-driver the registry/loader do not hand us.
  return await tool.execute(args.toolCallId ?? 'oc-host-s0', args.params);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// S1 — REGISTRATION BREADTH. Discover every installed tool-bearing OpenClaw plugin, run its real
// `register(api)` on the host, and report — per plugin — the tools it actually registered, OR the exact
// runtime path it reached at register time that S1 must not fake. This is the "works on one → works on
// all" registration guarantee made observable (docs/design/openclaw-substrate-adoption.md, build order S1).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The installed OpenClaw dist's extensions root, resolved relative to this compiled module. */
function openClawExtensionsDir(): string {
  // This file ships to `packages/core/dist/tools/openclaw-host.js` and runs from `src/` under vitest;
  // walk up to the repo's `node_modules/openclaw/dist/extensions` from either location.
  const here = dirname(fileURLToPath(import.meta.url));
  // src/tools → ../../../../node_modules ; dist/tools → ../../../../node_modules (same depth from pkg root
  // is not guaranteed, so search upward for the first node_modules/openclaw that exists).
  let dir = here;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'node_modules', 'openclaw', 'dist', 'extensions');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back to a CWD-relative resolution (covers the monorepo-root test invocation).
  return resolve('node_modules/openclaw/dist/extensions');
}

/** A discovered tool-bearing plugin: its dir, id, manifest tool names, and resolved entry file URL. */
interface DiscoveredPlugin {
  dir: string;
  id: string;
  declaredTools: string[];
  entryUrl: string;
}

/**
 * Discover every installed extension whose `openclaw.plugin.json` declares a non-empty `contracts.tools`.
 * The entry file is read from the plugin's `package.json` `openclaw.extensions[0]` (the authoritative
 * entry list OpenClaw itself uses), falling back to the conventional `./index.js`. Pure fs read — no import.
 */
export function discoverToolBearingPlugins(): DiscoveredPlugin[] {
  const root = openClawExtensionsDir();
  const out: DiscoveredPlugin[] = [];
  for (const dir of readdirSync(root)) {
    const manifestPath = join(root, dir, 'openclaw.plugin.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      id?: string;
      contracts?: { tools?: unknown };
    };
    const tools = manifest.contracts?.tools;
    if (!Array.isArray(tools) || tools.length === 0) continue;
    const declaredTools = tools.filter((t): t is string => typeof t === 'string');

    let entryRel = './index.js';
    const pkgPath = join(root, dir, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        openclaw?: { extensions?: unknown };
      };
      const exts = pkg.openclaw?.extensions;
      if (Array.isArray(exts) && typeof exts[0] === 'string') entryRel = exts[0];
    }
    const entryFile = join(root, dir, entryRel.replace(/^\.\//, ''));
    out.push({
      dir,
      id: manifest.id ?? dir,
      declaredTools,
      entryUrl: pathToFileURL(entryFile).href,
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * The tool name OpenClaw attaches to a captured `registerTool` call — resolved across the THREE shapes the
 * installed plugins use (all verified against the real dist):
 *   1. `opts.names: string[]`     → return them all (memory-core, memory-wiki, tavily, llm-task, workboard)
 *   2. `opts.name: string`        → return [name]  (defensive; OpenClaw's singular-name opt form)
 *   3. arg1 is a tool DEF object  → return [def.name]  (codex-supervisor, file-transfer)
 *   4. arg1 is a FACTORY function → call `factory(ctx)` and read the produced tool's `.name` (browser, canvas)
 * Case 4 INSTANTIATES the (lazy) tool only to read its declared name — it does NOT call `execute` (that is
 * S3). If the factory itself reaches a runtime service to build the tool, the loud `runtime` stub throws
 * and the caller records `needs-runtime` with the path.
 */
function captureToolNames(c: CapturedFactory, ctx: unknown): string[] {
  if (Array.isArray(c.opts?.names)) return c.opts.names.filter((n): n is string => typeof n === 'string');
  if (typeof (c.opts as { name?: unknown } | undefined)?.name === 'string') {
    return [(c.opts as { name: string }).name];
  }
  // arg1 carries the name: either a def object (`{ name, execute }`) or a factory `(ctx) => tool`.
  const arg1 = c.factory as unknown;
  if (arg1 && typeof arg1 === 'object' && typeof (arg1 as { name?: unknown }).name === 'string') {
    return [(arg1 as { name: string }).name];
  }
  if (typeof arg1 === 'function') {
    const tool = c.factory(ctx);
    if (tool && typeof (tool as { name?: unknown }).name === 'string') {
      return [(tool as { name: string }).name];
    }
  }
  return [];
}

/** A per-plugin S1 registration record: what it declared, what it actually registered, and its status. */
export interface LoadedOpenClawPlugin {
  /** Manifest `id` (e.g. `'memory-core'`). */
  id: string;
  /** `extensions/<dir>` segment (the entry/manifest location). */
  dir: string;
  /** Verbatim manifest `contracts.tools`. */
  declaredTools: string[];
  /** Tool names actually captured from the plugin's real `register(api)` (empty iff status ≠ registered). */
  capturedTools: string[];
  /**
   * `registered` — `register(api)` returned and its tools were captured on the host.
   * `needs-runtime` — `register` reached a runtime SERVICE we must not fake at register time (S1 stops
   *   here for this plugin); `detail` carries the exact reached path. NEVER set when register succeeded.
   */
  status: 'registered' | 'needs-runtime';
  /** For `needs-runtime`: the exact unwired `runtime.*`/`api.*` path the register reached. */
  detail?: string;
}

/**
 * Run EVERY installed tool-bearing plugin's real `register(api)` on the host and report a per-plugin
 * record. A plugin whose register returns is `registered` with its captured tool names; a plugin that
 * reaches an unwired runtime service at register time is `needs-runtime` with the exact path (its throw is
 * reported, NEVER swallowed as success). The host `api` adds only register-time-SAFE no-op declaration
 * verbs — never a stub that returns a service the tool's execute needs (that would hide an S3 problem).
 *
 * S1 scope: registration breadth only. This does NOT call any tool's `execute` and does NOT run gateway-
 * coupled tools (browser/canvas/etc. instantiate their lazy tool only to read its declared name).
 */
export async function loadAllOpenClawPlugins(): Promise<LoadedOpenClawPlugin[]> {
  const discovered = discoverToolBearingPlugins();
  const results: LoadedOpenClawPlugin[] = [];

  for (const p of discovered) {
    const cfg: Record<string, unknown> = { agents: { defaults: { workspace: '/tmp/oc-s1-register' } } };
    const { api, captured } = makeHostApi(cfg);
    // The benign ctx a lazy factory reads to produce its tool (for the name-on-tool capture shape). Same
    // shape as hostOpenClawTool's ctx; never used to call execute here.
    const ctx = {
      config: cfg,
      getRuntimeConfig: () => cfg,
      runtimeConfig: cfg,
      sandboxed: false,
      oneShotCliRun: false,
    };

    let entry: OpenClawPluginEntry;
    try {
      const mod = (await import(p.entryUrl)) as unknown;
      entry = resolveEntry(mod);
    } catch (err) {
      // An un-importable / register-less entry is a hard discovery blocker — surface it precisely.
      results.push({
        id: p.id,
        dir: p.dir,
        declaredTools: p.declaredTools,
        capturedTools: [],
        status: 'needs-runtime',
        detail: `import/entry: ${(err as Error).message}`,
      });
      continue;
    }

    try {
      entry.register(api as never);
      const capturedTools = captured.flatMap((c) => captureToolNames(c, ctx));
      results.push({
        id: p.id,
        dir: p.dir,
        declaredTools: p.declaredTools,
        capturedTools,
        status: 'registered',
      });
    } catch (err) {
      // register reached an unwired runtime/api path — report it as needs-runtime with the EXACT path
      // (the loud stub's message carries `runtime.<path>()`), NEVER counted as a success.
      results.push({
        id: p.id,
        dir: p.dir,
        declaredTools: p.declaredTools,
        capturedTools: [],
        status: 'needs-runtime',
        detail: (err as Error).message,
      });
    }
  }

  return results;
}
