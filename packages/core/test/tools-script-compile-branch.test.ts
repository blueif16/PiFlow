// compile.ts's `script` branch: a `ToolEntry` with `source:'script'` renders via `renderScriptTool` (its
// own inline execute), never the bridge/native-sdk route — the same additivity discipline the `contract`
// branch already proves. Verifies planTools carries `exec` through, the generated extension imports
// `execFile` (not the bridge), and a MIXED extension (script + mcp) imports BOTH lanes correctly.

import { describe, it, expect } from 'vitest';
import { compileToolExtension, planTools, DEFAULT_BRIDGE_MODULE } from '../src/index.js';
import type { ToolEntry } from '../src/index.js';

const SCRIPT_TOOL: ToolEntry = {
  address: 'tool:demo_probe',
  source: 'script',
  piName: 'demo_probe',
  description: 'Echo the given message back.',
  parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
  origin: { kind: 'native' },
  exec: { cmd: 'node', argv: ['/abs/tools/demo_probe/probe.mjs'], timeoutMs: 5000 },
};

const MCP_ISSUE: ToolEntry = {
  address: 'mcp.github:create_issue',
  source: 'mcp',
  piName: 'github_create_issue',
  description: 'Open a new issue.',
  parameters: { type: 'object', properties: { repo: { type: 'string' } } },
  origin: { kind: 'mcp-server', ref: 'github' },
};

describe('planTools — carries the script exec contract through', () => {
  it('sets `exec` for a script-source entry (and leaves it undefined for others)', () => {
    const plan = planTools([SCRIPT_TOOL, MCP_ISSUE]);
    expect(plan[0].source).toBe('script');
    expect(plan[0].exec).toEqual(SCRIPT_TOOL.exec);
    expect(plan[1].exec).toBeUndefined();
  });
});

describe('compileToolExtension — the script branch', () => {
  it('registers the script tool inline (pi.registerTool with the manifest-derived name)', () => {
    const src = compileToolExtension([SCRIPT_TOOL]).source;
    expect(src).toContain('pi.registerTool({');
    expect(src).toContain('"demo_probe"');
    expect(src).toContain('/abs/tools/demo_probe/probe.mjs');
  });

  it('reports the piName in `registered` (the bind-check ground truth)', () => {
    const out = compileToolExtension([SCRIPT_TOOL]);
    expect(out.registered).toEqual(['demo_probe']);
  });

  it('imports execFile (node:child_process), NEVER the bridge, for a script-only extension', () => {
    const src = compileToolExtension([SCRIPT_TOOL]).source;
    expect(src).toContain('import { execFile } from "node:child_process";');
    expect(src).not.toContain(DEFAULT_BRIDGE_MODULE);
    expect(src).not.toContain('callTool(');
  });

  it('a MIXED extension (script + mcp) imports BOTH execFile and the bridge', () => {
    const src = compileToolExtension([SCRIPT_TOOL, MCP_ISSUE]).source;
    expect(src).toContain('import { execFile } from "node:child_process";');
    expect(src).toContain(DEFAULT_BRIDGE_MODULE);
    // the mcp tool still routes through callTool; the script tool must NOT.
    expect(src).toContain(`callTool(${JSON.stringify(MCP_ISSUE.address)}`);
  });
});
