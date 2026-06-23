import { describe, it, expect } from 'vitest';
import { resolveTokens, resolveAll, MissingChannelError } from '../src/index.js';
import type { ResolveCtx } from '../src/index.js';

const ctx = (over: Partial<ResolveCtx> = {}): ResolveCtx => ({
  run: '/runs/abc',
  workspace: '/canon',
  state: { archetype: 'platformer', n: 3 },
  ...over,
});

describe('resolveTokens — the single logical-root + state resolver (U7)', () => {
  it('{{RUN}} resolves to the per-thread run dir', () => {
    expect(resolveTokens('{{RUN}}/spec/x.json', ctx())).toBe('/runs/abc/spec/x.json');
  });

  it('{{WORKSPACE}} resolves to the canonical out-of-thread tree', () => {
    expect(resolveTokens('{{WORKSPACE}}/packages/skills/write-gdd', ctx())).toBe(
      '/canon/packages/skills/write-gdd',
    );
  });

  it('{{state.<channel>}} resolves to the channel value from RunState', () => {
    expect(resolveTokens('arch={{state.archetype}}', ctx())).toBe('arch=platformer');
  });

  it('coerces a non-string channel value to its string form', () => {
    expect(resolveTokens('{{state.n}}', ctx())).toBe('3');
  });

  it('resolves MANY tokens in one string (mixed roots + state)', () => {
    expect(
      resolveTokens('{{WORKSPACE}}/templates/modules/{{state.archetype}} -> {{RUN}}/out', ctx()),
    ).toBe('/canon/templates/modules/platformer -> /runs/abc/out');
  });

  it('tolerates whitespace inside the delimiters', () => {
    expect(resolveTokens('{{ RUN }}/x', ctx())).toBe('/runs/abc/x');
    expect(resolveTokens('{{ state.archetype }}', ctx())).toBe('platformer');
  });

  it('THROWS a clear error for a missing channel — never a silent empty string', () => {
    expect(() => resolveTokens('{{state.nope}}', ctx())).toThrow(MissingChannelError);
    expect(() => resolveTokens('{{state.nope}}', ctx())).toThrow(/nope/);
    // load-bearing: it must NOT degrade to '' (the retired silent-token behavior).
    let resolved: string | undefined;
    try {
      resolved = resolveTokens('x={{state.nope}}', ctx());
    } catch {
      resolved = undefined;
    }
    expect(resolved).toBeUndefined();
  });

  it('leaves a string with no tokens unchanged', () => {
    expect(resolveTokens('templates/x.json', ctx())).toBe('templates/x.json');
  });

  it('treats an explicitly-null channel value as PRESENT (not missing) — only an ABSENT key throws', () => {
    expect(resolveTokens('{{state.maybe}}', ctx({ state: { maybe: null } }))).toBe('null');
  });
});

describe('resolveAll — uniform application across a marker list', () => {
  it('resolves every entry of a marker array (artifacts / readScope / owns / seed / schema)', () => {
    const readScope = [
      '{{RUN}}',
      '{{WORKSPACE}}/packages/skills/write-gdd',
      '{{WORKSPACE}}/templates/modules/{{state.archetype}}',
    ];
    expect(resolveAll(readScope, ctx())).toEqual([
      '/runs/abc',
      '/canon/packages/skills/write-gdd',
      '/canon/templates/modules/platformer',
    ]);
  });
});

describe('relocation-invariance — the resolver SUPERSEDES the retired BASE_ROOT→wtRoot regex', () => {
  it('the SAME {{RUN}}/{{WORKSPACE}} markers resolve under two DIFFERENT physical roots — no text rewrite', () => {
    // The retired model re-rooted a worktree thread with a `BASE_ROOT→wtRoot` string regex on the prompt
    // (which broke on relative / remote paths). Here the IDENTICAL marker set resolves correctly whether the
    // thread runs IN-PLACE or relocated to a worktree/remote root — re-rooting is just "resolve two roots".
    const markers = ['{{RUN}}/spec/blueprint.json', '{{WORKSPACE}}/templates/genres.json'];
    const inPlace = resolveAll(markers, { run: '/repo/out/game', workspace: '/repo' });
    const worktree = resolveAll(markers, { run: '/wt/pi-abc/out/game', workspace: '/wt/pi-abc' });
    const remote = resolveAll(markers, { run: '/vm/run', workspace: '/vm/canon' });
    expect(inPlace).toEqual(['/repo/out/game/spec/blueprint.json', '/repo/templates/genres.json']);
    expect(worktree).toEqual(['/wt/pi-abc/out/game/spec/blueprint.json', '/wt/pi-abc/templates/genres.json']);
    expect(remote).toEqual(['/vm/run/spec/blueprint.json', '/vm/canon/templates/genres.json']);
  });
});
