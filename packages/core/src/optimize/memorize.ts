// optimize/memorize.ts — the MEMORIZE WRITER (piflow-memory-v1.5 §6), the write-counterpart of the recurrence
// READER (recurrence.ts). At the END of a run it persists the run's tier0-signature defects and folds the
// standing lesson set so the two-run carry needs no human hand-write:
//   run 1 → APPEND a lesson at `sig:`, recurrence 1.  run 2 → the reader flips LAPSE→SKILL; MEMORIZE UPDATEs
//   the block to recurrence 2. Reader + writer share ONE identity (`signatureOf`) so they agree on "same failure".
//
// THE DESIGN DECISION (idempotency): the recurrence count is DERIVED from the run trail, then MATERIALIZED into
// the block's `recurrence:` — NEVER blindly incremented. Each MEMORIZE writes the run's defect signatures to
// `<runDir>/optimize/signatures.json`; count(sig) = the number of run dirs (under the product's runs/) whose
// signatures.json carries it. Re-MEMORIZE the same run → the same sidecar → the same count (never doubled). This
// leaves the shipped reader UNCHANGED (it still reads `recurrence:` off the block).
//
// DETERMINISTIC: no LLM, no network, no randomness. The count is COUNTED (memory-slices MODE B: "deterministic-
// first; the model only distills"); the deep root-cause prose is the FIXER's later job — the writer seeds honest
// `(pending — …)` placeholders. This module owns ALL of the layer's fs; triage/recurrence stay as they were.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { signatureOf } from './recurrence.js';
import { buildNodeMemory } from '../memory/index.js';
import type { NodeScore, Defect, DefectBucket } from './types.js';

export interface MemorizeOpts {
  /** the finished run's dir (`.piflow/<wf>/runs/<id>`); the sidecar `<runDir>/optimize/signatures.json` lands here. */
  runDir: string;
  /** the product template dir; a lesson lands in `<templateDir>/nodes/<node>/memory.md`. */
  templateDir: string;
  /** the product's runs dir (siblings of runDir); the count is derived over its run dirs. Default = dirname(runDir). */
  runsDir?: string;
}

/** One lesson the writer appended or updated, and where. */
export interface MemorizeLesson {
  node: string;
  sig: string;
  recurrence: number;
  action: 'append' | 'update';
  /** absolute path to the memory.md the lesson landed in. */
  file: string;
}

export interface MemorizeResult {
  /** absolute path to the per-run signatures.json sidecar this MEMORIZE (over)wrote. */
  signaturesPath: string;
  lessons: MemorizeLesson[];
}

/** The persisted per-run signature record — the atom the cross-run count is derived over. */
interface SignatureRecord {
  node: string;
  sig: string;
  bucket: DefectBucket;
  symptom: string;
}

// Only the tier0-signature buckets gate on recurrence: LAPSE (a one-off slip that, if it RECURS, is a SKILL gap)
// and SKILL (already-recurring). FUNCTIONALITY/ARCH use a DIFFERENT fix-surface signature (product code / a
// cross-node contract), so their recurrence is NOT keyed by signatureOf — they are OUT of this MVP's scope.
const RECORDABLE: ReadonlySet<DefectBucket> = new Set<DefectBucket>(['LAPSE', 'SKILL']);

export function memorize(scores: NodeScore[], defects: Defect[], opts: MemorizeOpts): MemorizeResult {
  const runsDir = opts.runsDir ?? dirname(opts.runDir);
  const scoreByNode = new Map(scores.map((s) => [s.node, s]));

  // (a) SCOPE — only the tier0-signature buckets; key each by the SHARED signatureOf (never reimplemented).
  const records: SignatureRecord[] = [];
  for (const d of defects) {
    if (!RECORDABLE.has(d.bucket)) continue;
    const s = scoreByNode.get(d.node);
    if (!s) continue; // a defect with no matching score cannot be signed; skip rather than mis-key.
    records.push({ node: d.node, sig: signatureOf(s), bucket: d.bucket, symptom: d.symptom });
  }

  // (b) PERSIST — write this run's signatures sidecar (OVERWRITE ⇒ idempotent; re-run yields the same file).
  const optimizeDir = join(opts.runDir, 'optimize');
  mkdirSync(optimizeDir, { recursive: true });
  const signaturesPath = join(optimizeDir, 'signatures.json');
  writeFileSync(
    signaturesPath,
    JSON.stringify(records.map((r) => ({ node: r.node, sig: r.sig, bucket: r.bucket, symptom: r.symptom })), null, 2),
    'utf8',
  );

  // (c) DERIVE COUNT — count(sig) = number of run dirs whose signatures.json carries it (this run counts, (b) wrote it).
  const runsBySig = deriveCounts(runsDir);

  // (d) WRITE — append/update the lesson block at `sig:` in the owning node's memory.md (create from seed if absent).
  const lessons: MemorizeLesson[] = [];
  for (const r of records) {
    const count = runsBySig.get(r.sig) ?? 1; // (b) guarantees at least this run
    const file = join(opts.templateDir, 'nodes', r.node, 'memory.md');
    const action = writeLesson(file, r, count);
    lessons.push({ node: r.node, sig: r.sig, recurrence: count, action, file });
  }

  // cap/retire (memory-slices MODE B) is a SEPARATE, out-of-band pass — NEVER inside this append loop. It
  // lives in the `piflowctl memory compact` verb (compactMemory + the git/OKF retire-trigger injectors).
  return { signaturesPath, lessons };
}

// ── (c) DERIVE the cross-run counts from the run trail ─────────────────────────────────────────────────────
/** count(sig) = the number of run dirs directly under `runsDir` whose `optimize/signatures.json` contains sig. */
function deriveCounts(runsDir: string): Map<string, number> {
  const counts = new Map<string, number>();
  let entries: string[];
  try {
    entries = readdirSync(runsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return counts; // missing runs dir ⇒ no trail (never throw)
  }
  for (const id of entries) {
    const sigs = readSignatures(join(runsDir, id, 'optimize', 'signatures.json'));
    for (const sig of sigs) counts.set(sig, (counts.get(sig) ?? 0) + 1); // one run contributes at most 1 per sig
  }
  return counts;
}

/** The SET of sigs one run's sidecar carries; missing/unreadable/malformed ⇒ empty (skipped, never throws). */
function readSignatures(path: string): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed)) return new Set();
    const set = new Set<string>();
    for (const row of parsed) if (row && typeof row.sig === 'string') set.add(row.sig);
    return set;
  } catch {
    return new Set();
  }
}

// ── (d) WRITE the lesson block (append new, or materialize the count onto an existing block) ────────────────
const KNOWN_FAILURES_HEADER = '## Known failure modes';

/** Append a new lesson block for `r` at recurrence `count`, or update an existing block's `recurrence:` line. */
function writeLesson(file: string, r: SignatureRecord, count: number): 'append' | 'update' {
  const body = existsSync(file) ? readFileSync(file, 'utf8') : seedMemory(file, r.node);
  const lines = body.split('\n');

  const block = findBlockBySig(lines, r.sig);
  if (block) {
    // UPDATE — MATERIALIZE the derived count onto the block's `recurrence:` line; leave the curated prose alone.
    const recIdx = findRecurrenceLine(lines, block.start, block.end);
    if (recIdx >= 0) lines[recIdx] = `recurrence: ${count}`;
    else lines.splice(block.start + 1, 0, `recurrence: ${count}`); // a sig-block with no recurrence: line — add one
    writeFileSync(file, lines.join('\n'), 'utf8');
    return 'update';
  }

  // APPEND — a new block in the locked grammar (honest placeholders; the fixer fills Root/Prevention later).
  const newBlock = [
    `### ${r.symptom}`,
    `sig: ${r.sig}`,
    `recurrence: ${count}`,
    '**Root:** (pending — the fixer fills the root-cause trace)',
    '**Prevention:** (pending — the fixer/human fills the durable guard)',
  ];
  const insertAt = insertionPoint(lines);
  lines.splice(insertAt, 0, '', ...newBlock);
  writeFileSync(file, lines.join('\n'), 'utf8');
  return 'append';
}

/** Seed the node's memory.md from the shared skeleton (create-if-absent) and return its body. */
function seedMemory(file: string, node: string): string {
  mkdirSync(dirname(file), { recursive: true });
  const body = buildNodeMemory(node);
  writeFileSync(file, body, 'utf8');
  return body;
}

/**
 * Locate the lesson block whose `sig:` equals `sig`. A block opens at a `### ` heading and runs until the next
 * `### `/`## ` or EOF — the SAME span rule the reader's splitBlocks uses, so what we update is what it reads.
 */
function findBlockBySig(lines: string[], sig: string): { start: number; end: number } | null {
  const target = `sig: ${sig}`;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trimStart();
    const isBoundary = t.startsWith('### ') || t.startsWith('## ');
    if (isBoundary && start >= 0) {
      // close the open block at this boundary; scan it for the sig.
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

/**
 * Where a new block is inserted: right after the `## Known failure modes` header + its leading comment block,
 * before the next `## ` section. If that section is absent, append at EOF. (deriveRecurrence closes an open
 * block at the next `## `, so a block placed inside this section is read correctly.)
 */
function insertionPoint(lines: string[]): number {
  const headerIdx = lines.findIndex((l) => l.trimStart().startsWith(KNOWN_FAILURES_HEADER));
  if (headerIdx < 0) return lines.length; // no section ⇒ EOF
  // insert BEFORE the next `## ` after the header (end of the failure-modes section), else at EOF.
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith('## ')) return i;
  }
  return lines.length;
}
