// BARE-ID skill staging + the LOUD missing-skill signal — the runner side of the P0 skill-resolution
// unification (sibling of runner-skill.test.ts, which covers the path-like lane). Drives a real
// runWorkflow (InMemory sandbox, no live pi) and proves:
//   (1) a BARE skill id ("my-skill", no path separator) now STAGES at runtime — resolved through the
//       ring search (workspace `.agents/skills/<id>`, then `<piflowHome>/skills/<id>`), the same order
//       the GUI display path searches — closing the live-proven silent-skip (run skillcase-01);
//   (2) a DECLARED skill that cannot be found is LOUD: the node's status-record `issues` carry a
//       skill-missing note with the ref + the searched roots (+ a console.warn, the driver-fit
//       advisory precedent) — while the node still PROCEEDS and no --skill flag is threaded.
//
// HERMETIC: PIFLOW_HOME points at a temp dir (piflow-home.test.ts precedent) — the real ~/.piflow/skills
// must never satisfy (or pollute) a ring search.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile } from '../src/index.js';
import type { NodeIntent, WorkflowSpec } from '../src/index.js';
import { runWorkflow } from '../src/runner/index.js';
import type { CommandContext } from '../src/runner/command.js';

let WS: string; // the run's workspace (Ring 0 base)
let HOME: string; // PIFLOW_HOME (Ring 1 base)
let SAVED: string | undefined;

beforeEach(async () => {
  WS = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-skillws-'));
  HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-skillhome-'));
  SAVED = process.env.PIFLOW_HOME;
  process.env.PIFLOW_HOME = HOME;
});
afterEach(async () => {
  if (SAVED === undefined) delete process.env.PIFLOW_HOME;
  else process.env.PIFLOW_HOME = SAVED;
  await fs.rm(WS, { recursive: true, force: true });
  await fs.rm(HOME, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const SKILL_MD = '---\nname: ring-skill\ndescription: a ring test skill\n---\nDo the thing.\n';

/** Write an Agent-Skill bundle `<base>/<id>/SKILL.md`. */
async function writeSkill(base: string, id: string): Promise<string> {
  const dir = path.join(base, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), SKILL_MD);
  return dir;
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

describe('runWorkflow — bare skill id resolution (the two local rings)', () => {
  it('stages a bare id from the WORKSPACE ring (<workspace>/.agents/skills/<id>) and threads --skill', async () => {
    await writeSkill(path.join(WS, '.agents', 'skills'), 'ws-ring-skill');
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-run-'));
    const sink: { ctx?: CommandContext } = {};

    const g = compile(oneNode({ skill: 'ws-ring-skill' }));
    const { status } = await runWorkflow(g, { run: 'bare-ws', outDir, workspace: WS, buildCommand: capturingBuild(sink) });

    expect(status.ok).toBe(true);
    expect(sink.ctx?.skillPath).toContain('.pi/skills/ws-ring-skill');
    // the copy reached the host run dir's pi-native discovery dir, byte-for-byte
    expect(await fs.readFile(path.join(outDir, '.pi/skills/ws-ring-skill/SKILL.md'), 'utf8')).toBe(SKILL_MD);

    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('stages a bare id from the HOME ring (<piflowHome>/skills/<id>) when the workspace ring misses', async () => {
    await writeSkill(path.join(HOME, 'skills'), 'home-ring-skill');
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-run-'));
    const sink: { ctx?: CommandContext } = {};

    const g = compile(oneNode({ skill: 'home-ring-skill' }));
    const { status } = await runWorkflow(g, { run: 'bare-home', outDir, workspace: WS, buildCommand: capturingBuild(sink) });

    expect(status.ok).toBe(true);
    expect(sink.ctx?.skillPath).toContain('.pi/skills/home-ring-skill');
    expect(await fs.readFile(path.join(outDir, '.pi/skills/home-ring-skill/SKILL.md'), 'utf8')).toBe(SKILL_MD);

    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('WORKSPACE SHADOWS HOME: with the id in both rings, the workspace copy is the one staged', async () => {
    const wsDir = path.join(WS, '.agents', 'skills', 'dup-skill');
    await fs.mkdir(wsDir, { recursive: true });
    await fs.writeFile(path.join(wsDir, 'SKILL.md'), '---\nname: dup-skill\n---\nWORKSPACE COPY\n');
    const homeDir = path.join(HOME, 'skills', 'dup-skill');
    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(path.join(homeDir, 'SKILL.md'), '---\nname: dup-skill\n---\nHOME COPY\n');
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-run-'));
    const sink: { ctx?: CommandContext } = {};

    const g = compile(oneNode({ skill: 'dup-skill' }));
    const { status } = await runWorkflow(g, { run: 'bare-dup', outDir, workspace: WS, buildCommand: capturingBuild(sink) });

    expect(status.ok).toBe(true);
    expect(await fs.readFile(path.join(outDir, '.pi/skills/dup-skill/SKILL.md'), 'utf8')).toContain('WORKSPACE COPY');

    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('LOUD MISS: a declared-but-unresolvable skill records a skill-missing issue (ref + searched roots), warns, and the node still proceeds with NO --skill', async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-run-'));
    const sink: { ctx?: CommandContext } = {};
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const g = compile(oneNode({ skill: 'ghost-skill' }));
    const { status } = await runWorkflow(g, { run: 'bare-miss', outDir, workspace: WS, buildCommand: capturingBuild(sink) });

    // the node PROCEEDS (advisory, never fatal) and no --skill flag is threaded
    expect(status.ok).toBe(true);
    expect(sink.ctx?.skillPath).toBeUndefined();

    // LOUD on the status record: the node's issues carry the ref + the searched roots
    const rec = Object.values(status.nodes)[0];
    const issueText = rec.issues.join(' | ');
    expect(issueText).toContain('ghost-skill');
    expect(issueText).toContain(path.join(WS, '.agents', 'skills', 'ghost-skill'));
    expect(issueText).toContain(path.join(HOME, 'skills', 'ghost-skill'));

    // LOUD on the console (the driver-fit advisory precedent)
    expect(warn.mock.calls.some((c) => String(c[0]).includes('ghost-skill'))).toBe(true);

    await fs.rm(outDir, { recursive: true, force: true });
  });
});
