// (Phase 2 · T2.3) loadFusionConfig — the READ-ONLY reader for the global fusion defaults
// (`~/.piflow/fusion.json`). Mirrors `loadModelTiers`: absence/invalid ⇒ a safe `{active:false, defaults:{}}`
// (never throws), a present file surfaces `active` + the param defaults (`mode/n/panel/judge/obligations/
// verify`) that each `node.fusion.<param>` falls back to. It only EXPOSES the config — it never auto-marks
// a node as fusion (that activation is a SKILL/init concern, spec §2). SDK-boundary: read-only, never writes.

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadFusionConfig } from '../src/runner/fusion-config.js';

const tmpFile = async (contents: string): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-fusion-'));
  const f = path.join(dir, 'fusion.json');
  await fs.writeFile(f, contents);
  return f;
};

describe('loadFusionConfig — graceful absence (read-only, never throws)', () => {
  it('returns {active:false, defaults:{}} when the file is absent', () => {
    expect(loadFusionConfig(path.join(os.tmpdir(), 'no-such-piflow-fusion.json'))).toEqual({
      active: false,
      defaults: {},
    });
  });

  it('returns the safe default on invalid JSON (never throws)', async () => {
    const f = await tmpFile('{ not valid json');
    expect(loadFusionConfig(f)).toEqual({ active: false, defaults: {} });
  });
});

describe('loadFusionConfig — parses active + the param defaults', () => {
  it('surfaces active and every known param, dropping unknown keys', async () => {
    const f = await tmpFile(
      JSON.stringify({
        active: true,
        mode: 'moa',
        n: 5,
        panel: ['fast', 'deep'],
        judge: 'deep',
        obligations: true,
        verify: false,
        bogus: 'ignored', // unknown key must NOT leak into defaults
      }),
    );
    expect(loadFusionConfig(f)).toEqual({
      active: true,
      defaults: { mode: 'moa', n: 5, panel: ['fast', 'deep'], judge: 'deep', obligations: true, verify: false },
    });
  });

  it('active defaults to false when the key is absent, and only sets the params present', async () => {
    const f = await tmpFile(JSON.stringify({ panel: ['a', 'b'] }));
    expect(loadFusionConfig(f)).toEqual({ active: false, defaults: { panel: ['a', 'b'] } });
  });
});
