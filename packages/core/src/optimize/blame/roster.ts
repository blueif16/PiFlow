// optimize/blame/roster.ts — the AUTO-COMPOSED responsibility roster (docs/design/optimize-blame.md §2).
// "What is each node responsible for" is the map the run-level judge attributes against — and it is NEVER
// hand-written into criteria.md. It is composed at judge time from each node's OWN declarations
// (`<templateDir>/nodes/<id>/node.json`: id · phase · contract.artifacts → produces · contract.owns), plus
// the first line of that node's prompt.md as a best-effort responsibility brief. Editing a node updates the
// roster on the next pass with ZERO manual sync — resolve-at-read, the same pointer-not-copy law as the
// memory-leg join. `criteria.md` stays purely the final-artifact bar; this rides beside it in the judge context.
//
// DEGRADE, NEVER THROW: a node whose node.json is missing/unparseable is SKIPPED (not the whole roster) — a
// half-authored template still yields a roster over the readable nodes. prompt.md is best-effort: absent ⇒ the
// responsibility is simply omitted (its content is a brief, not a gate). Reads straight off disk (fs) — the
// node.json `contract` block is the SAME authored shape the DAG compiles from (node.schema.ts:173), never the
// runtime NodeSpec.

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** One node's line in the roster — its identity + what it OWNS producing, off its own node.json declarations. */
export interface RosterEntry {
  /** The node id (node.json `id`, else the node-dir name). */
  id: string;
  /** The decorative phase label (node.json `phase`), when declared. */
  phase?: string;
  /** REQUIRED outputs the node produces — read from `contract.artifacts` (the authored spelling; there is no
   *  `contract.produces` key — node.schema.ts:179). Empty when the contract declares none. */
  produces: string[];
  /** Write-authority globs — `contract.owns`. Empty when none declared. */
  owns: string[];
  /** Best-effort brief: the FIRST non-empty line of the node's prompt.md, truncated to 200 chars. Omitted when
   *  prompt.md is absent/empty. */
  responsibility?: string;
}

/** The node.json fields the roster reads — a permissive subset (the loader validates the full shape elsewhere;
 *  here every field is best-effort and degrades). */
interface RawNodeJson {
  id?: unknown;
  phase?: unknown;
  contract?: { artifacts?: unknown; owns?: unknown };
}

/** Coerce an unknown value to a string[] (dropping non-string entries); a non-array ⇒ []. */
function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** The FIRST non-empty (trimmed) line of `text`, truncated to 200 chars; '' when there is none. */
function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t) return t.slice(0, 200);
  }
  return '';
}

/**
 * Compose the responsibility roster off `<templateDir>/nodes/<id>/node.json` (+ each node's prompt.md). Reads
 * every node dir, skips any whose node.json is missing/unparseable (degrade, never throw), and returns the
 * entries sorted by id (deterministic — `readdir` order is not). Best-effort throughout.
 */
export async function composeRoster(templateDir: string): Promise<RosterEntry[]> {
  const nodesDir = path.join(templateDir, 'nodes');
  let dirents: import('node:fs').Dirent[];
  try {
    dirents = await fs.readdir(nodesDir, { withFileTypes: true });
  } catch {
    return []; // no nodes/ dir yet — an empty roster, never a throw
  }

  const entries: RosterEntry[] = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const dirName = d.name;
    let raw: RawNodeJson;
    try {
      raw = JSON.parse(await fs.readFile(path.join(nodesDir, dirName, 'node.json'), 'utf8')) as RawNodeJson;
    } catch {
      continue; // missing/unparseable node.json ⇒ skip THIS node, keep the rest
    }
    const entry: RosterEntry = {
      id: typeof raw.id === 'string' && raw.id ? raw.id : dirName,
      produces: stringArray(raw.contract?.artifacts),
      owns: stringArray(raw.contract?.owns),
    };
    if (typeof raw.phase === 'string' && raw.phase) entry.phase = raw.phase;
    // prompt.md is best-effort — absent/empty ⇒ no responsibility (never a throw).
    const prompt = await fs.readFile(path.join(nodesDir, dirName, 'prompt.md'), 'utf8').catch(() => '');
    const brief = firstLine(prompt);
    if (brief) entry.responsibility = brief;
    entries.push(entry);
  }
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return entries;
}

/** Render the roster as a markdown section — one bullet per node (its id · phase · produces · owns · brief).
 *  An empty roster renders a placeholder line, never '' (the judge must see WHY there is nothing to attribute). */
export function renderRoster(entries: RosterEntry[]): string {
  if (entries.length === 0) return '(no nodes with a readable node.json under this template — empty roster)';
  return entries
    .map((e) => {
      const phase = e.phase ? ` (${e.phase})` : '';
      const produces = e.produces.length ? e.produces.join(', ') : '—';
      const owns = e.owns.length ? e.owns.join(', ') : '—';
      const resp = e.responsibility ? ` — ${e.responsibility}` : '';
      return `- \`${e.id}\`${phase} — produces: ${produces}; owns: ${owns}${resp}`;
    })
    .join('\n');
}
