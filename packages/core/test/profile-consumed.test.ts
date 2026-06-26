// (M6 · #19) COMPANION-MODE elidePhases IS CONSUMED BY THE RUN PATH (not inert).
//
// `applyProfile` (profile.ts) elides nodes by phase and rewires deps; its unit transform is covered in
// profile.test.ts. #19 asks the orthogonal, run-path question: does the canonical run ENTRY actually CONSUME
// the declared `companion` profile, or is it silently dropped so the elided nodes still execute? The entry
// wires `applyProfileByName(spec, opts.profile)` before compile (entry.ts) — this gate PROVES it end-to-end:
// a companion run must NEVER spawn the elided verify node (a call-count of 0 on its exec, AND it is absent
// from `status.nodes`), while a downstream node still runs over the bypassed edge.
//
// DISCRIMINATING: a per-node exec spy asserts the NEGATIVE (the elided node's exec fired 0 times). A bare
// "the run is ok" assertion would pass vacuously even if the profile were inert; the call-count is what fails
// if the profile is dropped (the verify node would run and tick the counter).
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NodeIntent, WorkflowSpec } from '../src/index.js';
import { runFromConfig, defaultExecRunner, type ExecRunner } from '../src/runner/index.js';

let outDir: string | undefined;
afterEach(async () => {
  if (outDir) await fs.rm(outDir, { recursive: true, force: true });
  outDir = undefined;
});

/** A NodeIntent carrying a PHASE + explicit deps (the chain the profile rewires). */
function n(label: string, phase: string, deps: string[], produces: string[]): NodeIntent {
  const io: NodeIntent['io'] = { reads: [], produces, artifacts: produces.map((p) => ({ path: p })) };
  if (deps.length) io.dependsOn = deps;
  return { label, phase, prompt: `do ${label}`, tools: {}, io };
}

/** a(execute) → v1(verify) → b(execute), with a companion profile eliding the verify phase. */
function chainSpec(): WorkflowSpec {
  return {
    meta: { name: 'companion-chain', description: 'd' },
    nodes: [
      n('a', 'execute', [], ['a.txt']),
      n('v1', 'verify', ['a'], ['v1.txt']),
      n('b', 'execute', ['v1'], ['b.txt']),
    ],
    profiles: { production: {}, companion: { elidePhases: ['verify'] } },
    defaultProfile: 'production',
  };
}

/** The offline stub builder (writes each declared artifact + a return fence). */
function stubBuilder() {
  return (node: { id: string; io: { artifacts: { path: string }[] }; sandbox: { output: string } }): string => {
    const writes = node.io.artifacts
      .map((a) => {
        const dest = `${node.sandbox.output}/${a.path}`;
        const dir = dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : '.';
        return `mkdir -p ${dir} && printf '%s' ${node.id} > ${dest}`;
      })
      .join(' && ');
    const ret = `printf '%s' '\`\`\`json\\n{"status":"ok"}\\n\`\`\`'`;
    return writes ? `${writes} && ${ret}` : ret;
  };
}

describe('runFromConfig — companion-mode elidePhases is consumed (#19)', () => {
  it('the declared companion profile ELIDES the verify node — it never spawns and is absent from status', async () => {
    outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-companion-'));
    // Count execs per node id (the negative: the elided verify node's count must be 0).
    const execCount = new Map<string, number>();
    const counting: ExecRunner = async (sandbox, cmd, opts) => {
      const id = (sandbox as { id?: string }).id ?? 'unknown';
      execCount.set(id, (execCount.get(id) ?? 0) + 1);
      return defaultExecRunner(sandbox, cmd, opts);
    };

    const result = await runFromConfig({
      workflowSpec: chainSpec(),
      run: 'companion',
      outDir,
      profile: 'companion', // ← the run path must consume this and elide the verify phase
      buildCommand: stubBuilder(),
      execRunner: counting,
    });

    expect(result.status.ok).toBe(true);
    // The verify node is GONE from the run — the profile was consumed, not inert.
    expect(Object.keys(result.status.nodes).sort()).toEqual(['a', 'b']);
    expect(result.status.nodes.v1).toBeUndefined();
    // DISCRIMINATING NEGATIVE: the elided node's exec fired ZERO times (an inert profile would run it).
    expect(execCount.get('v1') ?? 0).toBe(0);
    // The survivors ran over the bypassed edge (b skipped past v1 onto a).
    expect(result.status.nodes.a.status).toBe('ok');
    expect(result.status.nodes.b.status).toBe('ok');
  });

  it('production (the default, no elision) runs the FULL chain incl. the verify node (additivity)', async () => {
    outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-prod-'));
    const result = await runFromConfig({
      workflowSpec: chainSpec(),
      run: 'production',
      outDir,
      // no profile name → defaultProfile=production={} → full DAG
      buildCommand: stubBuilder(),
    });
    expect(result.status.ok).toBe(true);
    expect(Object.keys(result.status.nodes).sort()).toEqual(['a', 'b', 'v1']); // verify NODE present
    expect(result.status.nodes.v1.status).toBe('ok');
  });
});
