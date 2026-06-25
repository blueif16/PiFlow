// G6 — agentType PRESETS: author-time expansion + branding. The home of the preset MERGE contract.
//
// A preset is a thin, optional starting point a node can adopt: a few canonical skills + a base tool set +
// a canonical role-prompt + a `display` (icon/label/color) for branding. `piflow-init` flattens it INTO the
// node at AUTHOR time (`mergePreset`), so the runner/journal only ever see concrete `tools`/`prompt` — the
// preset never resolves at run time (docs/specs/wiring-g6-agenttype.md, decision #1).
//
// This file mirrors `runner/model-routing.ts`: a PURE function (`mergePreset`) that is exhaustively unit-
// testable, plus thin READ-ONLY adapters (`parseAgentPreset`/`loadAgentPreset`) over the global catalog in
// `~/.piflow/agents/<id>.md` (never written — the SDK-boundary rule). The CATALOG itself (named types,
// icons, role-prompt bodies) is PRODUCT DATA living outside `packages/*`; only this LOGIC lives in core.

import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import type { ToolSelection } from '../types.js';

/**
 * The parsed preset — a pure type (LOGIC, not data). `model`/`tier` are forward-compat slots that the seeds
 * leave empty and `mergePreset` NEVER sources (decision #3 — G1 owns per-node model). `display` is pure
 * branding: surfaced by observe → GUI, ignored by the runner.
 */
export interface AgentPreset {
  id: string;
  display?: { label?: string; icon?: string; color?: string };
  skills?: string[];
  tools?: ToolSelection;
  /** Forward-compat slot; seeds leave empty; `mergePreset` ignores it as a model source (decision #3). */
  model?: string;
  /** Forward-compat slot; seeds leave empty; `mergePreset` ignores it as a model source (decision #3). */
  tier?: string;
  /** The canonical role-prompt body (the node's task is appended below it). */
  prompt: string;
}

/** The subset of an authored node `mergePreset` reads + rewrites (the template/intent fields a preset touches). */
export interface PresetMergeable {
  prompt: string;
  skill?: string;
  tools?: ToolSelection;
  model?: string;
  tier?: string;
  agentType?: string;
}

/** Stable de-dupe preserving first-seen order. */
function uniq(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) if (!seen.has(x)) { seen.add(x); out.push(x); }
  return out;
}

/**
 * Expand a preset INTO a node at author time (the §4.3 contract). PURE — returns a NEW node, never mutates:
 *   • tools.allow = unique(preset.allow ∪ node.allow)  — ADDITIVE (the preset is a base, the node adds)
 *   • tools.deny  = unique(preset.deny  ∪ node.deny)   — then any address in deny is dropped from allow (deny wins)
 *   • prompt      = preset.prompt + "\n\n" + node.prompt  — ROLE first, the node's TASK appended
 *   • skill       = node.skill ?? preset.skills?.[0]   — the node wins; the preset's first skill is the fallback
 *   • agentType   = preset.id                          — the retained branding label (GUI keys the icon off it)
 *   • model/tier  = the node's OWN only               — NEVER sourced from the preset (decision #3)
 * Everything else on the node is carried through untouched.
 */
export function mergePreset<N extends PresetMergeable>(preset: AgentPreset, node: N): N {
  const allowUnion = uniq([...(preset.tools?.allow ?? []), ...(node.tools?.allow ?? [])]);
  const deny = uniq([...(preset.tools?.deny ?? []), ...(node.tools?.deny ?? [])]);
  const denySet = new Set(deny);
  const allow = allowUnion.filter((a) => !denySet.has(a)); // deny wins over allow

  // Emit a tools block only when either side contributed something; otherwise leave the node's tools as-is
  // (undefined ⇒ the SDK's default builtin set). Omit an empty allow/deny array (omitted ≠ "explicitly none").
  let tools = node.tools;
  if (allowUnion.length || deny.length) {
    tools = { ...(allow.length ? { allow } : {}), ...(deny.length ? { deny } : {}) };
  }

  const skill = node.skill ?? preset.skills?.[0]; // node wins; the preset's first skill is the fallback

  return {
    ...node,
    prompt: node.prompt ? `${preset.prompt}\n\n${node.prompt}` : preset.prompt,
    ...(skill !== undefined ? { skill } : {}),
    ...(tools !== undefined ? { tools } : {}),
    agentType: preset.id,
    // model/tier deliberately untouched — the node's own values (or undefined) stand (decision #3).
  };
}

// ── READ-ONLY catalog adapters (mirror loadModelTiers; never throw on absence) ──────────────────────────

/** Default home of the global, user-extensible preset catalog (parallels `~/.piflow/model-tiers.json`). */
export function defaultAgentsDir(): string {
  return path.join(os.homedir(), '.piflow', 'agents');
}

/** Drop a trailing `# …` comment that is NOT inside a quoted string (so a quoted `"#abc"` hex survives). */
function stripComment(v: string): string {
  let inS = false, inD = false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === '#' && !inS && !inD && (i === 0 || /\s/.test(v[i - 1]))) return v.slice(0, i);
  }
  return v;
}

/** Strip a single layer of matching quotes from a scalar. */
function unquote(s: string): string {
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

/** A frontmatter scalar: '' ⇒ undefined (an empty slot), `[a, b]` ⇒ string[], else an unquoted string. */
function parseScalar(v: string): string | string[] | undefined {
  const s = v.trim();
  if (s === '') return undefined;
  if (s.startsWith('[') && s.endsWith(']')) {
    return s.slice(1, -1).split(',').map((x) => unquote(x.trim())).filter((x) => x.length > 0);
  }
  return unquote(s);
}

/**
 * Parse the SUBSET of YAML our preset frontmatter uses: top-level `key: value`, one nested level (2-space
 * indent) under a key with an empty value, block lists (`- item`), inline arrays (`[a, b]`), quoted/bare
 * scalars, and `# …` line/inline comments. Deliberately small + the seeds stay within it; anything outside
 * is ignored rather than throwing (this is an authoring convenience, not a general YAML engine).
 */
function parseFrontmatter(fm: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let key: string | null = null; // the most recent empty-valued top-level key (the parent of nested lines)
  let map: Record<string, unknown> | null = null;
  let list: string[] | null = null;
  for (const rawLine of fm.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const content = stripComment(line.trim()).trimEnd();
    if (!content) continue;

    if (indent === 0) {
      key = null; map = null; list = null;
      const ci = content.indexOf(':');
      if (ci < 0) continue;
      const k = content.slice(0, ci).trim();
      const v = content.slice(ci + 1);
      const scalar = parseScalar(v);
      if (scalar === undefined) {
        key = k; // an empty value ⇒ a nested map or block list on the following indented lines
      } else {
        out[k] = scalar;
      }
    } else if (key !== null) {
      if (content.startsWith('- ')) {
        if (!list) { list = []; out[key] = list; }
        list.push(unquote(stripComment(content.slice(2).trim()).trim()));
      } else {
        const ci = content.indexOf(':');
        if (ci < 0) continue;
        if (!map) { map = {}; out[key] = map; }
        map[content.slice(0, ci).trim()] = parseScalar(content.slice(ci + 1));
      }
    }
  }
  return out;
}

/**
 * Parse a preset markdown file (`---` frontmatter + role-prompt body) → an `AgentPreset`. PURE (string in).
 * Returns null when there is no frontmatter block or no resolvable id. Never throws.
 */
export function parseAgentPreset(raw: string, fallbackId?: string): AgentPreset | null {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return null;
  const fm = parseFrontmatter(m[1]);
  const id = (typeof fm.id === 'string' && fm.id) || fallbackId;
  if (!id) return null;

  const preset: AgentPreset = { id, prompt: m[2].trim() };

  const d = fm.display;
  if (d && typeof d === 'object' && !Array.isArray(d)) {
    const dd = d as Record<string, unknown>;
    const display: { label?: string; icon?: string; color?: string } = {};
    if (typeof dd.label === 'string') display.label = dd.label;
    if (typeof dd.icon === 'string') display.icon = dd.icon;
    if (typeof dd.color === 'string') display.color = dd.color;
    if (Object.keys(display).length) preset.display = display;
  }

  if (Array.isArray(fm.skills)) preset.skills = fm.skills.map(String);

  const t = fm.tools;
  if (t && typeof t === 'object' && !Array.isArray(t)) {
    const tt = t as Record<string, unknown>;
    const tools: ToolSelection = {};
    if (Array.isArray(tt.allow)) tools.allow = (tt.allow as unknown[]).map(String);
    if (Array.isArray(tt.deny)) tools.deny = (tt.deny as unknown[]).map(String);
    if (tools.allow || tools.deny) preset.tools = tools;
  }

  if (typeof fm.model === 'string' && fm.model) preset.model = fm.model;
  if (typeof fm.tier === 'string' && fm.tier) preset.tier = fm.tier;
  return preset;
}

/**
 * Load a preset by id from the catalog dir (default `~/.piflow/agents/`). READ-ONLY: an absent/unparseable
 * file ⇒ null, never a throw (the init agent HALTS on a null — it never invents a preset).
 */
export function loadAgentPreset(id: string, dir: string = defaultAgentsDir()): AgentPreset | null {
  try {
    return parseAgentPreset(readFileSync(path.join(dir, `${id}.md`), 'utf8'), id);
  } catch {
    return null;
  }
}
