import { describe, it, expect } from 'vitest';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { compile, InMemorySandboxProvider } from '../src/index.js';
import type { NodeIntent, WorkflowSpec } from '../src/index.js';
import { runWorkflow } from '../src/runner/index.js';

// Target 13 — J3 chained-hash (§5-NODE #4): the consumer's recorded input-hash must equal an INDEPENDENT
// recomputation of the producer's real output bytes — blocking forged intermediates. Every other tier runs
// a single node; this is the FIRST real producer→consumer CHAIN. A consumer's `io.reads` are staged into its
// sandbox at the same relative path BEFORE exec (node-lifecycle.ts:285-288), so the consumer's shell command
// hashes the REAL staged producer bytes at exec time — a genuine chain, not a build-time fabrication.
//
// Mirrors deploy/docker/smoke-live.mjs:75-93 (producer→consumer shape) + runner.test.ts:23,32,48-84 (n/wf).

/** A NodeIntent factory (mirrors runner.test.ts:23): reads/produces; artifacts default to produces. */
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

async function tmpOut(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'piflow-run-'));
}

// The producer writes DETERMINISTIC bytes to its declared artifact at <output>/a.txt.
function producerCommand(node: { sandbox: { output: string } }): string {
  return `printf '%s' 'PRODUCER-PAYLOAD' > ${node.sandbox.output}/a.txt`;
}

// The consumer READS its staged input a.txt (relative to its workdir — where node.io.reads was staged) and
// records the sha256 of the PRODUCER's actual output to <output>/b.txt. The `node -e` hash form is portable
// across macOS/Linux (no sha256sum-vs-shasum coreutils flake across the CI matrix).
function honestConsumerCommand(node: { sandbox: { output: string } }): string {
  return `node -e "process.stdout.write(require('crypto').createHash('sha256').update(require('fs').readFileSync('a.txt')).digest('hex'))" > ${node.sandbox.output}/b.txt`;
}

// The FORGED-intermediate consumer: hashes FABRICATED bytes instead of the staged producer output.
function forgedConsumerCommand(node: { sandbox: { output: string } }): string {
  return `node -e "process.stdout.write(require('crypto').createHash('sha256').update('FORGED-NOT-THE-PRODUCER-OUTPUT').digest('hex'))" > ${node.sandbox.output}/b.txt`;
}

/** Build a per-node command from a consumer-command factory (producer is fixed). */
function chainBuilder(consumerCmd: (node: { sandbox: { output: string } }) => string) {
  return (node: { id: string; sandbox: { output: string } }): string => {
    return node.id === 'producer' ? producerCommand(node) : consumerCmd(node);
  };
}

describe('J3 chained-hash — consumer input hash == recomputed producer output (blocks forged intermediates)', () => {
  it('an honest consumer records sha256 of its STAGED producer input, matching an independent recomputation', async () => {
    const g = compile(wf([n('Producer', [], ['a.txt']), n('Consumer', ['a.txt'], ['b.txt'])]));
    const outDir = await tmpOut();

    const { status } = await runWorkflow(g, {
      run: 'j3-honest',
      outDir,
      provider: new InMemorySandboxProvider(),
      buildCommand: chainBuilder(honestConsumerCommand),
      nodeTimeoutMs: 15000,
    });

    // 1. Both nodes ran clean end-to-end (the chain reached its consumer).
    expect(status.nodes.producer.status).toBe('ok');
    expect(status.nodes.consumer.status).toBe('ok');

    // 2. Chain-link invariant (§5-NODE #4): fresh fs reads of the REAL on-disk bytes, NOT run-view copies.
    //    consumerRecordedHash is what the consumer independently computed over its staged input; the test
    //    independently recomputes sha256 over the producer's actual output. They agree ONLY when the consumer
    //    genuinely hashed the producer's real staged output (the forged-intermediate the spec must block).
    const producerBytes = readFileSync(path.resolve(outDir, 'a.txt'));
    const consumerRecordedHash = readFileSync(path.resolve(outDir, 'b.txt'), 'utf8').trim();
    const expectedHash = createHash('sha256').update(producerBytes).digest('hex');
    expect(consumerRecordedHash).toBe(expectedHash);

    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('a FORGED intermediate (consumer hashes fabricated bytes) breaks the chain-link equality', async () => {
    // Same real pipeline, real staging — the ONLY change is the consumer hashes fabricated bytes instead of
    // the staged producer output. The recorded hash no longer equals sha256(producerBytes): the forged
    // intermediate is caught by the independent recomputation. (This is the RED companion made permanent.)
    const g = compile(wf([n('Producer', [], ['a.txt']), n('Consumer', ['a.txt'], ['b.txt'])]));
    const outDir = await tmpOut();

    const { status } = await runWorkflow(g, {
      run: 'j3-forged',
      outDir,
      provider: new InMemorySandboxProvider(),
      buildCommand: chainBuilder(forgedConsumerCommand),
      nodeTimeoutMs: 15000,
    });

    // Both nodes still report ok (the forged command exits 0 and writes b.txt) — the run's own gates cannot
    // catch a forged intermediate; only the independent recomputation can.
    expect(status.nodes.producer.status).toBe('ok');
    expect(status.nodes.consumer.status).toBe('ok');

    const producerBytes = readFileSync(path.resolve(outDir, 'a.txt'));
    const consumerRecordedHash = readFileSync(path.resolve(outDir, 'b.txt'), 'utf8').trim();
    const expectedHash = createHash('sha256').update(producerBytes).digest('hex');
    expect(consumerRecordedHash).not.toBe(expectedHash);

    await fs.rm(outDir, { recursive: true, force: true });
  });
});
