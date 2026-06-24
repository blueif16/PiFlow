import { describe, it, expect } from 'vitest';
import {
  applyProfile,
  applyProfileByName,
  resolveProfile,
  UnknownProfileError,
  compile,
} from '../src/index.js';
import type { NodeIntent, WorkflowSpec, ProfileSpec } from '../src/index.js';

// A NodeIntent factory carrying a PHASE + explicit dependsOn (the chain the profile rewires). reads/
// produces are empty — the grounding case (game-omni verify chain) wires edges via deps, not data-flow.
function n(label: string, phase: string, deps: string[] = []): NodeIntent {
  const io: NodeIntent['io'] = { reads: [], produces: [], artifacts: [] };
  if (deps.length) io.dependsOn = deps;
  return { label, phase, prompt: `do ${label}`, tools: {}, io };
}

/** The grounding-shaped spec: a → v1 → b → v2 → c, with v1,v2 in the `verify` phase. */
function chainSpec(profiles?: Record<string, ProfileSpec>, defaultProfile?: string): WorkflowSpec {
  return {
    meta: { name: 'chain', description: 'd' },
    nodes: [
      n('a', 'execute'),
      n('v1', 'verify', ['a']),
      n('b', 'execute', ['v1']),
      n('v2', 'verify', ['b']),
      n('c', 'execute', ['v2']),
    ],
    ...(profiles ? { profiles } : {}),
    ...(defaultProfile ? { defaultProfile } : {}),
  };
}

/** Pull a node's rewired deps out of a reduced spec (undefined ⇒ the node was elided). */
function depsOf(spec: WorkflowSpec, label: string): string[] | undefined {
  return spec.nodes.find((x) => x.label === label)?.io.dependsOn;
}

describe('applyProfile — node elision + transitive dep rewire (the load-bearing transform)', () => {
  it('elides the verify-phase nodes AND rewires every dependent past them (transitive bypass)', () => {
    const reduced = applyProfile(chainSpec(), { elidePhases: ['verify'] });
    const labels = reduced.nodes.map((x) => x.label);

    // v1, v2 are GONE.
    expect(labels).toEqual(['a', 'b', 'c']);
    expect(depsOf(reduced, 'v1')).toBeUndefined();
    expect(depsOf(reduced, 'v2')).toBeUndefined();

    // THE REWIRE: b skipped past v1 onto a; c skipped past v2 onto b. (If the bypass were dropped, b.deps
    // would stay ["v1"] — the assertion below would catch it.)
    expect(depsOf(reduced, 'a')).toBeUndefined(); // a had no deps → unchanged (no dependsOn)
    expect(depsOf(reduced, 'b')).toEqual(['a']);
    expect(depsOf(reduced, 'c')).toEqual(['b']);
  });

  it('the reduced spec COMPILES to stages WITHOUT the elided nodes (a→b→c, gateless)', () => {
    const reduced = applyProfile(chainSpec(), { elidePhases: ['verify'] });
    const wf = compile(reduced);
    expect(Object.keys(wf.nodes).sort()).toEqual(['a', 'b', 'c']);
    expect(wf.stages.map((s) => s.nodeIds)).toEqual([['a'], ['b'], ['c']]);
    // the surviving edges are the bypassed chain — no edge mentions v1/v2.
    expect(wf.edges).toEqual([
      { from: 'a', to: 'b', files: [] },
      { from: 'b', to: 'c', files: [] },
    ]);
  });

  it('collapses a RUN of consecutive elided nodes onto the nearest survivor (transitive, multi-hop)', () => {
    // a → v1 → v2 → c, eliding BOTH verify nodes → c must bypass v2 AND v1 onto a.
    const spec: WorkflowSpec = {
      meta: { name: 'run', description: 'd' },
      nodes: [n('a', 'execute'), n('v1', 'verify', ['a']), n('v2', 'verify', ['v1']), n('c', 'execute', ['v2'])],
    };
    const reduced = applyProfile(spec, { elidePhases: ['verify'] });
    expect(reduced.nodes.map((x) => x.label)).toEqual(['a', 'c']);
    expect(depsOf(reduced, 'c')).toEqual(['a']);
  });

  it('de-duplicates when an elided node fans into a survivor by two paths (diamond)', () => {
    // d depends on BOTH v1 and v2; both elided verify nodes resolve back to a → d.deps must be ["a"] once.
    const spec: WorkflowSpec = {
      meta: { name: 'diamond', description: 'd' },
      nodes: [
        n('a', 'execute'),
        n('v1', 'verify', ['a']),
        n('v2', 'verify', ['a']),
        n('d', 'execute', ['v1', 'v2']),
      ],
    };
    const reduced = applyProfile(spec, { elidePhases: ['verify'] });
    expect(depsOf(reduced, 'd')).toEqual(['a']);
  });

  it('a no-op profile ({}) returns the spec UNCHANGED (the full DAG, referential identity)', () => {
    const spec = chainSpec();
    const out = applyProfile(spec, {});
    expect(out).toBe(spec); // same object — the production-mode path is byte-for-byte the original
  });

  it('an undefined profile returns the spec unchanged (no elision)', () => {
    const spec = chainSpec();
    expect(applyProfile(spec, undefined)).toBe(spec);
  });

  it('a predicate matching NO node returns the spec unchanged', () => {
    const spec = chainSpec();
    expect(applyProfile(spec, { elidePhases: ['no-such-phase'] })).toBe(spec);
  });
});

describe('resolveProfile — name → ProfileSpec (loud on unknown; default fallback)', () => {
  const profiles = { production: {}, companion: { elidePhases: ['verify'] } };

  it('resolves an explicitly named profile to its predicate', () => {
    const spec = chainSpec(profiles, 'production');
    expect(resolveProfile(spec, 'companion')).toEqual({ elidePhases: ['verify'] });
  });

  it('falls back to defaultProfile when no name is given', () => {
    const spec = chainSpec(profiles, 'companion');
    expect(resolveProfile(spec, undefined)).toEqual({ elidePhases: ['verify'] });
  });

  it('returns undefined (the full DAG) when there is NO name and NO defaultProfile', () => {
    const spec = chainSpec(profiles); // profiles declared, but no defaultProfile
    expect(resolveProfile(spec, undefined)).toBeUndefined();
  });

  it('THROWS on an unknown profile name, LISTING the declared names (never a silent full-DAG fallback)', () => {
    const spec = chainSpec(profiles, 'production');
    expect(() => resolveProfile(spec, 'ghost')).toThrow(UnknownProfileError);
    expect(() => resolveProfile(spec, 'ghost')).toThrow(/ghost.*production.*companion/);
  });

  it('THROWS when defaultProfile itself names a missing profile (a malformed template, caught loudly)', () => {
    const spec = chainSpec(profiles, 'nope');
    expect(() => resolveProfile(spec, undefined)).toThrow(UnknownProfileError);
  });
});

describe('applyProfileByName — resolve + apply (the one call the run path makes)', () => {
  const profiles = { production: {}, companion: { elidePhases: ['verify'] } };

  it('companion ⇒ verify nodes elided + deps rewired', () => {
    const spec = chainSpec(profiles, 'production');
    const reduced = applyProfileByName(spec, 'companion');
    expect(reduced.nodes.map((x) => x.label)).toEqual(['a', 'b', 'c']);
    expect(depsOf(reduced, 'b')).toEqual(['a']);
  });

  it('production (the default) ⇒ the FULL DAG, unchanged', () => {
    const spec = chainSpec(profiles, 'production');
    const reduced = applyProfileByName(spec, undefined); // no name → defaultProfile=production={}
    expect(reduced).toBe(spec);
    expect(reduced.nodes.map((x) => x.label)).toEqual(['a', 'v1', 'b', 'v2', 'c']);
  });

  it('an unknown name errors loudly (not a silent full DAG)', () => {
    const spec = chainSpec(profiles, 'production');
    expect(() => applyProfileByName(spec, 'ghost')).toThrow(UnknownProfileError);
  });
});
