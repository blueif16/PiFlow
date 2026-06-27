import { describe, it, expect } from 'vitest';
import {
  compileToolExtension,
  planTools,
  DEFAULT_BRIDGE_MODULE,
  BUILTIN_TOOLS,
} from '../src/index.js';
import { bundleExtension } from '../src/tools/compile.js';
import { captureOpenClawTools } from '../src/tools/openclaw-shim.js';
import pureFixture from './fixtures/pure-openclaw-plugin.js';
import type { ToolEntry } from '../src/index.js';

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────

const MCP_ISSUE: ToolEntry = {
  address: 'mcp.github:create_issue',
  source: 'mcp',
  piName: 'github_create_issue',
  description: 'Open a new issue in a repository.',
  parameters: { type: 'object', properties: { repo: { type: 'string' } }, required: ['repo'] },
  origin: { kind: 'mcp-server', ref: 'github' },
};
const SDK_SEARCH: ToolEntry = {
  address: 'web:search',
  source: 'sdk',
  piName: 'web_search',
  description: 'Search the web.',
  // no parameters → an empty object schema must be emitted
};

/**
 * THE MEANINGFUL HARNESS — instantiate the generated extension the way pi would, but against stubs.
 * pi's loader bundles `typebox` + the bridge; here we strip the import lines and inject a `Type` stub
 * (Unsafe → identity, so we can read back the embedded schema) and a `callTool` spy, then run the
 * default-exported factory against a fake `pi` that records every registerTool. This proves the
 * GENERATED CODE actually binds the right tools + routes execute correctly — not just that a string
 * contains some substrings.
 */
function instantiate(
  source: string,
  callTool: (...a: unknown[]) => unknown,
  disposeBridge: () => unknown = () => undefined,
) {
  const body = source
    .replace(/^\s*import[^\n]*\n/gm, '') // drop `import {Type} from "typebox"` + bridge import (callTool, disposeBridge)
    .replace(/export\s+default\s+function/m, 'return function'); // capture the factory
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const make = new Function('Type', 'callTool', 'disposeBridge', body);
  const TypeStub = { Unsafe: (s: unknown) => s, Object: (s: unknown) => s };
  const factory = make(TypeStub, callTool, disposeBridge) as (pi: unknown) => void;
  const registered: Array<Record<string, any>> = [];
  // The bridge extension also registers a `pi.on("agent_end", …)` cleanup; the fake `pi` accepts and ignores
  // it so the tool-binding assertions are unaffected. The dedicated cleanup test below uses its own `pi`
  // that CAPTURES the handler and proves it disposes the bridge.
  factory({ registerTool: (def: Record<string, any>) => registered.push(def), on: () => undefined });
  return registered;
}

// ── plan ──────────────────────────────────────────────────────────────────────────────────────────

describe('planTools — which entries become generated tools', () => {
  it('skips builtins (pi exposes those natively) and plans only sdk/mcp', () => {
    const plan = planTools([...BUILTIN_TOOLS, MCP_ISSUE, SDK_SEARCH]);
    expect(plan.map((p) => p.piName)).toEqual(['github_create_issue', 'web_search']);
    expect(plan.every((p) => p.source !== 'builtin')).toBe(true);
  });
});

// ── compile / render ────────────────────────────────────────────────────────────────────────────

describe('compileToolExtension — the generated -e extension', () => {
  it('emits NO extension when only builtins are selected', () => {
    const out = compileToolExtension(BUILTIN_TOOLS);
    expect(out).toEqual({ source: '', registered: [] });
  });

  it('reports the exact piNames it registered (the bind-check ground truth)', () => {
    const out = compileToolExtension([MCP_ISSUE, SDK_SEARCH]);
    expect(out.registered).toEqual(['github_create_issue', 'web_search']);
  });

  it('imports the bridge module (default, overridable)', () => {
    expect(compileToolExtension([MCP_ISSUE]).source).toContain(`from "${DEFAULT_BRIDGE_MODULE}"`);
    expect(compileToolExtension([MCP_ISSUE], { bridgeModule: '../bridge.ts' }).source)
      .toContain('from "../bridge.ts"');
  });

  it('GENERATES a loadable extension that registers each tool with name/description/params', () => {
    const out = compileToolExtension([MCP_ISSUE, SDK_SEARCH]);
    const registered = instantiate(out.source, () => ({ content: [] }));

    expect(registered.map((d) => d.name)).toEqual(['github_create_issue', 'web_search']);

    const issue = registered[0];
    expect(issue.description).toBe('Open a new issue in a repository.');
    expect(issue.parameters).toEqual(MCP_ISSUE.parameters); // embedded JSON-Schema preserved verbatim

    const search = registered[1];
    expect(search.parameters).toEqual({ type: 'object', properties: {} }); // no schema → empty object
  });

  it('routes execute to the bridge BY ADDRESS and returns the bridge result', async () => {
    const out = compileToolExtension([MCP_ISSUE]);
    const calls: unknown[][] = [];
    const bridgeResult = { content: [{ type: 'text', text: 'BRIDGED' }] };
    const registered = instantiate(out.source, (...args) => {
      calls.push(args);
      return bridgeResult;
    });

    const result = await registered[0].execute('tc-1', { repo: 'acme/widgets' });
    expect(result).toBe(bridgeResult); // execute returns whatever the bridge returns
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('mcp.github:create_issue'); // routed by the SDK address, not the piName
    expect(calls[0][1]).toEqual({ repo: 'acme/widgets' }); // params passed through unchanged
  });

  it('is ROBUST to quotes/newlines/backticks in a description (escaped, not concatenated)', () => {
    const nasty: ToolEntry = {
      address: 'web:weird',
      source: 'sdk',
      piName: 'web_weird',
      // a description engineered to break naive string concat / inject code if not JSON.stringified
      description: 'has "double" and \'single\' quotes,\nnewlines, a ${injection}, and `backticks`.',
    };
    const out = compileToolExtension([nasty]);
    // must still produce a parseable, loadable extension whose description round-trips EXACTLY.
    const registered = instantiate(out.source, () => ({ content: [] }));
    expect(registered[0].description).toBe(nasty.description);
  });
});

// ── the sdk branch: register a plugin's NATIVE execute (not callTool) ──────────────────────────────
// An `sdk` (OpenClaw) tool must NOT route through the bridge. The generated extension imports the pinned
// plugin module + the capture-shim, runs the shim to get the plugin's own tool def, and registers its
// NATIVE execute. The fixture below proves the generated code does exactly that — calling execute returns
// the plugin's local computation, and `callTool` is NEVER invoked.

const SDK_FIXTURE_TOOL: ToolEntry = {
  address: 'oc.fixture-pure:fixture_echo',
  source: 'sdk',
  piName: 'fixture_pure_fixture_echo',
  description: 'Echo a message back (pure compute, no gateway).',
  parameters: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
  // origin.ref is the import specifier the generated extension imports the plugin from.
  origin: { kind: 'openclaw-plugin', ref: './fixtures/pure-openclaw-plugin.js' },
};

/**
 * Instantiate a generated extension that contains the sdk branch. Like `instantiate`, but also injects
 * the capture-shim (`captureOpenClawTools`) and the plugin module namespace(s) the generated code imports.
 * The generated sdk code imports each distinct plugin module as `__ocPlugin_<i>` and the shim by name;
 * we strip the imports and pass those identifiers in as Function args (the real pi/esbuild path resolves
 * them via the bundle — proven separately by the bundle tests).
 */
function instantiateSdk(source: string, pluginModules: unknown[], callTool: (...a: unknown[]) => unknown) {
  const body = source
    .replace(/^\s*import[^\n]*\n/gm, '')
    .replace(/export\s+default\s+function/m, 'return function');
  const argNames = ['Type', 'callTool', 'captureOpenClawTools', ...pluginModules.map((_, i) => `__ocPlugin_${i}`)];
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const make = new Function(...argNames, body);
  const TypeStub = { Unsafe: (s: unknown) => s, Object: (s: unknown) => s };
  const factory = make(TypeStub, callTool, captureOpenClawTools, ...pluginModules) as (pi: unknown) => void;
  const registered: Array<Record<string, any>> = [];
  factory({ registerTool: (def: Record<string, any>) => registered.push(def), on: () => undefined });
  return registered;
}

describe('compileToolExtension — the sdk branch (native execute, NOT the bridge)', () => {
  it('plans an sdk tool with its plugin module + raw tool name (the import targets)', () => {
    const [p] = planTools([SDK_FIXTURE_TOOL]);
    expect(p.source).toBe('sdk');
    expect(p.rawName).toBe('fixture_echo'); // the name the plugin actually registered (after the colon)
    expect(p.pluginModule).toBe('./fixtures/pure-openclaw-plugin.js'); // derived from origin.ref
  });

  it('imports the capture-shim + the plugin module, and does NOT emit a callTool route for the sdk tool', () => {
    const src = compileToolExtension([SDK_FIXTURE_TOOL]).source;
    expect(src).toContain('captureOpenClawTools'); // the shim is wired in
    expect(src).toContain('./fixtures/pure-openclaw-plugin.js'); // the plugin module is imported
    expect(src).not.toContain('callTool('); // the sdk branch must NOT route through the bridge
  });

  it('GENERATES an extension that registers the plugin\'s NATIVE execute (computes locally, no bridge)', async () => {
    const src = compileToolExtension([SDK_FIXTURE_TOOL]).source;
    let bridgeCalls = 0;
    const registered = instantiateSdk(src, [pureFixture], () => {
      bridgeCalls++;
      return { content: [] };
    });

    expect(registered.map((d) => d.name)).toEqual(['fixture_pure_fixture_echo']); // SDK piName used
    expect(registered[0].parameters).toEqual(SDK_FIXTURE_TOOL.parameters); // captured/ingested schema

    // the execute is the plugin's OWN function — it computes locally and NEVER calls the bridge.
    const result = await registered[0].execute('tc-1', { msg: 'hi' });
    expect(result).toEqual({ content: [{ type: 'text', text: 'ECHO:hi' }] });
    expect(bridgeCalls).toBe(0); // the bridge was not touched — this is a native sdk tool
  });

  it('leaves the mcp branch exactly as-is (still routes through callTool by address)', async () => {
    // an mcp tool in the SAME extension must keep the bridge route untouched by the sdk branch.
    const src = compileToolExtension([MCP_ISSUE]).source;
    const calls: unknown[][] = [];
    const registered = instantiate(src, (...args) => {
      calls.push(args);
      return { content: [{ type: 'text', text: 'BRIDGED' }] };
    });
    await registered[0].execute('tc-1', { repo: 'a/b' });
    expect(calls[0][0]).toBe('mcp.github:create_issue'); // mcp still routed by address
  });
});

// ── bridge cleanup on agent_end (the MCP-node clean-exit fix) ───────────────────────────────────────
// BUG: a node that bound an MCP tool left the bridge's Streamable-HTTP/SSE connection open, so the spawned
// `pi` process never drained its event loop and exited NONZERO at teardown (observed: a deepwiki node exited
// 1 / hung), which made the runner SKIP output collection (it only collects on exit 0). FIX: the generated
// bridge extension registers a `pi.on("agent_end", …)` handler that disposes the bridge, closing the socket
// so the node can exit 0. (The bridge's own `beforeExit` can't save it — that only fires once the loop drains,
// and the open socket is what prevents the drain.)
describe('compileToolExtension — bridge cleanup on agent_end (MCP node exits cleanly)', () => {
  // Load the generated factory against a fake `pi` that CAPTURES lifecycle handlers, plus a disposeBridge spy.
  function lifecycleHandlers(source: string, disposeBridge: () => unknown) {
    const body = source
      .replace(/^\s*import[^\n]*\n/gm, '')
      .replace(/export\s+default\s+function/m, 'return function');
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const make = new Function('Type', 'callTool', 'disposeBridge', body);
    const TypeStub = { Unsafe: (s: unknown) => s, Object: (s: unknown) => s };
    const factory = make(TypeStub, () => ({ content: [] }), disposeBridge) as (pi: unknown) => void;
    const handlers: Record<string, Array<(...a: unknown[]) => unknown>> = {};
    factory({
      registerTool: () => undefined,
      on: (e: string, h: (...a: unknown[]) => unknown) => {
        (handlers[e] ??= []).push(h);
      },
    });
    return handlers;
  }

  it('an MCP extension imports disposeBridge alongside callTool', () => {
    expect(compileToolExtension([MCP_ISSUE]).source).toMatch(/import\s*\{[^}]*\bdisposeBridge\b[^}]*\}\s*from/);
  });

  it('registers an agent_end handler that actually disposes the bridge', async () => {
    let disposed = 0;
    const handlers = lifecycleHandlers(compileToolExtension([MCP_ISSUE]).source, async () => {
      disposed += 1;
    });
    // FAILS before the fix: no agent_end handler is registered at all (handlers['agent_end'] is undefined).
    expect(handlers['agent_end']?.length).toBe(1);
    // and the registered handler must REALLY close the bridge (not a no-op).
    await handlers['agent_end']![0]({ type: 'agent_end', messages: [] }, {});
    expect(disposed).toBe(1);
  });

  it('adds NO bridge disposer when no bridge tool is used (native-sdk stays bridge-free)', () => {
    const src = compileToolExtension([SDK_FIXTURE_TOOL]).source;
    expect(src).not.toContain('disposeBridge');
    expect(src).not.toContain('agent_end');
  });
});

// ── StringEnum normalization (#21 — Gemini-safe enum) ───────────────────────────────────────────────
// A generated param schema with an all-string `{ enum: [...] }` must render as the Gemini-safe StringEnum
// form (a generated-preamble helper emitting `{ type:'string', enum:[...] }`), NOT a raw `enum` array left
// inside `Type.Unsafe(...)` (which Google rejects) nor a `Type.Union` of literals. Authoring is unchanged;
// the compiler produces the safe form. A param with NO enum must render byte-identically to today.

describe('compileToolExtension — StringEnum normalization (#21, Gemini-safe)', () => {
  const ENUM_TOOL: ToolEntry = {
    address: 'oc.report:status',
    source: 'sdk',
    piName: 'report_status',
    description: 'Report a status.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['ok', 'gap', 'blocked'], description: 'the verdict' },
      },
      required: ['status'],
    },
  };

  it('renders an all-string enum param via the StringEnum helper, not a raw enum / Type.Union', () => {
    const src = compileToolExtension([ENUM_TOOL]).source;
    // the generated extension defines + uses a StringEnum helper carrying the three values.
    expect(src).toContain('StringEnum');
    expect(src).toMatch(/StringEnum\(\["ok","gap","blocked"\]\)/);
    // it must NOT leave the all-string enum as a bare JSON array inside Type.Unsafe (the Gemini-unsafe form),
    // nor wrap it in Type.Union.
    expect(src).not.toContain('"enum":["ok","gap","blocked"]');
    expect(src).not.toContain('Type.Union');
  });

  it('emits a StringEnum helper definition in the preamble (a real, callable factory)', () => {
    const src = compileToolExtension([ENUM_TOOL]).source;
    // the helper is DEFINED (a const/function) so the generated `StringEnum(...)` call resolves at load.
    expect(src).toMatch(/(const|function)\s+StringEnum\b/);
    // and it produces the Gemini-safe `{ type:'string', enum }` shape (carries type:'string').
    expect(src).toMatch(/type:\s*['"]string['"]/);
  });

  it('ADDITIVITY: a param with NO enum renders byte-identically (still a flat Type.Unsafe of the schema)', () => {
    // MCP_ISSUE has no enum anywhere → its param block must be the unchanged `Type.Unsafe(<json>)` form,
    // and the StringEnum helper must NOT be emitted (nothing needs it).
    const src = compileToolExtension([MCP_ISSUE]).source;
    expect(src).toContain(`parameters: Type.Unsafe(${JSON.stringify(MCP_ISSUE.parameters)}),`);
    expect(src).not.toContain('StringEnum');
  });
});

// ── the bundle seam: one self-contained ESM file (cross-provider delivery) ──────────────────────────
// pi's jiti loader resolves an extension's imports from the staged file's OWN location, which fails on an
// outside-repo temp dir / empty cloud VM. The fix: esbuild-bundle the rendered extension so the only
// imports left are the ones pi INJECTS via its alias map (typebox + @earendil-works/* + node builtins).
// `@piflow/tool-bridge` + `@modelcontextprotocol/sdk` get INLINED; typebox stays EXTERNAL.

describe('bundleExtension — esbuild self-contained ESM bundle', () => {
  it('INLINES @piflow/tool-bridge + @modelcontextprotocol/sdk (their import statements are gone)', () => {
    const src = compileToolExtension([MCP_ISSUE]).source;
    const bundled = bundleExtension(src);
    // No EXECUTABLE import statement (line-anchored, so esbuild's `// node_modules/…` path comments and
    // JSDoc example strings don't count) for the inlined specifiers — they were pulled into the bundle.
    const importLines = bundled.split('\n').filter((l) => /^\s*import\s/.test(l));
    expect(importLines.some((l) => /@piflow\/tool-bridge/.test(l))).toBe(false);
    expect(importLines.some((l) => /@modelcontextprotocol\/sdk/.test(l))).toBe(false);
    // the bundle is non-trivially larger than the source (the runtime was pulled in).
    expect(bundled.length).toBeGreaterThan(src.length * 5);
  });

  it('KEEPS the pi-injected specifiers EXTERNAL (typebox import survives verbatim)', () => {
    const bundled = bundleExtension(compileToolExtension([MCP_ISSUE]).source);
    // typebox is in pi's alias map → it must remain an external import (one instance via pi's copy).
    expect(bundled).toMatch(/from\s*['"]typebox['"]/);
  });

  it('BUILDS clean as ESM (the CJS/TLA trap is avoided) and preserves the default-export factory', () => {
    // building without throwing is the witness that format:'esm' avoided the
    // "Dynamic require / Top-level await not supported with cjs" failure mode.
    const bundled = bundleExtension(compileToolExtension([MCP_ISSUE]).source);
    // esbuild emits the default export as `export { <ident> as default }` (or `export default`).
    expect(bundled).toMatch(/export\s*\{[^}]*\bas default\b|export\s+default/);
  });

  it('returns empty for an empty source (nothing to bundle)', () => {
    expect(bundleExtension('')).toBe('');
  });
});
