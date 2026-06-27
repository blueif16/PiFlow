// Contract parity: the provider-agnostic Sandbox/runWorkflow lifecycle (the LOCAL in-memory backend).
//
// The seam's promise (l1-node-envelope.md philosophy #6): "One provider-agnostic lifecycle, identical
// local or cloud: create → stage → exec → collect → dispose; only the `provider` swaps." This file makes
// that promise EXECUTABLE for the in-tree backends — the user-visible CONTRACT (lifecycle, cross-sandbox
// file flow, host-stat artifact verification, run verdict) the runner exposes regardless of provider.
//
// The CLOUD rows (Daytona/E2B) live in their own choose-to-install extension packages
// (packages/daytona/test/sandbox-daytona-parity.test.ts, packages/e2b/test/sandbox-e2b-parity.test.ts):
// each drives the REAL provider against a fake SDK and re-runs THESE SAME assertions, proving the cloud
// backend honors the identical contract. Core keeps the provider-agnostic harness + the inmemory row.

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile, InMemorySandboxProvider, runWorkflow } from '../src/index.js';
import type { NodeIntent, WorkflowSpec, Sandbox, SandboxProvider } from '../src/index.js';

// ── shared workflow helpers (mirror runner.test.ts / sandbox-seatbelt.test.ts) ───────────────────────

function node(label: string, reads: string[], produces: string[], over: Partial<NodeIntent> = {}): NodeIntent {
  return {
    label,
    prompt: `do ${label}`,
    tools: {},
    io: { reads, produces, artifacts: produces.map((p) => ({ path: p })) },
    ...over,
  };
}
const wf = (nodes: NodeIntent[]): WorkflowSpec => ({ meta: { name: 't', description: 'd' }, nodes });

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `piflow-${prefix}-`));
}

// The offline stub command builder (identical to runner.test.ts): instead of spawning `pi`, write each
// declared artifact into the node's sandbox OUTPUT dir at <output>/<artifactPath> (the path convention
// downloadDir flattens onto the host run dir), plus a return-protocol JSON block on stdout.
function stubBuilder(producePaths?: (node: { id: string }) => string[]) {
  return (n: { id: string; io: { artifacts: { path: string }[] }; sandbox: { output: string } }): string => {
    const paths = producePaths ? producePaths(n) : n.io.artifacts.map((a) => a.path);
    const writes = paths
      .map((p) => {
        const dest = `${n.sandbox.output}/${p}`;
        const dir = dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : '.';
        return `mkdir -p ${dir} && printf '%s' ${n.id} > ${dest}`;
      })
      .join(' && ');
    const ret = `printf '%s' '\`\`\`json\\n{"status":"ok","summary":"${n.id} done"}\\n\`\`\`'`;
    return writes ? `${writes} && ${ret}` : ret;
  };
}

// ── provider cases: the SAME wiring the user writes, only `provider` swaps ────────────────────────────

interface ProviderCase {
  name: string;
  setup: () => Promise<{ provider: SandboxProvider; cleanup: () => Promise<void> }>;
}

const PROVIDER_CASES: ProviderCase[] = [
  {
    name: 'inmemory (local)',
    setup: async () => ({ provider: new InMemorySandboxProvider(), cleanup: async () => {} }),
  },
];

// ── 1. low-level Sandbox lifecycle parity (bare, no runner) ───────────────────────────────────────────
// Drives create → writeFile → exec → readFile → downloadDir → dispose. The provider-agnostic contract.

interface SandboxCase {
  name: string;
  makeSandbox: () => Promise<{ sandbox: Sandbox; cleanup: () => Promise<void> }>;
}

const SANDBOX_CASES: SandboxCase[] = [
  {
    name: 'inmemory (local)',
    makeSandbox: async () => {
      const sandbox = await new InMemorySandboxProvider().create({ readScope: [], outputDir: 'out', workdir: 'work' });
      return { sandbox, cleanup: async () => { await sandbox.dispose().catch(() => {}); } };
    },
  },
];

describe.each(SANDBOX_CASES)('Sandbox lifecycle contract — $name', ({ makeSandbox }) => {
  it('stages a file, execs against it, reads it back, collects the output dir', async () => {
    const { sandbox, cleanup } = await makeSandbox();
    const dest = await tmpDir('dl');
    try {
      await sandbox.writeFile('in.txt', 'hello');
      const r = await sandbox.exec('cat in.txt > out/copy.txt');
      expect(r.code).toBe(0);
      expect(await sandbox.readFile('out/copy.txt', { encoding: 'utf8' })).toBe('hello');

      await sandbox.downloadDir('out', path.join(dest, 'out'));
      expect(await fs.readFile(path.join(dest, 'out', 'copy.txt'), 'utf8')).toBe('hello');
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
      await cleanup();
    }
  });

  it('surfaces a nonzero exit code', async () => {
    const { sandbox, cleanup } = await makeSandbox();
    try {
      expect((await sandbox.exec('exit 3')).code).toBe(3);
    } finally {
      await cleanup();
    }
  });
});

// ── 2. runner integration parity (the user-facing path: `provider:` swaps, nothing else) ──────────────

describe.each(PROVIDER_CASES)('runWorkflow contract — $name', ({ setup }) => {
  it('producer → consumer: run ok, artifacts host-verified, cross-sandbox file flow lands', async () => {
    const { provider, cleanup } = await setup();
    const outDir = await tmpDir('run');
    try {
      // Consumer reads Producer's artifact — staged across sandboxes via the host run dir. Identical
      // shape to the seatbelt e2e test; the ONLY difference here is which provider is passed.
      const g = compile(wf([node('Producer', [], ['a.txt']), node('Consumer', ['a.txt'], ['b.txt'])]));

      const { status } = await runWorkflow(g, {
        run: 'parity',
        outDir,
        provider,
        buildCommand: stubBuilder(),
        nodeTimeoutMs: 15000,
      });

      expect(status.ok).toBe(true);
      expect(status.done).toBe(true);
      expect(status.nodes.producer.status).toBe('ok');
      expect(status.nodes.consumer.status).toBe('ok');
      // Artifacts verified by host-stat (downloadDir flattened <output>/<path> → <hostRunDir>/<path>).
      expect(status.nodes.consumer.artifacts).toEqual([{ path: 'b.txt', exists: true, bytes: 'consumer'.length }]);
      expect(await fs.readFile(path.join(outDir, 'a.txt'), 'utf8')).toBe('producer');
      expect(await fs.readFile(path.join(outDir, 'b.txt'), 'utf8')).toBe('consumer');
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
      await cleanup();
    }
  });

  it('blocked path: a node that produces nothing is `blocked` and halts the run (same verdict both backends)', async () => {
    const { provider, cleanup } = await setup();
    const outDir = await tmpDir('run');
    try {
      const g = compile(wf([node('Up', [], ['up.txt']), node('Down', ['up.txt'], ['down.txt'])]));
      let downRan = false;
      const builder = stubBuilder((n) => {
        if (n.id === 'down') downRan = true;
        return n.id === 'up' ? [] : ['down.txt']; // Up writes nothing → missing required artifact
      });

      const { status } = await runWorkflow(g, { run: 'parity-blocked', outDir, provider, buildCommand: builder, nodeTimeoutMs: 15000 });

      expect(status.nodes.up.status).toBe('blocked');
      expect(status.nodes.up.issues.join(' ')).toMatch(/required artifact.*missing/i);
      expect(downRan).toBe(false); // downstream never executed
      expect(status.nodes.down.status).toBe('pending');
      expect(status.ok).toBe(false);
      expect(status.done).toBe(true);
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
      await cleanup();
    }
  });
});
