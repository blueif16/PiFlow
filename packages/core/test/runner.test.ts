import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile } from '../src/index.js';
import type { NodeIntent, WorkflowSpec } from '../src/index.js';
import {
  runWorkflow,
  defaultExecRunner,
  defaultPiCommand,
  type ExecRunner,
} from '../src/runner/index.js';
import type { Sandbox } from '../src/types.js';

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────

/** A NodeIntent factory (mirrors dag.test): reads/produces; artifacts default to produces. */
function n(label: string, reads: string[], produces: string[], over: Partial<NodeIntent> = {}): NodeIntent {
  return {
    label,
    prompt: `do ${label}`,
    tools: {},
    io: { reads, produces, artifacts: produces.map((p) => ({ path: p })) },
    ...over,
  };
}
const wf = (nodes: NodeIntent[]): WorkflowSpec => ({ meta: { name: 't', description: 'd' }, nodes });

/** A fresh host run dir under the OS tmp (so a test never writes into the repo). */
async function tmpOut(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'piflow-run-'));
}

/**
 * THE STUB COMMAND BUILDER — the offline injection point. Instead of spawning `pi`, it returns a
 * shell command that writes each of the node's declared artifacts into its sandbox OUTPUT dir at
 * `<output>/<artifactPath>` (the path convention downloadDir flattens onto the host run dir), plus a
 * tiny return-protocol JSON block on stdout. This exercises the REAL lifecycle (stage → exec →
 * downloadDir → host-stat verify → hooks → dispose) with no live pi, no creds, no network.
 *
 * `producePaths` lets a test make a node NOT write a declared artifact (to drive the blocked path).
 */
function stubBuilder(producePaths?: (node: { id: string }) => string[]) {
  return (node: { id: string; io: { artifacts: { path: string }[] }; sandbox: { output: string } }): string => {
    const paths = producePaths ? producePaths(node) : node.io.artifacts.map((a) => a.path);
    const writes = paths
      .map((p) => {
        const dest = `${node.sandbox.output}/${p}`;
        const dir = dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : '.';
        return `mkdir -p ${dir} && printf '%s' ${node.id} > ${dest}`;
      })
      .join(' && ');
    const ret = `printf '%s' '\`\`\`json\\n{"status":"ok","summary":"${node.id} done"}\\n\`\`\`'`;
    return writes ? `${writes} && ${ret}` : ret;
  };
}

// ── 1. end-to-end ───────────────────────────────────────────────────────────────────────────────

describe('runWorkflow — end-to-end on InMemorySandboxProvider (no live pi)', () => {
  it('runs a parallel stage then a consumer, verifies artifacts, and writes run-status.json', async () => {
    // Two independent producers (parallel stage 1) → one consumer that reads BOTH (stage 2).
    const g = compile(
      wf([
        n('Alpha', [], ['alpha.txt']),
        n('Beta', [], ['beta.txt']),
        n('Gamma', ['alpha.txt', 'beta.txt'], ['gamma.txt']),
      ]),
    );
    expect(g.stages[0]).toMatchObject({ parallel: true, nodeIds: ['alpha', 'beta'] });

    const outDir = await tmpOut();
    // Observe concurrency: wrap the default exec runner, tracking how many execs are in flight at once.
    let inFlight = 0;
    let maxInFlight = 0;
    const tracking: ExecRunner = async (sandbox, cmd, opts) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        // a tick of overlap so the two parallel-lane execs are both counted in-flight
        await new Promise((r) => setTimeout(r, 5));
        return await defaultExecRunner(sandbox, cmd, opts);
      } finally {
        inFlight--;
      }
    };

    const { status } = await runWorkflow(g, { run: 'e2e', outDir, buildCommand: stubBuilder(), execRunner: tracking });

    // Parallel stage actually ran both lanes concurrently.
    expect(maxInFlight).toBe(2);

    // Stage order: Gamma's consumed inputs were staged from the host run dir (cross-sandbox flow),
    // so its own artifact exists only if Alpha/Beta landed first.
    expect(status.ok).toBe(true);
    expect(status.done).toBe(true);
    expect(status.nodes.alpha.status).toBe('ok');
    expect(status.nodes.beta.status).toBe('ok');
    expect(status.nodes.gamma.status).toBe('ok');

    // Artifacts verified by host-stat (path convention: <output>/<artifactPath> → <hostRunDir>/<path>).
    expect(status.nodes.gamma.artifacts).toEqual([{ path: 'gamma.txt', exists: true, bytes: 'gamma'.length }]);
    for (const f of ['alpha.txt', 'beta.txt', 'gamma.txt']) {
      expect(await fs.readFile(path.join(outDir, f), 'utf8')).toBeTruthy();
    }

    // run-status.json written with the right shape.
    const onDisk = JSON.parse(await fs.readFile(path.join(outDir, 'run-status.json'), 'utf8'));
    expect(onDisk).toMatchObject({ run: 'e2e', done: true, ok: true, totals: { nodes: 3, ok: 3, failed: 0 } });
    expect(onDisk.startedAt).toBeTruthy();
    expect(onDisk.nodes.gamma.artifacts[0]).toMatchObject({ path: 'gamma.txt', exists: true });

    await fs.rm(outDir, { recursive: true, force: true });
  });
});

// ── 2. halt-on-failure ──────────────────────────────────────────────────────────────────────────

describe('runWorkflow — halt-on-failure', () => {
  it('blocks a node that does not produce its declared artifact and never runs downstream', async () => {
    const g = compile(wf([n('Up', [], ['up.txt']), n('Down', ['up.txt'], ['down.txt'])]));
    const outDir = await tmpOut();

    let downRan = false;
    // `Up` produces NOTHING (empty produce list for it); `Down` would run normally if reached.
    const builder = stubBuilder((node) => {
      if (node.id === 'down') downRan = true;
      return node.id === 'up' ? [] : ['down.txt'];
    });

    const { status } = await runWorkflow(g, { run: 'halt', outDir, buildCommand: builder });

    expect(status.nodes.up.status).toBe('blocked');
    expect(status.nodes.up.issues.join(' ')).toMatch(/required artifact.*missing/i);
    expect(downRan).toBe(false); // downstream never executed
    expect(status.nodes.down.status).toBe('pending'); // never advanced past pending
    expect(status.ok).toBe(false);
    expect(status.done).toBe(true);

    await fs.rm(outDir, { recursive: true, force: true });
  });
});

// ── 3. resume (--from) ──────────────────────────────────────────────────────────────────────────

describe('runWorkflow — --from resume', () => {
  it('reuses present upstream artifacts and runs only the suffix', async () => {
    const g = compile(wf([n('Stage1', [], ['s1.txt']), n('Stage2', ['s1.txt'], ['s2.txt'])]));
    const outDir = await tmpOut();
    // Pre-place the upstream artifact on the host (as a prior run would have).
    await fs.writeFile(path.join(outDir, 's1.txt'), 'from-prior-run');

    let stage1Ran = false;
    const builder = stubBuilder((node) => {
      if (node.id === 'stage1') stage1Ran = true;
      return node.io.artifacts.map((a) => a.path);
    });

    const { status } = await runWorkflow(g, { run: 'resume', outDir, from: 'stage2', buildCommand: builder });

    expect(stage1Ran).toBe(false); // upstream NOT re-executed
    expect(status.nodes.stage1.status).toBe('reused');
    expect(status.nodes.stage1.artifacts).toEqual([{ path: 's1.txt', exists: true, bytes: 'from-prior-run'.length }]);
    expect(status.nodes.stage2.status).toBe('ok');
    expect(status.ok).toBe(true);
    // The downstream node consumed the reused upstream file (staged from the host run dir).
    expect(await fs.readFile(path.join(outDir, 's2.txt'), 'utf8')).toBe('stage2');

    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('HALTs when a required upstream artifact is missing', async () => {
    const g = compile(wf([n('Stage1', [], ['s1.txt']), n('Stage2', ['s1.txt'], ['s2.txt'])]));
    const outDir = await tmpOut(); // s1.txt NOT placed → preflight must halt

    let anyRan = false;
    const builder = stubBuilder((node) => { anyRan = true; return node.io.artifacts.map((a) => a.path); });

    const { status } = await runWorkflow(g, { run: 'resume-miss', outDir, from: 'stage2', buildCommand: builder });

    expect(anyRan).toBe(false); // halted BEFORE any node ran
    expect(status.ok).toBe(false);
    expect(status.done).toBe(true);
    expect(JSON.stringify(status.nodes)).toMatch(/missing upstream artifact/i);

    await fs.rm(outDir, { recursive: true, force: true });
  });
});

// ── 4. watchdog (node timeout) ────────────────────────────────────────────────────────────────────

describe('runWorkflow — node-timeout watchdog', () => {
  it('kills a node that sleeps beyond nodeTimeoutMs and marks it error (killedTimeout), not hung', async () => {
    const g = compile(wf([n('Slow', [], ['slow.txt'])]));
    const outDir = await tmpOut();

    // A stub that sleeps far longer than the tiny node timeout and only writes its artifact AFTER.
    const slowBuilder = (node: { sandbox: { output: string } }): string =>
      `sleep 5 && mkdir -p ${node.sandbox.output} && printf '%s' slow > ${node.sandbox.output}/slow.txt`;

    const start = Date.now();
    const { status } = await runWorkflow(g, {
      run: 'watchdog',
      outDir,
      buildCommand: slowBuilder,
      nodeTimeoutMs: 60, // tiny
      killGraceMs: 10,
    });
    const elapsed = Date.now() - start;

    expect(status.nodes.slow.status).toBe('error');
    expect(status.nodes.slow.killedTimeout).toBe(true);
    expect(status.nodes.slow.artifacts).toEqual([{ path: 'slow.txt', exists: false, bytes: 0 }]);
    expect(status.ok).toBe(false);
    // It returned promptly (watchdog abandoned the wait) rather than blocking ~5s on the sleep.
    expect(elapsed).toBeLessThan(3000);

    await fs.rm(outDir, { recursive: true, force: true });
  });
});

// ── command builder (the production default's flag shape) ────────────────────────────────────────

describe('defaultPiCommand — production headless flags', () => {
  it('builds the headless pi invocation with provider, tools, and @prompt', () => {
    const node = compile(wf([n('X', [], ['x.txt'])])).nodes.x;
    const cmd = defaultPiCommand(node, { piTools: ['read', 'write'] }, { promptFile: '_pi/prompt.md', provider: 'cp', model: 'm1' });
    expect(cmd).toContain('pi -p --mode json -a --no-session --offline --no-extensions --no-context-files');
    expect(cmd).toContain('--provider cp');
    expect(cmd).toContain('--model m1');
    expect(cmd).toContain('--tools read,write');
    expect(cmd).toMatch(/@'_pi\/prompt\.md'$/);
  });
});
