// `piflowctl agents list [--json]` — the init agent's DISCOVER surface over the agentType preset catalog
// (`~/.piflow/agents/`). Tested through the public `runAgentsCli` with a temp PIFLOW_HOME seeded with
// preset `.md` fixtures + injected stdout/stderr sinks (the blueprint.test.ts pattern) — no real ~/.piflow.
//
// Load-bearing behaviors pinned here:
//   • `list` prints one row per preset: id · display label · skills · a tools summary.
//   • `list --json` emits a STABLE machine shape ({ presets: [{ id, label, skills, tools }], errors }) the
//     init agent can parse — no prose mixed into stdout.
//   • a malformed preset never sinks the listing (it surfaces as an error note).
//   • an empty/unmaterialized catalog exits non-zero in human mode with an actionable hint, but --json
//     stays parseable (empty presets, exit 0).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgentsCli } from '../src/agents.js';

let HOME_DIR: string;
let AGENTS_DIR: string;
let SAVED_HOME: string | undefined;

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
  const code = await runAgentsCli(argv, { out: o.write, err: e.write });
  return { out: o.text, err: e.text, code };
}

const CODER = `---
id: coder
display:
  label: Coder
  icon: braces
skills: [okf-slices]
tools:
  allow: [fs:read, fs:write, exec:run]
  deny: [web:search]
tier: balanced
---
You are the coder.
`;

const RESEARCHER = `---
id: researcher
display:
  label: Researcher
skills: [multi-source-research, deep-research]
---
You are the researcher.
`;

beforeEach(async () => {
  HOME_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-agents-home-'));
  AGENTS_DIR = path.join(HOME_DIR, 'agents');
  await fs.mkdir(AGENTS_DIR, { recursive: true });
  await fs.writeFile(path.join(AGENTS_DIR, 'coder.md'), CODER);
  await fs.writeFile(path.join(AGENTS_DIR, 'researcher.md'), RESEARCHER);
  SAVED_HOME = process.env.PIFLOW_HOME;
  process.env.PIFLOW_HOME = HOME_DIR;
});

afterEach(async () => {
  if (SAVED_HOME === undefined) delete process.env.PIFLOW_HOME;
  else process.env.PIFLOW_HOME = SAVED_HOME;
  await fs.rm(HOME_DIR, { recursive: true, force: true });
});

describe('piflowctl agents list — human table', () => {
  it('prints one row per preset with id, label, skills and a tools summary', async () => {
    const r = await run('list');
    expect(r.code).toBe(0);
    // ids + labels
    expect(r.out).toContain('coder');
    expect(r.out).toContain('Coder');
    expect(r.out).toContain('researcher');
    expect(r.out).toContain('Researcher');
    // skills column carries the actual skill ids
    expect(r.out).toContain('okf-slices');
    expect(r.out).toContain('multi-source-research');
    // tools summary reflects the coder's allow/deny counts
    expect(r.out).toMatch(/allow 3/);
    expect(r.out).toMatch(/deny 1/);
  });

  it('bare `agents` defaults to list', async () => {
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.out).toContain('coder');
  });

  it('an empty catalog exits non-zero with an actionable hint (human mode)', async () => {
    await fs.rm(AGENTS_DIR, { recursive: true, force: true });
    const r = await run('list');
    expect(r.code).toBe(1);
    expect(r.err).toContain('no agent presets');
  });

  it('a malformed preset .md never sinks the listing — it surfaces as an error note', async () => {
    await fs.writeFile(path.join(AGENTS_DIR, 'broken.md'), 'no frontmatter at all\n');
    const r = await run('list');
    expect(r.code).toBe(0);
    expect(r.out).toContain('coder'); // the healthy presets still list
    expect(r.err).toContain('broken.md'); // the bad file is named, not swallowed
  });
});

describe('piflowctl agents list --json', () => {
  it('emits the stable machine shape: { presets: [{ id, label, skills, tools }], errors }', async () => {
    const r = await run('list', '--json');
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out) as {
      presets: { id: string; label?: string; skills?: string[]; tools?: { allow?: string[]; deny?: string[] } }[];
      errors: string[];
    };
    expect(parsed.errors).toEqual([]);
    expect(parsed.presets.map((p) => p.id)).toEqual(['coder', 'researcher']);
    const coder = parsed.presets[0];
    expect(coder.label).toBe('Coder');
    expect(coder.skills).toEqual(['okf-slices']);
    expect(coder.tools).toEqual({ allow: ['fs:read', 'fs:write', 'exec:run'], deny: ['web:search'] });
  });

  it('an empty catalog still emits parseable JSON (exit 0, empty presets)', async () => {
    await fs.rm(AGENTS_DIR, { recursive: true, force: true });
    const r = await run('list', '--json');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ presets: [], errors: [] });
  });
});

describe('piflowctl agents — dispatch edges', () => {
  it('an unknown subcommand exits non-zero with usage', async () => {
    const r = await run('frobnicate');
    expect(r.code).toBe(1);
    expect(r.err).toContain('agents');
  });
});
