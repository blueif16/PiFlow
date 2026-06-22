import { describe, it, expect } from 'vitest';
import {
  compileToolExtension,
  planTools,
  DEFAULT_BRIDGE_MODULE,
  BUILTIN_TOOLS,
} from '../src/index.js';
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
function instantiate(source: string, callTool: (...a: unknown[]) => unknown) {
  const body = source
    .replace(/^\s*import[^\n]*\n/gm, '') // drop `import {Type} from "typebox"` + bridge import
    .replace(/export\s+default\s+function/m, 'return function'); // capture the factory
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const make = new Function('Type', 'callTool', body);
  const TypeStub = { Unsafe: (s: unknown) => s, Object: (s: unknown) => s };
  const factory = make(TypeStub, callTool) as (pi: unknown) => void;
  const registered: Array<Record<string, any>> = [];
  factory({ registerTool: (def: Record<string, any>) => registered.push(def) });
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
