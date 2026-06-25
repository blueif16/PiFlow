// G1 — the ONE home of model/provider precedence (runner/model-routing.ts). `resolveNodeModel` is a PURE
// function over (node fields, run routing); these tests pin the override ladder from
// docs/specs/per-node-routing-and-fusion.md §2 — including the LOUD-failure cases (a tier that can't resolve
// must throw, never silently fall through). The loaders are tested only for graceful absence + the parse.

import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  resolveNodeModel,
  ModelRoutingError,
  loadModelTiers,
  loadModelsIndex,
  type ModelTiers,
} from '../src/runner/model-routing.js';

const activeTiers: ModelTiers = { active: true, tiers: { fast: 'deepseek-v3', deep: 'claude-opus-4-8' } };

describe('resolveNodeModel — MODEL precedence (node.model > tier > run > pi default)', () => {
  it('node.model wins over tier, run model, and everything else', () => {
    const r = resolveNodeModel(
      { model: 'glm-4.6', tier: 'fast' },
      { model: 'run-model', tiers: activeTiers },
    );
    expect(r.model).toBe('glm-4.6');
  });

  it('tier (active) maps to its model when node.model is absent — and beats the run model', () => {
    const r = resolveNodeModel({ tier: 'deep' }, { model: 'run-model', tiers: activeTiers });
    expect(r.model).toBe('claude-opus-4-8');
  });

  it('falls back to the run-level model when the node has neither model nor tier', () => {
    const r = resolveNodeModel({}, { model: 'run-model', tiers: activeTiers });
    expect(r.model).toBe('run-model');
  });

  it('resolves to undefined (⇒ pi provider default) when nothing is set', () => {
    const r = resolveNodeModel({}, {});
    expect(r.model).toBeUndefined();
  });
});

describe('resolveNodeModel — LOUD failures (a tier must resolve or throw)', () => {
  it('throws when a node sets a tier but model-tiers is inactive', () => {
    expect(() => resolveNodeModel({ tier: 'fast' }, { tiers: { active: false, tiers: {} } })).toThrow(
      ModelRoutingError,
    );
  });

  it('throws when a node sets a tier that is not in the (active) map', () => {
    expect(() => resolveNodeModel({ tier: 'nope' }, { tiers: activeTiers })).toThrow(ModelRoutingError);
  });

  it('does NOT throw on an unresolvable tier when node.model is set (model wins, tier is irrelevant)', () => {
    const r = resolveNodeModel({ model: 'glm-4.6', tier: 'nope' }, { tiers: activeTiers });
    expect(r.model).toBe('glm-4.6');
  });
});

describe('resolveNodeModel — PROVIDER precedence (node.provider > models.json > run > default)', () => {
  it('node.provider wins', () => {
    const r = resolveNodeModel(
      { model: 'glm-4.6', provider: 'openrouter' },
      { provider: 'cp', modelsIndex: new Map([['glm-4.6', 'zhipu']]) },
    );
    expect(r.provider).toBe('openrouter');
  });

  it('auto-resolves the provider from the models index, keyed by the EFFECTIVE model', () => {
    const r = resolveNodeModel({ tier: 'deep' }, { tiers: activeTiers, provider: 'cp', modelsIndex: new Map([['claude-opus-4-8', 'anthropic']]) });
    expect(r.model).toBe('claude-opus-4-8');
    expect(r.provider).toBe('anthropic');
  });

  it('falls back to the run provider when the index has no entry for the model', () => {
    const r = resolveNodeModel({ model: 'mystery' }, { provider: 'cp', modelsIndex: new Map() });
    expect(r.provider).toBe('cp');
  });

  it('resolves to undefined provider when nothing is set (caller applies its cp default)', () => {
    const r = resolveNodeModel({ model: 'm' }, {});
    expect(r.provider).toBeUndefined();
  });
});

describe('loaders — graceful absence + parse (read-only, never throw on absence)', () => {
  it('loadModelTiers returns {active:false} when the file is absent', () => {
    expect(loadModelTiers(path.join(os.tmpdir(), 'no-such-piflow-tiers.json'))).toEqual({ active: false, tiers: {} });
  });

  it('loadModelsIndex returns an empty map when the file is absent', () => {
    expect(loadModelsIndex(path.join(os.tmpdir(), 'no-such-models.json')).size).toBe(0);
  });

  it('loadModelsIndex builds model-id → provider from a real models.json shape', async () => {
    const f = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-models-')), 'models.json');
    await fs.writeFile(
      f,
      JSON.stringify({ providers: { cp: { models: [{ id: 'glm-4.6' }, { id: 'deepseek-v3' }] }, or: { models: [{ id: 'claude-opus-4-8' }] } } }),
    );
    const idx = loadModelsIndex(f);
    expect(idx.get('glm-4.6')).toBe('cp');
    expect(idx.get('deepseek-v3')).toBe('cp');
    expect(idx.get('claude-opus-4-8')).toBe('or');
  });
});
