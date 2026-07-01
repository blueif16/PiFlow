// optimize/recurrence.ts — the FIRST reader of Leg-A `memory.md` (piflow-memory-v1.5 §3, §7). It supplies
// the ONE signal the four-way triage projector lacks to decide the SKILL bucket: has this exact failure
// signature RECURRED across runs? A one-off structural slip is a LAPSE (fix the executor); the SAME signature
// twice means the skill prose is wrong/underspecified (fix the envelope) — SKILL, higher blast radius.
//
// Two surfaces, one pure + one I/O (all fs lives HERE; triage stays pure):
//   • signatureOf  — PURE, stable, deterministic key: `<node>::<sorted-anomalies | reason | "underperformed">`.
//                    Anomalies are SORTED so trace ordering can't split one recurring failure into two keys.
//   • deriveRecurrence — reads per-node `<templateDir>/nodes/<node>/memory.md` + the system `<templateDir>/memory.md`,
//                    parses LESSON BLOCKS, returns the RecurrenceIndex keyed by each block's machine `sig:`.
//
// THE LESSON-BLOCK GRAMMAR (what MEMORIZE/authors write — see memory/skeleton.ts's seed comment):
//   `### <symptom signature>`   ← opens a block (any `###` heading); the block runs until the next `###`/`##` or EOF.
//   Inside the block, these OPTIONAL lines (order-free, one per line):
//     `sig: <node>::<key>`       ← the machine key = signatureOf(...) output; THE index key. No sig ⇒ block SKIPPED.
//     `recurrence: <N>`          ← the cross-run count; `count` (default 0 if absent).
//     `[[<okf-slice-key>]]`      ← the code-map slice the fixer should read; → lesson.okfSlice.
//     `**Root:** <text>`         ← → lesson.root.
//     `**Prevention:** <text>`   ← → lesson.prevention.
// Missing files/dirs ⇒ empty index, never throw. Deterministic line-scan (no regex-monster).

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { NodeScore } from './types.js';

/**
 * The stable, deterministic failure-signature key. `<node>::<discriminator>` where the discriminator is the
 * SORTED anomaly kinds joined by `+`, falling back to the tier0 reason, then the literal `underperformed`.
 * PURE — a function of the score alone; the same failure always keys the same string across runs.
 */
export function signatureOf(s: Pick<NodeScore, 'node' | 'tier0'>): string {
  return `${s.node}::${[...s.tier0.anomalies].sort().join('+') || (s.tier0.reason ?? 'underperformed')}`;
}

/** One recurrence entry: how many times this signature recurred + the author's/optimizer's lesson, if any. */
export interface RecurrenceHit {
  count: number;
  lesson?: { root?: string; prevention?: string; okfSlice?: string };
}

/** The cross-run recurrence index, keyed by signature (signatureOf output). */
export type RecurrenceIndex = Map<string, RecurrenceHit>;

/**
 * Read Leg-A memory.md (per-node + system) under `templateDir`, parse the lesson blocks, and fold them into
 * the recurrence index. `nodes` scopes the per-node scan; when omitted it discovers every node dir's memory.md.
 * The ONLY I/O in this layer; triage consumes the returned Map and never touches disk.
 */
export function deriveRecurrence(opts: { templateDir: string; nodes?: string[] }): RecurrenceIndex {
  const index: RecurrenceIndex = new Map();
  const nodeNames = opts.nodes ?? discoverNodes(opts.templateDir);
  for (const node of nodeNames) {
    absorb(index, readFileMaybe(join(opts.templateDir, 'nodes', node, 'memory.md')));
  }
  absorb(index, readFileMaybe(join(opts.templateDir, 'memory.md')));
  return index;
}

/** `<templateDir>/nodes/*` directory names; empty when the dir is missing/unreadable. */
function discoverNodes(templateDir: string): string[] {
  try {
    return readdirSync(join(templateDir, 'nodes'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Read a file, or null if it does not exist / is unreadable (missing memory ⇒ no recurrence, never throw). */
function readFileMaybe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Parse the lesson blocks in one memory.md body and merge each keyed hit into the index. */
function absorb(index: RecurrenceIndex, body: string | null): void {
  if (!body) return;
  for (const block of splitBlocks(body)) {
    const hit = parseBlock(block);
    if (hit) index.set(hit.sig, hit.entry);
  }
}

/** Split a memory.md body into lesson blocks: each starts at a `### ` line, ends before the next `###`/`##`. */
function splitBlocks(body: string): string[][] {
  const lines = body.split('\n');
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    const isH3 = line.startsWith('### ') || line.trimStart().startsWith('### ');
    const isSectionBreak = line.startsWith('## ') && !isH3;
    if (isH3) {
      if (current) blocks.push(current);
      current = [line];
    } else if (isSectionBreak) {
      if (current) blocks.push(current);
      current = null; // a `##` section header closes the open block and opens no new one
    } else if (current) {
      current.push(line);
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

/** Parse one lesson block into its sig + entry; null when the block carries no machine `sig:` line. */
function parseBlock(block: string[]): { sig: string; entry: RecurrenceHit } | null {
  let sig: string | undefined;
  let count = 0;
  const lesson: { root?: string; prevention?: string; okfSlice?: string } = {};
  for (const raw of block) {
    const line = raw.trim();
    if (line.startsWith('sig:')) {
      sig = line.slice('sig:'.length).trim();
    } else if (line.startsWith('recurrence:')) {
      const n = Number.parseInt(line.slice('recurrence:'.length).trim(), 10);
      if (Number.isFinite(n)) count = n;
    } else if (line.startsWith('[[') && line.endsWith(']]')) {
      lesson.okfSlice = line.slice(2, -2).trim();
    } else if (line.startsWith('**Root:**')) {
      lesson.root = line.slice('**Root:**'.length).trim();
    } else if (line.startsWith('**Prevention:**')) {
      lesson.prevention = line.slice('**Prevention:**'.length).trim();
    }
  }
  if (!sig) return null; // no machine key ⇒ not guessable ⇒ skip (never mis-key)
  const entry: RecurrenceHit = { count };
  if (lesson.root || lesson.prevention || lesson.okfSlice) entry.lesson = lesson;
  return { sig, entry };
}
