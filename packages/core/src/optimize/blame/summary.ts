// optimize/blame/summary.ts — the run summary's fenced-tail codec (docs/design/optimize-blame.md §3).
// The per-node blame files are PROSE and have NO parser at all; the run summary `blame.md` is the ONE parser
// boundary in the whole `blame/` dir — a small fenced JSON tail carrying the ONLY machine-read fields the
// scheduler (§5) and lane priority need: `{blamed, edges, unattributed}`. This module owns both directions:
//   • `parseBlameSummaryTail` — extract the LAST fenced ```json block, JSON.parse, and FAIL CLOSED on ANY
//     malformation (no tail · bad severity · a non-pair edge · an empty node · a non-string list). It mirrors
//     `parseGateVerdict`'s strictness (gate.ts) — a malformed tail must BLOCK, never silently best-effort, or
//     the scheduler would schedule off garbage. Every throw names its reason.
//   • `renderBlameSummaryTail` — the inverse, for tests + fixtures. Round-trip law: parse(render(x)) deep-
//     equals x.

export type BlameSeverity = 'critical' | 'high' | 'medium' | 'low';

const SEVERITIES: readonly BlameSeverity[] = ['critical', 'high', 'medium', 'low'];

/** One attribution in the machine-read tail: the OWNING node, its severity, and where the defect was OBSERVED. */
export interface BlameEntry {
  node: string;
  severity: BlameSeverity;
  /** the node(s) the defect surfaced at (may be empty when it surfaces at the owner itself). */
  observedAt: string[];
}

/** The whole machine-read tail (§3): blamed owners, the blame graph edges (owner → observedAt), and the
 *  defects the judge could NOT attribute with evidence (an ARCH signal — never forced onto a node). */
export interface BlameSummary {
  blamed: BlameEntry[];
  edges: [string, string][];
  unattributed: string[];
}

/** True iff `v` is a string[] (every element a string). */
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Parse the LAST fenced ```json block of a blame summary into a validated `BlameSummary`. FAIL CLOSED: no
 * fenced tail, invalid JSON, or ANY field out of shape throws a NAMED error (never a silent best-effort read —
 * the scheduler reads this and only this).
 */
export function parseBlameSummaryTail(markdown: string): BlameSummary {
  const blocks = [...markdown.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (blocks.length === 0) {
    throw new Error('blame summary has no fenced ```json tail block — the machine-read summary is missing');
  }
  const inner = blocks[blocks.length - 1][1];

  let parsed: unknown;
  try {
    parsed = JSON.parse(inner);
  } catch (e) {
    throw new Error(`blame summary tail is not valid JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('blame summary tail must be a JSON object');
  }
  const v = parsed as Record<string, unknown>;

  if (!Array.isArray(v.blamed)) throw new Error('blame summary "blamed" must be an array');
  const blamed: BlameEntry[] = v.blamed.map((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`blame summary blamed[${i}] must be an object`);
    const b = raw as Record<string, unknown>;
    if (typeof b.node !== 'string' || !b.node.trim()) throw new Error(`blame summary blamed[${i}].node must be a non-empty string`);
    if (!SEVERITIES.includes(b.severity as BlameSeverity)) {
      throw new Error(`blame summary blamed[${i}].severity must be one of ${SEVERITIES.join('|')}, got ${JSON.stringify(b.severity)}`);
    }
    if (!isStringArray(b.observedAt)) throw new Error(`blame summary blamed[${i}].observedAt must be an array of strings`);
    return { node: b.node, severity: b.severity as BlameSeverity, observedAt: [...b.observedAt] };
  });

  if (!Array.isArray(v.edges)) throw new Error('blame summary "edges" must be an array');
  const edges: [string, string][] = v.edges.map((raw, i) => {
    if (!Array.isArray(raw) || raw.length !== 2 || typeof raw[0] !== 'string' || typeof raw[1] !== 'string') {
      throw new Error(`blame summary edges[${i}] must be a [owner, observedAt] pair of strings`);
    }
    return [raw[0], raw[1]];
  });

  if (!isStringArray(v.unattributed)) throw new Error('blame summary "unattributed" must be an array of strings');

  return { blamed, edges, unattributed: [...v.unattributed] };
}

/** Render a `BlameSummary` as the fenced ```json tail string (for tests + fixtures). Round-trip law:
 *  `parseBlameSummaryTail(renderBlameSummaryTail(x))` deep-equals x. */
export function renderBlameSummaryTail(summary: BlameSummary): string {
  return '```json\n' + JSON.stringify(summary, null, 2) + '\n```';
}
