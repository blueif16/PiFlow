// claudeCommand — the headless Claude Code (`claude-code` executor) command builder (PURE LOGIC gate,
// test-discipline §0). Local subscription, builtins only, for read/write/fix/debug.
//
// The contract IS the `claude -p` string (docs/design/agent-executor-interface.md §5): a CommandBuilder
// that drops into RunOptions.buildCommand exactly like defaultPiCommand. These FAIL against the stub
// (which emits only `claude -p < <prompt>` and reads no flags/tools/session).
//
// Each test asserts ONE behavior. The base case pins the FULL string (any flag drift goes red).

import { describe, it, expect } from 'vitest';
import { claudeCommand } from '../src/runner/command.js';
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
});
