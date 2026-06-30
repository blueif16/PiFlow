// The real PromptIO — a thin wrapper over node:readline/promises (zero deps). This is the I/O boundary; all
// step logic is pure over the answers it returns, so this file carries no behavior worth unit-testing (the
// scripted IO in init.test.ts stands in for it). The caller owns the interface lifecycle via `close`.

import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { PromptIO } from './types.js';

export function createPromptIO(): { io: PromptIO; close(): void } {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const io: PromptIO = {
    print: (line) => stdout.write(line + '\n'),
    async confirm(question, def) {
      const ans = (await rl.question(`${question} (${def ? 'Y/n' : 'y/N'}) `)).trim().toLowerCase();
      if (!ans) return def;
      return ans === 'y' || ans === 'yes';
    },
    async input(question, def = '') {
      const ans = (await rl.question(def ? `${question} [${def}] ` : `${question} `)).trim();
      return ans || def;
    },
  };
  return { io, close: () => rl.close() };
}
