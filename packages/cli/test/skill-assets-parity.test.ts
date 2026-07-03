import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The `okf-slices` skill is the PORTABLE brain (installed globally, travels to any repo). Its SETUP mode seeds
// a target repo from a BUNDLED copy of the engine under `assets/`. That copy must never drift from the live,
// dogfooded engine (`.agents/okf/topics/`) — else a repo seeded from the skill gets a stale ranker/gate. This
// is the M2 drift gate: the bundled assets are byte-identical to the canonical engine. When the live engine
// changes (like M1 did), re-copy it into the skill's assets/ — this test fails until you do (code-as-truth).
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const LIVE = path.join(REPO, '.agents', 'okf', 'topics');
const BUNDLED = path.join(REPO, '.claude', 'skills', 'okf-slices', 'assets');

describe('okf-slices bundled engine assets — parity with the live engine (M2 drift gate)', () => {
  for (const f of ['_generate.mjs', '_rank.mjs']) {
    it(`${f} bundled in the skill is byte-identical to the canonical engine`, () => {
      const bundled = path.join(BUNDLED, f);
      expect(existsSync(bundled)).toBe(true); // the skill must carry the engine so SETUP is self-contained
      expect(readFileSync(bundled, 'utf8')).toBe(readFileSync(path.join(LIVE, f), 'utf8'));
    });
  }
});
