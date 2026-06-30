// Eval #9 — DETERMINISTIC end-to-end init-expansion contract (G6 §8 test plan).
//
// Proves the §4.4 author-time expansion mechanism COMPOSES end-to-end with NO model:
//   mergePreset → written into fixture node.json+prompt.md → loadTemplate → compile → assert on NodeSpec.
//
// This is NOT a re-test of the pure mergePreset logic (covered by agent-preset.test.ts).
// It tests the COMPOSITION: that the merged fields survive the round-trip through the
// template's loadTemplate/compile gate and emerge in the final NodeSpec.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadTemplate, compile } from '../src/index.js';
import {
  mergePreset,
  parseAgentPreset,
  loadAgentPreset,
  type AgentPreset,
  type PresetMergeable,
} from '../src/workflow/agent-preset.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'template-min');

// ── helpers copied from load-template.test.ts ──────────────────────────────────────────────────
async function cloneFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-expansion-'));
  await fs.cp(FIXTURE, dir, { recursive: true });
  return dir;
}

const readJson = async (p: string): Promise<any> => JSON.parse(await fs.readFile(p, 'utf8'));
const writeJson = async (p: string, v: unknown): Promise<void> =>
  fs.writeFile(p, JSON.stringify(v, null, 2) + '\n');
const nodeJson = (dir: string, id: string): string => path.join(dir, 'nodes', id, 'node.json');
// ──────────────────────────────────────────────────────────────────────────────────────────────

// Hermetic agents catalog (see scaffold.test.ts): seed the in-repo presets into a temp PIFLOW_HOME so
// eval #9's market-research agentType resolves without the dev's real ~/.piflow/agents (absent in CI).
const AGENT_SEEDS = path.join(HERE, '../../..', '.claude/skills/piflow-init/references/agent-presets');
let PIFLOW_HOME_DIR: string;
let SAVED_PIFLOW_HOME: string | undefined;
beforeEach(async () => {
  PIFLOW_HOME_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-home-'));
  await fs.cp(AGENT_SEEDS, path.join(PIFLOW_HOME_DIR, 'agents'), { recursive: true });
  SAVED_PIFLOW_HOME = process.env.PIFLOW_HOME;
  process.env.PIFLOW_HOME = PIFLOW_HOME_DIR;
});
afterEach(async () => {
  if (SAVED_PIFLOW_HOME === undefined) delete process.env.PIFLOW_HOME;
  else process.env.PIFLOW_HOME = SAVED_PIFLOW_HOME;
  await fs.rm(PIFLOW_HOME_DIR, { recursive: true, force: true });
});

let dir: string;
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

describe('eval #9 — end-to-end init-expansion: mergePreset → node.json+prompt.md → loadTemplate → compile', () => {
  it('merged tools (preset ∪ node) + agentType label + role-then-task prompt survive the round-trip; preset model does NOT leak', async () => {
    // ── Step 1: a small inline preset (with a model set to prove no-leak) ──────────────────────
    const rawPreset = [
      '---',
      'id: market-research',
      'display:',
      '  label: Market Research',
      '  icon: chart-trend',
      '  color: "#2563eb"',
      'skills: [multi-source-research]',
      'tools:',
      '  allow: [fs:read, oc.firecrawl:firecrawl_search]',
      'model: preset-model-should-not-leak',
      'tier:',
      '---',
      'You are a senior market-research analyst.',
    ].join('\n');
    const preset = parseAgentPreset(rawPreset)!;
    expect(preset).not.toBeNull();

    // ── Step 2: the author's raw node intent ────────────────────────────────────────────────────
    const authoredNode: PresetMergeable = {
      prompt: 'Size the EV-charging market in the US.',
      tools: { allow: ['mcp.x:y'] },
    };

    // ── Step 3: expand (the §4.3 contract) ─────────────────────────────────────────────────────
    const merged = mergePreset(preset, authoredNode);

    // ── Step 4: clone the fixture and write the merged result into w0-classify ──────────────────
    dir = await cloneFixture();
    const promptMdPath = path.join(dir, 'nodes', 'w0-classify', 'prompt.md');
    await fs.writeFile(promptMdPath, merged.prompt, 'utf8');

    const nj = await readJson(nodeJson(dir, 'w0-classify'));
    nj.tools = merged.tools;
    nj.agentType = merged.agentType;
    if (merged.skill) nj.prompt = { ...nj.prompt, skill: merged.skill };
    await writeJson(nodeJson(dir, 'w0-classify'), nj);

    // ── Step 5: compile the template and assert on the NodeSpec ────────────────────────────────
    const wf = compile(await loadTemplate(dir));
    const node = wf.nodes['w0-classify'];

    // (a) agentType label survived to the compiled NodeSpec
    expect(node.agentType, 'agentType must survive to the compiled NodeSpec').toBe('market-research');

    // (b) tools.allow is the additive UNION (preset base ∪ node ['mcp.x:y'], deny-filtered)
    //     preset allow: [fs:read, oc.firecrawl:firecrawl_search], node allow: [mcp.x:y]
    expect(node.tools?.allow, 'preset allow members must be present').toContain('fs:read');
    expect(node.tools?.allow, 'preset allow members must be present').toContain('oc.firecrawl:firecrawl_search');
    expect(node.tools?.allow, 'node allow members must be present').toContain('mcp.x:y');

    // (c) the compiled NodeSpec.prompt CONTAINS the preset role body AND the task, role before task
    expect(node.prompt, 'compiled prompt must contain the preset role body').toContain(
      'You are a senior market-research analyst.',
    );
    expect(node.prompt, 'compiled prompt must contain the task text').toContain(
      'Size the EV-charging market in the US.',
    );
    // role-then-task ordering: role body must appear BEFORE the task text
    const roleIdx = node.prompt.indexOf('You are a senior market-research analyst.');
    const taskIdx = node.prompt.indexOf('Size the EV-charging market in the US.');
    expect(roleIdx, 'role body must appear before the task text in the compiled prompt').toBeLessThan(taskIdx);

    // (d) the preset's model did NOT leak (decision #3)
    expect(node.model, 'preset model must NEVER leak to the compiled NodeSpec').toBeUndefined();
  });

  it('HALT precondition: loadAgentPreset returns null for an unknown preset id', () => {
    // This is the signal the §4.4 contract HALTS on — the init agent never invents a preset.
    const result = loadAgentPreset('does-not-exist', path.join(os.tmpdir(), 'no-such-piflow-agents-dir'));
    expect(result, 'loadAgentPreset must return null for an unknown preset (the HALT signal)').toBeNull();
  });
});
