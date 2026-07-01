// `piflowctl memory find|check` — the read-only Leg-A face of the per-node MEMORY layer. It promotes the
// already-built recurrence engine (`deriveRecurrence`, @piflow/core) into a deterministic CLI verb, mirroring
// `understand.ts` (the Leg-B code-slice reader). Both subcommands are strictly READ-ONLY — no model, no
// network, no mutation: `find` folds the counted recurrence index into a printed report for the out-of-band
// triage/fixer; `check` RIDES the OKF `--check` gate through each lesson's `[[okf-slice]]` pointer (never a
// separate drift engine — pointer + resolve-at-read). The mutating MEMORIZE write stays the out-of-loop
// distiller step (untouched here). Memory is OPTIMIZER-FACING reference, NEVER a worker node's runtime prompt.

import { deriveRecurrence, type RecurrenceIndex, type RecurrenceHit } from '@piflow/core';
import { resolveTopicsDir, resolveSlice, defaultRunGate } from './understand.js';

const out = (s: string): void => void process.stdout.write(s);
const err = (s: string): void => void process.stderr.write(s);

const MEMORY_FIND_USAGE = 'piflowctl memory find <templateDir> [--node <id>] [symptom…]';
const MEMORY_CHECK_USAGE = 'piflowctl memory check <templateDir> [node…] [--strict]';

/** Pull the value that follows `--flag` (e.g. `--node build`), or undefined when absent. */
function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * `piflowctl memory find <templateDir> [--node <id>] [symptom…]` — surface a node's standing lessons + the
 * cross-run RECURRENCE count for the triage/fixer (the LAPSE-vs-SKILL signal). A pure fold over
 * `deriveRecurrence`'s index: for each matched lesson print its machine `sig:` + `recurrence: N` + the
 * `[[okf-slice]]` pointer + Root/Prevention. `--node` scopes to one node; a bare `<symptom>` query filters the
 * index to signatures containing it (case-insensitive substring). Empty index ⇒ an honest "no standing
 * lessons" (never invents). Read-only.
 */
export async function runMemoryFind(argv: string[], _deps: { cwd?: string } = {}): Promise<void> {
  const node = flagValue(argv, '--node');
  const positionals = argv.filter((a) => !a.startsWith('-'));
  const templateDir = positionals[0];
  if (!templateDir) {
    err(`piflowctl memory find: a template directory is required\n  ${MEMORY_FIND_USAGE}\n`);
    process.exitCode = 1;
    return;
  }
  // Remaining positionals (after templateDir) are the free-text symptom query.
  const query = positionals.slice(1).join(' ').trim().toLowerCase();

  const index: RecurrenceIndex = deriveRecurrence({
    templateDir,
    nodes: node ? [node] : undefined,
  });

  const scope = node ? `node '${node}'` : 'all nodes + system';
  // Deterministic order: signature ascending. Filter to the query substring when one is given.
  const entries = [...index.entries()]
    .filter(([sig]) => (query ? sig.toLowerCase().includes(query) : true))
    .sort((a, b) => a[0].localeCompare(b[0]));

  if (entries.length === 0) {
    const q = query ? ` matching "${query}"` : '';
    out(
      `piflowctl memory find — no standing lessons for ${scope}${q} (recurrence 0 — first occurrence).\n`,
    );
    return;
  }

  out(`piflowctl memory find — ${entries.length} standing lesson(s) for ${scope}:\n`);
  for (const [sig, hit] of entries) renderHit(sig, hit);
  out(`\nvalidate freshness:  piflowctl memory check ${templateDir}\n`);
}

/** Print one recurrence entry: the signature, its count, and any lesson prose the fixer needs. */
function renderHit(sig: string, hit: RecurrenceHit): void {
  out(`\n${sig}\n  recurrence: ${hit.count}\n`);
  const l = hit.lesson;
  if (l?.okfSlice) out(`  code slice: [[${l.okfSlice}]]\n`);
  if (l?.root) out(`  Root: ${l.root}\n`);
  if (l?.prevention) out(`  Prevention: ${l.prevention}\n`);
}

/**
 * `piflowctl memory check <templateDir> [node…] [--strict]` — an ADVISORY staleness/drift gate over the
 * lessons' `[[okf-slice]]` links. It RIDES the OKF `--check` gate (never a separate drift engine): collect the
 * DISTINCT slice keys the lessons link, then run the gate on exactly those keys. A lesson whose linked slice
 * fails `--check` (gate non-zero) is `code-shifted`; one whose slice is absent (`resolveSlice` null) is
 * `dangling`. Advisory by default — exit 0 even when a lesson is code-shifted/dangling (parity with
 * `understand --check`'s advisory auto-region drift). `--strict` makes any dangling/code-shifted lesson a
 * non-zero exit (for a pre-commit hook). A template with no `.agents/okf` substrate simply has no ride-along
 * gate — reported and skipped (advisory exit 0). `deps.runGate` lets tests inject the gate; `deps.cwd` sets
 * the OKF-substrate search root. Read-only.
 */
export async function runMemoryCheck(
  argv: string[],
  deps: {
    cwd?: string;
    runGate?: (mode: 'check' | 'write', topicsDir: string, keys: string[]) => number;
  } = {},
): Promise<void> {
  const strict = argv.includes('--strict');
  const positionals = argv.filter((a) => !a.startsWith('-'));
  const templateDir = positionals[0];
  if (!templateDir) {
    err(`piflowctl memory check: a template directory is required\n  ${MEMORY_CHECK_USAGE}\n`);
    process.exitCode = 1;
    return;
  }
  const nodes = positionals.slice(1);

  const index: RecurrenceIndex = deriveRecurrence({
    templateDir,
    nodes: nodes.length > 0 ? nodes : undefined,
  });

  // Lessons that carry an [[okf-slice]] link — the only ones a freshness gate can ride.
  const linked = [...index.entries()].filter(([, hit]) => hit.lesson?.okfSlice);
  if (linked.length === 0) {
    out(`piflowctl memory check — no lessons link an [[okf-slice]] under ${templateDir}; nothing to gate.\n`);
    return;
  }

  const topicsDir = resolveTopicsDir(deps.cwd ?? templateDir);
  if (!topicsDir) {
    out(
      `piflowctl memory check — no .agents/okf substrate from ${deps.cwd ?? templateDir}; ` +
        `the memory freshness gate is skipped (advisory).\n`,
    );
    return;
  }

  // Split the linked lessons into dangling (slice absent) vs gateable (slice present). Ride the OKF gate ONCE
  // on the DISTINCT set of present slice keys, then attribute the gate's verdict back to each lesson.
  const dangling: Array<{ sig: string; key: string }> = [];
  const gateable: Array<{ sig: string; key: string }> = [];
  for (const [sig, hit] of linked) {
    const key = hit.lesson!.okfSlice!;
    (resolveSlice(topicsDir, key) === null ? dangling : gateable).push({ sig, key });
  }

  const sliceKeys = [...new Set(gateable.map((g) => g.key))].sort();
  const gate = deps.runGate ?? defaultRunGate;
  const gateCode = sliceKeys.length > 0 ? gate('check', topicsDir, sliceKeys) : 0;
  const codeShifted = gateCode !== 0; // a HEALTH failure on the linked slice set

  out(`piflowctl memory check — ${linked.length} linked lesson(s) under ${templateDir}:\n`);
  for (const { sig, key } of gateable.sort((a, b) => a.sig.localeCompare(b.sig))) {
    out(`  ${codeShifted ? 'code-shifted' : 'fresh'}: ${sig} ← [[${key}]]\n`);
  }
  for (const { sig, key } of dangling.sort((a, b) => a.sig.localeCompare(b.sig))) {
    out(`  dangling: ${sig} → [[${key}]] is absent from ${topicsDir}\n`);
  }

  const problems = codeShifted || dangling.length > 0;
  if (problems && strict) {
    process.exitCode = 1;
  } else if (problems) {
    out(`\n(advisory — re-run with --strict to fail on code-shifted/dangling lessons)\n`);
  }
}
