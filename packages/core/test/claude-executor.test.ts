// claude-executor — the HOST-SIDE credential + isolation model for the `claude-code` executor (PURE LOGIC
// gate, test-discipline §0). Proven live (the §7.2 jail spike): a jailed `claude -p` cannot reach the macOS
// Keychain and must not write the user's ~/.claude, so the runner resolves the subscription OAuth token
// host-side and injects it as CLAUDE_CODE_OAUTH_TOKEN, strips the API-key vars (else `-p` silently bills the
// API), and points CLAUDE_CONFIG_DIR at an isolated per-node dir. These tests pin that contract; the live
// keychain/`security` extraction is the external boundary (proven live, injected here).

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeExecutorEnvAdditions, resolveClaudeOAuthToken } from '../src/runner/claude-executor.js';

// A deterministic local-login extractor stand-in (the real one shells out to `security` / reads
// .credentials.json — the external boundary we never touch in a unit test).
const noLogin = (): undefined => undefined;

describe('claudeExecutorEnvAdditions — the claude-code node env (credential inject + API-key strip + config isolation)', () => {
  it('returns {} for a non-claude executor (a pi node is byte-identical — additive)', async () => {
    expect(await claudeExecutorEnvAdditions({ executor: undefined, nodeId: 'x', configDir: '/run/.cfg/x' })).toEqual({});
    expect(await claudeExecutorEnvAdditions({ executor: 'pi', nodeId: 'x', configDir: '/run/.cfg/x' })).toEqual({});
  });

  it('for a claude-code node: injects the resolved OAuth token, STRIPS the API-key vars, isolates the config dir', async () => {
    const env = await claudeExecutorEnvAdditions({
      executor: 'claude-code',
      nodeId: 'fix',
      configDir: '/run/.claude-config/fix',
      resolver: (name) => (name === 'CLAUDE_CODE_OAUTH_TOKEN' ? 'tok-123' : undefined),
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok-123');
    // empty string = "absent" to claude `-p` (proven live) — guarantees subscription auth, never silent API billing.
    expect(env.ANTHROPIC_API_KEY).toBe('');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/run/.claude-config/fix');
  });

  it('with NO token resolvable: still strips the API-key vars + isolates config, but emits NO token key (absent, not empty)', async () => {
    const env = await claudeExecutorEnvAdditions({
      executor: 'claude-code',
      nodeId: 'fix',
      configDir: '/run/.claude-config/fix',
      resolver: () => undefined,
      sources: { credFile: '/no/such/file.json', localLogin: noLogin },
    });
    expect('CLAUDE_CODE_OAUTH_TOKEN' in env).toBe(false); // never inject an empty/garbage token
    expect(env.ANTHROPIC_API_KEY).toBe(''); // the strip is UNCONDITIONAL (a stray host key must never win)
    expect(env.CLAUDE_CONFIG_DIR).toBe('/run/.claude-config/fix');
  });
});

describe('resolveClaudeOAuthToken — layered host-side resolution (env/resolver → ~/.piflow file → local login)', () => {
  it('the SecretResolver wins over the file and the local login (host-plugged binding has precedence)', async () => {
    const seen: string[] = [];
    const tok = await resolveClaudeOAuthToken({
      resolver: (n) => { seen.push(n); return 'from-resolver'; },
      credFile: '/should/not/be/read.json',
      localLogin: () => { seen.push('LOGIN'); return 'from-login'; },
    });
    expect(tok).toBe('from-resolver');
    expect(seen).not.toContain('LOGIN'); // short-circuits — never falls through to the keychain
  });

  it('falls to the ~/.piflow/claude-code.json setup-token when the resolver is empty', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-cc-'));
    const credFile = path.join(dir, 'claude-code.json');
    await fs.writeFile(credFile, JSON.stringify({ oauthToken: 'from-setup-file' }));
    const tok = await resolveClaudeOAuthToken({ resolver: () => undefined, credFile, localLogin: () => 'from-login' });
    expect(tok).toBe('from-setup-file'); // the file beats the local-login fallback
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('falls to the existing LOCAL LOGIN (keychain/.credentials.json) when resolver + file are both empty', async () => {
    const tok = await resolveClaudeOAuthToken({
      resolver: () => undefined,
      credFile: '/no/such/file.json',
      localLogin: () => 'from-login',
    });
    expect(tok).toBe('from-login');
  });

  it('returns undefined when nothing resolves (claude will report "not logged in")', async () => {
    const tok = await resolveClaudeOAuthToken({ resolver: () => undefined, credFile: '/no/such/file.json', localLogin: noLogin });
    expect(tok).toBeUndefined();
  });
});
