// claudeCommand — the headless Claude Code (`claude-code` executor) command builder (PURE LOGIC gate,
// test-discipline §0). Local subscription, builtins only, for read/write/fix/debug.
//
// The contract IS the `claude -p` string (docs/design/agent-executor-interface.md §5): a CommandBuilder
// that drops into RunOptions.buildCommand exactly like defaultPiCommand. These FAIL against the stub
// (which emits only `claude -p < <prompt>` and reads no flags/tools/session).
//
// Each test asserts ONE behavior. The base case pins the FULL string (any flag drift goes red).

import { describe, it, expect } from 'vitest';
import { claudeCommand, dispatchCommand } from '../src/runner/command.js';
import type { NodeSpec, ResolveResult } from '../src/types.js';

// Like defaultPiCommand, the builder reads only resolved/ctx/opts (never `node`), so a bare stub is enough.
const node = {} as NodeSpec;

describe('claudeCommand — headless Claude Code builder', () => {
  it('base contract: fixed headless flags + --model + mapped --tools + stdin-piped prompt', () => {
    const resolved: ResolveResult = { piTools: ['read', 'write', 'edit', 'grep', 'bash'] };
    const cmd = claudeCommand(node, resolved, { promptFile: '_pi/fix/prompt.md', model: 'claude-opus-4-8' });
    expect(cmd).toBe(
      "claude -p --permission-mode bypassPermissions --output-format stream-json --verbose " +
        "--model claude-opus-4-8 --tools 'Read Write Edit Grep Bash' < '_pi/fix/prompt.md'",
    );
  });

  it('maps pi bare names to Claude tools: find→Glob, and drops `ls` (no Claude-native tool)', () => {
    const resolved: ResolveResult = { piTools: ['read', 'find', 'ls', 'bash'] };
    const cmd = claudeCommand(node, resolved, { promptFile: 'p.md' });
    expect(cmd).toContain("--tools 'Read Glob Bash'");
    expect(cmd).not.toMatch(/\bls\b/i); // ls never reaches the grant
    expect(cmd).not.toContain('find'); // the pi name never leaks
  });

  it('deny list → mapped --disallowedTools', () => {
    const resolved: ResolveResult = { piTools: ['read', 'edit'], excludeTools: ['bash', 'write'] };
    const cmd = claudeCommand(node, resolved, { promptFile: 'p.md' });
    expect(cmd).toContain("--disallowedTools 'Bash Write'");
  });

  it('script tools (a compiled -e extension) degrade to Bash — the CLI on disk IS the tool on claude', () => {
    // gameplay-shaped loadout: builtins + two script tools; the script tools have no Claude builtin, but
    // they are node CLIs under readScope — Bash is claude's native way to run them. Without this grant the
    // tool surface silently shrinks to Read/Write/Edit and the node's ritual (measure/feasibility) strands.
    const resolved: ResolveResult = { piTools: ['read', 'write', 'edit', 'measure', 'feasibility_calc'], extension: '// generated binding' };
    const cmd = claudeCommand(node, resolved, { promptFile: 'p.md' });
    expect(cmd).toContain("--tools 'Read Write Edit Bash'");
  });

  it('no extension → no implicit Bash (a builtins-only loadout keeps its exact surface)', () => {
    const resolved: ResolveResult = { piTools: ['read'] };
    const cmd = claudeCommand(node, resolved, { promptFile: 'p.md' });
    expect(cmd).toContain("--tools 'Read'");
    expect(cmd).not.toContain('Bash');
  });

  it('extension + an explicit bash grant never doubles Bash', () => {
    const resolved: ResolveResult = { piTools: ['read', 'bash'], extension: '// generated binding' };
    const cmd = claudeCommand(node, resolved, { promptFile: 'p.md' });
    expect(cmd).toContain("--tools 'Read Bash'");
  });

  it('effort: emitted only when thinking is a valid Claude effort level', () => {
    const resolved: ResolveResult = { piTools: ['read'] };
    expect(claudeCommand(node, resolved, { promptFile: 'p.md' }, { thinking: 'medium' })).toContain('--effort medium');
    // absent thinking → no --effort
    expect(claudeCommand(node, resolved, { promptFile: 'p.md' })).not.toContain('--effort');
    // a non-effort thinking value (pi accepts `true`) must NOT produce a bogus --effort
    expect(claudeCommand(node, resolved, { promptFile: 'p.md' }, { thinking: true })).not.toContain('--effort');
  });

  it('warm resume: emits --resume <id> ONLY on the resume arm (Claude mints the id on create)', () => {
    const resolved: ResolveResult = { piTools: ['read'] };
    const sess = { dir: '/run/.sessions', id: 'fix-bug' };
    // resume → --resume <id>
    expect(claudeCommand(node, resolved, { promptFile: 'p.md' }, { session: { ...sess, resume: true } })).toContain(
      "--resume 'fix-bug'",
    );
    // create (resume falsy) → NO --resume (id is captured from output, not minted by us)
    expect(claudeCommand(node, resolved, { promptFile: 'p.md' }, { session: sess })).not.toContain('--resume');
    // no session → NO --resume
    expect(claudeCommand(node, resolved, { promptFile: 'p.md' })).not.toContain('--resume');
    // resumeRef (the claude-minted UUID, captured off the prior attempt's result event) WINS over the
    // pi-convention id — `--resume <nodeId>` is fatal in `claude -p` (live: 260715-01 gameplay retries).
    const uuid = '051c8666-f8c3-45e2-81ce-7f2edd03aa64';
    expect(
      claudeCommand(node, resolved, { promptFile: 'p.md' }, { session: { ...sess, resume: true, resumeRef: uuid } }),
    ).toContain(`--resume '${uuid}'`);
  });

  it('omits --model when none is resolved (rides the subscription default)', () => {
    const cmd = claudeCommand(node, { piTools: ['read'] }, { promptFile: 'p.md' });
    expect(cmd).not.toContain('--model');
  });

  it('never leaks pi-isms (no --no-session / --mode json / @file / --provider)', () => {
    const cmd = claudeCommand(node, { piTools: ['read'] }, { promptFile: 'p.md', model: 'm', provider: 'cp' });
    expect(cmd).not.toContain('--no-session');
    expect(cmd).not.toContain('--mode json');
    expect(cmd).not.toContain('--provider');
    expect(cmd).not.toContain("@'"); // pi's `@file` prompt ref must not appear
  });

  // ── native MCP wiring (feat/claude-mcp-wiring): a claude-code node's own `mcp.servers` stages a
  // Claude-format `--mcp-config <file>` (docs.claude.com/en/cli-reference: `--mcp-config` loads server
  // configs from a JSON file; `--strict-mcp-config` — used together here — restricts the session to
  // ONLY those servers, ignoring the operator's own project/user/plugin MCP config so a fleet node never
  // inherits capabilities it did not declare). `--tools` (the builtin allowlist above) does NOT gate MCP
  // tools at all (same docs page) — no `mcp__<server>__<tool>` entry is needed there, proven live too
  // (2026-07-21 probe: `--tools 'Read'` + `--mcp-config` still bound and called `mcp__snippets__search_snippets`).
  it('ctx.mcpConfigFile set → emits --mcp-config <path> --strict-mcp-config', () => {
    const cmd = claudeCommand(node, { piTools: ['read'] }, { promptFile: 'p.md', mcpConfigFile: '.pi/staged/w/claude-mcp.json' });
    expect(cmd).toContain("--mcp-config '.pi/staged/w/claude-mcp.json' --strict-mcp-config");
  });

  it('ctx.mcpConfigFile absent → no --mcp-config / --strict-mcp-config (today\'s behavior, unchanged)', () => {
    const cmd = claudeCommand(node, { piTools: ['read'] }, { promptFile: 'p.md' });
    expect(cmd).not.toContain('--mcp-config');
    expect(cmd).not.toContain('--strict-mcp-config');
  });
});

describe('dispatchCommand — routes by node.executor (the default builder)', () => {
  const resolved: ResolveResult = { piTools: ['read'] };
  const ctx = { promptFile: 'p.md' };

  it('node.executor === "claude-code" → the Claude builder (`claude -p …`)', () => {
    const cmd = dispatchCommand({ executor: 'claude-code' } as NodeSpec, resolved, ctx);
    expect(cmd.startsWith('claude -p ')).toBe(true);
  });

  it('absent executor → the pi builder (byte-identical default path)', () => {
    const cmd = dispatchCommand({} as NodeSpec, resolved, ctx);
    expect(cmd.startsWith('pi ')).toBe(true);
  });

  it('executor === "pi" → the pi builder', () => {
    const cmd = dispatchCommand({ executor: 'pi' } as NodeSpec, resolved, ctx);
    expect(cmd.startsWith('pi ')).toBe(true);
  });

  // GUARD: mcpConfigFile is a claude-only emission — a pi node must stay byte-identical even if the
  // runner ever handed it one (it never does, since node-lifecycle gates staging on executor==='claude-code',
  // but the builder itself must not silently start honoring it for pi too).
  it('mcpConfigFile is IGNORED on the pi path — defaultPiCommand never emits --mcp-config', () => {
    const cmd = dispatchCommand({} as NodeSpec, resolved, { ...ctx, mcpConfigFile: '.pi/staged/w/claude-mcp.json' });
    expect(cmd).not.toContain('--mcp-config');
    expect(cmd).not.toContain('--strict-mcp-config');
  });
});
