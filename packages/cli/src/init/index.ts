// `piflowctl init` — the interactive, modular setup wizard. The human walks a few prompts; each capability is
// one pluggable step (see registry.ts). This entry is just the lifecycle: build the real PromptIO + the
// on-disk context, run the registry, print a summary, close the interface. The home (~/.piflow) is already
// seeded by `ensurePiflowHome()` at the CLI entry, so `loadModelTiers` always has the canonical tiers to show.
//
// Non-interactive contexts (an agent, CI) do NOT use this — they call the granular commands directly
// (`piflowctl model set …`, `piflowctl claude-code connect`). So a non-TTY stdin prints that guidance and exits.

import { stdin } from 'node:process';
import { homeTiersFile } from '@piflow/core';
import { homeClaudeCodeFile, claudeBinOnPath } from '../claude-code.js';
import { createPromptIO } from './prompt.js';
import { runInitSteps } from './run.js';
import { INIT_STEPS } from './registry.js';

const USAGE = `piflowctl init  — interactive setup wizard for ~/.piflow (model tiers + optional executors)

Walks you through the setup as a series of choices. Core steps always run; optional steps (e.g. the Claude
Code executor) ask before configuring and are freely skippable. Reuses the same config the granular commands
write, so anything here can also be done with 'piflowctl model set …' / 'piflowctl claude-code connect'.`;

export async function runInitCli(argv: string[]): Promise<void> {
  if (argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(USAGE + '\n');
    return;
  }
  if (!stdin.isTTY) {
    process.stderr.write(
      `piflowctl init is interactive — run it in a terminal.\n` +
        `In a non-interactive context use the granular commands instead:\n` +
        `  piflowctl model set <tier> <id> [--claude]\n` +
        `  piflowctl claude-code connect [--token <t>]\n`,
    );
    process.exitCode = 1;
    return;
  }

  const { io, close } = createPromptIO();
  try {
    io.print(`piflow setup — ~/.piflow`);
    const results = await runInitSteps(INIT_STEPS, {
      io,
      tiersFile: homeTiersFile(),
      credFile: homeClaudeCodeFile(),
      claudeOnPath: claudeBinOnPath(),
    });
    io.print(`\nsetup complete:`);
    for (const r of results) io.print(`  ${r.id.padEnd(12)} ${r.status === 'skipped' ? 'skipped' : r.detail}`);
  } finally {
    close();
  }
}
