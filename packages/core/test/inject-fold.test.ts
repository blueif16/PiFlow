// (M5 · #10) inject-fold — a PRE op's reads must FOLD into the realized prompt. The `inject:[path]` grammar
// lowers to a pre-op `{when:'pre', reads:[path]}`, and that read is now surfaced in the node's realized
// prompt so the model knows which forced-read inputs to load (the long-stale `loader.ts:121` reads:[] hardcode
// meant injected reads NEVER folded). This is a genuine NEW behavior (#10), not a preserve.
//
// Written test-first against today's loader: the realized prompt carries the DRIVER-* contract tail but NOT
// the injected forced-read paths — so the assertion that the injected path appears in the realized prompt is
// RED for the right reason (the fold step does not exist).

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTemplate } from '../src/index.js';

const writeJson = (p: string, v: unknown): Promise<void> => fs.writeFile(p, JSON.stringify(v, null, 2) + '\n');

async function templateWith(def: Record<string, unknown>, prose: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-inject-'));
  await writeJson(path.join(dir, 'meta.json'), { id: 't', name: 't', description: 'd', phases: ['build'] });
  const ndir = path.join(dir, 'nodes', String(def.id));
  await fs.mkdir(ndir, { recursive: true });
  await writeJson(path.join(ndir, 'node.json'), def);
  await fs.writeFile(path.join(ndir, 'prompt.md'), prose);
  return dir;
}

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true });
});

describe('inject-fold — a pre-op read folds into the realized prompt (#10)', () => {
  it("the injected forced-read path appears in the node's realized prompt", async () => {
    const def = {
      id: 'w0',
      phase: 'build',
      deps: [],
      prompt: { file: 'prompt.md' },
      inject: ['{{RUN}}/spec/request.json'],
      contract: { artifacts: ['spec/out.json'], owns: ['spec/**'], readScope: ['{{RUN}}'] },
    };
    const dir = await templateWith(def, 'Classify the request.');
    dirs.push(dir);

    const spec = await loadTemplate(dir);
    const node = spec.nodes.find((n) => n.label === 'w0')!;

    // The prose survives …
    expect(node.prompt).toContain('Classify the request.');
    // … AND the injected forced-read path is FOLDED into the realized prompt (RED today: it is not).
    expect(node.prompt, 'the injected read must fold into the realized prompt').toContain('spec/request.json');
  });
});
