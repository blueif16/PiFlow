// The OpenClaw capture-shim — the `sdk` lane's def-captor AND its purity gate.
//
// OpenClaw plugins ship a `definePluginEntry({ id, name, description, register(api) })` default export.
// The descriptions + TypeBox `parameters` of a plugin's tools live ONLY in the `register()` body, not in
// the shipped `openclaw.plugin.json` manifest (which carries tool NAMES only). To learn them — and to
// embed the tool's NATIVE execute into our generated `-e` — we RUN `register(api)` against a FAKE `api`
// whose `registerTool(def, opts?)` CAPTURES the def and whose every other method is a harmless no-op.
//
// This is the project-blessed pattern: `@openclaw/plugin-inspector --mock-sdk` imports plugin entrypoints
// and records what `register(api)` does via generated mocks for the `openclaw/plugin-sdk` subpaths.
//
// ONE shim, TWO call sites: (1) at ingest time on the host (to learn description+parameters and gate
// purity) and (2) inside the generated `-e` (to obtain the captured native execute to `pi.registerTool`).
//
// PURITY GATE: the no-op `api` provides NO `api.runtime`/inference gateway/store. A PURE tool's execute
// reads only its params and runs fine; a GATEWAY-COUPLED tool's execute reaches `api.*` and THROWS when
// invoked — so a smoke `execute(params)` under this shim classifies portability.

/** One tool def an OpenClaw plugin registers (the fields we read; the manifest carries none of these). */
export interface OpenClawToolDef {
  name: string;
  description?: string;
  /** TypeBox / JSON-Schema for the tool's args. */
  parameters?: unknown;
  /** The plugin's NATIVE execute — `(toolCallId, params, ...)` → a pi tool-result. Kept verbatim. */
  execute(toolCallId: string, params: unknown, ...rest: unknown[]): unknown;
}

/** A captured registration: the tool def plus the `opts` (`{ optional? }`) passed to `registerTool`. */
export interface CapturedTool {
  def: OpenClawToolDef;
  opts?: unknown;
}

/**
 * (#20) A SURFACED OpenClaw hook-bus registration. The host/shim drive a tool's `execute` directly and
 * bypass OpenClaw's hook bus, so a plugin that self-gates via `before_tool_call` (or persists via
 * `tool_result_persist`) has that hook SKIPPED. Rather than swallow the registration silently (the old
 * `registerHook`/`on` no-op — a latent trap), we RECORD it as an ADVISORY entry: observable but NON-BLOCKING
 * (Dagster `blocking=False`). `advisory` is always `true` (the hook does not gate the tool); `hook` is the
 * event name; `via` is which verb registered it (`registerHook` | `on`).
 */
export interface AdvisoryHook {
  hook: string;
  via: 'registerHook' | 'on';
  advisory: true;
}

/** The fake-`api` surface OpenClaw's `register(api)` receives. registerTool captures; the rest no-op. */
export interface CaptureApi {
  registerTool(def: OpenClawToolDef, opts?: unknown): void;
  registerProvider(...args: unknown[]): void;
  registerChannel(...args: unknown[]): void;
  registerEmbeddingProvider(...args: unknown[]): void;
  registerWebSearchProvider(...args: unknown[]): void;
  registerCommand(...args: unknown[]): void;
  registerService(...args: unknown[]): void;
  registerHook(...args: unknown[]): void;
  on(...args: unknown[]): void;
  logger: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void; debug(...a: unknown[]): void };
  config: Record<string, unknown>;
  pluginConfig: Record<string, unknown>;
  resolvePath(...args: unknown[]): unknown;
}

/** An OpenClaw plugin entry — the `definePluginEntry` default export shape we drive. */
export interface OpenClawPluginEntry {
  id?: string;
  name?: string;
  description?: string;
  register(api: CaptureApi): void;
}

const noop = (): void => {};

/**
 * Build the fake `api` + the array its `registerTool` captures into. The capture array is returned
 * alongside so a caller can run a plugin's `register(api)` and then read `captured`. Every non-tool
 * registration method is a no-op, so a plugin's `register()` body completes without a real gateway.
 * Crucially there is NO `api.runtime`/inference/store — that absence is the purity gate at execute time.
 */
export function makeCaptureApi(): { api: CaptureApi; captured: CapturedTool[]; advisories: AdvisoryHook[] } {
  const captured: CapturedTool[] = [];
  // (#20) Hook-bus registrations are RECORDED here (advisory, non-blocking) instead of silently dropped.
  const advisories: AdvisoryHook[] = [];
  const recordHook = (via: AdvisoryHook['via']) => (hook: unknown, ..._rest: unknown[]): void => {
    if (typeof hook === 'string') advisories.push({ hook, via, advisory: true });
  };
  const api: CaptureApi = {
    registerTool(def, opts) {
      captured.push(opts === undefined ? { def } : { def, opts });
    },
    registerProvider: noop,
    registerChannel: noop,
    registerEmbeddingProvider: noop,
    registerWebSearchProvider: noop,
    registerCommand: noop,
    registerService: noop,
    // SURFACE (not silently no-op) the hook-bus verbs as advisory entries — the tool still runs (the host
    // drives execute directly); the advisory makes a self-gating plugin's bypassed hook OBSERVABLE (#20).
    registerHook: recordHook('registerHook'),
    on: recordHook('on'),
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    config: {},
    pluginConfig: {},
    resolvePath: (p: unknown) => p,
  };
  return { api, captured, advisories };
}

/** Unwrap an ESM-interop default: `{ default: entry }` → `entry`; a bare entry passes through. */
export function resolveEntry(mod: unknown): OpenClawPluginEntry {
  const candidate =
    mod && typeof mod === 'object' && 'default' in (mod as Record<string, unknown>)
      ? (mod as { default: unknown }).default
      : mod;
  if (!candidate || typeof (candidate as OpenClawPluginEntry).register !== 'function') {
    throw new Error('openclaw-shim: plugin entry has no register(api) function (expected a definePluginEntry default export)');
  }
  return candidate as OpenClawPluginEntry;
}

/**
 * Run an OpenClaw plugin entry's `register(api)` against the capture-shim and return the captured tool
 * defs. Accepts either the entry object or its `{ default }` module wrapper. The returned defs carry the
 * plugin's NATIVE `execute` (and the description + parameters the manifest omits). Pure transform of the
 * (already-imported) module — no network, no filesystem.
 */
export function captureOpenClawTools(mod: unknown): CapturedTool[] {
  const entry = resolveEntry(mod);
  const { api, captured } = makeCaptureApi();
  entry.register(api);
  return captured;
}

/**
 * (#20) Run an OpenClaw plugin entry's `register(api)` and return its SURFACED hook-bus registrations as
 * ADVISORY entries (`before_tool_call`/`tool_result_persist`/…). These are non-blocking: the host drives a
 * tool's `execute` directly and bypasses the hook bus, so this list makes a self-gating plugin OBSERVABLE
 * instead of letting the registration vanish into a silent no-op. An empty list ⇒ the plugin registers no
 * hooks (the hook-free path is unchanged). Pure transform of the (already-imported) module — no I/O.
 */
export function captureOpenClawHooks(mod: unknown): AdvisoryHook[] {
  const entry = resolveEntry(mod);
  const { api, advisories } = makeCaptureApi();
  entry.register(api);
  return advisories;
}
