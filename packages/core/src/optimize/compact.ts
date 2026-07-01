// optimize/compact.ts — the cap/retire COMPACTION pass (piflow-memory-v1.5 §5.3, §6; memory-slices MODE B).
// The write-counterpart of MEMORIZE's per-round append/update: a SEPARATE, out-of-band pass that keeps each
// `memory.md` bounded and honest by RETIRING discrete lowest-value lesson blocks — it NEVER re-summarizes
// (full-rewrite consolidation causes measured context collapse, ACE arXiv 2510.04618). Every kept block is
// byte-identical to its original; compaction only DELETES whole blocks.
//
// Two retire triggers (memory-slices MODE B), both deterministic:
//   • UNCONDITIONAL — a lesson whose fix GRADUATED to code/git (superseded) or whose linked `[[okf-slice]]`
//     went stale (code-shifted) is retired regardless of the cap. The graduated/code-shifted SETS are INJECTED
//     (the optimizer computes them from git + the OKF `--check` gate); this module stays pure fs + arithmetic.
//   • CAP-PRESSURE — when more lessons remain than the cap allows, retire the LOWEST-VALUE blocks until under
//     the cap. Value = recurrence (a proven, recurring lesson is kept; a recurrence-1 one-off is the first to
//     go); ties break by document order, bottom-first ("~40 lines, top-loaded: the bottom truncates first").
//
// The cap constant + the value metric are TUNABLE defaults, not laws (the eviction surveys settle the AXIS —
// age × importance × recurrence — not the constant). `deriveRecurrence` reads back exactly the kept blocks.

import { readFileSync, writeFileSync } from 'node:fs';

/** One parsed lesson block: its machine key, count, and its half-open line span `[start, end)` in the file. */
interface ParsedBlock {
  sig: string;
  recurrence: number;
  /** index of the `### ` line. */
  start: number;
  /** exclusive: the next `### `/`## ` boundary line, or lines.length. The span self-contains its trailing blank. */
  end: number;
  /** 0-based document order among lesson blocks. */
  order: number;
}

/** The default lesson cap per memory.md (≈ the ~40-line, top-loaded cap at ~5 lines/block). Tunable via opts. */
export const DEFAULT_MAX_LESSONS = 8;

export interface CompactOpts {
  /** max lesson blocks to keep in this memory.md (the cap). Default {@link DEFAULT_MAX_LESSONS}. */
  maxLessons?: number;
  /** sigs whose fix GRADUATED to code/git (superseded) → retired regardless of the cap. Injected; default none. */
  graduated?: ReadonlySet<string>;
  /** sigs whose linked `[[okf-slice]]` went stale/code-shifted → retired regardless of the cap. Injected; default none. */
  codeShifted?: ReadonlySet<string>;
}

export type RetireReason = 'graduated' | 'code-shifted' | 'cap-eviction';

/** One block the compaction retired, and why. */
export interface RetiredLesson {
  sig: string;
  recurrence: number;
  reason: RetireReason;
}

export interface CompactResult {
  /** the memory.md path compacted (absolute). */
  file: string;
  /** blocks retired this pass, in retirement order. */
  retired: RetiredLesson[];
  /** the sigs of the blocks that remain, in document order. */
  keptSigs: string[];
}

/**
 * Compact one `memory.md`: retire graduated + code-shifted blocks unconditionally, then evict the lowest-value
 * survivors down to the cap. Deletes whole blocks (never re-summarizes); rewrites only when something retired.
 * A missing/unreadable file is a no-op (never throws). `deriveRecurrence` reads back exactly the kept blocks.
 */
export function compactMemory(file: string, opts: CompactOpts = {}): CompactResult {
  const maxLessons = opts.maxLessons ?? DEFAULT_MAX_LESSONS;
  const graduated = opts.graduated ?? new Set<string>();
  const codeShifted = opts.codeShifted ?? new Set<string>();

  let body: string;
  try {
    body = readFileSync(file, 'utf8');
  } catch {
    return { file, retired: [], keptSigs: [] }; // no file ⇒ nothing to compact
  }

  const lines = body.split('\n');
  const blocks = parseBlocks(lines);

  const retired: RetiredLesson[] = [];
  const retiredOrders = new Set<number>();

  // (1) UNCONDITIONAL retires — a superseded (graduated) or stale (code-shifted) lesson goes regardless of cap.
  //     graduated is checked first so a block that is BOTH is reported as graduated (the stronger signal).
  for (const b of blocks) {
    if (graduated.has(b.sig)) {
      retired.push({ sig: b.sig, recurrence: b.recurrence, reason: 'graduated' });
      retiredOrders.add(b.order);
    } else if (codeShifted.has(b.sig)) {
      retired.push({ sig: b.sig, recurrence: b.recurrence, reason: 'code-shifted' });
      retiredOrders.add(b.order);
    }
  }

  // (2) CAP-PRESSURE — evict the lowest-value survivors until at the cap. Value = recurrence (proven lessons
  //     stay); ties break by document order BOTTOM-first (the ~40-line "bottom truncates first"). Retire order
  //     is lowest-value-first so the report reads worst→least-bad.
  const survivors = blocks.filter((b) => !retiredOrders.has(b.order));
  if (survivors.length > maxLessons) {
    const evictCount = survivors.length - maxLessons;
    const ranked = [...survivors].sort((a, b) => a.recurrence - b.recurrence || b.order - a.order);
    for (const b of ranked.slice(0, evictCount)) {
      retired.push({ sig: b.sig, recurrence: b.recurrence, reason: 'cap-eviction' });
      retiredOrders.add(b.order);
    }
  }

  const keptSigs = blocks.filter((b) => !retiredOrders.has(b.order)).map((b) => b.sig);
  if (retiredOrders.size === 0) return { file, retired, keptSigs }; // nothing retired ⇒ leave the file untouched

  // Delete the retired blocks' lines (each span self-contains its trailing blank), preserving all else.
  const drop = new Set<number>();
  for (const b of blocks) {
    if (!retiredOrders.has(b.order)) continue;
    for (let i = b.start; i < b.end; i++) drop.add(i);
  }
  const keptLines = lines.filter((_, i) => !drop.has(i));
  writeFileSync(file, keptLines.join('\n'), 'utf8');

  return { file, retired, keptSigs };
}

// ── block parsing (the SAME boundary rule the reader/writer share: `### ` opens, `### `/`## ` or EOF closes) ──
/** Parse the file's lesson blocks (those carrying a machine `sig:` line) with their line spans + document order. */
function parseBlocks(lines: string[]): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  let start = -1;
  for (let i = 0; i <= lines.length; i++) {
    const atEnd = i === lines.length;
    const t = atEnd ? '' : lines[i].trimStart();
    const isH3 = !atEnd && t.startsWith('### ');
    const isSection = !atEnd && t.startsWith('## ') && !isH3;
    const isBoundary = atEnd || isH3 || isSection;
    if (isBoundary && start >= 0) {
      const parsed = readBlock(lines, start, i);
      if (parsed) blocks.push({ ...parsed, start, end: i, order: blocks.length });
      start = isH3 ? i : -1; // a `### ` boundary reopens; a `## `/EOF closes and opens nothing
    } else if (isH3 && start < 0) {
      start = i;
    }
  }
  return blocks;
}

/** Read a block's `sig:` + `recurrence:` (default 0); null when the block has no machine `sig:` (skip, never mis-key). */
function readBlock(lines: string[], start: number, end: number): { sig: string; recurrence: number } | null {
  let sig: string | undefined;
  let recurrence = 0;
  for (let i = start; i < end; i++) {
    const line = lines[i].trim();
    if (line.startsWith('sig:')) {
      sig = line.slice('sig:'.length).trim();
    } else if (line.startsWith('recurrence:')) {
      const n = Number.parseInt(line.slice('recurrence:'.length).trim(), 10);
      if (Number.isFinite(n)) recurrence = n;
    }
  }
  return sig ? { sig, recurrence } : null;
}
