import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { instantiateRun } from '../src/workflow/template/instantiate.js';
import { nodeDir, nodePromptFile, nodeIoFile, nodeEventsFile, stateFile } from '../src/runner/layout.js';

// The REAL authored template fixture (template-format.md §10's init-RUN INPUT) — NOT a hand-made stub.
const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'template-min',
);

async function tmpRun(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'piflow-initrun-'));
}

/** Read the authored template's raw bytes for a node file (bucket-1 byte-identity reference). */
async function tmplBytes(id: string, file: string): Promise<string> {
  return fs.readFile(path.join(FIXTURE, 'nodes', id, file), 'utf8');
}

describe('instantiateRun (init-RUN) — the four §10 buckets over the real template-min fixture', () => {
  it('materializes .pi/nodes/<id>/ for every node + the run-level state stub', async () => {
    const runDir = await tmpRun();
    const workspace = '/canon/ws';
    await instantiateRun(FIXTURE, runDir, { workspace });

    // every authored node got its dedicated run folder
    for (const id of ['w0-classify', 'w2a-levels', 'w2b-assets']) {
      const st = await fs.stat(nodeDir(runDir, id));
      expect(st.isDirectory()).toBe(true);
    }

    // BUCKET 4 — run-level state stub seeded EMPTY ({})
    expect(JSON.parse(await fs.readFile(stateFile(runDir), 'utf8'))).toEqual({});

    await fs.rm(runDir, { recursive: true, force: true });
  });

  it('PRESERVES a pre-existing state.json on re-instantiation (a --from resume must NOT wipe promoted channels)', async () => {
    const runDir = await tmpRun();
    // First run: instantiate stubs {}, then an upstream node promotes a channel into RunState.
    await instantiateRun(FIXTURE, runDir, { workspace: '/canon/ws' });
    await fs.writeFile(stateFile(runDir), JSON.stringify({ archetype: 'platformer' }));

    // A --from resume re-instantiates the run (runFromTemplate calls instantiateRun every time). The
    // promoted state MUST survive — else a reused upstream node's channel vanishes and a downstream
    // {{state.archetype}} consumer fails with "unresolved state channel".
    await instantiateRun(FIXTURE, runDir, { workspace: '/canon/ws' });

    expect(JSON.parse(await fs.readFile(stateFile(runDir), 'utf8'))).toEqual({ archetype: 'platformer' });

    await fs.rm(runDir, { recursive: true, force: true });
  });

  it('BUCKET 1 — copies each node.json BYTE-IDENTICAL (verbatim, no token resolution in node.json)', async () => {
    const runDir = await tmpRun();
    await instantiateRun(FIXTURE, runDir, { workspace: '/canon/ws' });

    for (const id of ['w0-classify', 'w2a-levels', 'w2b-assets']) {
      const copied = await fs.readFile(path.join(nodeDir(runDir, id), 'node.json'), 'utf8');
      const authored = await tmplBytes(id, 'node.json');
      expect(copied).toBe(authored); // byte-identical — node.json is the frozen contract source
    }

    await fs.rm(runDir, { recursive: true, force: true });
  });

  it('BUCKET 2 — resolves {{RUN}}/{{WORKSPACE}} to the physical roots in the prose AND leaves {{state.*}} DEFERRED', async () => {
    const runDir = await tmpRun();
    const workspace = '/canon/ws';
    await instantiateRun(FIXTURE, runDir, { workspace });

    // w0's prose carries {{RUN}}/spec/request.json → must resolve to the physical run root.
    const w0 = await fs.readFile(nodePromptFile(runDir, 'w0-classify'), 'utf8');
    expect(w0).toContain(`${runDir}/spec/request.json`);
    expect(w0).not.toMatch(/\{\{\s*RUN\s*\}\}/); // no RUN token survives

    // w2a's prose + tail carry {{state.archetype}} → must be LEFT as a deferred token (resolved at launch).
    const w2a = await fs.readFile(nodePromptFile(runDir, 'w2a-levels'), 'utf8');
    expect(w2a).toContain('{{state.archetype}}'); // state token NOT resolved at instantiation
    expect(w2a).toContain(workspace); // {{WORKSPACE}} resolved
    expect(w2a).not.toMatch(/\{\{\s*WORKSPACE\s*\}\}/); // no WORKSPACE token survives

    await fs.rm(runDir, { recursive: true, force: true });
  });

  it('BUCKET 3 — appends the markersFromNode tail (DRIVER-*) to each copied prose body', async () => {
    const runDir = await tmpRun();
    const workspace = '/canon/ws';
    await instantiateRun(FIXTURE, runDir, { workspace });

    const w0 = await fs.readFile(nodePromptFile(runDir, 'w0-classify'), 'utf8');
    // the prose body survives (its first line) AND the rendered contract tail is appended after it.
    expect(w0).toContain('Classify the request');
    expect(w0).toMatch(/DRIVER-ARTIFACTS:/); // the marker tail is present
    expect(w0).toContain('DRIVER-ARTIFACTS: spec/classification.json'); // run-relative artifact carried into the tail
    // the READ-SCOPE marker carries {{RUN}}/{{WORKSPACE}} — those resolved to physical roots in the tail too.
    expect(w0).toContain(`DRIVER-READ-SCOPE: ${runDir} ${workspace}/packages/skills/classify`);
    // tail comes AFTER the prose body
    expect(w0.indexOf('Classify the request')).toBeLessThan(w0.indexOf('DRIVER-ARTIFACTS:'));

    await fs.rm(runDir, { recursive: true, force: true });
  });

  it('BUCKET 4 — ships EMPTY io.json ({}) + events.jsonl (empty) stubs per node', async () => {
    const runDir = await tmpRun();
    await instantiateRun(FIXTURE, runDir, { workspace: '/canon/ws' });

    for (const id of ['w0-classify', 'w2a-levels', 'w2b-assets']) {
      expect(JSON.parse(await fs.readFile(nodeIoFile(runDir, id), 'utf8'))).toEqual({});
      expect(await fs.readFile(nodeEventsFile(runDir, id), 'utf8')).toBe('');
    }

    await fs.rm(runDir, { recursive: true, force: true });
  });
});
