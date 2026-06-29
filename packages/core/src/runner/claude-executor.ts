// Host-side credential + isolation seam for the `claude-code` executor (the §7.2 model, proven live).
//
// A claude-code node runs headless `claude -p` INSIDE the kernel jail. The jail allows exec + network +
// mach-lookup but DENIES file reads/writes outside the node's lane — so claude cannot reach the macOS
// Keychain (its default credential store) and must not write the user's real ~/.claude. The ROBUST,
// cross-platform model (docs/design/agent-executor-interface.md §7.2; verified with live Haiku runs):
//
//   1. CREDENTIAL — resolve the subscription OAuth token HOST-SIDE (outside the jail) and inject it as
//      CLAUDE_CODE_OAUTH_TOKEN (Claude's auth precedence #5, ABOVE the keychain). The jail never touches
//      the keychain, and the SAME path works on Linux/cloud (no keychain there) — that is the whole reason
//      it is robust, not a macOS path-grant.
//   2. BILLING GUARANTEE — STRIP ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN (precedence #2/#3): a NON-EMPTY
//      key silently WINS in `-p` mode (per-token API billing). Setting them EMPTY = "absent" (proven live),
//      so a subscription run can never silently fall to API billing.
//   3. ISOLATION — point CLAUDE_CONFIG_DIR at a per-node dir under the run dir (the jail-writable workdir
//      lane), so session/history/projects write THERE, never the user's ~/.claude.
//
// Token resolution is LAYERED (host owns the binding, mirroring `SecretResolver`): an explicit token wins
// (env / a `piflowctl claude-code` setup-token in ~/.piflow/claude-code.json); else extract the EXISTING
// local login (macOS Keychain via `security`; Linux ~/.claude/.credentials.json) so it "just works" off
// `claude /login` with no setup. Absent ⇒ undefined (claude reports "not logged in").

import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { SecretResolver } from '../types.js';
import { defaultSecretResolver } from '../types.js';

/** Claude Code's OAuth env var — auth precedence #5, above the keychain (the credential we inject). */
const OAUTH_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';
/** API-key vars that OUTRANK the OAuth token in `claude -p`; stripped (set empty) so a stray host key can never silently bill the API. */
const STRIP_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;
/** The macOS Keychain generic-password service name Claude Code stores its credential under. */
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** Default global store a `piflowctl claude-code` setup step writes (parallels ~/.piflow/model-tiers.json). */
export function defaultClaudeCodeCredFile(): string {
  return path.join(os.homedir(), '.piflow', 'claude-code.json');
}

/** Extract `.claudeAiOauth.accessToken` from a credential blob (the keychain secret OR a Linux .credentials.json). Tolerant: undefined on any shape miss. */
function accessTokenFromBlob(raw: string): string | undefined {
  try {
    const t = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } })?.claudeAiOauth?.accessToken;
    return typeof t === 'string' && t ? t : undefined;
  } catch {
    return undefined;
  }
}

/** Read the explicit setup-token a `piflowctl claude-code` step stored (`{ oauthToken }`). undefined if absent/garbage. */
function tokenFromPiflowFile(file: string): string | undefined {
  try {
    const t = (JSON.parse(readFileSync(file, 'utf8')) as { oauthToken?: unknown })?.oauthToken;
    return typeof t === 'string' && t ? t : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract the EXISTING local-login token, HOST-SIDE (the runner process is NOT jailed): macOS reads the
 * Keychain via `security find-generic-password -w`; Linux reads ~/.claude/.credentials.json. Any failure
 * (no login, no `security`, malformed) ⇒ undefined (the caller degrades to "not logged in"). This is the
 * external-boundary layer — kept thin + proven live, never unit-tested against a real keychain.
 */
function tokenFromLocalLogin(home: string, platform: NodeJS.Platform): string | undefined {
  try {
    if (platform === 'darwin') {
      return accessTokenFromBlob(
        execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { encoding: 'utf8' }),
      );
    }
    return accessTokenFromBlob(readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

/** The token-source seams, injected so each layer is deterministically testable (the real defaults are host I/O). */
export interface ClaudeTokenSources {
  resolver?: SecretResolver;
  nodeId?: string;
  /** Path to the `piflowctl claude-code` setup-token file. Default `~/.piflow/claude-code.json`. */
  credFile?: string;
  home?: string;
  platform?: NodeJS.Platform;
  /** Override the local-login extractor (tests). Default = keychain (darwin) / .credentials.json (linux). */
  localLogin?: (home: string, platform: NodeJS.Platform) => string | undefined;
}

/**
 * Resolve the Claude Code subscription OAuth token HOST-SIDE, LAYERED (first non-empty hit wins):
 *   1. `SecretResolver(CLAUDE_CODE_OAUTH_TOKEN)` — default = `process.env` (a host can plug a vault).
 *   2. `~/.piflow/claude-code.json` `{ oauthToken }` — the `piflowctl claude-code` setup-token.
 *   3. the existing local login — macOS Keychain / Linux .credentials.json (so it just works off `/login`).
 * undefined ⇒ no credential found.
 */
export async function resolveClaudeOAuthToken(src: ClaudeTokenSources = {}): Promise<string | undefined> {
  const resolver = src.resolver ?? defaultSecretResolver;
  const fromResolver = await resolver(OAUTH_ENV, { nodeId: src.nodeId ?? '', isCloud: false });
  if (fromResolver) return fromResolver;
  const fromFile = tokenFromPiflowFile(src.credFile ?? defaultClaudeCodeCredFile());
  if (fromFile) return fromFile;
  return (src.localLogin ?? tokenFromLocalLogin)(src.home ?? os.homedir(), src.platform ?? process.platform);
}

/**
 * Build the env additions for a `claude-code` node (the §7.2 model). Returns `{}` for any OTHER executor
 * (additive — a pi node is byte-identical). For a claude-code node it ALWAYS sets `CLAUDE_CONFIG_DIR`
 * (isolation) and strips the API-key vars (subscription guarantee); it injects `CLAUDE_CODE_OAUTH_TOKEN`
 * only when a token actually resolves (never an empty/garbage token — an absent token lets claude report
 * "not logged in" cleanly rather than presenting a bad credential).
 */
export async function claudeExecutorEnvAdditions(opts: {
  executor?: string;
  nodeId: string;
  configDir: string;
  resolver?: SecretResolver;
  /** Token-source overrides for tests; production uses the host defaults (env → ~/.piflow file → local login). */
  sources?: Omit<ClaudeTokenSources, 'resolver' | 'nodeId'>;
}): Promise<Record<string, string>> {
  if (opts.executor !== 'claude-code') return {};
  const env: Record<string, string> = { CLAUDE_CONFIG_DIR: opts.configDir };
  for (const v of STRIP_VARS) env[v] = ''; // empty = "absent" → subscription auth guaranteed, never silent API billing
  const token = await resolveClaudeOAuthToken({ resolver: opts.resolver, nodeId: opts.nodeId, ...opts.sources });
  if (token) env[OAUTH_ENV] = token;
  return env;
}
