import { describe, it, expect } from 'vitest';
import { runHooks } from '../src/index.js';
import type { Hook, HookContext } from '../src/index.js';

const ctx: HookContext = { workspace: '/tmp', inputs: [], outputs: [] };
const hook = (over: Partial<Hook>): Hook => ({
  id: 'h',
  phase: 'post',
  inputs: [],
  outputs: [],
  when: 'always',
  run: async () => {},
  ...over,
});

describe('runHooks', () => {
  it('fires only the hooks whose `when` matches the outcome', async () => {
    const calls: string[] = [];
    const hooks: Hook[] = [
      hook({ id: 'always', when: 'always', run: async () => void calls.push('always') }),
      hook({ id: 'succ', when: 'on-success', run: async () => void calls.push('succ') }),
      hook({ id: 'fail', when: 'on-failure', run: async () => void calls.push('fail') }),
    ];
    await runHooks(hooks, ctx, { outcome: 'failure' });
    expect(calls).toEqual(['always', 'fail']);
  });

  it('skips a fresh idempotent hook (outputs newer than inputs)', async () => {
    let ran = 0;
    const mtime = async (p: string): Promise<number> => (p.endsWith('/out') ? 200 : 100);
    const h = hook({ phase: 'pre', inputs: ['in'], outputs: ['out'], run: async () => void ran++ });
    const reports = await runHooks([h], ctx, { outcome: 'success', mtime });
    expect(reports[0]).toMatchObject({ ran: false, skipped: 'idempotent' });
    expect(ran).toBe(0);
  });

  it('re-runs when a declared output is missing', async () => {
    let ran = 0;
    const mtime = async (p: string): Promise<number | null> => (p.endsWith('/out') ? null : 100);
    const h = hook({ phase: 'pre', inputs: ['in'], outputs: ['out'], run: async () => void ran++ });
    await runHooks([h], ctx, { outcome: 'success', mtime });
    expect(ran).toBe(1);
  });

  it('throws on a blocking failure but only collects a warn failure', async () => {
    const boom = hook({ id: 'boom', failure: 'block', run: async () => { throw new Error('nope'); } });
    await expect(runHooks([boom], ctx, { outcome: 'success' })).rejects.toThrow(/boom.*blocking/);

    const warn = hook({ id: 'warn', failure: 'warn', run: async () => { throw new Error('nope'); } });
    const reports = await runHooks([warn], ctx, { outcome: 'success' });
    expect(reports[0]).toMatchObject({ id: 'warn', ran: true, ok: false, error: 'nope' });
  });
});
