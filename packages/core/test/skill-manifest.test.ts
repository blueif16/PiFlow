// SA-A · Skill manifest — `requires` (floor) / `allowed` (ceiling) surface.
//
// Every test in this file MUST FAIL when the production code is wrong or absent — that is the
// `test-discipline` contract. The three scenarios tested:
//
//   1. parseSkillManifest — correctly extracts `requires` + `allowed`; enforces `requires ⊆ allowed`
//      at parse time (a `requires` id not in `allowed` throws).
//   2. resolveSkillLoadout — auto-wires the union of `requires` across skills; de-dups.
//   3. preflightSkills — throws BEFORE a pi is spawned when any required id is absent from the
//      live capability registry; passes when all requirements are met; auto-wire binds required tools.
//
// The `DefaultToolRegistry` (registry.ts) is the live registry shim — we seed it inline per test
// so no file I/O or MCP bridge is needed. Each test has a clear failing scenario in its comment.

import { describe, it, expect } from 'vitest';
import { parseSkillManifest, parseSkillDoc, resolveSkillLoadout, preflightSkills } from '../src/workflow/ops/skill.js';
import { DefaultToolRegistry } from '../src/tools/registry.js';
import type { ToolEntry } from '../src/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a tiny registry seeded with the given addresses as builtin-like entries (no extension). */
function registryWith(...addresses: string[]): DefaultToolRegistry {
  const entries: ToolEntry[] = addresses.map((addr) => ({
    address: addr,
    source: 'builtin' as const,
    piName: addr.replace(/[^a-zA-Z0-9]/g, '_'),
    description: `test tool ${addr}`,
  }));
  // DefaultToolRegistry constructor takes a seed; builtins need no extension.
  return new DefaultToolRegistry(entries);
}

/** Build a SKILL.md string with the given frontmatter fields. */
function skillMd(fields: Record<string, string | string[]>): string {
  const lines: string[] = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${item}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push('---', '', 'Skill body text.');
  return lines.join('\n');
}

// ── 1. parseSkillManifest ─────────────────────────────────────────────────────

describe('parseSkillManifest — extract requires/allowed from SKILL.md frontmatter', () => {
  it('parses both lists and the id from name field', () => {
    // FAILS WITHOUT THE CHANGE: requires/allowed would be missing ([] both) if parser ignores them.
    const raw = skillMd({
      name: 'web-search',
      requires: ['mcp.brave:brave_web_search'],
      allowed: ['mcp.brave:brave_web_search', 'fs:read'],
    });
    const m = parseSkillManifest(raw, 'web-search');
    expect(m.id).toBe('web-search');
    expect(m.requires).toEqual(['mcp.brave:brave_web_search']);
    expect(m.allowed).toEqual(['mcp.brave:brave_web_search', 'fs:read']);
  });

  it('uses fallbackId when frontmatter has no name field', () => {
    // FAILS WITHOUT THE CHANGE: id resolution falls through wrong branch → '<unknown>' not fallback.
    const raw = skillMd({ requires: ['fs:read'], allowed: ['fs:read'] });
    const m = parseSkillManifest(raw, 'my-skill');
    expect(m.id).toBe('my-skill');
  });

  it('a skill with NO frontmatter at all is permissive (empty requires + allowed) — existing skills keep loading', () => {
    // FAILS WITHOUT THE CHANGE: if parser threw on no-frontmatter, the 6 existing presets break.
    const raw = 'No frontmatter here.\n\nJust body text.';
    const m = parseSkillManifest(raw, 'bare-skill');
    expect(m.requires).toEqual([]);
    expect(m.allowed).toEqual([]);
  });

  it('a skill with frontmatter but NO requires/allowed fields is permissive', () => {
    // FAILS WITHOUT THE CHANGE: if absent fields threw instead of defaulting to [].
    const raw = skillMd({ name: 'no-manifest-skill', description: 'some skill' });
    const m = parseSkillManifest(raw, 'no-manifest-skill');
    expect(m.requires).toEqual([]);
    expect(m.allowed).toEqual([]);
  });

  it('requires ⊄ allowed → throws with a clear error naming skill + missing id', () => {
    // FAILS WITHOUT THE CHANGE: the violation would silently pass if the ⊆ check is absent.
    const raw = skillMd({
      name: 'bad-skill',
      requires: ['mcp.github:create_issue'],
      // 'mcp.github:create_issue' is NOT in allowed — violates requires ⊆ allowed
      allowed: ['fs:read'],
    });
    expect(() => parseSkillManifest(raw)).toThrow(/requires ⊄ allowed/);
    expect(() => parseSkillManifest(raw)).toThrow(/mcp\.github:create_issue/);
    expect(() => parseSkillManifest(raw)).toThrow(/bad-skill/);
  });

  it('inline-array syntax `requires: [a, b]` is parsed correctly', () => {
    const raw = `---\nname: inline-skill\nrequires: [fs:read, fs:write]\nallowed: [fs:read, fs:write]\n---\n`;
    const m = parseSkillManifest(raw);
    expect(m.requires).toEqual(['fs:read', 'fs:write']);
    expect(m.allowed).toEqual(['fs:read', 'fs:write']);
  });
});

// ── 1b. parseSkillDoc (manifest + description + body — the detail-view surface) ──

describe('parseSkillDoc — manifest widened with the frontmatter description + markdown body', () => {
  it('extracts the frontmatter description AND the markdown body after the closing ---', () => {
    // FAILS WITHOUT THE CHANGE: if body = whole raw, the frontmatter leaks into it; if description
    // extraction is missing, it stays ''. Both are what a remote detail page needs to render.
    const raw = `---\nname: pdf\ndescription: Fill and read PDF forms\nrequires: [read]\nallowed: [read]\n---\n# PDF\n\nDo the thing.\n`;
    const d = parseSkillDoc(raw, 'pdf');
    expect(d.id).toBe('pdf');
    expect(d.description).toBe('Fill and read PDF forms');
    expect(d.body.trim()).toBe('# PDF\n\nDo the thing.');
    expect(d.body).not.toContain('name: pdf'); // frontmatter must NOT bleed into the body
    expect(d.requires).toEqual(['read']);
    expect(d.allowed).toEqual(['read']);
  });

  it('a doc with NO frontmatter → empty description, the whole content as body (never throws)', () => {
    // FAILS if a missing frontmatter block throws or mis-slices the body.
    const raw = 'Just a plain body, no frontmatter.\n';
    const d = parseSkillDoc(raw, 'bare');
    expect(d.description).toBe('');
    expect(d.body).toBe(raw);
    expect(d.id).toBe('bare');
    expect(d.requires).toEqual([]);
  });

  it('a quoted description scalar is unquoted (one wrapping layer stripped)', () => {
    // FAILS if the extractor keeps the surrounding quotes.
    const raw = `---\nname: q\ndescription: "A quoted, comma-bearing summary"\n---\nBody.\n`;
    expect(parseSkillDoc(raw, 'q').description).toBe('A quoted, comma-bearing summary');
  });
});

// ── 2. resolveSkillLoadout (auto-wire) ───────────────────────────────────────

describe('resolveSkillLoadout — auto-wire: union of requires across skills, de-duped', () => {
  it('unions requires across multiple skills and de-dups', () => {
    // FAILS WITHOUT THE CHANGE: toolsToWire would be [] if requires are ignored.
    const manifests = [
      parseSkillManifest(skillMd({ name: 'skill-a', requires: ['fs:read', 'mcp.brave:search'], allowed: ['fs:read', 'fs:write', 'mcp.brave:search'] })),
      parseSkillManifest(skillMd({ name: 'skill-b', requires: ['fs:read', 'fs:write'], allowed: ['fs:read', 'fs:write'] })),
    ];
    const { toolsToWire, effectiveCeiling } = resolveSkillLoadout(manifests);
    // fs:read appears in both — de-duped to one occurrence; stable first-seen order.
    expect(toolsToWire).toEqual(['fs:read', 'mcp.brave:search', 'fs:write']);
    // effectiveCeiling = union of allowed across both skills, de-duped.
    expect(effectiveCeiling).toContain('fs:read');
    expect(effectiveCeiling).toContain('fs:write');
    expect(effectiveCeiling).toContain('mcp.brave:search');
  });

  it('empty manifests list → empty loadout (the no-skill case)', () => {
    // FAILS if resolveSkillLoadout throws on an empty input rather than returning the empty case.
    const { toolsToWire, effectiveCeiling } = resolveSkillLoadout([]);
    expect(toolsToWire).toEqual([]);
    expect(effectiveCeiling).toEqual([]);
  });

  it('a permissive skill (no requires) contributes nothing to toolsToWire', () => {
    // FAILS if a bare skill accidentally contributes to the auto-wire list.
    const manifest = parseSkillManifest(skillMd({ name: 'permissive' }), 'permissive');
    const { toolsToWire } = resolveSkillLoadout([manifest]);
    expect(toolsToWire).toEqual([]);
  });
});

// ── 3. preflightSkills (fail-fast before pi spawns) ──────────────────────────

describe('preflightSkills — preflight: throws when a required id is absent from the registry', () => {
  it('throws BEFORE the run when a required id is NOT in the registry — names skill + missing id', () => {
    // FAILS WITHOUT THE CHANGE: if preflight is absent, the missing capability is only discovered at
    // runtime (or never), wasting a pi invocation or silently misbehaving.
    const manifest = parseSkillManifest(
      skillMd({ name: 'web-search', requires: ['mcp.brave:brave_web_search'], allowed: ['mcp.brave:brave_web_search'] }),
    );
    const reg = registryWith('fs:read'); // 'mcp.brave:brave_web_search' is NOT registered
    expect(() => preflightSkills([manifest], reg)).toThrow(/mcp\.brave:brave_web_search/);
    expect(() => preflightSkills([manifest], reg)).toThrow(/web-search/);
    expect(() => preflightSkills([manifest], reg)).toThrow(/preflight FAILED/i);
  });

  it('passes when all required ids ARE in the registry', () => {
    // FAILS if the check incorrectly reports a violation for a present capability.
    const manifest = parseSkillManifest(
      skillMd({ name: 'fs-skill', requires: ['fs:read', 'fs:write'], allowed: ['fs:read', 'fs:write'] }),
    );
    const reg = registryWith('fs:read', 'fs:write');
    // Must NOT throw.
    expect(() => preflightSkills([manifest], reg)).not.toThrow();
  });

  it('reports ALL missing ids in one error (not just the first)', () => {
    // FAILS if the implementation throws on the first violation and skips reporting the rest —
    // a "fail-slow" error report is essential for usability.
    const manifest = parseSkillManifest(
      skillMd({
        name: 'multi-req-skill',
        requires: ['mcp.a:tool1', 'mcp.b:tool2'],
        allowed: ['mcp.a:tool1', 'mcp.b:tool2'],
      }),
    );
    const reg = registryWith(); // empty registry — both are missing
    let err: Error | null = null;
    try { preflightSkills([manifest], reg); } catch (e) { err = e as Error; }
    expect(err).not.toBeNull();
    expect(err?.message).toContain('mcp.a:tool1');
    expect(err?.message).toContain('mcp.b:tool2');
  });

  it('auto-wire: resolveSkillLoadout + preflightSkills together — wired tool appears in registry', () => {
    // FAILS if auto-wire and preflight are disconnected: the loadout says "wire X" but preflight
    // checks a different set, or the registry used for the check lacks the wired entry.
    const manifest = parseSkillManifest(
      skillMd({ name: 'wired-skill', requires: ['oc.calc:add'], allowed: ['oc.calc:add', 'fs:read'] }),
    );
    const { toolsToWire } = resolveSkillLoadout([manifest]);
    // The auto-wire result must include 'oc.calc:add'.
    expect(toolsToWire).toContain('oc.calc:add');
    // A registry with 'oc.calc:add' registered → preflight must pass.
    const reg = registryWith('oc.calc:add');
    expect(() => preflightSkills([manifest], reg)).not.toThrow();
  });

  it('a skill with empty requires never fails preflight, even with an empty registry', () => {
    // FAILS if the preflight throws for a permissive skill (would break all existing no-requires skills).
    const manifest = parseSkillManifest(skillMd({ name: 'permissive' }), 'permissive');
    const emptyReg = registryWith();
    expect(() => preflightSkills([manifest], emptyReg)).not.toThrow();
  });

  it('aggregates violations across MULTIPLE skills in one error', () => {
    // FAILS if preflight only checks the first skill and ignores the rest.
    const a = parseSkillManifest(
      skillMd({ name: 'skill-a', requires: ['mcp.x:tool'], allowed: ['mcp.x:tool'] }),
    );
    const b = parseSkillManifest(
      skillMd({ name: 'skill-b', requires: ['mcp.y:tool'], allowed: ['mcp.y:tool'] }),
    );
    const reg = registryWith(); // both missing
    let err: Error | null = null;
    try { preflightSkills([a, b], reg); } catch (e) { err = e as Error; }
    expect(err?.message).toContain('skill-a');
    expect(err?.message).toContain('mcp.x:tool');
    expect(err?.message).toContain('skill-b');
    expect(err?.message).toContain('mcp.y:tool');
  });
});
