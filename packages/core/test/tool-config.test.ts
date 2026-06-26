import { describe, it, expect } from 'vitest';

import { assembleRunTools } from '../src/runner/tool-config.js';
import { verifyToolBinding } from '../src/tools/verify.js';
import type { WorkflowSpec, NodeIntent } from '../src/types.js';

// ── M1 — `assembleRunTools` seeds the catalog into the canonical run path. ───────────────────────────
//
// The blocker (design §4, investigation §3a): the ingest→schema→bind→execute tool pipeline is fully built
// (`seededRegistry()` carries the `oc.calc:add` sdk seed + the community catalog) but has ZERO non-test
// callers, so the canonical run path falls through to `new DefaultToolRegistry()` (runner.ts:1347) — a
// registry that does NOT carry `oc.calc:add`. `assembleRunTools` is the single pure builder that produces
// the run's registry (a seeded one) so a node-declared `oc.*`/`mcp.*` tool BINDS.
//
// This is the M1 TEST-FIRST gate. It is a deterministic unit test (no pi): `assembleRunTools` over a spec
// with an `oc.calc:add` node returns a registry where `verifyToolBinding('oc.calc:add')` is FOUND (not
// MISSING). It FAILS today because `tool-config.ts` does not exist — no production caller seeds
// `seededRegistry`/`loadCatalog`.

/** A minimal one-node WorkflowSpec whose node selects the `oc.calc:add` catalog tool. */
function specWithCalcNode(extra: Partial<NodeIntent> = {}): WorkflowSpec {
  const node: NodeIntent = {
    label: 'calc',
    prompt: 'add two numbers',
    tools: { allow: ['oc.calc:add', 'contract:submit_result', 'fs:write'] },
    io: {
      reads: [],
      produces: ['out/sum.txt'],
      externalInputs: [],
      dependsOn: [],
      artifacts: [{ path: 'out/sum.txt' }],
    },
    ...extra,
  };
  return { meta: { name: 'calc-wf', description: 'one calc node' }, nodes: [node] };
}

describe('assembleRunTools — seeds the catalog so a node-declared oc.* tool BINDS on the canonical path', () => {
  it('over a spec with an oc.calc:add node yields a registry where verifyToolBinding finds it (not MISSING)', () => {
    const spec = specWithCalcNode();

    const { registry } = assembleRunTools({ spec });

    // THE LOAD-BEARING ASSERTION: the assembled registry carries `oc.calc:add`, so a node selecting it
    // binds. `verifyToolBinding` over the registry's catalog must NOT report it missing. Today this throws
    // (no `tool-config.ts`); after M1 lands it resolves and `bind.missing` is empty.
    const bind = verifyToolBinding(spec.nodes[0].tools, registry.list());
    expect(bind.missing).not.toContain('oc.calc:add');
    expect(bind.ok).toBe(true);
    // It bound to the seed's bare pi name (`calc_add`), proving the catalog row reached the registry.
    expect(bind.bound).toContain('calc_add');
  });

  // ADDITIVITY: the assembled registry must be a SUPERSET of DefaultToolRegistry for the first-party
  // contract tool too — `seededRegistry()` alone DROPS `submit_result` (catalog.ts:58 = builtins+catalog,
  // no contract tool). A node declaring `contract:submit_result` MUST still bind, else M1 unblocks
  // `oc.calc:add` but RE-blocks every submit_result node (the M0 finding, runner-live-tool-e2e.test.ts:24).
  it('keeps the first-party submit_result contract tool (seededRegistry ⊉ it; assembleRunTools must add it)', () => {
    const spec = specWithCalcNode();
    const { registry } = assembleRunTools({ spec });

    const bind = verifyToolBinding(spec.nodes[0].tools, registry.list());
    expect(bind.missing).not.toContain('contract:submit_result');
    expect(bind.bound).toContain('submit_result');
  });

  // The mcpConfig is the UNION of every node's `mcp.servers`; absent any `mcp` ⇒ no mcpConfig (additive:
  // an all-native template stages no `_pi/mcp.json`).
  it('returns no mcpConfig when no node declares mcp (an all-native template stages nothing)', () => {
    const { mcpConfig } = assembleRunTools({ spec: specWithCalcNode() });
    expect(mcpConfig).toBeUndefined();
  });

  // The MCP union: two nodes each declaring a DISTINCT server key are merged into one mcpConfig.servers.
  it('unions every node mcp.servers into one mcpConfig', () => {
    const a: NodeIntent = {
      label: 'a',
      prompt: 'a',
      tools: { allow: ['mcp.github:create_issue'] },
      io: { reads: [], produces: [], externalInputs: [], dependsOn: [], artifacts: [] },
      mcp: { servers: { github: { transport: 'http', url: 'https://api.example/mcp/' } } },
    };
    const b: NodeIntent = {
      label: 'b',
      prompt: 'b',
      tools: { allow: ['mcp.linear:list_issues'] },
      io: { reads: [], produces: [], externalInputs: [], dependsOn: [], artifacts: [] },
      mcp: { servers: { linear: { transport: 'http', url: 'https://api.linear/mcp/' } } },
    };
    const spec: WorkflowSpec = { meta: { name: 'mcp-wf', description: '' }, nodes: [a, b] };

    const { mcpConfig } = assembleRunTools({ spec });
    expect(mcpConfig?.servers).toEqual({
      github: { transport: 'http', url: 'https://api.example/mcp/' },
      linear: { transport: 'http', url: 'https://api.linear/mcp/' },
    });
  });

  // CONFLICT GUARD: the same server key declared with DIFFERENT config across two nodes throws — never a
  // silent last-wins (a byte-identical duplicate is allowed).
  it('throws on a non-byte-identical duplicate server key across nodes (never silent last-wins)', () => {
    const a: NodeIntent = {
      label: 'a',
      prompt: 'a',
      tools: { allow: ['mcp.github:create_issue'] },
      io: { reads: [], produces: [], externalInputs: [], dependsOn: [], artifacts: [] },
      mcp: { servers: { github: { transport: 'http', url: 'https://api.example/mcp/' } } },
    };
    const b: NodeIntent = {
      label: 'b',
      prompt: 'b',
      tools: { allow: ['mcp.github:close_issue'] },
      io: { reads: [], produces: [], externalInputs: [], dependsOn: [], artifacts: [] },
      mcp: { servers: { github: { transport: 'http', url: 'https://DIFFERENT/mcp/' } } },
    };
    const spec: WorkflowSpec = { meta: { name: 'mcp-wf', description: '' }, nodes: [a, b] };

    expect(() => assembleRunTools({ spec })).toThrow(/github/);
  });

  // A byte-identical duplicate server key across nodes is allowed (the common "two nodes hit the same
  // server" case) — it merges to one entry, no throw.
  it('allows a byte-identical duplicate server key across nodes', () => {
    const cfg = { transport: 'http', url: 'https://api.example/mcp/' };
    const a: NodeIntent = {
      label: 'a',
      prompt: 'a',
      tools: { allow: ['mcp.github:create_issue'] },
      io: { reads: [], produces: [], externalInputs: [], dependsOn: [], artifacts: [] },
      mcp: { servers: { github: { ...cfg } } },
    };
    const b: NodeIntent = {
      label: 'b',
      prompt: 'b',
      tools: { allow: ['mcp.github:close_issue'] },
      io: { reads: [], produces: [], externalInputs: [], dependsOn: [], artifacts: [] },
      mcp: { servers: { github: { ...cfg } } },
    };
    const spec: WorkflowSpec = { meta: { name: 'mcp-wf', description: '' }, nodes: [a, b] };

    const { mcpConfig } = assembleRunTools({ spec });
    expect(mcpConfig?.servers).toEqual({ github: cfg });
  });
});
