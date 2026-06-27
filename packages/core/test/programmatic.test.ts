// PROGRAMMATIC NODE — a node carrying `programmatic:true` runs its DECLARATIVE ops deterministically and
// spawns NO `pi`: no `buildCommand`, no exec. It is the no-pi twin of `checkpoint`/`rerouteGate` — an
// honest DAG vertex for a purely-deterministic step (e.g. a render) with no vestigial agent.
//
// The load-bearing behavior, asserted RED-first (no dispatch arm ⇒ the node falls through to the pi lane,
// which calls the injected `buildCommand`/`execRunner` — both wired to THROW here, so the node errors and
// the artifact never appears):
//   (a) the node RUNS its op (the artifact/effect appears),
//   (b) it spawns NO pi (the injected build/exec seam is NEVER invoked),
//   (c) it finishes `ok`.
// Plus: a programmatic node whose `run` op FAILS (default onFailure block) must BLOCK (the gate is real),
// and one whose declarative CHECK fails must BLOCK too.

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile } from '../src/index.js';
import { runWorkflow, type ExecRunner } from '../src/runner/index.js';
import type { NodeIntent, WorkflowSpec, NodeSpec, CommandBuilder } from '../src/index.js';

const wf = (nodes: NodeIntent[]): WorkflowSpec => ({ meta: { name: 't', description: 'd' }, nodes });
const tmpOut = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'piflow-prog-'));

/**
 * A pi seam that must NEVER fire on a programmatic node. If the runner reaches the pi lane it calls these,
 * which RECORD the call and THROW — so a missing dispatch arm fails the node loudly (the right RED reason),
 * and the test's `calls` counter proves "no pi" directly.
 */
function piSeam(): { buildCommand: CommandBuilder; execRunner: ExecRunner; calls: { build: number; exec: number } } {
  const calls = { build: 0, exec: 0 };
  const buildCommand: CommandBuilder = (() => {
    calls.build++;
    throw new Error('buildCommand must NOT be called for a programmatic node');
  }) as unknown as CommandBuilder;
  const execRunner: ExecRunner = async () => {
    calls.exec++;
    throw new Error('execRunner must NOT be called for a programmatic node');
  };
  return { buildCommand, execRunner, calls };
}

/**
 * A PROGRAMMATIC node — NO `prompt`, NO `tools`, `programmatic:true` — whose POST `run` op deterministically
 * writes its declared artifact into the run dir (the `run` op executes with cwd = the host run dir). The
 * op's file-effect IS the proof it ran; the artifact gate then verifies the same file by host-stat.
 */
function programmaticNode(over: { runArgs?: string[]; produces?: string[]; checks?: NodeSpec['io']['checks'] } = {}): NodeIntent {
  const produces = over.produces ?? ['render.out'];
  const runArgs = over.runArgs ?? ['-e', "require('fs').writeFileSync('render.out','rendered')"];
  return {
    label: 'render',
    // NO prompt, NO tools — a programmatic node carries neither.
    programmatic: true,
    io: {
      reads: [],
      produces,
      artifacts: produces.map((p) => ({ path: p })),
      ...(over.checks ? { checks: over.checks } : {}),
    },
    op: [{ when: 'post', run: { cmd: 'node', args: runArgs } }],
  } as unknown as NodeIntent;
}

describe('programmatic node — runs declarative ops, spawns no pi', () => {
  it('runs its POST run op (artifact appears), spawns NO pi, finishes ok', async () => {
    const outDir = await tmpOut();
    const { buildCommand, execRunner, calls } = piSeam();

    const { status } = await runWorkflow(compile(wf([programmaticNode()])), {
      run: 'prog-ok', outDir, buildCommand, execRunner,
    });

    // (c) finishes ok
    expect(status.nodes.render.status, status.nodes.render.issues?.join(' | ')).toBe('ok');
    // (b) NO pi — neither seam was ever invoked
    expect(calls.build, 'buildCommand must not be called').toBe(0);
    expect(calls.exec, 'execRunner must not be called').toBe(0);
    // (a) the op RAN — its artifact is on disk with the op's bytes
    expect(await fs.readFile(path.join(outDir, 'render.out'), 'utf8')).toBe('rendered');
    expect(status.nodes.render.artifacts).toEqual([{ path: 'render.out', exists: true, bytes: 'rendered'.length }]);
    expect(status.ok).toBe(true);

    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('BLOCKS when its POST run op fails (default onFailure block) — the op gate is real', async () => {
    const outDir = await tmpOut();
    const { buildCommand, execRunner, calls } = piSeam();

    // The run op exits non-zero AND never writes the required artifact.
    const node = programmaticNode({ runArgs: ['-e', 'process.exit(3)'] });
    const { status } = await runWorkflow(compile(wf([node])), {
      run: 'prog-runfail', outDir, buildCommand, execRunner,
    });

    expect(status.nodes.render.status, 'a failing run op must block the node').toBe('blocked');
    expect(calls.build).toBe(0);
    expect(calls.exec).toBe(0);
    expect(status.ok).toBe(false);

    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('BLOCKS when a declarative CHECK fails on the produced artifact — the check gate is real', async () => {
    const outDir = await tmpOut();
    const { buildCommand, execRunner, calls } = piSeam();

    // The op writes an EMPTY artifact; a non-empty check on it fails → the node blocks.
    const node = programmaticNode({
      runArgs: ['-e', "require('fs').writeFileSync('render.out','')"],
      checks: [{ kind: 'non-empty', path: 'render.out' }],
    });
    const { status } = await runWorkflow(compile(wf([node])), {
      run: 'prog-checkfail', outDir, buildCommand, execRunner,
    });

    expect(status.nodes.render.status, 'a failing check must block the node').toBe('blocked');
    expect(calls.build).toBe(0);
    expect(calls.exec).toBe(0);
    expect(status.ok).toBe(false);

    await fs.rm(outDir, { recursive: true, force: true });
  });
});
