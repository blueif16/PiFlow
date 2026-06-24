import { describe, it, expect } from 'vitest';
import { verifyToolBinding, BUILTIN_TOOLS, mcpToolsToEntries } from '../src/index.js';
import type { ToolEntry } from '../src/index.js';

const MCP = mcpToolsToEntries('github', [
  { name: 'create_issue', description: 'Open an issue.' },
]); // → address mcp.github:create_issue, piName github_create_issue
const CATALOG: ToolEntry[] = [...BUILTIN_TOOLS, ...MCP];

describe('verifyToolBinding — the per-node bind pre-check', () => {
  it('passes a default (empty) selection: the node binds every builtin', () => {
    const r = verifyToolBinding({}, CATALOG);
    expect(r.ok).toBe(true);
    expect(r.bound).toEqual(expect.arrayContaining(['read', 'write', 'bash']));
    expect(r.missing).toEqual([]);
    expect(r.collisions).toEqual([]);
  });

  it('passes a mixed builtin + mcp selection and reports the exact bound bare names', () => {
    const r = verifyToolBinding({ allow: ['fs:read', 'mcp.github:create_issue'] }, CATALOG);
    expect(r.ok).toBe(true);
    expect(r.bound).toEqual(['read', 'github_create_issue']);
    expect(r.declared).toEqual(['fs:read', 'mcp.github:create_issue']);
  });

  it('honors deny: a denied tool is neither declared nor bound', () => {
    const r = verifyToolBinding({ allow: ['fs:read', 'fs:write'], deny: ['fs:write'] }, CATALOG);
    expect(r.ok).toBe(true);
    expect(r.bound).toEqual(['read']);
    expect(r.declared).toEqual(['fs:read']);
  });

  it('FAILS when a declared address is not in the catalog (the function will not bind)', () => {
    const r = verifyToolBinding({ allow: ['fs:read', 'mcp.slack:post_message'] }, CATALOG);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['mcp.slack:post_message']);
    expect(r.issues.join(' ')).toMatch(/mcp\.slack:post_message/);
  });

  it('FAILS on a bare-name collision: two declared addresses mapping to one piName', () => {
    // two DISTINCT addresses deliberately sharing a bare name (the pi flat-namespace skip hazard).
    const clashy: ToolEntry[] = [
      { address: 'a:dup', source: 'sdk', piName: 'dup', description: 'A' },
      { address: 'b:dup', source: 'sdk', piName: 'dup', description: 'B' },
    ];
    const r = verifyToolBinding({ allow: ['a:dup', 'b:dup'] }, [...BUILTIN_TOOLS, ...clashy]);
    expect(r.ok).toBe(false);
    expect(r.collisions).toEqual([{ piName: 'dup', addresses: ['a:dup', 'b:dup'] }]);
    expect(r.issues.join(' ')).toMatch(/collision|collide/i);
  });
});
