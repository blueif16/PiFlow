// Target 2 · Edit E — run.ts fail-loud on a missing E2B_TEMPLATE (LOCKED spec §"Target 2 … Edit E").
//
// Today `run.ts:649` reads `const template = process.env.E2B_TEMPLATE;` and, when absent, calls
// `makeE2bProvider` with NO template → the SDK boots the E2B DEFAULT BASE IMAGE (no pi baked) → the node
// runs `pi …` → 'pi: command not found' → exit 127 → nothing is written. That silent degrade is mis-triaged
// as a workflow bug. `resolveE2bTemplate` converts it into an ACTIONABLE pre-flight error BEFORE a paid VM
// boots, naming E2B_TEMPLATE + the exit-127 consequence + both escapes.
//
// RED-first: this file imports `{ resolveE2bTemplate }` from '../src/e2b-template.js', which does not exist
// yet → the whole suite reds at import resolution. Then the implementation greens it.
//
// The observable is the FUNCTION's return value / thrown Error — a fresh call for each assertion, never a
// config/self-report substring. TEETH: making the neither-branch return `undefined` instead of throwing reds
// the throw assertion below.

import { describe, expect, it } from 'vitest';

import { resolveE2bTemplate } from '../src/e2b-template.js';

describe('resolveE2bTemplate — fail-loud pre-flight for --sandbox e2b', () => {
  it('returns the E2B_TEMPLATE id verbatim when it is set', () => {
    expect(resolveE2bTemplate({ E2B_TEMPLATE: 'riwrtwrfanz3tewd5pw6' })).toBe('riwrtwrfanz3tewd5pw6');
  });

  it('returns undefined (deliberate base-image boot, NO throw) when only PIFLOW_E2B_ALLOW_BASE is set', () => {
    expect(resolveE2bTemplate({ PIFLOW_E2B_ALLOW_BASE: '1' })).toBeUndefined();
  });

  it('throws an actionable Error naming E2B_TEMPLATE when neither is set', () => {
    // The exact silent-127 latent bug: no template + no explicit opt-in → must fail loud, not degrade.
    expect(() => resolveE2bTemplate({})).toThrow(/E2B_TEMPLATE/);
  });
});
