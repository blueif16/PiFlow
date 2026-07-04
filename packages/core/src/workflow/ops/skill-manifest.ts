// Skill manifest — `requires` (floor) ≠ `allowed` (ceiling) — SA-A build surface.
//
// A SKILL.md file may carry TWO lists in its YAML frontmatter that drive the capability-manifest
// surface (docs/design/expert-representations-build-spec.md §"Final surfaces", decision 7):
//
//   requires: [id, ...]   — dependency FLOOR: tool/MCP/capability ids that MUST be bound or the
//                            skill cannot run. Drives (a) auto-wiring the loadout and (b) a preflight
//                            fail-fast BEFORE a pi is spawned.
//   allowed:  [id, ...]   — permission CEILING: what the running agent may touch (the Anthropic
//                            `allowed-tools` convention). Scopes/restricts; does not provision.
//
// Invariant (compile-time): requires ⊆ allowed (every floor id must appear in the ceiling).
// Invariant (runtime):      requires ⊆ bound ⊆ allowed ⊆ catalog.
//
// PURE: no filesystem access (the caller reads the SKILL.md; we parse the string). Additive/
// optional: a skill with no manifest (or no `requires`/`allowed`) is treated as empty/permissive —
// the 6 existing presets that carry no manifest still load and stage exactly as before.
//
// REUSE: the frontmatter parser is a THIN, independent reimplementation of the same inline-YAML
// subset that `agent-preset.ts::parseFrontmatter` parses — the same grammar, the same conventions —
// but defined HERE so skill-manifest.ts carries ZERO imports from agent-preset.ts and can be
// consumed without pulling the full preset machinery. The two share no state.

import type { ToolRegistry } from '../../types.js';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * The parsed skill manifest — two optional capability lists extracted from a SKILL.md frontmatter.
 * A missing/empty manifest is the permissive default (the skill has no declared requirements).
 *
 * Invariant: `requires ⊆ allowed` (a `requires` id not in `allowed` is a manifest authoring error).
 */
export interface SkillManifest {
  /** Skill id (SKILL.md `name` field, else the caller's fallback). */
  id: string;
  /** FLOOR — tool/MCP/capability ids that MUST be bound. Drives auto-wire + preflight. */
  requires: string[];
  /** CEILING — what the running agent MAY touch (Anthropic `allowed-tools` convention). */
  allowed: string[];
  /** Pass-through display metadata from the frontmatter. */
  display?: { label?: string; icon?: string; color?: string };
}

/**
 * The result of auto-wiring a node's skill loadout from a set of parsed manifests.
 * Callers merge `toolsToWire` into the node's `tools.allow` list and pass `servers` to the
 * run's MCP config — matching the catalog seam pattern in `catalog/client.ts`.
 */
export interface SkillLoadout {
  /**
   * The union of all `requires` ids across the skills — the tool addresses to AUTO-WIRE into
   * the node's `tools.allow`. Already de-duplicated.
   */
  toolsToWire: string[];
  /**
   * The union of all `allowed` ids across the skills — the effective ceiling for the node.
   * Callers may pass this as the Anthropic `allowed-tools` list. Already de-duplicated.
   */
  effectiveCeiling: string[];
}

// ── Frontmatter parser (inline subset — same grammar as agent-preset.ts::parseFrontmatter) ──

/** Drop a trailing `# …` comment that is NOT inside a quoted string. */
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
  if (
    s.length >= 2 &&
    ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/** A frontmatter scalar: '' ⇒ undefined, `[a, b]` ⇒ string[], else an unquoted string. */
function parseScalar(v: string): string | string[] | undefined {
  const s = v.trim();
  if (s === '') return undefined;
  if (s.startsWith('[') && s.endsWith(']')) {
    return s
      .slice(1, -1)
      .split(',')
      .map((x) => unquote(x.trim()))
      .filter((x) => x.length > 0);
  }
  return unquote(s);
}

/**
 * Parse the SUBSET of YAML our SKILL.md frontmatter uses (the same grammar as `agent-preset.ts`
 * `parseFrontmatter`): top-level `key: value`, one nested level (2-space indent), block lists
 * (`- item`), inline arrays (`[a, b]`), quoted/bare scalars, and `# …` comments. Anything outside
 * is ignored (an authoring convenience, not a general YAML engine).
 */
function parseFrontmatter(fm: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let key: string | null = null;
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
        key = k; // empty value ⇒ nested map or block list follows on indented lines
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

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse a SKILL.md file's content into a {@link SkillManifest}. PURE (string in, no I/O).
 *
 * - A missing `---` frontmatter block ⇒ `requires: [], allowed: []` (permissive default).
 * - A `requires` id absent from `allowed` is a manifest authoring error: throws with a clear
 *   message citing the skill id and the offending id (compile-time enforcement of `requires ⊆ allowed`).
 * - A `fallbackId` must be provided when the frontmatter carries no `name` field; if neither is
 *   present the manifest is parsed with `id: '<unknown>'` (never throws on absence — the caller
 *   decides whether to reject a nameless skill).
 */
export function parseSkillManifest(raw: string, fallbackId?: string): SkillManifest {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/.exec(raw);
  const fm: Record<string, unknown> = m ? parseFrontmatter(m[1]) : {};

  const id =
    (typeof fm.name === 'string' && fm.name.trim()) ||
    (typeof fm.id === 'string' && fm.id.trim()) ||
    fallbackId ||
    '<unknown>';

  // Coerce requires / allowed to string[]; tolerate a missing field → [] (permissive default).
  const requires = Array.isArray(fm.requires) ? (fm.requires as unknown[]).map(String) : [];
  const allowed = Array.isArray(fm.allowed) ? (fm.allowed as unknown[]).map(String) : [];

  // Compile-time invariant: requires ⊆ allowed — every floor id must appear in the ceiling.
  const allowedSet = new Set(allowed);
  for (const req of requires) {
    if (!allowedSet.has(req)) {
      throw new Error(
        `skill "${id}": manifest violation — requires ⊄ allowed. ` +
          `"${req}" is in requires[] but missing from allowed[]. ` +
          `Add it to allowed[] or remove it from requires[].`,
      );
    }
  }

  const manifest: SkillManifest = { id, requires, allowed };

  // Optional display metadata (same nested-map shape as agent-preset.ts).
  const d = fm.display;
  if (d && typeof d === 'object' && !Array.isArray(d)) {
    const dd = d as Record<string, unknown>;
    const display: { label?: string; icon?: string; color?: string } = {};
    if (typeof dd.label === 'string') display.label = dd.label;
    if (typeof dd.icon === 'string') display.icon = dd.icon;
    if (typeof dd.color === 'string') display.color = dd.color;
    if (Object.keys(display).length) manifest.display = display;
  }

  return manifest;
}

/** A parsed SKILL.md widened with the two display-only fields the manifest omits: the frontmatter
 *  `description` scalar and the markdown `body` after the frontmatter block. Used by the detail views
 *  (the local skill panel + the ONLINE remote-skill panel, which fetches a repo's SKILL.md and parses
 *  it client-side) — one parser for both, so a remote card's detail can never disagree with a local one. */
export interface SkillDoc extends SkillManifest {
  /** The frontmatter `description:` scalar (unquoted), or '' when absent. */
  description: string;
  /** The markdown body after the closing `---` (the whole raw string when there is no frontmatter). */
  body: string;
}

/**
 * Parse a SKILL.md into a {@link SkillDoc} — the manifest ({@link parseSkillManifest}, same `requires ⊆
 * allowed` enforcement) PLUS the `description` + `body`. PURE (string in, no I/O), so it runs in the
 * browser bundle exactly like {@link parseSkillManifest}. A doc with no frontmatter block ⇒ `description:
 * ''` and `body` = the whole raw string (never throws on absence).
 */
export function parseSkillDoc(raw: string, fallbackId?: string): SkillDoc {
  const manifest = parseSkillManifest(raw, fallbackId);
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/.exec(raw);
  const body = m ? m[2] : raw;
  let description = '';
  if (m) {
    const d = parseFrontmatter(m[1]).description;
    if (typeof d === 'string') description = d;
  }
  return { ...manifest, description, body };
}

/**
 * Stable de-dupe preserving first-seen order (shared utility — same pattern as `agent-preset.ts`).
 */
function uniq(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) if (!seen.has(x)) { seen.add(x); out.push(x); }
  return out;
}

/**
 * **Auto-wire** a node's tool loadout from its skills' `requires` lists.
 *
 * Given a list of parsed {@link SkillManifest} objects, returns:
 *   - `toolsToWire`    — union of all skills' `requires` ids (de-duped, stable order)
 *   - `effectiveCeiling` — union of all skills' `allowed` ids (de-duped, stable order)
 *
 * PURE — no I/O, no catalog access (the preflight check is a separate step via `preflightSkills`).
 * An empty `manifests` array ⇒ `{ toolsToWire: [], effectiveCeiling: [] }`.
 */
export function resolveSkillLoadout(manifests: SkillManifest[]): SkillLoadout {
  const allRequires: string[] = [];
  const allAllowed: string[] = [];
  for (const m of manifests) {
    allRequires.push(...m.requires);
    allAllowed.push(...m.allowed);
  }
  return {
    toolsToWire: uniq(allRequires),
    effectiveCeiling: uniq(allAllowed),
  };
}

/**
 * **Preflight check** — fail fast BEFORE a pi is spawned.
 *
 * For each skill manifest, verify that every id in `requires[]` is present in the live capability
 * registry (the `ToolRegistry` the caller provides — typically the run-scoped registry that has
 * already been seeded with the MCP catalog via `catalogForSpec`).
 *
 * Throws a single, actionable error that lists ALL missing ids (not just the first), naming the
 * skill and the missing id for each violation. NEVER throws for an empty `requires[]` (a skill with
 * no requirements always passes). A `requires` id present in the registry binds; one that is absent
 * fails the preflight.
 *
 * Invariant enforced: requires ⊆ catalog (for all skills; node-effective).
 */
export function preflightSkills(manifests: SkillManifest[], registry: ToolRegistry): void {
  if (manifests.length === 0) return;

  // Build a Set of every registered address for O(1) membership testing.
  const registered = new Set(registry.list().map((e) => e.address));

  const violations: string[] = [];
  for (const manifest of manifests) {
    for (const req of manifest.requires) {
      if (!registered.has(req)) {
        violations.push(`  skill "${manifest.id}" requires "${req}" — not found in the capability registry`);
      }
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `Skill preflight FAILED — the following required capabilities are missing from the registry. ` +
        `Register or introspect the relevant MCP server before spawning a pi for this node.\n` +
        violations.join('\n'),
    );
  }
}
