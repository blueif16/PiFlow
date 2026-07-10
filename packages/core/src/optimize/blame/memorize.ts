// optimize/blame/memorize.ts — BLAME-MEMORIZE (docs/design/optimize-blame.md §7, WS-B6), the run-level twin
// of optimize/memorize.ts one grammar up. Node-level MEMORIZE distills a NODE's own tier0-signature defects
// into `nodes/<id>/memory.md`; this module distills a finished BLAME PASS's attributions into TEMPLATE-ROOT
// `<templateDir>/memory.md` — the cross-run trail `deriveRecurrence` (recurrence.ts) already reads
// (recurrence.ts:55 absorbs the template-root file) but that, before this module, had NO automated writer:
// every shipped MEMORIZE call touches only a per-node memory.md. blame-memorize is the FIRST automated writer
// of the template-root file, closing the loop §7 describes ("the NEXT blame judge reads those lessons").
//
// SAME lesson-block grammar as the node-level writer (memorize.ts's `writeLesson` / recurrence.ts's reader),
// SAME UPDATE-IN-PLACE-BY-SIG discipline — deliberately NOT sharing code with memorize.ts (its block-span
// helpers are module-private, and its identity key `signatureOf(NodeScore)` is a different atom than a blame
// attribution's symptom line). Two sig families, so a blamed node and a dissent against it read side by side:
//   sig: blame:<node>::<tag>            — one blamed node's attribution (a `blame/<node>.md` blame file).
//   sig: blame-dissent:<node>::<tag>    — a node-triage CONTEST of that attribution (§4.1's dissent trace,
//                                          `blame/dissent.<node>.md`), same node+tag derivation.
// `<tag>` is a deterministic slug of the SYMPTOM line, so the SAME re-observed defect across generations keys
// the SAME block (recurrence bumps, never duplicates) while a genuinely different defect on the same node gets
// its own block.
//
// DETERMINISTIC: no LLM, no network, no randomness — the blame judge already wrote the prose; this module only
// lifts the first defect line as the symptom and slugifies it. The deep root/prevention prose stays the honest
// `(pending)` placeholder until the generation loop (§8) confirms or refutes the attribution against a fresh
// baseline — filling it is NOT this module's job.
//
// RECURRENCE COUNTS GENERATIONS, NOT INVOCATIONS (§7: the block stores "run id + owner + defect"). Each block
// carries a `runs:` line listing the DISTINCT run ids that exhibited the defect, and `recurrence:` is the SIZE
// of that set. Blame is idempotent/re-runnable (`optimize blame <run>` / `--latest` may run twice in a session),
// so a re-memorize of the SAME run must NOT bump recurrence — otherwise the §7 cross-generation escalation
// signal (recurring ≥N generations → ARCH) is corrupted by mere invocation count. The `runs:` line is invisible
// to `deriveRecurrence` (recurrence.ts parses only `sig:`/`recurrence:`/lesson lines), so no reader changes.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { seedSystemMemory } from '../../memory/index.js';
import { blameSummaryPath, blameFilePath, blameDissentPath, blameDir } from './paths.js';
import { parseBlameSummaryTail } from './summary.js';

/** One MEMORIZE pass's tally + where it landed — mirrors optimize/memorize.ts's `MemorizeResult` shape, one
 *  grain up (a single template-root file rather than one file per lesson). */
export interface MemorizeBlameResult {
  /** new lesson blocks appended this pass (blamed + dissent, combined). */
  written: number;
  /** existing lesson blocks whose `recurrence:` bumped this pass (a re-observed sig, never duplicated). */
  updated: number;
  /** absolute path to the template-root `memory.md` this pass wrote. */
  file: string;
}

/**
 * Distill ONE finished blame pass into template-root `memory.md`:
 *   1. read `blame/blame.md`'s fenced tail (`parseBlameSummaryTail`) — HARD-THROW if the summary is absent or
 *      malformed; memorizing without a blame pass is a caller-bug, never a silent no-op (mirrors
 *      `runBlameJudge`'s own fail-closed law over the same file).
 *   2. ensure the template-root file exists (`seedSystemMemory`, create-if-absent — curated content is NEVER
 *      clobbered).
 *   3. for each `summary.blamed` entry, lift the SYMPTOM off `blame/<node>.md`'s first defect line and
 *      append/update a `sig: blame:<node>::<tag>` block.
 *   4. for each `dissent.<node>.md` actually on disk (§4.1's node-triage contest trace — NOT the summary,
 *      since a contest may name a node the summary itself never blamed), append/update a
 *      `sig: blame-dissent:<node>::<tag>` block recording the contested attribution.
 * Idempotent BY GENERATION: a second call over the SAME run (same `runDir` basename) is a NO-OP — it writes no
 * new block AND does not bump `recurrence:`, because recurrence counts DISTINCT runs, not memorize invocations
 * (§7). A later run that re-observes the defect adds its run id and bumps recurrence by one (UPDATE-IN-PLACE-BY-SIG).
 */
export async function memorizeBlame(runDir: string, templateDir: string): Promise<MemorizeBlameResult> {
  // (1) the summary is the caller's proof a blame pass ran on THIS run — HARD-THROW if absent/malformed.
  const summaryPath = blameSummaryPath(runDir);
  let raw: string;
  try {
    raw = await fs.readFile(summaryPath, 'utf8');
  } catch (e) {
    throw new Error(
      `memorizeBlame: no blame summary at ${summaryPath} — memorize without a blame pass is a caller bug ` +
      `(run \`piflowctl optimize blame\` first): ${(e as Error).message}`,
    );
  }
  const summary = parseBlameSummaryTail(raw);

  // (2) ensure the template-root file exists — create-if-absent, reusing the shared system-memory skeleton;
  // never clobbers curated content (seedSystemMemory's own law).
  const wfId = await readWorkflowId(templateDir);
  const { path: file } = await seedSystemMemory(templateDir, wfId);

  // The GENERATION identity: recurrence counts distinct runs, so the run dir's own id is what a re-memorize of
  // the SAME run dedups against (basename of the canonical `.piflow/<wf>/runs/<id>` run dir).
  const runId = path.basename(path.resolve(runDir));

  let written = 0;
  let updated = 0;

  // (3) one lesson block per BLAMED node.
  for (const entry of summary.blamed) {
    const body = await readFileMaybe(blameFilePath(runDir, entry.node));
    const symptom = extractSymptom(body, entry.node);
    const sig = `blame:${entry.node}::${slugify(symptom)}`;
    const action = await writeBlameLesson(file, symptom, sig, runId);
    if (action === 'append') written++; else if (action === 'update') updated++;
  }

  // (4) one lesson block per DISSENT trace actually on disk (§4.1) — scanned off `blame/`, not the summary:
  // a dissent may contest an attribution against a node the summary never blamed.
  for (const node of await listDissentNodes(runDir)) {
    const body = await readFileMaybe(blameDissentPath(runDir, node));
    const symptom = extractSymptom(body, node);
    const sig = `blame-dissent:${node}::${slugify(symptom)}`;
    const action = await writeBlameLesson(file, symptom, sig, runId);
    if (action === 'append') written++; else if (action === 'update') updated++;
  }

  return { written, updated, file };
}

// ── workflow id (for the system-memory skeleton's title) ───────────────────────────────────────────────────

/** `<templateDir>/meta.json`'s `id`, falling back to the dir's own basename — mirrors `scaffoldMemory`'s
 *  backfill fallback (packages/cli/src/scaffold.ts). A missing/unparseable meta.json never throws here (blame
 *  is self-sufficient, per the doc's §4 opening line — it does not assume a fully-authored template). */
async function readWorkflowId(templateDir: string): Promise<string> {
  try {
    const meta = JSON.parse(await fs.readFile(path.join(templateDir, 'meta.json'), 'utf8')) as { id?: unknown };
    if (typeof meta.id === 'string' && meta.id) return meta.id;
  } catch {
    /* missing/unparseable meta.json — fall back to the dir name */
  }
  return path.basename(templateDir);
}

/** Read a file, or `null` when it is missing/unreadable (never throw — a blamed node with no per-node file on
 *  disk is a data-integrity gap to record honestly, not a memorize failure). */
async function readFileMaybe(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** `<runDir>/optimize/blame/dissent.<node>.md` file names actually on disk, sorted — the node ids therein. */
async function listDissentNodes(runDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(blameDir(runDir));
  } catch {
    return [];
  }
  return entries
    .map((f) => /^dissent\.(.+)\.md$/.exec(f)?.[1])
    .filter((n): n is string => Boolean(n))
    .sort();
}

// ── symptom extraction + slug (the stable identity a re-observed defect must re-derive) ────────────────────

/**
 * Lift a one-line SYMPTOM off a per-node prose blame/dissent body: the first non-empty line AFTER the opening
 * `# ...` heading (`# blame — <node> @ <run id>` per judge.ts's OUTPUT_SPEC — a generic label, never the
 * defect itself) is the doc's "defect line". Falls back to the heading's own text when the file has no body
 * past it, and to a placeholder when the file is missing/empty (never throws — see `readFileMaybe`).
 */
function extractSymptom(body: string | null, node: string): string {
  if (body === null) return `${node}: blamed with no per-node blame file on disk`;
  const lines = body.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return `${node}: empty blame file`;
  const rest = lines[0].startsWith('#') ? lines.slice(1) : lines;
  const line = rest[0] ?? lines[0].replace(/^#+\s*/, '');
  return line.slice(0, 160) || `${node}: no defect line recorded`;
}

/** Deterministic slug of `text`: lowercase, non-alphanumeric runs collapse to one `-`, trimmed, capped at 60
 *  chars. STABLE — the same defect text always yields the same tag, which is what lets a re-observed defect
 *  UPDATE its existing block instead of duplicating (the sig-derived law this whole module exists to keep). */
function slugify(text: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
  return slug || 'unspecified';
}

// ── the lesson-block writer (mirrors memorize.ts's writeLesson — same grammar, same span rules, deliberately
// a separate implementation: those helpers are module-private and this module's identity key differs) ──────

/**
 * Append a NEW lesson block at `sig` (recurrence 1, `runs: <runId>`), or — when a block with that `sig:`
 * already exists — add `runId` to its `runs:` set and set `recurrence:` to the new set size. GENERATION-KEYED
 * IDEMPOTENCE: a re-memorize of a run ALREADY in the `runs:` set is a no-op (`'noop'` — recurrence unchanged),
 * so recurrence counts distinct GENERATIONS, never memorize invocations. UPDATE-IN-PLACE-BY-SIG: never duplicates.
 */
async function writeBlameLesson(file: string, symptom: string, sig: string, runId: string): Promise<'append' | 'update' | 'noop'> {
  const body = await fs.readFile(file, 'utf8');
  const lines = body.split('\n');

  const block = findBlockBySig(lines, sig);
  if (block) {
    const runsIdx = findFieldLine(lines, block.start, block.end, 'runs');
    const runs = runsIdx >= 0 ? parseRunIds(lines[runsIdx]) : [];
    if (runs.includes(runId)) return 'noop'; // this generation already counted — a re-run is not a re-observation

    const recIdx = findRecurrenceLine(lines, block.start, block.end);
    // The prior generation count: the runs-set size when present (this module's invariant recurrence == |runs|),
    // else the legacy `recurrence:` number (a pre-fix block carried a count but no run set) — advance it by one.
    const priorCount = runsIdx >= 0
      ? runs.length
      : (recIdx >= 0 ? (Number.parseInt(lines[recIdx].split(':')[1]?.trim() ?? '', 10) || 0) : 0);
    const nextRuns = [...runs, runId];
    const nextRec = priorCount + 1;

    if (recIdx >= 0) lines[recIdx] = `recurrence: ${nextRec}`;
    if (runsIdx >= 0) {
      lines[runsIdx] = `runs: ${nextRuns.join(', ')}`;
    } else {
      // legacy/no-runs block — seed the runs line (and a recurrence line if even that was absent) right after
      // the heading; the recurrence line was already updated in place above when it existed.
      const insertAt = recIdx >= 0 ? recIdx : block.start + 1;
      lines.splice(insertAt, 0, `runs: ${nextRuns.join(', ')}`);
      if (recIdx < 0) lines.splice(insertAt + 1, 0, `recurrence: ${nextRec}`);
    }
    await fs.writeFile(file, lines.join('\n'), 'utf8');
    return 'update';
  }

  const newBlock = [
    `### ${symptom}`,
    `sig: ${sig}`,
    `runs: ${runId}`,
    'recurrence: 1',
    '**Root:** (pending — filled as generations confirm)',
    '**Prevention:** (pending)',
  ];
  const insertAt = insertionPoint(lines);
  lines.splice(insertAt, 0, '', ...newBlock);
  await fs.writeFile(file, lines.join('\n'), 'utf8');
  return 'append';
}

/** The DISTINCT run ids listed on a `runs: r1, r2, …` line (order-preserving, de-duped, blanks dropped). */
function parseRunIds(line: string): string[] {
  const after = line.slice(line.indexOf(':') + 1);
  const out: string[] = [];
  for (const raw of after.split(',')) {
    const id = raw.trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The index of the first `<field>:` line within [start,end), or -1 (the SAME span scan as findRecurrenceLine). */
function findFieldLine(lines: string[], start: number, end: number, field: string): number {
  const prefix = `${field}:`;
  for (let i = start; i < end; i++) if (lines[i].trim().startsWith(prefix)) return i;
  return -1;
}

/**
 * Locate the lesson block whose `sig:` equals `sig`. A block opens at a `### ` heading and runs until the
 * next `###`/`##` or EOF — the SAME span rule `recurrence.ts`'s `splitBlocks` uses, so what we update here is
 * exactly what the reader parses (verbatim of memorize.ts's `findBlockBySig`, duplicated per this module's
 * header note).
 */
function findBlockBySig(lines: string[], sig: string): { start: number; end: number } | null {
  const target = `sig: ${sig}`;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trimStart();
    const isBoundary = t.startsWith('### ') || t.startsWith('## ');
    if (isBoundary && start >= 0) {
      if (blockHasSig(lines, start, i, target)) return { start, end: i };
      start = t.startsWith('### ') ? i : -1;
    } else if (t.startsWith('### ') && start < 0) {
      start = i;
    }
  }
  if (start >= 0 && blockHasSig(lines, start, lines.length, target)) return { start, end: lines.length };
  return null;
}

function blockHasSig(lines: string[], start: number, end: number, target: string): boolean {
  for (let i = start; i < end; i++) if (lines[i].trim() === target) return true;
  return false;
}

/** The index of the `recurrence:` line within [start,end), or -1. */
function findRecurrenceLine(lines: string[], start: number, end: number): number {
  for (let i = start; i < end; i++) if (lines[i].trim().startsWith('recurrence:')) return i;
  return -1;
}

const KNOWN_FAILURES_HEADER = '## Known failure modes';

/**
 * Where a new block is inserted: right after the `## Known failure modes` header, before the next `## `
 * section. If that section is absent (the template-root skeleton carries no such section by default — this
 * module is its first automated writer), append at EOF, exactly like memorize.ts's `insertionPoint` degrades —
 * `recurrence.ts`'s reader closes an open block at the next `## ` OR EOF regardless of which section it sits
 * in, so a block placed either way is still read correctly.
 */
function insertionPoint(lines: string[]): number {
  const headerIdx = lines.findIndex((l) => l.trimStart().startsWith(KNOWN_FAILURES_HEADER));
  if (headerIdx < 0) return lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith('## ')) return i;
  }
  return lines.length;
}
