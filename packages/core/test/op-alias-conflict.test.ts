// A2 oracle — checkOpAliasConflict must catch the SILENT context-injection loss: a node that authors
// `op[]` directly short-circuits `lowerToOps` (`if (def.op) return def.op`), so its `inject`/`hooks.*`
// aliases are NEVER lowered — they vanish with no error (e.g. DRIVER-INJECT disappears; the model stops
// receiving the injected file). The migration that surfaced this only caught it by diffing resolved
// markers; this check makes the loader reject the conflict loudly instead.
//
// The load-bearing subtlety: `checks`/`policy`/`return` are EXEMPT — `toNodeIntent` re-collects them onto
// the NodeIO independent of `op` (io.checks/io.policy/io.returnSchema), so they SURVIVE alongside an
// authored `op[]`. Flagging them would be a false positive. So the checks-coexist case asserts EMPTY.
//
// checkOpAliasConflict is PURE over LoadedNode[] — we construct nodes directly (no fixture/disk round-trip).

import { describe, it, expect } from 'vitest';
import { checkOpAliasConflict } from '../src/workflow/template/checks.js';
import type { LoadedNode } from '../src/workflow/template/types.js';
import type { OpSpec } from '../src/types.js';

/** Minimal LoadedNode builder — the fields checkOpAliasConflict reads (def.id/op/inject/hooks). */
function node(
  id: string,
  opts: {
    op?: OpSpec[];
    inject?: string[];
    hooks?: NonNullable<LoadedNode['def']['hooks']>;
    checks?: NonNullable<LoadedNode['def']['checks']>;
    policy?: NonNullable<LoadedNode['def']['policy']>;
  } = {},
): LoadedNode {
  return {
    def: {
      id,
      phase: 'p',
      deps: [],
      contract: { artifacts: [], owns: [], readScope: [] },
      ...(opts.op ? { op: opts.op } : {}),
      ...(opts.inject ? { inject: opts.inject } : {}),
      ...(opts.hooks ? { hooks: opts.hooks } : {}),
      ...(opts.checks ? { checks: opts.checks } : {}),
      ...(opts.policy ? { policy: opts.policy } : {}),
    } as LoadedNode['def'],
    dir: `/tmp/${id}`,
    prose: '',
  };
}

const OP: OpSpec[] = [{ when: 'pre', reads: ['ignored.md'] }];

describe('checkOpAliasConflict — op[] silently drops inject/hooks (A2)', () => {
  it('op[] + inject → ONE violation naming the node and `inject`', () => {
    const errs = checkOpAliasConflict([node('n', { op: OP, inject: ['visual-design.md'] })]);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('"n"');
    expect(errs[0]).toContain('inject');
  });

  it('op[] + hooks.merge → ONE violation naming `hooks.merge`', () => {
    const errs = checkOpAliasConflict([
      node('m', { op: OP, hooks: { merge: { ops: [{ run: { cmd: 'x' } }] } } }),
    ]);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('hooks.merge');
  });

  it('op[] + BOTH inject and hooks.promote → ONE violation listing BOTH dropped aliases', () => {
    const errs = checkOpAliasConflict([
      node('b', { op: OP, inject: ['x.md'], hooks: { promote: [{ from: '@return:x', to: 'X' }] } }),
    ]);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('inject');
    expect(errs[0]).toContain('hooks.promote');
  });

  it('op[] with NO inject/hooks → no violation (a legitimately op-authored node)', () => {
    expect(checkOpAliasConflict([node('ok', { op: OP })])).toEqual([]);
  });

  it('inject/hooks WITHOUT op → no violation (the aliases lower normally — the common path)', () => {
    const errs = checkOpAliasConflict([
      node('alias', { inject: ['x.md'], hooks: { merge: { ops: [{ run: { cmd: 'x' } }] } } }),
    ]);
    expect(errs).toEqual([]);
  });

  it('op[] + checks/policy (NO inject/hooks) → NO violation — checks/policy survive their own channels', () => {
    const errs = checkOpAliasConflict([
      node('c', {
        op: OP,
        checks: { post: [{ kind: 'non-empty', path: 'out.md', severity: 'fail' }] },
        policy: { fail: 'block' },
      }),
    ]);
    expect(errs).toEqual([]);
  });
});
