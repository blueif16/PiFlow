// The generated `-e` extension compiler — the declarative WIRING half. pi has no native MCP and no
// way to call an `sdk` tool unless an extension registers it (README: "No MCP. …build an extension
// that adds MCP support."). So a node that declares `sdk`/`mcp` tools compiles to a generated pi
// extension that `registerTool`s each one; the bare piNames go on `--tools`. The extension loads via
// explicit `-e` (which survives `--no-extensions`) exactly like the proven providers/coding-plan.ts +
// extensions/node-contract.ts witnesses, whose `defineTool`/`registerTool` shape this mirrors.
//
// Structure is PURE plan → render so the bind-verifier (tools/verify.ts) can cross-check the exact set
// of piNames this binds against what the node declared ("Verified, not trusted", spine philosophy #8).
//
// Robustness: every embedded string/schema goes through JSON.stringify (never naive concat), so a
// description carrying quotes/newlines/backticks can't break — or inject into — the generated source.
// A tool's JSON-Schema `parameters` is wrapped in TypeBox `Type.Unsafe(...)`: pi accepts it as a real
// schema and advertises the correct param shape to the model, without us reconstructing TypeBox by hand.
//
// `execute` routes to the bridge by ADDRESS: `callTool("mcp.github:create_issue", params, …)`. The
// bridge (the deferred MCP/sdk runtime seam) owns the actual transport; this compiler owns the binding.
//
// CODE MODE (deferred optimization — NOT wired). Today we bind EVERY selected tool's schema into the
// generated `-e`: fine for a handful, but a large catalog (many `oc.*`/`mcp.*` tools) bloats the model
// prompt. The industry answer (Cloudflare/Anthropic) is "code mode" — expose only `exec`/`wait` and let
// the model write code that searches + calls tools via a hidden catalog (94–99% tool-token cut; data
// stays out of the model). OpenClaw ships its own code mode, but it is NOT importable (welded to its
// agent runtime). Two ways to get it if catalog size ever bites: (a) DELEGATE a tool-heavy sub-task to an
// OpenClaw agent turn (its model runs code mode) via the gateway agent RPC / `/v1/chat/completions`; or
// (b) BUILD our own exec/catalog/snapshot surface here over the MCP client, borrowing only the OSS
// `quickjs-wasi`. Evidence: docs/research/sandbox-tool-wiring-2026-06-22.md.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import type { ToolEntry, ToolSource } from '../types.js';
import { renderContractTool } from './contract-tool.js';
import { renderParamsExpr, paramsNeedStringEnum, STRING_ENUM_PREAMBLE } from './params.js';

/** Module the generated extension imports its execute-bridge (`callTool`) from. */
export const DEFAULT_BRIDGE_MODULE = '@piflow/tool-bridge';

/**
 * Module the generated extension imports the OpenClaw capture-shim (`captureOpenClawTools`) from.
 *
 * LEAN-BUNDLE: the shim is exposed via the dedicated subpath export `@piflow/core/tools/openclaw-shim`
 * (packages/core `exports`), so bundling a PINNED sdk tool inlines ONLY the shim — a few KB — instead of
 * the whole `@piflow/core` barrel (esbuild + daytona ≈ 2.6 MB) that the bare `"."` entry would drag in.
 * Override via `CompileOpts.shimModule` (e.g. a relative path in a fixture test). Unpinned sdk tools (no
 * plugin module) route through the bridge and never import the shim; the mcp lane is unaffected.
 */
export const DEFAULT_SHIM_MODULE = '@piflow/core/tools/openclaw-shim';

/** Compiler knobs. */
export interface CompileOpts {
  /** Module specifier the generated extension imports `callTool` from. Default {@link DEFAULT_BRIDGE_MODULE}. */
  bridgeModule?: string;
  /** Module specifier the generated extension imports `captureOpenClawTools` from. Default {@link DEFAULT_SHIM_MODULE}. */
  shimModule?: string;
}

/** One tool the generated extension will register (the pure plan; builtins are excluded — pi has those natively). */
export interface PlannedTool {
  address: string;
  piName: string;
  source: ToolSource; // 'sdk' | 'mcp'
  description: string;
  label: string;
  /** JSON-Schema object for the tool's args, or undefined (→ an empty object schema). */
  parameters?: unknown;
  /** sdk only: the RAW tool name the plugin registered (the address segment after the colon). */
  rawName?: string;
  /** sdk only: the import specifier for the pinned plugin module (from `origin.ref`, version-stripped). */
  pluginModule?: string;
}

/** A compiled extension: the source pi loads via `-e`, plus the piNames it registers (for bind-verify). */
export interface CompiledExtension {
  /** The pi extension source (TS/JS-compatible). Empty string when there are no non-builtin tools. */
  source: string;
  /** The bare piNames the extension registers — the ground truth the bind-check compares against. */
  registered: string[];
}

/** A readable label from an address: `mcp.github:create_issue` → `github: create_issue`. */
function labelFor(address: string): string {
  return address.replace(/^(mcp|oc)\./, '').replace(':', ': ');
}

/** The RAW tool name an address carries (the segment after the colon): `oc.mem:memory_get` → `memory_get`. */
function rawNameOf(address: string): string {
  const i = address.indexOf(':');
  return i >= 0 ? address.slice(i + 1) : address;
}

/**
 * Turn an `origin.ref` into an IMPORTABLE plugin module specifier, or `undefined` when the ref does NOT
 * name a standalone-importable module. The ref records a pin: an npm pin (`<pkg>@<ver>`) or a relative/
 * source path are importable; a GIT-SOURCE pin (`<repo>@<commit>#extensions/<name>`, the form the OpenClaw
 * sourcing brief defines for in-repo plugins) is NOT — that fragment points at a path inside a monorepo,
 * not an installed package, so a bare `import` of it would resolve to the wrong package (or drag in the
 * whole gateway) and the tool is gateway-coupled / discoverable-only anyway. So:
 *   - a ref containing `#` → `undefined` (git-source pin; the tool routes through the bridge, not a native
 *     bind — see {@link isNativeSdk}), never a bogus `import`.
 *   - otherwise strip a trailing `@<version>` WITHOUT eating a leading scope
 *     (`@openclaw/memory-core@2026.6.8` → `@openclaw/memory-core`); a path-like or version-less ref passes
 *     through.
 */
function pluginModuleFromRef(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  if (ref.includes('#')) return undefined; // git-source pin → not a standalone-importable module
  // a version suffix is `@<ver>` AFTER the package name (i.e. an `@` that is not the leading scope `@`).
  const at = ref.lastIndexOf('@');
  if (at > 0) return ref.slice(0, at);
  return ref;
}

/** Plan which entries become generated tools: drop builtins (pi has them natively), keep sdk/mcp. */
export function planTools(entries: ToolEntry[]): PlannedTool[] {
  return entries
    .filter((e) => e.source !== 'builtin')
    .map((e): PlannedTool => {
      const t: PlannedTool = {
        address: e.address,
        piName: e.piName,
        source: e.source,
        description: e.description,
        label: labelFor(e.address),
        parameters: e.parameters,
      };
      if (e.source === 'sdk') {
        t.rawName = rawNameOf(e.address);
        t.pluginModule = pluginModuleFromRef(e.origin?.ref);
      }
      return t;
    });
}

/** The schema emitted when a tool declares no parameters (a valid empty-object JSON Schema). */
const EMPTY_SCHEMA = { type: 'object', properties: {} };

/** An sdk tool gets its NATIVE execute (imported plugin + capture-shim) iff it carries a plugin module. */
function isNativeSdk(t: PlannedTool): boolean {
  return t.source === 'sdk' && typeof t.pluginModule === 'string' && t.pluginModule.length > 0;
}

/** The common registration head (name/label/description/prompt/parameters) shared by both branches. */
function renderHead(t: PlannedTool): string[] {
  const params = t.parameters !== undefined ? t.parameters : EMPTY_SCHEMA;
  // promptSnippet/promptGuidelines name the tool explicitly (pi guideline rule) so the model knows when to call it.
  const snippet = `Use ${t.piName} — ${t.description}`;
  const guidelines = [`Call ${t.piName} when the task needs: ${t.description}`];
  return [
    `    name: ${JSON.stringify(t.piName)},`,
    `    label: ${JSON.stringify(t.label)},`,
    `    description: ${JSON.stringify(t.description)},`,
    `    promptSnippet: ${JSON.stringify(snippet)},`,
    `    promptGuidelines: ${JSON.stringify(guidelines)},`,
    // #21: all-string `enum` sub-schemas render via the Gemini-safe `StringEnum` helper; a schema with no
    // such enum is BYTE-IDENTICAL to the prior `Type.Unsafe(<json>)` form (renderParamsExpr is additive).
    `    parameters: ${renderParamsExpr(params)},`,
  ];
}

/**
 * Render ONE `pi.registerTool({...})` block. Every interpolation is JSON.stringify'd (injection-safe).
 *
 * - mcp (and sdk WITHOUT a pinned plugin): `execute` routes through the bridge by ADDRESS (`callTool`).
 * - sdk WITH a pinned plugin (`pluginModule`): bind the plugin's NATIVE execute — at load the extension
 *   runs the capture-shim over the imported plugin (`modIdent`) to obtain the tool's own def, then uses
 *   `def.execute`. No bridge: an OpenClaw tool brings its own execute.
 *
 * @param modIdent the local identifier the plugin module was imported as (sdk-native branch only).
 */
function renderTool(t: PlannedTool, modIdent?: string): string {
  // A first-party CONTRACT tool (e.g. submit_result) carries its OWN inline execute — render it directly,
  // never the bridge/native-sdk route. (Its piName/description/parameters satisfy ContractRenderable.)
  if (t.source === 'contract') return renderContractTool(t);
  const head = renderHead(t);
  if (isNativeSdk(t) && modIdent) {
    // capture the plugin's tool defs, find THIS tool by its raw registered name, bind its native execute.
    return [
      '  {',
      `    const __caps = captureOpenClawTools(${modIdent});`,
      `    const __d = __caps.find((c) => c.def.name === ${JSON.stringify(t.rawName)});`,
      `    if (!__d) throw new Error("openclaw sdk tool not found in plugin: " + ${JSON.stringify(t.rawName)});`,
      '    pi.registerTool({',
      ...head,
      '      execute: __d.def.execute,',
      '    });',
      '  }',
    ].join('\n');
  }
  return [
    '  pi.registerTool({',
    ...head,
    '    async execute(toolCallId, params, signal) {',
    `      return callTool(${JSON.stringify(t.address)}, params, { toolCallId, signal });`,
    '    },',
    '  });',
  ].join('\n');
}

/** Render the full pi extension source from a plan. Empty string when there is nothing to bind. */
export function renderExtension(tools: PlannedTool[], opts: CompileOpts = {}): string {
  if (!tools.length) return '';
  const bridge = opts.bridgeModule ?? DEFAULT_BRIDGE_MODULE;
  const shim = opts.shimModule ?? DEFAULT_SHIM_MODULE;

  // any tool that routes through the bridge needs `callTool`; any native sdk tool needs the shim. A
  // first-party CONTRACT tool brings its own inline execute → it needs NEITHER (no bridge, no plugin).
  const nativeSdk = tools.filter(isNativeSdk);
  const needsBridge = tools.some((t) => t.source !== 'contract' && !isNativeSdk(t));
  const needsShim = nativeSdk.length > 0;

  // dedupe distinct plugin modules → one stable import each (`__ocPlugin_<i>`); map module → ident.
  const modIdent = new Map<string, string>();
  const pluginImports: string[] = [];
  for (const t of nativeSdk) {
    const mod = t.pluginModule as string;
    if (!modIdent.has(mod)) {
      const ident = `__ocPlugin_${modIdent.size}`;
      modIdent.set(mod, ident);
      pluginImports.push(`import * as ${ident} from ${JSON.stringify(mod)};`);
    }
  }

  const imports = ['import { Type } from "typebox";'];
  // A bridge-backed extension also imports `disposeBridge` so it can CLOSE the MCP/openclaw connections
  // when the agent loop ends (the cleanup snippet below). Without that, an open Streamable-HTTP/SSE socket
  // keeps the spawned `pi` process's event loop alive, so the node exits NONZERO at teardown — which makes
  // the runner skip output collection (it only collects on exit 0). The bridge's own `beforeExit` hook can't
  // save this: `beforeExit` only fires once the loop DRAINS, and the open socket is exactly what prevents it.
  if (needsBridge) imports.push(`import { callTool, disposeBridge } from ${JSON.stringify(bridge)};`);
  if (needsShim) imports.push(`import { captureOpenClawTools } from ${JSON.stringify(shim)};`);
  imports.push(...pluginImports);

  // #21: emit the Gemini-safe `StringEnum` preamble helper iff some tool's params carry an all-string enum
  // (renderParamsExpr emits `StringEnum([...])` for those). Absent any enum ⇒ no preamble (byte-identical).
  const needsStringEnum = tools.some((t) => paramsNeedStringEnum(t.parameters ?? EMPTY_SCHEMA));
  const preamble = needsStringEnum ? ['', STRING_ENUM_PREAMBLE] : [];

  // Close the bridge when the agent loop ends so the spawned node can exit 0 (see the import note above).
  // Gated on `needsBridge`: a builtins-only / native-sdk-only / contract-only extension stays byte-identical.
  const cleanup = needsBridge
    ? [
        '  // Release MCP/bridge connections at agent end so the open transport socket does not keep this',
        '  // process alive (an unclosed Streamable-HTTP/SSE connection makes a spawned node exit nonzero).',
        '  pi.on("agent_end", async () => { try { await disposeBridge(); } catch {} });',
      ]
    : [];

  return [
    '// GENERATED by @piflow/core compileToolExtension — do not edit by hand.',
    '// Binds each declared sdk/mcp tool to the headless pi agent. mcp tools (and unpinned sdk tools)',
    '// route execute through the bridge by address; pinned sdk (OpenClaw) tools bind their native execute.',
    ...imports,
    ...preamble,
    '',
    'export default function (pi) {',
    ...cleanup,
    tools.map((t) => renderTool(t, isNativeSdk(t) ? modIdent.get(t.pluginModule as string) : undefined)).join('\n'),
    '}',
    '',
  ].join('\n');
}

/** Plan + render. Returns the `-e` source and the exact piNames bound (the bind-check ground truth). */
export function compileToolExtension(entries: ToolEntry[], opts: CompileOpts = {}): CompiledExtension {
  const tools = planTools(entries);
  return { source: renderExtension(tools, opts), registered: tools.map((t) => t.piName) };
}

// ── the BUNDLE seam (host-side, before staging) ───────────────────────────────────────────────────
// pi's jiti loader resolves the extension's imports from the STAGED FILE's own directory (delivery
// brief). That works only when an up-tree `node_modules` carries `@piflow/tool-bridge` + the MCP SDK —
// false on an outside-repo temp dir (InMemory) and an empty cloud VM. The cross-provider-robust fix is
// to esbuild-bundle the rendered extension into ONE self-contained ESM file: the bridge + SDK (and any
// pinned OpenClaw plugin + the shim) are INLINED, and the only imports left are the ones pi INJECTS via
// its alias map (typebox + @earendil-works/* aliases + node builtins), which stay EXTERNAL so there is
// one typebox instance and the real injected `pi`/`defineTool`. Identical bytes resolve on every provider.

/**
 * The pi-injected specifiers (loader.js alias map) kept EXTERNAL — bundling them in would fork typebox /
 * the pi runtime. Node builtins are external automatically under `platform:'node'`.
 */
export const PI_INJECTED_EXTERNALS: readonly string[] = [
  'typebox', 'typebox/compile', 'typebox/value',
  '@sinclair/typebox', '@sinclair/typebox/compile', '@sinclair/typebox/value',
  '@earendil-works/pi-coding-agent', '@earendil-works/pi-ai', '@earendil-works/pi-agent-core',
  '@earendil-works/pi-tui', '@earendil-works/pi-ai/oauth',
  '@mariozechner/pi-coding-agent', '@mariozechner/pi-ai', '@mariozechner/pi-agent-core', '@mariozechner/pi-tui',
];

/** Bundling knobs. */
export interface BundleOpts {
  /**
   * Directory esbuild resolves the extension's bare imports from — MUST be a location where
   * `@piflow/tool-bridge` + `@modelcontextprotocol/sdk` (and any pinned plugin) resolve ON THE HOST
   * (the repo/worktree root). Defaults to the auto-detected repo root (see {@link detectRepoRoot}).
   */
  resolveDir?: string;
}

/**
 * Walk up from a starting dir until a directory containing `node_modules/@piflow/tool-bridge` is found
 * (the host anchor where the bridge + the hoisted MCP SDK resolve). Falls back to `process.cwd()`.
 */
function detectRepoRoot(): string {
  // anchor on this module's location first, then cwd — covers both the installed-dep and in-repo cases.
  const starts = [dirname(fileURLToPath(import.meta.url)), process.cwd()];
  for (const start of starts) {
    let dir = start;
    for (;;) {
      if (existsSync(join(dir, 'node_modules', '@piflow', 'tool-bridge'))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return process.cwd();
}

/**
 * Bundle a rendered extension source into ONE self-contained ESM string (esbuild `buildSync`, so the
 * registry's `resolve()` stays SYNCHRONOUS). Inlines the bridge/SDK/plugin/shim; keeps the pi-injected
 * specifiers external. `format:'esm'` is mandatory: a `cjs` output would hit the MCP SDK's
 * "Dynamic require of … is not supported" / "Top-level await not supported with cjs" trap. Composes OVER
 * `renderExtension` — the rendered string is PURE; this is a separate pass. Empty in → empty out.
 */
export function bundleExtension(source: string, opts: BundleOpts = {}): string {
  if (!source) return '';
  const resolveDir = opts.resolveDir ?? detectRepoRoot();
  const result = esbuild.buildSync({
    stdin: { contents: source, resolveDir, loader: 'ts', sourcefile: '_pi/tools.ts' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['node20'],
    write: false,
    external: [...PI_INJECTED_EXTERNALS],
  });
  return result.outputFiles[0].text;
}
