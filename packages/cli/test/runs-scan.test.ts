// packages/cli/src/runs-scan.ts — parseNodeRef: the DOTTED `<run>.<node>` reference resolver a substrate verb's
// `--node` arg accepts (`--node tS2.gameplay` ≡ `--node gameplay --run tS2`). Every test FAILS when the
// dot-splitting or the run-dir precedence rule is wrong.
//
// Run: npx vitest run packages/cli/test/runs-scan.test.ts

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseNodeRef } from '../src/runs-scan.js';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'runs-scan-'));

/** A bare run dir under `runsHome` — enough for `listRunIds` (a readdir) to see it; no `.pi/run.json` needed. */
async function seedRunDir(runsHome: string, id: string): Promise<void> {
  await fs.mkdir(path.join(runsHome, id), { recursive: true });
}

describe('parseNodeRef — dotted --node <run>.<node> resolution', () => {
  it('a plain (dot-free) node passes through untouched — no run key, no fs read required', () => {
    // a bogus runsHome proves this path never stats the filesystem for the dot-free case.
    expect(parseNodeRef('gameplay', '/does/not/exist')).toEqual({ node: 'gameplay' });
  });

  it('pair equivalence: segment 0 names a base run, segment 1 is the node', async () => {
    const runsHome = await tmp();
    await seedRunDir(runsHome, 'tS2'); // only the base run exists — no run literally named "tS2.gameplay"
    expect(parseNodeRef('tS2.gameplay', runsHome)).toEqual({ run: 'tS2', node: 'gameplay' });
  });

  it('child-run-id precedence: when BOTH tS2/ and tS2.gameplay/ exist, the full-string match wins', async () => {
    const runsHome = await tmp();
    await seedRunDir(runsHome, 'tS2');
    await seedRunDir(runsHome, 'tS2.gameplay'); // a genuine child-run id (childRunName's own mint shape)
    expect(parseNodeRef('tS2.gameplay', runsHome)).toEqual({ run: 'tS2.gameplay', node: 'gameplay' });
  });

  it('an unknown run (neither the full string nor segment 0) errors, naming both attempts', async () => {
    const runsHome = await tmp();
    await seedRunDir(runsHome, 'unrelated');
    let message = '';
    try {
      parseNodeRef('ghost.gameplay', runsHome);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/no run/);
    expect(message).toContain('ghost.gameplay'); // the full-string attempt
    expect(message).toContain('"ghost"'); // segment 0's attempt, named distinctly (quoted, not just a substring hit)
  });
});
