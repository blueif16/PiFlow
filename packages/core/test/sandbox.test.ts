import { describe, it, expect } from 'vitest';
import { InMemorySandbox, NotImplementedProvider } from '../src/index.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('InMemorySandbox lifecycle (create → stage → exec → collect → dispose)', () => {
  it('stages a file, execs against it, collects the output dir, and wipes on dispose', async () => {
    const sb = await InMemorySandbox.create({ readScope: [], outputDir: 'out', workdir: '.' });
    await sb.writeFile('in.txt', 'hello');
    const r = await sb.exec('cat in.txt > out/copy.txt');
    expect(r.code).toBe(0);
    expect(await sb.readFile('out/copy.txt', { encoding: 'utf8' })).toBe('hello');

    const dest = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-dl-'));
    await sb.downloadDir('out', path.join(dest, 'out'));
    expect(await fs.readFile(path.join(dest, 'out', 'copy.txt'), 'utf8')).toBe('hello');

    const root = sb.root;
    await sb.dispose();
    await expect(fs.stat(root)).rejects.toThrow(); // disposed ⇒ gone
    await fs.rm(dest, { recursive: true, force: true });
  });

  it('surfaces a nonzero exit code', async () => {
    const sb = await InMemorySandbox.create({ readScope: [], outputDir: 'out', workdir: '.' });
    expect((await sb.exec('exit 3')).code).toBe(3);
    await sb.dispose();
  });

  it('a not-yet-implemented provider rejects clearly', async () => {
    await expect(new NotImplementedProvider('daytona').create()).rejects.toThrow(/not implemented/);
  });
});
