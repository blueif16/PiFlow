// Render-time ROLE-PROMPT inheritance (the agentType → preset role body, single-sourced).
//
// A node bound to a base-agent preset via `agentType` must INHERIT that preset's role-prompt body at
// RENDER time — the realized prompt becomes `<preset role>\n\n<node task>` (role FIRST), resolved BY
// REFERENCE from the preset (keyed by `agentType`), NEVER copied into prompt.md. This mirrors how the
// skill is inherited: the preset is the single source, so editing the preset updates every bound node.
//
// PURE-LOGIC row (test-discipline §0): the renderer is a pure string transform, so this is example tests.
// The preset catalog is injected via an explicit `agentsDir` so the test is deterministic and does NOT
// depend on the user's ~/.piflow/agents/ home dir. The MUTATION that must redden these: delete the
// role-prepend (return the raw prose unchanged) — assertions (a)/(c) below then fail.

import { describe, it, expect } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderRealizedPrompt } from '../src/workflow/template/render.js';
import type { TemplateNode } from '../src/workflow/template/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// The seed presets ship with the piflow-init skill (same path agent-preset-roleprompt.test.ts uses).
// From packages/core/test/ → ../../.. is the repo root.
const SEEDS_DIR = join(HERE, '../../..', '.claude/skills/piflow-init/references/agent-presets');

// A distinctive phrase from the market-research seed's role body — its presence proves the role was
// inherited; its position (before the task) proves the ROLE-first order.
const ROLE_PHRASE = 'senior market-research analyst';
const TASK = 'Size the EV-charging market in the US for 2026 — your lane only.';

/** A minimal contract block (the only `contract` fields the renderer reads). */
const CONTRACT = (id: string): TemplateNode['contract'] => ({
  artifacts: [`research/${id}/brief.md`],
  owns: [`research/${id}/**`],
  readScope: ['{{RUN}}'],
});

/** A bound research-lane node: declares `agentType: market-research`, prose = JUST the task. */
function boundNode(): TemplateNode {
  return {
    id: 'research-lane',
    phase: 'research',
    deps: [],
    prompt: { file: 'prompt.md', skill: 'multi-source-research' },
    agentType: 'market-research',
    contract: CONTRACT('lane'),
  };
}

/** A bespoke node with NO agentType — must render exactly as today (no role injected). */
function bespokeNode(): TemplateNode {
  return {
    id: 'bespoke',
    phase: 'research',
    deps: [],
    prompt: { file: 'prompt.md' },
    contract: CONTRACT('bespoke'),
  };
}

/** A programmatic node — no prompt block; spawns no pi → must be untouched (no role, no crash). */
function programmaticNode(): TemplateNode {
  return {
    id: 'prog',
    phase: 'build',
    deps: [],
    programmatic: true,
    contract: { artifacts: [], owns: [], readScope: ['{{RUN}}'] },
  };
}

describe('render-time role inheritance — agentType prepends the preset role body, single-sourced', () => {
  // (a) WITH agentType → role body present, ONCE, BEFORE the task.
  it('a node WITH agentType: market-research inherits the role body, once, before the task', () => {
    const out = renderRealizedPrompt(boundNode(), TASK, { agentsDir: SEEDS_DIR });

    // The role body was inherited (a distinctive phrase from the preset).
    expect(out).toContain(ROLE_PHRASE);
    // The task survived.
    expect(out).toContain(TASK);
    // Role FIRST, task AFTER.
    const roleIdx = out.indexOf(ROLE_PHRASE);
    const taskIdx = out.indexOf(TASK);
    expect(roleIdx).toBeGreaterThanOrEqual(0);
    expect(roleIdx).toBeLessThan(taskIdx);
    // Applied EXACTLY ONCE (no double-prepend).
    const occurrences = out.split(ROLE_PHRASE).length - 1;
    expect(occurrences).toBe(1);
  });

  // (b) WITHOUT agentType → identical to the raw render (no role injected). This pins "no behavior
  // change for bespoke nodes" — it must stay green under the role-prepend mutation.
  it('a node WITHOUT agentType renders identically to the raw render (no role injected)', () => {
    const def = bespokeNode();
    const withSeam = renderRealizedPrompt(def, TASK, { agentsDir: SEEDS_DIR });
    const baseline = renderRealizedPrompt(def, TASK);
    expect(withSeam).toBe(baseline);
    // And crucially: the market-research role body is NOT present.
    expect(withSeam).not.toContain(ROLE_PHRASE);
    // The task is the head of the body (no prepended role) — body starts with the task.
    expect(withSeam.startsWith(TASK)).toBe(true);
  });

  // (c) A programmatic node has no prompt → renderer tolerates it (no role injection, no crash).
  it('a programmatic node is untouched (no prompt, no role, no crash)', () => {
    const out = renderRealizedPrompt(programmaticNode(), '', { agentsDir: SEEDS_DIR });
    expect(out).not.toContain(ROLE_PHRASE);
  });

  // (2) Missing preset is a LOUD failure (consistent with the loader's fail-closed gate) — never a
  // node that looks bound but silently isn't.
  it('a node naming an UNKNOWN agentType throws (never silently un-bound)', () => {
    const def = { ...boundNode(), agentType: 'no-such-preset' };
    expect(() => renderRealizedPrompt(def, TASK, { agentsDir: SEEDS_DIR })).toThrow(/no-such-preset/);
  });
});
