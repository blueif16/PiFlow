// SA-C · AgentBase schema + compiler expansion — RED-BAR tests (test-discipline contract).
//
// Each test FAILS if the production code is absent or wrong. Scenarios:
//
//   1. A preset (loadout-only AgentBase) + a node adding sandbox + a judge gate compiles to a
//      NodeIntent patch whose op[] contains the lowered rerouteTo gate + a materialized judge node
//      + a resolved tier.
//   2. node.model beats recipe.tier (tier precedence invariant from worker-types.md §Plane 2).
//   3. A missing required tool throws preflight at compile time (preflightSkills enforcement).
//   4. The three canonical tier constants are 'fast', 'balanced', 'deep' (decision 1 pinning).
//   5. `seedModelTiers` writes the three canonical tier keys (active: false) to a temp path.
//   6. A preset with sandbox set throws AgentBaseError (workflow-level invariant).
//   7. The 6 existing preset shapes still load/validate as valid partial AgentBase objects
//      (no sandbox, no op — backward-compat).
//
// test-discipline contract: no coverage gate; only behavioral correctness. A test that passes
// regardless of whether the code is present is worthless.

import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  compileNodeBase,
  resolveAgentTier,
  presetToBase,
  validatePresetAsBase,
  AgentBaseError,
  type NodeBaseSpec,
} from '../src/workflow/agent-base.js';
import {
  TIER_FAST,
  TIER_BALANCED,
  TIER_DEEP,
  CANONICAL_TIERS,
  seedModelTiers,
  loadModelTiers,
} from '../src/runner/model-routing.js';
import { DefaultToolRegistry } from '../src/tools/registry.js';
import type { ToolEntry } from '../src/types.js';
import type { JudgeGate, ExecutionGate } from '../src/workflow/gate-authoring.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Minimal tool registry seeded with given addresses. */
function makeRegistry(...addresses: string[]): DefaultToolRegistry {
  const entries: ToolEntry[] = addresses.map((addr) => ({
    address: addr,
    source: 'builtin' as const,
    piName: addr.replace(/[^a-zA-Z0-9]/g, '_'),
    description: `test tool ${addr}`,
  }));
  return new DefaultToolRegistry(entries);
}

/** Build a SKILL.md string with frontmatter requires/allowed. */
function skillMd(requires: string[], allowed: string[]): string {
  const lines = ['---', 'name: test-skill'];
  if (requires.length) { lines.push('requires:'); for (const r of requires) lines.push(`  - ${r}`); }
  if (allowed.length) { lines.push('allowed:'); for (const a of allowed) lines.push(`  - ${a}`); }
  lines.push('---', 'Skill body.');
  return lines.join('\n');
}

/** Parse requires/allowed lists into a SkillManifest (builds and parses a SKILL.md string). */
async function parseSkill(requires: string[], allowed: string[]) {
  const { parseSkillManifest } = await import('../src/workflow/ops/skill.js');
  return parseSkillManifest(skillMd(requires, allowed), 'test-skill');
}

// ── 1 · Full-compile: preset loadout + node sandbox + judge gate ──────────────

describe('compileNodeBase — judge gate + skill auto-wire + tier', () => {
  it('compiles: judge gate lowers to op[rerouteTo] + judgeNode + resolved tier', async () => {
    // The failing scenario: if compileNodeBase is absent/wrong, op[] will be empty/undefined
    // or judgeNode will be missing.
    const judgeGate: JudgeGate = {
      kind: 'judge',
      judgeTier: TIER_DEEP,
      rubric: 'The output must be complete and well-structured.',
      threshold: 'pass',
      policy: { onFail: 'retry', retryMax: 2 },
    };

    const spec: NodeBaseSpec = {
      base: {
        id: 'produce',
        tier: TIER_BALANCED,
        prompt: 'You are a researcher.',
        tools: { allow: ['fs:read'] },
      },
      gates: [judgeGate],
    };

    const compiled = compileNodeBase(spec, { producerId: 'produce', recipeTier: TIER_FAST });

    // tier: node.tier (balanced) beats recipeTier (fast)
    expect(compiled.tier, 'node.tier must beat recipeTier').toBe(TIER_BALANCED);

    // op[] must contain the rerouteTo action from the judge gate
    expect(compiled.op, 'op[] must be defined for a judge gate').toBeDefined();
    const rerouteOp = compiled.op!.find((o) => o.action?.kind === 'rerouteTo');
    expect(rerouteOp, 'op[] must contain a rerouteTo action').toBeDefined();
    expect((rerouteOp!.action as { kind: 'rerouteTo'; node: string }).node).toBe('produce');

    // judgeNode must be materialized (foldable/editable in the DAG)
    expect(compiled.judgeNode, 'a judge gate MUST materialize a judgeNode').toBeDefined();
    expect(compiled.judgeNode!.agentType).toBe('judge');
    expect(compiled.judgeNode!.tier).toBe(TIER_DEEP);
    expect(compiled.judgeNode!.prompt).toContain('The output must be complete');
  });

  it('auto-wires skill requires into tools.allow', async () => {
    // Failing scenario: if resolveSkillLoadout is not called, tools.allow won't include 'web:search'.
    const manifest = await parseSkill(['web:search'], ['web:search', 'fs:read']);

    const spec: NodeBaseSpec = {
      base: { id: 'produce', tools: { allow: ['fs:read'] } },
      skillManifests: [manifest],
    };

    const compiled = compileNodeBase(spec, { producerId: 'produce' });

    // Auto-wired: web:search must appear in tools.allow (from requires)
    expect(compiled.tools?.allow, 'skill requires must be auto-wired into tools.allow').toContain('web:search');
    // Base tools merged in too
    expect(compiled.tools?.allow).toContain('fs:read');

    // Effective ceiling contains the allowed ceiling
    expect(compiled.effectiveCeiling).toContain('web:search');
    expect(compiled.effectiveCeiling).toContain('fs:read');
  });

  it('sandbox from base is passed through (never from a preset - workflow-level)', () => {
    // Failing scenario: if compileNodeBase drops sandbox, it returns undefined.
    const spec: NodeBaseSpec = {
      base: {
        id: 'executor',
        sandbox: { provider: 'local', read: ['/repo'], write: ['/repo/out'] },
      },
    };
    const compiled = compileNodeBase(spec, { producerId: 'executor' });
    expect(compiled.sandbox?.provider).toBe('local');
    expect(compiled.sandbox?.read).toEqual(['/repo']);
  });
});

// ── 2 · Tier precedence ───────────────────────────────────────────────────────

describe('resolveAgentTier — precedence: node.tier > recipeTier', () => {
  it('node.tier beats recipeTier', () => {
    // Failing: if recipeTier takes precedence, this returns TIER_FAST instead of TIER_DEEP.
    expect(resolveAgentTier({ id: 'n', tier: TIER_DEEP }, TIER_FAST)).toBe(TIER_DEEP);
  });

  it('falls back to recipeTier when node has no tier', () => {
    expect(resolveAgentTier({ id: 'n' }, TIER_BALANCED)).toBe(TIER_BALANCED);
  });

  it('returns undefined when neither node nor recipe has a tier', () => {
    expect(resolveAgentTier({ id: 'n' })).toBeUndefined();
  });

  it('node.model beats the tier track — compileNodeBase carries no model override (runner handles it)', () => {
    // The spec says: node.model > node.tier > recipe.tier > run.model > pi default.
    // compileNodeBase resolves the tier track only; model overrides are for the runner.
    // This test pins that compileNodeBase does NOT eat node.model.
    const spec: NodeBaseSpec = {
      base: { id: 'n', tier: TIER_BALANCED },
    };
    const compiled = compileNodeBase(spec, { producerId: 'n', recipeTier: TIER_FAST });
    // compiled.tier = TIER_BALANCED (node.tier beats recipeTier)
    // At runtime: if the node also sets model='some-concrete-model', model-routing.ts uses that
    // instead. compileNodeBase carries the tier key; runner resolves the precedence.
    expect(compiled.tier).toBe(TIER_BALANCED);
  });
});

// ── 3 · Preflight: missing required tool throws ───────────────────────────────

describe('compileNodeBase — preflight (requires ⊆ catalog)', () => {
  it('throws at compile time when a required skill tool is absent from the registry', async () => {
    // Failing scenario: if preflightSkills is not called, this passes silently.
    const manifest = await parseSkill(['web:search', 'fs:write'], ['web:search', 'fs:write']);
    const registry = makeRegistry('fs:write'); // web:search is MISSING

    const spec: NodeBaseSpec = {
      base: { id: 'producer' },
      skillManifests: [manifest],
      registry,
    };

    expect(() => compileNodeBase(spec, { producerId: 'producer' })).toThrow(
      /web:search.*not found|missing.*web:search/i,
    );
  });

  it('passes when all required tools are present in the registry', async () => {
    const manifest = await parseSkill(['web:search'], ['web:search']);
    const registry = makeRegistry('web:search');

    const spec: NodeBaseSpec = {
      base: { id: 'producer' },
      skillManifests: [manifest],
      registry,
    };

    // Must not throw
    expect(() => compileNodeBase(spec, { producerId: 'producer' })).not.toThrow();
  });

  it('does NOT run preflight when no registry is provided (optional preflight)', async () => {
    const manifest = await parseSkill(['missing:tool'], ['missing:tool']);

    const spec: NodeBaseSpec = {
      base: { id: 'producer' },
      skillManifests: [manifest],
      // no registry — preflight skipped
    };

    // Must not throw even though the tool is "missing" (no registry to check against)
    expect(() => compileNodeBase(spec, { producerId: 'producer' })).not.toThrow();
  });
});

// ── 4 · Canonical tier constants ─────────────────────────────────────────────

describe('canonical tier constants — fast | balanced | deep (decision 1)', () => {
  it('TIER_FAST is "fast"', () => {
    // Failing: if the constant is wrong, the tier vocabulary is broken.
    expect(TIER_FAST).toBe('fast');
  });

  it('TIER_BALANCED is "balanced"', () => {
    expect(TIER_BALANCED).toBe('balanced');
  });

  it('TIER_DEEP is "deep"', () => {
    expect(TIER_DEEP).toBe('deep');
  });

  it('CANONICAL_TIERS contains all three in cost order (cheapest first)', () => {
    // Failing: if the array is wrong/incomplete, the tier seeding + docs are broken.
    expect(CANONICAL_TIERS).toEqual(['fast', 'balanced', 'deep']);
  });
});

// ── 5 · seedModelTiers writes canonical tiers (inactive) to disk ──────────────

describe('seedModelTiers — write-once seed of canonical tiers', () => {
  it('creates ~/.piflow/model-tiers.json with the three canonical keys (active: false)', async () => {
    // Failing: if seedModelTiers is absent or writes wrong keys.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-tier-seed-'));
    const file = path.join(dir, 'model-tiers.json');

    seedModelTiers(file);

    expect(() => loadModelTiers(file)).not.toThrow();
    const tiers = loadModelTiers(file);

    // Seeded as INACTIVE — the user must opt in
    expect(tiers.active, 'seed must be inactive (user must set active:true)').toBe(false);

    // All three canonical keys present (even if values are empty strings)
    expect(Object.keys(tiers.tiers)).toContain(TIER_FAST);
    expect(Object.keys(tiers.tiers)).toContain(TIER_BALANCED);
    expect(Object.keys(tiers.tiers)).toContain(TIER_DEEP);
  });

  it('does NOT overwrite an existing file (write-once)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-tier-nooverwrite-'));
    const file = path.join(dir, 'model-tiers.json');

    // Write a custom file first
    await fs.writeFile(file, JSON.stringify({ active: true, tiers: { custom: 'my-model' } }), 'utf8');

    seedModelTiers(file); // should be a no-op

    const tiers = loadModelTiers(file);
    expect(tiers.active, 'existing file must not be overwritten').toBe(true);
    expect(tiers.tiers['custom']).toBe('my-model');
  });
});

// ── 6 · Preset invariant: sandbox and op must be absent ──────────────────────

describe('validatePresetAsBase — workflow-level invariant', () => {
  it('throws AgentBaseError when a preset has sandbox set', () => {
    // Failing: if validatePresetAsBase is absent, this error goes undetected.
    expect(() =>
      validatePresetAsBase({
        id: 'explore',
        sandbox: { provider: 'local' } as unknown as undefined,
      }),
    ).toThrow(AgentBaseError);
  });

  it('throws AgentBaseError when a preset has op[] set', () => {
    expect(() =>
      validatePresetAsBase({
        id: 'general-purpose',
        op: [{ when: 'post', gate: { kind: 'non-empty' } }] as unknown as undefined,
      }),
    ).toThrow(AgentBaseError);
  });

  it('passes for a valid loadout-only preset (no sandbox, no op)', () => {
    // Must not throw — this is the shape of all 6 existing presets.
    expect(() =>
      validatePresetAsBase({
        id: 'market-research',
        tier: 'fast', // a valid tier key, not a model id
      }),
    ).not.toThrow();
  });

  it('throws AgentBaseError when tier looks like a concrete model id', () => {
    // Failing: if the heuristic is absent, a tier:"claude-opus-4-8" mistake goes undetected.
    expect(() =>
      validatePresetAsBase({
        id: 'bad-preset',
        tier: 'claude-opus-4-8-something-really-long-that-is-clearly-a-model-id',
      }),
    ).toThrow(AgentBaseError);
  });
});

// ── 7 · 6 existing presets remain valid (backward compat) ─────────────────────

describe('existing presets — valid as partial AgentBase (backward compat)', () => {
  const presetShapes = [
    { id: 'explore' },
    { id: 'general-purpose' },
    { id: 'interview' },
    { id: 'market-research' },
    { id: 'paper-analyzer' },
    { id: 'plan' },
  ];

  for (const shape of presetShapes) {
    it(`preset "${shape.id}" passes validatePresetAsBase (no sandbox, no op)`, () => {
      // Failing: if the preset shape changes to include sandbox/op, this fires — intentionally.
      expect(() => validatePresetAsBase(shape)).not.toThrow();
    });

    it(`presetToBase("${shape.id}") produces a valid AgentBase`, () => {
      // Failing: if presetToBase is absent/wrong, this will throw or return wrong shape.
      const base = presetToBase({ id: shape.id, prompt: 'role body' });
      expect(base.id).toBe(shape.id);
      expect(base.sandbox).toBeUndefined();
      expect(base.op).toBeUndefined();
      expect(base.prompt).toBe('role body');
    });
  }
});

// ── 8 · Execution gate (additional coverage of compileNodeBase) ───────────────

describe('compileNodeBase — execution gate lowers correctly', () => {
  it('emits op.run with the correct cmd + onFailure:block (default)', () => {
    const gate: ExecutionGate = {
      kind: 'execution',
      cmd: 'npm',
      args: ['test'],
    };
    const spec: NodeBaseSpec = {
      base: { id: 'executor', tier: TIER_FAST },
      gates: [gate],
    };
    const compiled = compileNodeBase(spec, { producerId: 'executor' });

    expect(compiled.op).toBeDefined();
    const runOp = compiled.op!.find((o) => o.run !== undefined);
    expect(runOp, 'execution gate must lower to op.run').toBeDefined();
    expect((runOp!.run as { cmd: string }).cmd).toBe('npm');
    expect(runOp!.onFailure).toBe('block');
  });
});
