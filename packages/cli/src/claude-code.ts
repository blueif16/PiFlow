// `piflowctl claude-code` — manage the OPTIONAL Claude Code executor credential. A node may run on a
// headless local Claude session (`--executor claude-code`) instead of the pi fleet; the runner resolves its
// subscription OAuth token HOST-SIDE and injects it into the jail (runner/claude-executor.ts). That resolver
// is LAYERED: $CLAUDE_CODE_OAUTH_TOKEN → ~/.piflow/claude-code.json → the existing local login (macOS
// Keychain / Linux ~/.claude/.credentials.json). So this command is FREELY SKIPPABLE — on macOS an existing
// `claude` login already works. Its job is the explicit, portable middle layer: capture a long-lived token
// (from `claude setup-token`) and persist it for Linux/cloud or deterministic control.
//
//   piflowctl claude-code connect [--token <t>]   write the token → ~/.piflow/claude-code.json (chmod 600)
//   piflowctl claude-code status                  show whether the explicit credential is configured
//
// The LOGIC is two PURE units (no fs): `resolveConnectToken` (source precedence) + `claudeCodeCredJson` (the
// on-disk shape). `writeClaudeCodeCred` is the thin fs boundary, carrying the load-bearing 0600 guarantee.

import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Resolve the connect token from its sources (first non-empty, TRIMMED wins): `--token` > $CLAUDE_CODE_OAUTH_TOKEN.
 *  An empty/whitespace value is "absent" — the credential model proved an empty token reads as "not logged in",
 *  so it must never be persisted as a real value. */
export function resolveConnectToken(sources: { token?: string; env?: string }): string | undefined {
  for (const candidate of [sources.token, sources.env]) {
    const t = candidate?.trim();
    if (t) return t;
  }
  return undefined;
}

/** The on-disk credential shape — the EXACT `{ oauthToken }` key core's `tokenFromPiflowFile` parses. */
export function claudeCodeCredJson(token: string): string {
  return JSON.stringify({ oauthToken: token }, null, 2) + '\n';
}

/** The explicit credential path — MIRRORS core's `defaultClaudeCodeCredFile()` (the read/write contract). */
export function homeClaudeCodeFile(home: string = os.homedir()): string {
  return path.join(home, '.piflow', 'claude-code.json');
}

/** Persist the token to `file` as `{ oauthToken }`, chmod 600. The explicit `chmod` is load-bearing: a
 *  `writeFile` `mode` only applies on CREATE, so re-connecting over a pre-existing looser file would leave a
 *  world-readable secret without it. */
export async function writeClaudeCodeCred(token: string, file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, claudeCodeCredJson(token), { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

const USAGE = `piflowctl claude-code <connect | status>  — manage the OPTIONAL claude-code executor credential

  connect [--token <t>]   persist the subscription OAuth token → ~/.piflow/claude-code.json (chmod 600).
                          Token source: --token, else $CLAUDE_CODE_OAUTH_TOKEN.
                          Get a long-lived token with:  claude setup-token  (opens a browser).
  status                  show whether the explicit credential is configured + whether the claude CLI is found.

This step is SKIPPABLE: on macOS an existing 'claude' login (keychain) is used automatically. The token file
is the portable middle layer for Linux/cloud or deterministic control (runner/claude-executor.ts).`;

/** The first value after `--name` in `args`, or undefined. */
function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Best-effort, spawn-free check: is a `claude` executable on $PATH? (Reused by `piflowctl init`.) */
export function claudeBinOnPath(): boolean {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir && existsSync(path.join(dir, 'claude'))) return true;
  }
  return false;
}

/** `piflowctl claude-code [...]` — the thin fs/print wrapper over the pure units above. */
export async function runClaudeCodeCli(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'connect': {
      const token = resolveConnectToken({
        token: flagValue(rest, '--token'),
        env: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      });
      if (!token) {
        process.stderr.write(
          `claude-code connect: no token.\n` +
            `  1) run:  claude setup-token            (opens a browser; prints a long-lived token)\n` +
            `  2) run:  piflowctl claude-code connect --token <paste>\n` +
            `  (or export CLAUDE_CODE_OAUTH_TOKEN first). This step is OPTIONAL — on macOS an existing\n` +
            `  'claude' login is used automatically; the file is for Linux/cloud + explicit control.\n`,
        );
        process.exitCode = 1;
        return;
      }
      const file = homeClaudeCodeFile();
      await writeClaudeCodeCred(token, file);
      process.stdout.write(`wrote ${file} (chmod 600)\nnodes can now run with --executor claude-code.\n`);
      return;
    }
    case 'status': {
      const file = homeClaudeCodeFile();
      const present = existsSync(file);
      process.stdout.write(
        `claude-code credential: ${present ? `configured (${file})` : 'not configured'}\n` +
          `claude CLI on PATH:     ${claudeBinOnPath() ? 'yes' : 'no'}\n` +
          (present
            ? ''
            : `  OPTIONAL: 'piflowctl claude-code connect' to persist an explicit token, or skip —\n` +
              `  on macOS an existing 'claude' login is used automatically.\n`),
      );
      return;
    }
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      process.stdout.write(USAGE + '\n');
      return;
    default:
      process.stderr.write(`piflowctl claude-code: unknown subcommand '${sub}'\n\n${USAGE}\n`);
      process.exitCode = 1;
  }
}
