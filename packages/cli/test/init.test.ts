// `piflowctl init` — the modular setup wizard. Tested through its public surface with an injected, scripted
// PromptIO + a temp PIFLOW_HOME, so a step is exercised as a pure function of (answers, on-disk paths) — no
// real readline, no real ~/.piflow. The load-bearing contracts pinned here:
//   • the orchestrator GATES an optional step: a declined gate ⇒ `run` is NEVER called (skipped writes nothing).
//   • the claude-code step's AUTH writes the 0600 credential only for a real token; an empty token persists nothing.
//   • the claude-code step maps Claude models into the PARALLEL `claude` block — NOT the pi `tiers` block.
//   • the model-tiers step writes the pi `tiers` block — and leaves `claude` untouched.
// Test-the-test target: flip the orchestrator's gate (run a declined step anyway) and 'declined gate runs nothing'
// reddens; write the claude ids into `tiers` instead of `claude` and the separation tests redden.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInitSteps } from '../src/init/run.js';
import { modelTiersStep } from '../src/init/steps/model-tiers.js';
import { claudeCodeStep } from '../src/init/steps/claude-code.js';
import type { InitStep, InitContext, PromptIO } from '../src/init/types.js';

/** A scripted PromptIO: confirm answers and input answers are consumed in order; prints are captured. */
function scriptedIO(script: { confirms?: boolean[]; inputs?: string[] }): PromptIO & { lines: string[] } {
  const confirms = [...(script.confirms ?? [])];
  const inputs = [...(script.inputs ?? [])];
  const lines: string[] = [];
  return {
    lines,
    print: (l) => lines.push(l),
    async confirm(_q, def) {
      return confirms.length ? confirms.shift()! : def;
    },
    async input(_q, def = '') {
      const next = inputs.length ? inputs.shift()! : '';
      const trimmed = next.trim();
      return trimmed || def;
    },
  };
}

let home: string;
let ctx: Omit<InitContext, 'io'>;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-init-'));
  process.env.PIFLOW_HOME = home;
  ctx = {
    tiersFile: path.join(home, 'model-tiers.json'),
    credFile: path.join(home, 'claude-code.json'),
    claudeOnPath: true,
  };
});
afterEach(async () => {
  delete process.env.PIFLOW_HOME;
  await fs.rm(home, { recursive: true, force: true });
});

describe('orchestrator — optional-step gating', () => {
  it('a declined gate skips the step and NEVER calls run (the pure default is preserved)', async () => {
    let ran = false;
    const spy: InitStep = {
      id: 'spy',
      title: 'spy',
      optional: true,
      gate: 'enable spy?',
      async run() {
        ran = true;
        return { id: 'spy', status: 'done', detail: 'ran' };
      },
    };
    const io = scriptedIO({ confirms: [false] });
    const [result] = await runInitSteps([spy], { ...ctx, io });
    expect(ran).toBe(false); // mutation: if the orchestrator ran a declined optional step, this reddens.
    expect(result).toEqual({ id: 'spy', status: 'skipped', detail: 'skipped' });
  });

  it('an accepted gate runs the optional step', async () => {
    let ran = false;
    const spy: InitStep = {
      id: 'spy',
      title: 'spy',
      optional: true,
      gate: 'enable spy?',
      async run() {
        ran = true;
        return { id: 'spy', status: 'done', detail: 'ran' };
      },
    };
    const io = scriptedIO({ confirms: [true] });
    await runInitSteps([spy], { ...ctx, io });
    expect(ran).toBe(true);
  });

  it('a CORE (non-optional) step always runs without asking a gate', async () => {
    const io = scriptedIO({ confirms: [] }); // no gate answer available
    let ran = false;
    const core: InitStep = {
      id: 'core',
      title: 'core',
      optional: false,
      async run() {
        ran = true;
        return { id: 'core', status: 'done', detail: 'ran' };
      },
    };
    await runInitSteps([core], { ...ctx, io });
    expect(ran).toBe(true);
  });
});

describe('model-tiers step — writes the pi tiers, not the claude block', () => {
  it('sets the answered tiers and activates; leaves the claude block absent', async () => {
    const io = scriptedIO({ inputs: ['deepseek-v3', 'sonnet', 'claude-opus-4-8'] });
    await modelTiersStep.run({ ...ctx, io });
    const t = JSON.parse(await fs.readFile(ctx.tiersFile, 'utf8'));
    expect(t.tiers).toMatchObject({ fast: 'deepseek-v3', balanced: 'sonnet', deep: 'claude-opus-4-8' });
    expect(t.active).toBe(true); // a `set` activates — else the runner resolves nothing.
    expect(t.claude).toBeUndefined(); // pi base tiers must NOT touch the parallel claude map.
  });

  it('an empty answer keeps the current tier (enter = keep)', async () => {
    await fs.writeFile(ctx.tiersFile, JSON.stringify({ active: true, tiers: { fast: 'keep', balanced: '', deep: '' } }));
    const io = scriptedIO({ inputs: ['', 'sonnet', ''] });
    await modelTiersStep.run({ ...ctx, io });
    const t = JSON.parse(await fs.readFile(ctx.tiersFile, 'utf8'));
    expect(t.tiers.fast).toBe('keep'); // unchanged by an empty answer.
    expect(t.tiers.balanced).toBe('sonnet');
  });
});

describe('claude-code step — auth gates the claude tier mapping', () => {
  it('a pasted token is persisted 0600 and the claude tiers go into the PARALLEL claude block', async () => {
    // token, then claude fast / balanced(skip) / deep
    const io = scriptedIO({ inputs: ['tok-xyz', 'haiku', '', 'opus'] });
    await claudeCodeStep.run({ ...ctx, io, claudeOnPath: true });

    expect(existsSync(ctx.credFile)).toBe(true);
    expect(JSON.parse(await fs.readFile(ctx.credFile, 'utf8'))).toEqual({ oauthToken: 'tok-xyz' });
    const mode = (await fs.stat(ctx.credFile)).mode & 0o777;
    expect(mode).toBe(0o600); // a token file must never be world-readable.

    const t = JSON.parse(await fs.readFile(ctx.tiersFile, 'utf8'));
    expect(t.claude).toMatchObject({ fast: 'haiku', deep: 'opus' }); // mapped into the claude block...
    expect(t.claude.balanced).toBeUndefined(); // ...skipped tier stays unset.
    expect(t.tiers?.fast ?? '').not.toBe('haiku'); // and NOT into the pi tiers (the separation guarantee).
  });

  it('an EMPTY token with an existing claude login persists NO credential (empty ≠ a real token)', async () => {
    const io = scriptedIO({ inputs: ['', '', '', ''] }); // skip token + all claude tiers
    const result = await claudeCodeStep.run({ ...ctx, io, claudeOnPath: true });
    expect(existsSync(ctx.credFile)).toBe(false); // empty token must never be written as a credential.
    expect(result.detail).toMatch(/existing claude login/i);
  });
});

describe('full wizard — pure-pi path leaves Claude untouched', () => {
  it('declining the claude-code gate writes pi tiers only: no claude block, no credential file', async () => {
    const io = scriptedIO({
      inputs: ['deepseek-v3', 'sonnet', 'claude-opus-4-8'], // model-tiers answers
      confirms: [false], // decline the claude-code gate
    });
    const results = await runInitSteps([modelTiersStep, claudeCodeStep], { ...ctx, io });
    expect(results.map((r) => r.status)).toEqual(['done', 'skipped']);
    expect(existsSync(ctx.credFile)).toBe(false);
    const t = JSON.parse(await fs.readFile(ctx.tiersFile, 'utf8'));
    expect(t.tiers.fast).toBe('deepseek-v3');
    expect(t.claude).toBeUndefined();
  });
});
