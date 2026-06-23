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
export function makeCaptureApi(): { api: CaptureApi; captured: CapturedTool[] } {
  const captured: CapturedTool[] = [];
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
    registerHook: noop,
    on: noop,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    config: {},
    pluginConfig: {},
    resolvePath: (p: unknown) => p,
  };
  return { api, captured };
}

/** Unwrap an ESM-interop default: `{ default: entry }` → `entry`; a bare entry passes through. */
function resolveEntry(mod: unknown): OpenClawPluginEntry {
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
