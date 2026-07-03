// Skill-FLOOR wiring — the run-start pre-pass that turns a node's bound skill's `requires` (dependency
// FLOOR) into the node's effective `tools.allow` BEFORE `catalogForSpec`/`resolveRunTools` read the spec.
// This is the DORMANT `requires`-floor machinery (skill-manifest.ts) finally wired into the live run path.
//
// HERMETIC: PIFLOW_HOME points at a temp dir so the real ~/.piflow is never read; a temp WORKSPACE carries
// the `.agents/skills/<id>/SKILL.md` bundles the wire resolves against (mirrors skill-locate.test.ts).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NodeIntent, WorkflowSpec } from '../src/index.js';
import { wireSkillFloors } from '../src/runner/skill-floor.js';

let WS: string; // workspace root (Ring 0 base)
let HOME: string; // PIFLOW_HOME (Ring 1 base)
let SAVED: string | undefined;

beforeEach(async () => {
  WS = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-floor-ws-'));
  HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-floor-home-'));
  SAVED = process.env.PIFLOW_HOME;
  process.env.PIFLOW_HOME = HOME;
});
afterEach(async () => {
  if (SAVED === undefined) delete process.env.PIFLOW_HOME;
  else process.env.PIFLOW_HOME = SAVED;
  await fs.rm(WS, { recursive: true, force: true });
  await fs.rm(HOME, { recursive: true, force: true });
});

/** Write a workspace-ring (Ring 0) skill bundle `<WS>/.agents/skills/<id>/SKILL.md` with the given frontmatter. */
async function writeSkill(id: string, fm: string): Promise<void> {
  const dir = path.join(WS, '.agents', 'skills', id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\n${fm}\n---\nBody.\n`);
}

/** A single-node spec whose node binds `skill` and carries the given `allow`/`deny`. */
function specWith(node: Partial<NodeIntent>): WorkflowSpec {
  const base: NodeIntent = {
    label: 'n',
    prompt: 'do n',
    tools: {},
    io: { reads: [], produces: [], artifacts: [] },
  };
  return { meta: { name: 't', description: 'd' }, nodes: [{ ...base, ...node }] };
}

const ctx = () => ({ run: path.join(WS, 'out', 'r1'), workspace: WS, piflowHome: HOME });

describe('wireSkillFloors — a resolving skill unions its `requires` FLOOR into the node tools.allow', () => {
  it('unions the manifest requires into allow (dedup), preserving the author allow', async () => {
    await writeSkill('needs', 'name: needs\nrequires: [fs:read, mcp.foo:bar]\nallowed: [fs:read, mcp.foo:bar]');
    const spec = specWith({ skill: 'needs', tools: { allow: ['fs:write'] } });
    await wireSkillFloors(spec, ctx());
    // author's explicit allow kept; both requires added; stable order (author first, then floor).
    expect(spec.nodes[0].tools.allow).toEqual(['fs:write', 'fs:read', 'mcp.foo:bar']);
  });

  it('does not duplicate a requires id already present in allow', async () => {
    await writeSkill('dup', 'name: dup\nrequires: [mcp.foo:bar]\nallowed: [mcp.foo:bar]');
    const spec = specWith({ skill: 'dup', tools: { allow: ['mcp.foo:bar', 'fs:read'] } });
    await wireSkillFloors(spec, ctx());
    expect(spec.nodes[0].tools.allow).toEqual(['mcp.foo:bar', 'fs:read']);
  });

  it('DENY WINS — a required id the node explicitly denies is NOT wired into allow', async () => {
    await writeSkill('denied', 'name: denied\nrequires: [fs:read, mcp.foo:bar]\nallowed: [fs:read, mcp.foo:bar]');
    const spec = specWith({ skill: 'denied', tools: { allow: [], deny: ['mcp.foo:bar'] } });
    await wireSkillFloors(spec, ctx());
    // fs:read wired (not denied); mcp.foo:bar NOT wired (deny wins); deny preserved.
    expect(spec.nodes[0].tools.allow).toEqual(['fs:read']);
    expect(spec.nodes[0].tools.deny).toEqual(['mcp.foo:bar']);
  });
});

describe('wireSkillFloors — additive / no-op cases stay byte-identical', () => {
  it('a node with NO skill is left untouched', async () => {
    const spec = specWith({ tools: { allow: ['fs:write'] } }); // no `skill`
    const before = JSON.parse(JSON.stringify(spec));
    await wireSkillFloors(spec, ctx());
    expect(spec).toEqual(before);
  });

  it('a skill that does NOT resolve wires nothing and does NOT throw (loud-miss stays at node launch)', async () => {
    const spec = specWith({ skill: 'ghost-not-installed', tools: { allow: ['fs:write'] } });
    await wireSkillFloors(spec, ctx()); // must not throw
    expect(spec.nodes[0].tools.allow).toEqual(['fs:write']);
  });

  it('a resolving skill with an EMPTY/absent requires floor wires nothing', async () => {
    await writeSkill('permissive', 'name: permissive\ndescription: no floor'); // no requires/allowed
    const spec = specWith({ skill: 'permissive', tools: { allow: ['fs:write'] } });
    await wireSkillFloors(spec, ctx());
    expect(spec.nodes[0].tools.allow).toEqual(['fs:write']);
  });
});

describe('wireSkillFloors — a malformed manifest fails with the parser message (requires ⊄ allowed)', () => {
  it('propagates the parseSkillManifest error (a floor id missing from the ceiling)', async () => {
    await writeSkill('bad', 'name: bad\nrequires: [mcp.x:y]\nallowed: [fs:read]'); // mcp.x:y ∉ allowed
    const spec = specWith({ skill: 'bad', tools: { allow: [] } });
    await expect(wireSkillFloors(spec, ctx())).rejects.toThrow(/manifest violation — requires ⊄ allowed/);
  });
});
