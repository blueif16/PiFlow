// G6 — agentType presets. `mergePreset` is the PURE, load-bearing expansion utility (the seam every other
// G6 piece depends on); these pin the §4.3 merge contract from docs/specs/wiring-g6-agenttype.md and the
// frontmatter parser the read-only loader uses. Each test FAILS on a specific wrong behavior (the §8 plan).

import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  mergePreset,
  parseAgentPreset,
  loadAgentPreset,
  type AgentPreset,
  type PresetMergeable,
} from '../src/workflow/agent-preset.js';

const preset = (over: Partial<AgentPreset> = {}): AgentPreset => ({
  id: 'market-research',
  prompt: 'ROLE: you are a market analyst.',
  ...over,
});
const node = (over: Partial<PresetMergeable> = {}): PresetMergeable => ({
  prompt: 'TASK: size the EV-charging market.',
  ...over,
});

describe('mergePreset — §4.3 merge contract', () => {
  it('tools.allow is the UNION of preset base + node (additive), deduped + order-stable', () => {
    const merged = mergePreset(
      preset({ tools: { allow: ['fs:read', 'oc.firecrawl:firecrawl_search'] } }),
      node({ tools: { allow: ['mcp.github:create_issue', 'fs:read'] } }),
    );
    // preset base FIRST, node additions next, the duplicate fs:read folded to one occurrence.
    expect(merged.tools?.allow).toEqual([
      'fs:read',
      'oc.firecrawl:firecrawl_search',
      'mcp.github:create_issue',
    ]);
  });

  it('deny WINS over allow — a denied address is removed from the merged allow and kept in deny', () => {
    const merged = mergePreset(
      preset({ tools: { allow: ['oc.tavily:tavily_search', 'fs:read'] } }),
      node({ tools: { deny: ['oc.tavily:tavily_search'] } }),
    );
    expect(merged.tools?.allow ?? []).not.toContain('oc.tavily:tavily_search');
    expect(merged.tools?.allow).toContain('fs:read');
    expect(merged.tools?.deny).toContain('oc.tavily:tavily_search');
  });

  it('prompt is ROLE first, TASK appended', () => {
    const merged = mergePreset(preset({ prompt: 'ROLE' }), node({ prompt: 'TASK' }));
    expect(merged.prompt).toBe('ROLE\n\nTASK');
  });

  it('NEVER sources model/tier from the preset (decision #3)', () => {
    const merged = mergePreset(preset({ model: 'preset-model', tier: 'deep' }), node());
    expect(merged.model).toBeUndefined();
    expect(merged.tier).toBeUndefined();
  });

  it('carries the node\'s OWN model/tier through untouched', () => {
    const merged = mergePreset(preset({ model: 'preset-model' }), node({ model: 'node-model', tier: 'fast' }));
    expect(merged.model).toBe('node-model');
    expect(merged.tier).toBe('fast');
  });

  it('retains agentType = preset.id (the branding label the GUI keys the icon off)', () => {
    expect(mergePreset(preset({ id: 'paper-analyzer' }), node()).agentType).toBe('paper-analyzer');
  });

  it('skill: node wins; preset.skills[0] is the fallback when the node sets none', () => {
    expect(mergePreset(preset({ skills: ['a', 'b'] }), node({ skill: 'node-skill' })).skill).toBe('node-skill');
    expect(mergePreset(preset({ skills: ['a', 'b'] }), node()).skill).toBe('a');
  });

  it('does not mutate the input node (pure)', () => {
    const n = node({ tools: { allow: ['x'] } });
    const before = JSON.stringify(n);
    mergePreset(preset({ tools: { allow: ['y'] } }), n);
    expect(JSON.stringify(n)).toBe(before);
  });
});

describe('parseAgentPreset — frontmatter + role-prompt body', () => {
  const raw = [
    '---',
    'id: market-research',
    'display:',
    '  label: Market Research',
    '  icon: chart-trend',
    '  color: "#2563eb"',
    'skills: [multi-source-research]',
    'tools:',
    '  allow: [fs:read, fs:write, oc.firecrawl:firecrawl_search]',
    'model:',
    'tier:',
    '---',
    'You are a senior market-research analyst.',
    '',
    'Second line of the role prompt.',
  ].join('\n');

  it('parses id, display, skills, tools and the body', () => {
    const p = parseAgentPreset(raw);
    expect(p?.id).toBe('market-research');
    expect(p?.display).toEqual({ label: 'Market Research', icon: 'chart-trend', color: '#2563eb' });
    expect(p?.skills).toEqual(['multi-source-research']);
    expect(p?.tools?.allow).toEqual(['fs:read', 'fs:write', 'oc.firecrawl:firecrawl_search']);
    expect(p?.prompt).toBe('You are a senior market-research analyst.\n\nSecond line of the role prompt.');
  });

  it('leaves model/tier UNDEFINED when the frontmatter slot is empty (decision #3)', () => {
    const p = parseAgentPreset(raw);
    expect(p?.model).toBeUndefined();
    expect(p?.tier).toBeUndefined();
  });

  it('strips an inline comment but keeps a "#" inside a quoted value', () => {
    const r = ['---', 'id: x', 'display:   # the headline', '  color: "#abcdef"', '---', 'body'].join('\n');
    const p = parseAgentPreset(r);
    expect(p?.display?.color).toBe('#abcdef');
    // the comment on the `display:` line must not become its scalar value (it stays a nested map)
    expect(p?.id).toBe('x');
  });

  it('returns null when there is no frontmatter block', () => {
    expect(parseAgentPreset('just a body, no fences')).toBeNull();
  });

  it('round-trips through mergePreset: a parsed preset expands a node', () => {
    const p = parseAgentPreset(raw)!;
    const merged = mergePreset(p, node({ tools: { allow: ['mcp.github:create_issue'] } }));
    expect(merged.tools?.allow).toContain('oc.firecrawl:firecrawl_search'); // from the preset
    expect(merged.tools?.allow).toContain('mcp.github:create_issue'); // from the node
    expect(merged.agentType).toBe('market-research');
    expect(merged.prompt.startsWith('You are a senior market-research analyst.')).toBe(true);
  });
});

describe('loadAgentPreset — read-only adapter (never throws on absence)', () => {
  it('returns null when the preset file is absent', () => {
    expect(loadAgentPreset('no-such-preset', path.join(os.tmpdir(), 'no-such-piflow-agents'))).toBeNull();
  });

  it('loads a preset .md from a directory by id', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-agents-'));
    await fs.writeFile(
      path.join(dir, 'interview.md'),
      ['---', 'id: interview', 'skills: [x]', '---', 'You are an interviewer.'].join('\n'),
    );
    const p = loadAgentPreset('interview', dir);
    expect(p?.id).toBe('interview');
    expect(p?.prompt).toBe('You are an interviewer.');
  });
});
