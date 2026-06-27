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

import type { NodeSpec, ResolveResult, PiCommandOptions } from '../types.js';

/**
 * A function that builds the shell command for one node run, given its resolved toolset. `opts` is
 * OPTIONAL — a 3-arg builder still satisfies this contract, and the 3-arg call stays byte-identical.
 */
export interface CommandBuilder {
  (node: NodeSpec, resolved: ResolveResult, ctx: CommandContext, opts?: PiCommandOptions): string;
}

/** What the runner hands a command builder. `promptFile` is the in-sandbox path of the staged prompt. */
export interface CommandContext {
  /** In-sandbox path to the staged prompt file (referenced as `@<promptFile>`). */
  promptFile: string;
  /** Optional model pin (provider's default model is used when omitted). */
  model?: string;
  /** Provider name passed to `pi --provider` (default 'cp'). */
  provider?: string;
  /**
   * In-sandbox path to the generated tool `-e` extension, when the node selected sdk/mcp tools. The
   * runner stages `ResolveResult.extension` (source) to this path; passed as `pi -e <file>`. Absent
   * when the node uses only builtins.
   */
  extensionFile?: string;
  /**
   * In-sandbox path to the node's staged skill directory (its `SKILL.md` + assets), when the node
   * declared `node.skill`. The runner stages the skill folder into the sandbox and passes its in-sandbox
   * path here; emitted as `pi --skill <dir>` (additive even under `--no-skills`, so the load never depends
   * on `.pi/skills/` auto-discovery surviving the headless flag set). Absent when the node declares no skill.
   */
  skillPath?: string;
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
 * `--model` only when pinned, `--tools <resolved.piTools joined by ,>`, `--exclude-tools
 * <resolved.excludeTools joined by ,>` when the selection denied any, `--thinking <v>` only when
 * `opts.thinking` is set, each `opts.extraExtensions` as `-e <path>` BEFORE `-e <ctx.extensionFile>`
 * (the staged generated tool extension), and the prompt as `@<file>`. Closes stdin (the runner does —
 * an open stdin pipe with no TTY hangs a headless CLI forever).
 *
 * `opts` is OPTIONAL and ENV-FREE: the consumer (the runner) maps env/config → it. The 3-arg call is
 * byte-identical to before.
 */
export const defaultPiCommand: CommandBuilder = (node, resolved, ctx, opts = {}) => {
  const provider = ctx.provider ?? 'cp';
  const parts: string[] = [
    'pi', '-p', '--mode', 'json', '-a', '--no-session',
    '--offline', '--no-extensions', '--no-context-files',
    '--provider', provider,
  ];
  if (ctx.model) parts.push('--model', ctx.model);
  if (resolved.piTools.length) parts.push('--tools', resolved.piTools.join(','));
  if (resolved.excludeTools?.length) parts.push('--exclude-tools', resolved.excludeTools.join(','));
  if (opts.thinking) parts.push('--thinking', String(opts.thinking));
  // -e ORDER is load-bearing: the extra extensions FIRST, then the staged tool-binding extension.
  for (const ext of opts.extraExtensions ?? []) parts.push('-e', q(ext));
  if (ctx.extensionFile) parts.push('-e', q(ctx.extensionFile));
  // The staged skill dir, loaded explicitly (additive even under `--no-skills`).
  if (ctx.skillPath) parts.push('--skill', q(ctx.skillPath));
  parts.push(`@${q(ctx.promptFile)}`);
  return parts.join(' ');
};
