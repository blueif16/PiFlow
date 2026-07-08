// `piflowctl skill list|search` — the resolvable-skill catalog over core's `listSkills` (the SAME two rings
// `locateSkillStage` stages by, BOTH project-local: workspace `.agents/skills` → `<workspace>/.claude/skills`,
// the latter where `piflowctl skills install` lands its catalog). NEVER a global `~/.piflow/skills` ring —
// resolution hangs entirely off the workspace, so a run reproduces from the product alone with no
// machine-global state. Tested through the public `runSkillCli` with a single temp workspace via the
// injected deps (hermetic — no real ~/.piflow, no cwd dependence).
//
// Load-bearing behaviors pinned here:
//   • `list` merges BOTH rings, tagging each row with its ring; a workspace bundle shadowing an installed
//     one is visible (the installed twin is flagged shadowed).
//   • `list --json` emits the raw SkillListEntry[] (core's shape — stable for the init agent).
//   • `search <q>` filters case-insensitively over id + description; a missing query is usage (exit 1).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSkillCli } from '../src/skill.js';

let WS: string; // workspace root: ring 0 = <WS>/.agents/skills, ring 1 = <WS>/.claude/skills

function sink(): { text: string; write: (s: string) => void } {
  const parts: string[] = [];
  return {
    write: (s: string) => void parts.push(s),
    get text() {
      return parts.join('');
    },
  };
}

async function run(...argv: string[]): Promise<{ out: string; err: string; code: number }> {
  const o = sink();
  const e = sink();
  const code = await runSkillCli(argv, { out: o.write, err: e.write, workspace: WS });
  return { out: o.text, err: e.text, code };
}

async function bundle(root: string, id: string, description: string): Promise<void> {
  const dir = path.join(root, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${id}\ndescription: ${description}\n---\nBody of ${id}.\n`);
}

beforeEach(async () => {
  WS = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-skill-ws-'));
  await bundle(path.join(WS, '.agents', 'skills'), 'alpha', 'reads the alpha telemetry stream');
  await bundle(path.join(WS, '.claude', 'skills'), 'beta', 'writes the beta research brief');
  await bundle(path.join(WS, '.claude', 'skills'), 'alpha', 'the INSTALLED alpha (shadowed by the workspace copy)');
});

afterEach(async () => {
  await fs.rm(WS, { recursive: true, force: true });
});

describe('piflowctl skill list — both rings, ring-tagged', () => {
  it('lists workspace and installed bundles with their ring tags', async () => {
    const r = await run('list');
    expect(r.code).toBe(0);
    expect(r.out).toContain('alpha');
    expect(r.out).toContain('beta');
    expect(r.out).toContain('workspace');
    expect(r.out).toContain('installed');
    // descriptions ride along (the discovery line the agent scans)
    expect(r.out).toContain('reads the alpha telemetry stream');
    expect(r.out).toContain('writes the beta research brief');
  });

  it('a shadowed installed bundle is visible and flagged', async () => {
    const r = await run('list');
    // The `[shadowed]` marker is renderEntries' own flag suffix — assert THAT literal marker, not the
    // bare word "shadowed" (which also appears, coincidentally, inside this fixture's own description
    // text, so a bare substring check would pass even if the shadow flag/rendering were broken).
    expect(r.out).toContain('[shadowed]');
  });

  it('--json emits the raw SkillListEntry[] (id, ring, dir, description)', async () => {
    const r = await run('list', '--json');
    expect(r.code).toBe(0);
    const rows = JSON.parse(r.out) as { id: string; ring: string; dir: string; description: string; shadowed?: boolean }[];
    expect(rows.map((x) => `${x.id}:${x.ring}`)).toEqual(['alpha:workspace', 'alpha:installed', 'beta:installed']);
    const shadowedAlpha = rows.find((x) => x.id === 'alpha' && x.ring === 'installed');
    expect(shadowedAlpha?.shadowed).toBe(true);
    expect(rows[0].dir).toBe(path.join(WS, '.agents', 'skills', 'alpha'));
  });
});

describe('piflowctl skill search — case-insensitive over id + description', () => {
  it('matches on description keywords, any case', async () => {
    const r = await run('search', 'RESEARCH');
    expect(r.code).toBe(0);
    expect(r.out).toContain('beta');
    expect(r.out).not.toContain('telemetry'); // alpha's row is filtered out
  });

  it('matches on the id itself', async () => {
    const r = await run('search', 'beta');
    expect(r.out).toContain('beta');
    expect(r.out).not.toContain('alpha');
  });

  it('--json emits the filtered SkillListEntry[]', async () => {
    const r = await run('search', 'research', '--json');
    const rows = JSON.parse(r.out) as { id: string }[];
    expect(rows.map((x) => x.id)).toEqual(['beta']);
  });

  it('a missing query is usage: exit 1', async () => {
    const r = await run('search');
    expect(r.code).toBe(1);
    expect(r.err).toContain('search');
  });
});

describe('piflowctl skill — dispatch edges', () => {
  it('an unknown subcommand exits non-zero with usage', async () => {
    const r = await run('frobnicate');
    expect(r.code).toBe(1);
    expect(r.err).toContain('skill');
  });
});
