import { describe, it, expect } from 'vitest';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile, InMemorySandboxProvider } from '../src/index.js';
import type { NodeIntent, WorkflowSpec } from '../src/index.js';
import { runWorkflow } from '../src/runner/index.js';

// ── Target 5 — L1 LIFECYCLE (fakes, falsifiable CONTENT assertion) ──────────────────────────────
//
// The full runWorkflow lifecycle (bind → stage → exec → collect/downloadDir → host-stat verify →
// dispose) driven entirely through FAKES — no live pi, no creds, no network, no model. The spine is a
// §5 non-hackable content probe: an INDEPENDENT `readFileSync` at the declared artifact's contract path
// (a different code path than the runner's `artifactState` host-stat), asserting on the EXACT bytes the
// injection wrote. This reds on empty, garbage, wrong-path (N-breach), or a no-op executor.
//
// Reuse: `runner.test.ts:48,69,507-538` (the stub/content builders + the ExecRunner fake shape). The
// builder writes each declared artifact at `${node.sandbox.output}/${artifactPath}`; the runner then
// `downloadDir(node.sandbox.output, outDir)` flattens it onto the host run dir at `resolve(outDir, path)`
// — exactly where the artifact gate stats it (`node-lifecycle.ts:552-555`).

// ── helpers (mirror runner.test) ───────────────────────────────────────────────────────────────

/** A NodeIntent factory: reads/produces; artifacts default to produces. */
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
  return fs.mkdtemp(path.join(os.tmpdir(), 'piflow-lifecycle-'));
}

/**
 * A builder that writes EXACT bytes to each named path under the node's sandbox OUTPUT dir (which the
 * runner `downloadDir`s onto the host run dir), then exits 0. `contentFn` returns a `{ path: bytes }`
 * map — the caller controls whether the written paths MATCH the node's declared artifacts (the honest
 * pipeline) or DIVERGE from them (the injected fault). Content is shell-single-quoted, so keep it
 * single-quote-free (`LIFECYCLE-OK` / `X` qualify).
 */
function contentBuilder(contents: Record<string, string>) {
  return (node: { sandbox: { output: string } }): string => {
    const out = node.sandbox.output;
    const writes = Object.entries(contents)
      .map(([p, c]) => {
        const dest = `${out}/${p}`;
        const dir = dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : '.';
        return `mkdir -p ${dir} && printf '%s' '${c}' > ${dest}`;
      })
      .join(' && ');
    return writes || 'true';
  };
}

/** A no-op executor: exits 0 but writes NOTHING (the litmus — must be REJECTED, never pass). */
function noopBuilder() {
  return (): string => 'true';
}

// ── GUARDRAIL: the honest lifecycle greens with a content-verified deliverable ────────────────────

describe('runWorkflow — L1 lifecycle (bind→stage→exec→collect→verify) with a content-verified artifact', () => {
  it('runs a 1-node workflow through fakes; the declared artifact lands on host with the EXACT bytes the executor wrote', async () => {
    // A single node declaring one artifact at a nested path.
    const g = compile(wf([n('Lifecycle', [], ['out/result.md'])]));
    const outDir = await tmpOut();

    // The offline injection: write the declared artifact with a KNOWN sentinel, then exit 0.
    const { status } = await runWorkflow(g, {
      run: 'lifecycle-ok',
      outDir,
      provider: new InMemorySandboxProvider(),
      buildCommand: contentBuilder({ 'out/result.md': 'LIFECYCLE-OK' }),
    });

    // (1) verdict: the node completed the full lifecycle and the host-stat gate passed.
    expect(status.nodes.lifecycle.status).toBe('ok');

    // (2) INDEPENDENT content probe — a fresh fs read at the contract path, a DIFFERENT code path than
    //     the runner's `artifactState` host-stat. Asserts the EXACT bytes (reds on empty/garbage/wrong-path).
    const bytes = readFileSync(path.resolve(outDir, 'out/result.md'), 'utf8');
    expect(bytes.trim()).toBe('LIFECYCLE-OK');

    // (3) run-level verdict.
    expect(status.ok).toBe(true);

    await fs.rm(outDir, { recursive: true, force: true });
  });

  // ── INJECTED FAULT (real pipeline, NOT a test-option flip) ─────────────────────────────────────
  //   The SAME runWorkflow pipeline, but the executor writes a DIFFERENT path than the declared
  //   artifact — a real "the executor produced nothing at the contract path" run. The artifact gate
  //   (node-lifecycle.ts:552-555) finds `out/result.md` missing → verdict blocked, AND the independent
  //   probe's readFileSync throws. A regression that WEAKENS the artifact gate would green this run and
  //   red the guardrail below, proving the gate has teeth.
  it('FAILS the node (blocked/gap) AND leaves the contract path unwritten when the executor writes a DIFFERENT path', async () => {
    const g = compile(wf([n('Lifecycle', [], ['out/result.md'])])); // still declares out/result.md
    const outDir = await tmpOut();

    const { status } = await runWorkflow(g, {
      run: 'lifecycle-wrongpath',
      outDir,
      provider: new InMemorySandboxProvider(),
      buildCommand: contentBuilder({ 'out/other.md': 'X' }), // writes the WRONG path
    });

    // The real artifact gate caught the missing declared deliverable (blocked/gap, never `ok`).
    expect(['blocked', 'gap']).toContain(status.nodes.lifecycle.status);
    // …and it says WHY (the declared artifact is missing) — the code's own emitted diagnostic.
    expect(status.nodes.lifecycle.issues.join(' ')).toMatch(/required artifact.*missing|missing.*out\/result\.md/i);
    // The run does not lie about success.
    expect(status.ok).toBe(false);

    // INDEPENDENT probe: nothing landed at the contract path → a fresh read THROWS (ENOENT).
    expect(() => readFileSync(path.resolve(outDir, 'out/result.md'), 'utf8')).toThrow();

    await fs.rm(outDir, { recursive: true, force: true });
  });

  // ── NO-OP LITMUS: an executor that writes nothing cannot pass. ─────────────────────────────────
  it('cannot pass on a no-op executor — nothing is written, the node blocks, the probe throws', async () => {
    const g = compile(wf([n('Lifecycle', [], ['out/result.md'])]));
    const outDir = await tmpOut();

    const { status } = await runWorkflow(g, {
      run: 'lifecycle-noop',
      outDir,
      provider: new InMemorySandboxProvider(),
      buildCommand: noopBuilder(),
    });

    expect(status.nodes.lifecycle.status).not.toBe('ok');
    expect(status.ok).toBe(false);
    expect(() => readFileSync(path.resolve(outDir, 'out/result.md'), 'utf8')).toThrow();

    await fs.rm(outDir, { recursive: true, force: true });
  });
});
