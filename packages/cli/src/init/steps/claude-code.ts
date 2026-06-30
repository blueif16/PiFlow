// OPTIONAL plugin step — the Claude Code executor. A node can run on your LOCAL Claude coding plan (the
// subscription, via host-side OAuth token) instead of a pi. This is NOT "call Claude over the billed API" —
// it is the coding-plan path, so it is gated behind AUTH: only once a token/login is in place do the
// Claude-side tier models mean anything. Declining the whole step (the orchestrator's gate) writes nothing —
// the workflow stays pure pi.
//
// REUSES the granular CLI we already shipped: `resolveConnectToken` + `writeClaudeCodeCred` (the `claude-code
// connect` logic, incl. the load-bearing 0600) for auth, and `applyModelCommand(... '--claude')` (the `model
// set --claude` logic) for the parallel `claude` tier block. The wizard is orchestration only.

import { existsSync } from 'node:fs';
import { loadModelTiers, writeModelTiers, CANONICAL_TIERS } from '@piflow/core';
import { applyModelCommand } from '../../model.js';
import { resolveConnectToken, writeClaudeCodeCred } from '../../claude-code.js';
import type { InitStep, InitContext } from '../types.js';

/** Suggested Claude coding-plan alias per tier (shown in the prompt; enter still skips). */
const SUGGEST: Record<string, string> = { fast: 'haiku', balanced: 'sonnet', deep: 'opus' };

/** AUTH — establish a usable Claude Code credential. Returns a one-line note for the summary. Persists a
 *  credential ONLY for a real (non-empty) token; an empty answer falls back to an existing local login. */
async function ensureAuth(ctx: InitContext): Promise<string> {
  const { io } = ctx;
  io.print(`  claude CLI on PATH: ${ctx.claudeOnPath ? 'yes' : 'no'}`);
  if (existsSync(ctx.credFile)) {
    io.print(`  explicit token already configured (${ctx.credFile}).`);
    return `token already configured`;
  }
  io.print(`  Paste a token from 'claude setup-token' to persist one (portable to Linux/cloud),`);
  io.print(`  or press enter to use your existing local 'claude' login.`);
  const token = resolveConnectToken({ token: await io.input('  token', '') });
  if (token) {
    await writeClaudeCodeCred(token, ctx.credFile);
    return `token saved → ${ctx.credFile}`;
  }
  if (ctx.claudeOnPath) return `using existing claude login`;
  return `no token + no claude login — run 'piflowctl claude-code connect' before running a claude-code node`;
}

export const claudeCodeStep: InitStep = {
  id: 'claude-code',
  title: 'Claude Code executor (optional) — run a node on your local Claude coding plan instead of pi',
  optional: true,
  gate: 'Enable the Claude Code executor?',
  async run(ctx) {
    const { io } = ctx;
    const authNote = await ensureAuth(ctx);

    // The Claude-side tier models — only meaningful now that auth is in place. These map into the PARALLEL
    // `claude` block (an `--executor claude-code` node resolves them); the pi `tiers` are left untouched.
    io.print(`  Map Claude coding-plan models to tiers (enter to skip each):`);
    let tiers = loadModelTiers(ctx.tiersFile);
    const set: string[] = [];
    for (const tier of CANONICAL_TIERS) {
      const cur = tiers.claude?.[tier] ?? '';
      const ans = await io.input(`  claude ${tier} (e.g. ${SUGGEST[tier] ?? '…'})`, cur);
      if (ans) {
        tiers = applyModelCommand(tiers, ['set', tier, ans, '--claude']).next;
        set.push(`${tier}=${ans}`);
      }
    }
    if (set.length) writeModelTiers(tiers, ctx.tiersFile);

    return {
      id: 'claude-code',
      status: 'done',
      detail: set.length ? `${authNote}; claude tiers ${set.join(' ')}` : authNote,
    };
  },
};
