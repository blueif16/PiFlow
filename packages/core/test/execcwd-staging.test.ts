import { describe, it, expect } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile, LocalSandboxProvider } from '../src/index.js';
import type { NodeIntent, WorkflowSpec, NodeSpec, CommandContext } from '../src/index.js';
import { runWorkflow } from '../src/runner/index.js';

// REGRESSION (E10 bug #2): when a node declares `execCwd` (its build runs FROM a project root OUTSIDE the
// run dir), the process cwd becomes execCwd — but `writeFile` stages the prompt under the WORKDIR at
// `_pi/<id>/prompt.md`. The command references the prompt as `@<promptFile>`, which pi resolves against its
// cwd. Before the fix `promptFile` was the RELATIVE `_pi/<id>/prompt.md`, so pi looked under execCwd and hit
// "File not found: …/<execCwd>/_pi/<id>/prompt.md". The fix hands the builder the WORKDIR-ABSOLUTE ref when
// execCwd is set (the same base skillPath/PIFLOW_MCP_CONFIG already use), so the ref resolves to the staged
// file regardless of cwd. Absent execCwd the ref stays relative (byte-identical to before).

const wf = (nodes: NodeIntent[]): WorkflowSpec => ({ meta: { name: 't', description: 'd' }, nodes });
function node(over: Partial<NodeIntent> = {}): NodeIntent {
  return { label: 'Build', prompt: 'do build', tools: {}, io: { reads: [], produces: ['out.txt'], artifacts: [{ path: 'out.txt' }] }, ...over };
}

/**
 * A builder that CAPTURES the prompt ref the runner hands it, then returns a command that writes the node's
 * artifact at its ABSOLUTE run-dir location (so the node passes regardless of the process cwd — the point of
 * this test is the REF, not where a relative write lands). Injected at the `buildCommand` seam.
 */
function capturingBuilder(outDir: string, sink: { promptFile?: string }) {
  return (n: NodeSpec, _r: unknown, ctx: CommandContext): string => {
    sink.promptFile = ctx.promptFile;
    const abs = path.join(outDir, n.io.artifacts[0].path);
    return `mkdir -p '${path.dirname(abs)}' && printf '%s' ok > '${abs}'`;
  };
}

describe('execCwd prompt staging — the ref resolves from the exec cwd (E10 bug #2)', () => {
  it('hands the builder a WORKDIR-ABSOLUTE prompt ref that pi can find from execCwd', async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-run-'));
    // A real out-of-tree project root the build runs FROM — a dir that is NOT the run dir.
    const execCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-execcwd-'));
    const g = compile(wf([node({ sandbox: { execCwd } })]));

    const sink: { promptFile?: string } = {};
    const { status } = await runWorkflow(g, {
      run: 'execcwd',
      outDir,
      // danger bypass ⇒ no sandbox-exec needed (portable to Linux CI); the cwd = execCwd path is unaffected.
      provider: new LocalSandboxProvider({ enforceReadScope: false }),
      buildCommand: capturingBuilder(outDir, sink),
    });

    expect(sink.promptFile).toBeDefined();
    // The heart of the regression: resolve the ref exactly as pi resolves `@<file>` — against its cwd
    // (= execCwd) — and the staged prompt MUST be there. Relative `_pi/<id>/prompt.md` (pre-fix) resolves to
    // <execCwd>/_pi/<id>/prompt.md, which does NOT exist → red. The absolute ref (post-fix) resolves to the
    // real staged file under the run dir → green.
    expect(existsSync(path.resolve(execCwd, sink.promptFile!))).toBe(true);
    expect(status.status).not.toBe('failed');
  });

  it('keeps the prompt ref RELATIVE when no execCwd is declared (byte-identical to before)', async () => {
    const g = compile(wf([node()]));
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-run-'));
    const nodeId = Object.keys(g.nodes)[0];

    const sink: { promptFile?: string } = {};
    await runWorkflow(g, {
      run: 'no-execcwd',
      outDir,
      provider: new LocalSandboxProvider({ enforceReadScope: false }),
      buildCommand: capturingBuilder(outDir, sink),
    });

    // No execCwd ⇒ cwd IS the workdir, so the ref stays the relative staged path (unchanged behavior).
    expect(sink.promptFile).toBe(path.posix.join('_pi', nodeId, 'prompt.md'));
  });
});
