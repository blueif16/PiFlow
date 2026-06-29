// Skill staging — INTEGRATION gate (test-discipline §0): drive a real runWorkflow on the InMemory sandbox (no
// live pi) and prove the runner (1) stages a node's `skill` folder INTO the sandbox and (2) threads the
// in-sandbox path to the command builder as `ctx.skillPath`. The skills lane reuses the seed seam
// (stageHostPathIntoSandbox) — docs/design/skills-integration.md, option C.

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile, LocalSandboxProvider } from '../src/index.js';
import type { NodeIntent, WorkflowSpec } from '../src/index.js';
import { runWorkflow, defaultExecRunner, type ExecRunner } from '../src/runner/index.js';
import type { CommandContext } from '../src/runner/command.js';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Create a real Agent-Skill dir `<root>/my-skill/` with a SKILL.md + a nested asset, return its abs path. */
async function makeSkill(): Promise<{ dir: string; name: string; skillMd: string }> {
  const root = await tmpDir('piflow-skillsrc-');
  const name = 'my-skill';
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, 'references'), { recursive: true });
  const skillMd = '---\nname: my-skill\ndescription: a test skill\n---\nDo the thing.\n';
  await fs.writeFile(path.join(dir, 'SKILL.md'), skillMd);
  await fs.writeFile(path.join(dir, 'references', 'r.md'), 'reference body');
  return { dir, name, skillMd };
}

const oneNode = (over: Partial<NodeIntent>): WorkflowSpec => ({
  meta: { name: 't', description: 'd' },
  nodes: [{ label: 'S', prompt: 'do S', tools: {}, io: { reads: [], produces: ['out.txt'], artifacts: [{ path: 'out.txt' }] }, ...over }],
});

/** A buildCommand that captures the ctx it receives and writes the node's declared artifact (so the node passes). */
function capturingBuild(sink: { ctx?: CommandContext }) {
  return (node: { id: string; sandbox: { output: string } }, _resolved: unknown, ctx: CommandContext): string => {
    sink.ctx = ctx;
    const dest = `${node.sandbox.output}/out.txt`;
    return `mkdir -p ${node.sandbox.output} && printf '%s' ${node.id} > ${dest}`;
  };
}

describe('runWorkflow — skill staging (option C: stage into the sandbox + pass --skill path)', () => {
  it('stages the skill folder into the sandbox AND threads its in-sandbox path as ctx.skillPath', async () => {
    const skill = await makeSkill();
    const outDir = await tmpDir('piflow-run-');
    const sink: { ctx?: CommandContext } = {};

    // Read the staged SKILL.md back FROM the sandbox during exec — proves the sandbox actually received it.
    let sandboxSkillMd: string | undefined;
    const readingExec: ExecRunner = async (sandbox, cmd, opts) => {
      try {
        sandboxSkillMd = (await sandbox.readFile(`.pi/skills/${skill.name}/SKILL.md`, { encoding: 'utf8' })) as string;
      } catch {
        sandboxSkillMd = undefined;
      }
      return defaultExecRunner(sandbox, cmd, opts);
    };

    const g = compile(oneNode({ skill: skill.dir }));
    const { status } = await runWorkflow(g, { run: 'skill', outDir, buildCommand: capturingBuild(sink), execRunner: readingExec });

    expect(status.ok).toBe(true);
    // (1) threaded to the builder, pointing at the in-sandbox `.pi/skills/<name>` dir.
    expect(sink.ctx?.skillPath).toBeDefined();
    expect(sink.ctx?.skillPath).toContain(`.pi/skills/${skill.name}`);
    // (2) the sandbox actually received SKILL.md, byte-for-byte (proves stageHostPathIntoSandbox ran).
    expect(sandboxSkillMd).toBe(skill.skillMd);
    // (3) the recursive copy reached the host run dir incl. the nested asset (proves the dir-walk, not just top file).
    expect(await fs.readFile(path.join(outDir, '.pi/skills', skill.name, 'SKILL.md'), 'utf8')).toBe(skill.skillMd);
    expect(await fs.readFile(path.join(outDir, '.pi/skills', skill.name, 'references', 'r.md'), 'utf8')).toBe('reference body');

    await fs.rm(outDir, { recursive: true, force: true });
    await fs.rm(path.dirname(skill.dir), { recursive: true, force: true });
  });

  it('IN-PLACE local: the advertised skillPath resolves under the RUN DIR (outDir), not scope.root (repoRoot)', async () => {
    // REGRESSION: an in-place `local` node runs with cwd = outDir (the run dir), and its skill is staged at
    // outDir/.pi/skills/<name>. The `--skill` path advertised to pi MUST therefore resolve under outDir — not
    // `scope.root` (= the host repoRoot, LocalRunScope.root). Before the in-place stage-root fix, the path was
    // joined on scope.root → it pointed at repoRoot/.pi/skills/<name>, where the skill does NOT exist.
    const skill = await makeSkill();
    const outDir = await tmpDir('piflow-run-');
    const sink: { ctx?: CommandContext } = {};
    // write the artifact RELATIVE (as a real agent does) so it lands in the in-place cwd (= outDir); capture ctx.
    const relBuild = (node: { id: string }, _r: unknown, ctx: CommandContext): string => {
      sink.ctx = ctx;
      return `printf '%s' ${node.id} > out.txt`;
    };

    const g = compile(oneNode({ skill: skill.dir }));
    const { status } = await runWorkflow(g, {
      run: 'skill-local',
      outDir,
      provider: new LocalSandboxProvider({ enforceReadScope: false }),
      buildCommand: relBuild,
    });

    expect(status.ok).toBe(true); // the relative artifact lands under outDir (the in-place cwd fix)
    expect(sink.ctx?.skillPath).toBe(path.posix.join(outDir, '.pi/skills', skill.name));
    expect(await fs.readFile(path.join(outDir, '.pi/skills', skill.name, 'SKILL.md'), 'utf8')).toBe(skill.skillMd);

    await fs.rm(outDir, { recursive: true, force: true });
    await fs.rm(path.dirname(skill.dir), { recursive: true, force: true });
  });

  it('ADDITIVITY: a node with no skill threads no skillPath (byte-identical to before)', async () => {
    const outDir = await tmpDir('piflow-run-');
    const sink: { ctx?: CommandContext } = {};

    const g = compile(oneNode({})); // no `skill`
    const { status } = await runWorkflow(g, { run: 'noskill', outDir, buildCommand: capturingBuild(sink) });

    expect(status.ok).toBe(true);
    expect(sink.ctx?.skillPath).toBeUndefined();

    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('GRACEFUL SKIP: a declared skill whose source is absent does not fail the node (no skillPath, mirrors a missing seed)', async () => {
    const outDir = await tmpDir('piflow-run-');
    const sink: { ctx?: CommandContext } = {};

    const g = compile(oneNode({ skill: '/nonexistent/skills/ghost' }));
    const { status } = await runWorkflow(g, { run: 'ghost', outDir, buildCommand: capturingBuild(sink) });

    expect(status.ok).toBe(true); // the node still runs
    expect(sink.ctx?.skillPath).toBeUndefined(); // but no skill was wired

    await fs.rm(outDir, { recursive: true, force: true });
  });
});
