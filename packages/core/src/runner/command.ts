// The agent-command builder — the INJECTION SEAM that keeps the runner testable OFFLINE.
//
// `buildCommand(node, resolved)` returns the shell command the runner hands to `Sandbox.exec`. The
// DEFAULT builds the production headless `pi` invocation (the flags ported from run.mjs `piArgs`
// 700–728 + reference/provider-and-headless.md's headless invariants). A test (or any caller) can
// pass its OWN builder — e.g. one that writes the node's declared artifact into the sandbox output
// dir — so the runner exercises the FULL lifecycle (stage → exec → collect → verify → hooks →
// dispose) with no live `pi`, no creds, and no network.
//
// The prompt is staged into the sandbox as a FILE and referenced with `@<path>` (a headless
// invariant — multi-KB wave prompts are robust as a file ref, brittle as an argv string). The
// command is a single shell string because `Sandbox.exec(cmd)` runs it under `shell: true`.

import type { NodeSpec, ResolveResult } from '../types.js';

/** A function that builds the shell command for one node run, given its resolved toolset. */
export interface CommandBuilder {
  (node: NodeSpec, resolved: ResolveResult, ctx: CommandContext): string;
}

/** What the runner hands a command builder. `promptFile` is the in-sandbox path of the staged prompt. */
export interface CommandContext {
  /** In-sandbox path to the staged prompt file (referenced as `@<promptFile>`). */
  promptFile: string;
  /** Optional model pin (provider's default model is used when omitted). */
  model?: string;
  /** Provider name passed to `pi --provider` (default 'cp'). */
  provider?: string;
}

/** Shell-quote a single token (the prompt path / extension path may contain spaces). */
function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The PRODUCTION default: build the headless `pi` command for one node.
 *
 * Headless invariants (provider-and-headless.md): `-p --mode json -a --no-session` (print mode, JSON
 * event stream, auto-approve tools, ephemeral), `--offline` (suppress pi's startup network chatter;
 * the model call still works), `--no-extensions` (+ explicit `-e` still loads), `--no-context-files`
 * (a node runs on ONLY the driver's prompt — no repo AGENTS.md/CLAUDE.md leak), `--provider cp`,
 * `--model` only when pinned, `--tools <resolved.piTools joined by ,>`, `-e <resolved.extension>`
 * when sdk/mcp tools were selected, and the prompt as `@<file>`. The caller closes stdin (the runner
 * does — an open stdin pipe with no TTY hangs a headless CLI forever).
 */
export const defaultPiCommand: CommandBuilder = (node, resolved, ctx) => {
  const provider = ctx.provider ?? 'cp';
  const parts: string[] = [
    'pi', '-p', '--mode', 'json', '-a', '--no-session',
    '--offline', '--no-extensions', '--no-context-files',
    '--provider', provider,
  ];
  if (ctx.model) parts.push('--model', ctx.model);
  if (resolved.piTools.length) parts.push('--tools', resolved.piTools.join(','));
  if (resolved.extension) parts.push('-e', q(resolved.extension));
  parts.push(`@${q(ctx.promptFile)}`);
  return parts.join(' ');
};
