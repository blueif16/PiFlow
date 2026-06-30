// optimize/criteria.ts — parse the product's per-node quality bar (`skill-system-criteria.md`) into a
// CriteriaFixture the scorer/triage key by node id. Pure: markdown string → Map. READ-ONLY input.
//
// THE GRAMMAR (confirmed against test/fixtures/optimize/skill-system-criteria.md):
//   • A NODE ENTRY is an H2/H3 heading whose text ends in a `(<paren>)` group, e.g.
//       `## W0 Classify (w0-classify)`            → id `w0-classify`, label `W0 Classify`.
//     The id is the parenthetical SLUG; the label is the heading text before that paren.
//   • SKIP (not nodes): every H1 (`# …`); any heading WITHOUT a trailing `(…)` id; and any heading
//     whose parenthetical is prose not a slug (`## Affordance bar … (the demo bar)`) or carries no
//     clean base slug (`## action_3d archetype … (WIN-LOSE, …)`). The id is rejected unless it matches
//     a clean slug — so a prose/Uppercase parenthetical falls through to SKIP, never a dirty key.
//   • A VARIANT heading carries a compound parenthetical — a comma list `(<id>, <axis>:<value>, …)`
//     (e.g. `(w1-spec, goalModel:open-ended)`, `(w2-scaffold, archetype:voxel_sandbox)`). The base id
//     is the first segment; the first `axis:value` qualifier's VALUE is the variantKey; the entry is
//     keyed `id:variantKey`. A variantKey is dropped (entry kept as the bare base) if it is not a clean
//     slug — keys never contain a space (the contract forbids it).
//   • Inside an entry (until the next H1/H2/H3) the body fields are bold-led lines:
//       `**Artifact:** <one line>` · `**Purpose:** <prose, runs on until the next `**` field>` ·
//       `**Acceptance criteria…:**` then `- ` bullets · `**Red flags:**` then `- ` bullets.
//     The `Acceptance criteria` marker varies its tail (`(what good looks like)`, `…, when built`, …)
//     so it is matched by PREFIX. Each bullet is one `- ` line; the leading `- ` is stripped.
//
// Run: npx vitest run packages/core/test/optimize-criteria.test.ts

import type { CriteriaEntry, CriteriaFixture } from './types.js';

/** A clean node/variant slug: lowercase-ish, no spaces — the only key shape the contract allows. */
const SLUG = /^[a-z0-9][a-z0-9_-]*$/;

/** A heading line: capture the level (# count) and the trimmed text after it. */
const HEADING = /^(#{1,6})\s+(.*?)\s*$/;

/** The node-id parenthetical: a trailing, paren-free `(…)` group at the very end of the heading text. */
const ID_PAREN = /\(([^()]+)\)\s*$/;

type Section = 'artifact' | 'purpose' | 'acceptance' | 'redflags' | null;

/** Resolve a bold field marker (`**Artifact:** …`) to its section + the inline remainder after it. */
function matchField(line: string): { section: Exclude<Section, null>; rest: string } | null {
  const m = /^\*\*([^*]+?)\*\*\s*(.*)$/.exec(line);
  if (!m) return null;
  const label = m[1].replace(/:\s*$/, '').trim().toLowerCase();
  if (label === 'artifact') return { section: 'artifact', rest: m[2] };
  if (label === 'purpose') return { section: 'purpose', rest: m[2] };
  if (label.startsWith('acceptance criteria')) return { section: 'acceptance', rest: m[2] };
  if (label === 'red flags') return { section: 'redflags', rest: m[2] };
  return null;
}

/** Parse a heading's parenthetical into a base nodeId + optional variantKey, or null when it is not a node. */
function parseHeadingId(text: string): { nodeId: string; variantKey?: string; label: string } | null {
  const paren = ID_PAREN.exec(text);
  if (!paren) return null;
  const label = text.slice(0, paren.index).trim();
  const segments = paren[1].split(',').map((s) => s.trim());
  const nodeId = segments[0];
  if (!SLUG.test(nodeId)) return null; // prose / Uppercase / non-slug parenthetical → not a node
  // First `axis:value` qualifier supplies the variant key; a non-slug value is dropped (no dirty key).
  let variantKey: string | undefined;
  for (const seg of segments.slice(1)) {
    const colon = seg.indexOf(':');
    if (colon === -1) continue;
    const value = seg.slice(colon + 1).trim();
    if (SLUG.test(value)) variantKey = value;
    break;
  }
  return { nodeId, variantKey, label };
}

/** Parse `skill-system-criteria.md` content → entries keyed by node id (and `nodeId:variantKey`). */
export function parseCriteria(markdown: string): CriteriaFixture {
  const fixture: CriteriaFixture = new Map();
  const lines = markdown.split(/\r?\n/);

  let entry: CriteriaEntry | null = null;
  let key = '';
  let section: Section = null;

  const flush = () => {
    if (entry) fixture.set(key, entry);
    entry = null;
    key = '';
    section = null;
  };

  const appendPurpose = (text: string) => {
    if (!entry) return;
    entry.purpose = entry.purpose ? `${entry.purpose} ${text}`.trim() : text.trim();
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    const heading = HEADING.exec(line);
    if (heading) {
      flush(); // a new heading closes the prior entry
      const level = heading[1].length;
      if (level < 2) continue; // H1 is never a node (the FACTS rule)
      const parsed = parseHeadingId(heading[2]);
      if (!parsed) continue; // thematic heading with no clean parenthetical id → skipped
      key = parsed.variantKey ? `${parsed.nodeId}:${parsed.variantKey}` : parsed.nodeId;
      entry = {
        nodeId: parsed.nodeId,
        label: parsed.label,
        artifact: '',
        purpose: '',
        acceptanceCriteria: [],
        redFlags: [],
        ...(parsed.variantKey ? { variantKey: parsed.variantKey } : {}),
      };
      continue;
    }

    if (!entry) continue;

    const field = matchField(line);
    if (field) {
      section = field.section;
      if (section === 'artifact') entry.artifact = field.rest.trim();
      else if (section === 'purpose') appendPurpose(field.rest);
      continue;
    }

    if (section === 'purpose' && line.trim()) {
      appendPurpose(line); // purpose prose runs on until the next field/heading
      continue;
    }

    const bullet = /^\s*-\s+(.*\S)\s*$/.exec(line);
    if (bullet) {
      if (section === 'acceptance') entry.acceptanceCriteria.push(bullet[1].trim());
      else if (section === 'redflags') entry.redFlags.push(bullet[1].trim());
    }
  }

  flush();
  return fixture;
}
