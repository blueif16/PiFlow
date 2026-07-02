// `piflowctl memory compact <templateDir>` — the OUT-OF-BAND home for the core cap/retire pass. It gives the
// built-but-uncalled `compactMemory` (@piflow/core) a caller so each per-node `memory.md` stays bounded, and
// it computes the two DETERMINISTIC retire-trigger injectors that `compactMemory` takes but cannot source
// itself (they are product/CLI-side by the SDK boundary law — they shell to `git` and to the OKF `--check`
// engine, which `@piflow/core` must never do):
//   • codeShifted — a lesson whose linked `[[okf-slice]]` went HEALTH-stale on the OKF gate (the code its
//     prevention guards moved). RIDES the same OKF `--check` engine `understand`/`memory check` shell to,
//     PER-KEY (so a stale slice retires ONLY its linked sigs, never every lesson on the node).
//   • graduated — a lesson whose fix graduated to code/git: a `skillsys(<node>)`/`flowCommit` commit body
//     literally contains the block's `sig:` (`<node>::<key>`). Exact, false-positive-free; the land/MEMORIZE
//     commit template (cluster A1) OWNS echoing the sig — until it does, `graduated` is safely ∅.
//
// COMPACTION MUTATES a live file, so this is an out-of-band VERB, never a per-round loop hook (the loop never
// mutates a live file — loop.ts). It DEFAULTS TO DRY-RUN (report the retire plan, write nothing); `--apply`
// is the explicit opt-in to rewrite, symmetric with how `optimize --adopt` is a separate physical-land step.
// ACE: compaction DELETES discrete lowest-value lessons; it NEVER re-summarizes (compactMemory's own body).

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  compactMemory,
  deriveRecurrence,
  DEFAULT_MAX_LESSONS,
  type CompactResult,
  type RetiredLesson,
} from '@piflow/core';
import { resolveTopicsDir, resolveSlice, defaultRunGate } from './understand.js';

/** The injectable gate signature — the SAME seam `memory check`/`understand --check` thread (understand.ts).
 *  Reused (not a new `runCheck` shape) so the two gate paths can never drift. */
type RunGate = (mode: 'check' | 'write', topicsDir: string, keys: string[]) => number;

/** Read the set of sigs whose fix graduated to git — a `skillsys`/`flowCommit` commit body contains the sig.
 *  Takes the templateDir + node scope; the DEFAULT resolves the repo root itself (an injected fake needn't). */
type ReadGraduatedSigs = (templateDir: string, nodes: string[]) => Set<string>;

export interface MemoryCompactDeps {
  /** inject the OKF `--check` gate (default = the repo-local `_generate.mjs` shell); tests fake it. */
  runGate?: RunGate;
  /** inject the git-graduation reader (default = the `git log --grep` shell); tests fake it. A test injects
   *  this to avoid shelling git — so it is honored WITHOUT a discoverable repo root. */
  readGraduatedSigs?: ReadGraduatedSigs;
  /** capture output; default = process.stdout. */
  print?: (s: string) => void;
}

const MEMORY_COMPACT_USAGE =
  'piflowctl memory compact <templateDir> [--apply] [--node <substr>] [--max-lessons <n>] ' +
  '[--no-graduated] [--no-code-shifted] [--json]';

// ── the two retire-trigger injectors (both deterministic, CLI-side) ───────────────────────────────────────

/**
 * Build the sig → `[[okf-slice]]` map by reading each node's memory.md through `deriveRecurrence` (the ONLY
 * source that parses the link into `lesson.okfSlice`), then GATE each DISTINCT linked slice key PER-KEY and
 * mark every sig whose key is HEALTH-stale as code-shifted. Per-key attribution is the whole point: a stale
 * slice retires ONLY the lessons that link it, never every lesson on the node. Degrades to ∅ (never throws)
 * when there is no `.agents/okf/` substrate — same silent-degrade posture as scoreTriageEnrich (optimize-fix.ts).
 */
export function codeShiftedInjector(
  templateDir: string,
  nodes: string[],
  deps: { runGate?: RunGate } = {},
): Set<string> {
  const shifted = new Set<string>();
  const topicsDir = resolveTopicsDir(templateDir);
  if (!topicsDir) return shifted; // no OKF substrate ⇒ nothing to ride ⇒ ∅

  // sig → its linked slice key (deriveRecurrence parses `[[…]]` into lesson.okfSlice; compact.ts does NOT).
  const index = deriveRecurrence({ templateDir, nodes: nodes.length ? nodes : undefined });
  const sigsByKey = new Map<string, string[]>();
  for (const [sig, hit] of index) {
    const key = hit.lesson?.okfSlice;
    if (!key) continue;
    if (resolveSlice(topicsDir, key) === null) continue; // absent slice ⇒ dangling, NOT code-shifted
    const bucket = sigsByKey.get(key) ?? [];
    bucket.push(sig);
    sigsByKey.set(key, bucket);
  }

  const gate = deps.runGate ?? defaultRunGate;
  for (const [key, sigs] of sigsByKey) {
    // PER-KEY probe: exit-1 = that one slice is HEALTH-stale (code-shifted); exit 0 = fresh (_generate.mjs:319-323).
    let stale = false;
    try {
      stale = gate('check', topicsDir, [key]) !== 0;
    } catch {
      stale = false; // a gate crash degrades to fresh (never throw out of the injector)
    }
    if (stale) for (const s of sigs) shifted.add(s);
  }
  return shifted;
}

/**
 * The default git-graduation reader: a sig graduated iff a `skillsys(<node>)`/`flowCommit` commit body
 * literally contains the sig string (`<node>::<key>`). Exact + false-positive-free (the coarse node-level
 * heuristic over-retires and is rejected). The commit template (cluster A1) OWNS echoing the sig; until it
 * does, this returns ∅ (nothing wrongly retired). Absent git / no `.git` ⇒ ∅ (never throws). Resolves the
 * enclosing repo root from `templateDir` itself, so the verb passes only the templateDir + node scope.
 */
export function readGraduatedSigsFromGit(templateDir: string, nodes: string[]): Set<string> {
  const graduated = new Set<string>();
  const repoRoot = findRepoRoot(templateDir);
  if (!repoRoot) return graduated; // no `.git` up the tree ⇒ ∅
  try {
    // One log over the graduation commits (either prefix graduates; NOT --all-match). NUL-delimit each body
    // so a multi-line message stays one record. A sig is a literal `<node>::<key>` — scan every body for it.
    const raw = execFileSync(
      'git',
      ['-C', repoRoot, 'log', '--grep', '^skillsys(', '--grep', '^flowCommit', '--format=%B%x00'],
      { encoding: 'utf8' },
    );
    if (!raw.trim()) return graduated;
    // The sig set the caller cares about is derived from memory (below); here we only need to expose the
    // commit corpus — the caller intersects. But to keep the injector self-contained, scan for every sig the
    // nodes' memory declares. That map lives in the verb; this reader returns the RAW graduated-sig corpus by
    // matching the `<node>::` prefix so it stays node-scoped and cheap.
    for (const body of raw.split('\0')) {
      for (const m of body.matchAll(/([A-Za-z0-9_.-]+)::([^\s`'")\]]+)/g)) {
        const node = m[1];
        if (nodes.length === 0 || nodes.includes(node)) graduated.add(`${node}::${m[2]}`);
      }
    }
  } catch {
    return new Set<string>(); // no git / no repo ⇒ ∅
  }
  return graduated;
}

/** Walk up from `startDir` to the enclosing repo root (the dir holding `.git`); null when there is none. */
export function findRepoRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ── arg parsing ───────────────────────────────────────────────────────────────────────────────────────────

interface CompactArgs {
  templateDir: string;
  node?: string;
  maxLessons?: number;
  apply: boolean;
  noGraduated: boolean;
  noCodeShifted: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): CompactArgs {
  const out: CompactArgs = {
    templateDir: '',
    apply: false,
    noGraduated: false,
    noCodeShifted: false,
    json: false,
  };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--apply') out.apply = true;
    else if (k === '--no-graduated') out.noGraduated = true;
    else if (k === '--no-code-shifted') out.noCodeShifted = true;
    else if (k === '--json') out.json = true;
    else if (k === '--node') out.node = argv[++i];
    else if (k === '--max-lessons') out.maxLessons = Number(argv[++i]);
    else if (k.startsWith('--')) {
      /* ignore unknown flags */
    } else positionals.push(k);
  }
  out.templateDir = positionals[0] ?? '';
  return out;
}

/** `<templateDir>/nodes/*` directory names (empty when absent), mirroring recurrence.ts's discovery shape. */
function discoverNodes(templateDir: string): string[] {
  try {
    return readdirSync(path.join(templateDir, 'nodes'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

// ── the verb ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `piflowctl memory compact <templateDir> [flags]` — run the out-of-band cap/retire pass over each node's
 * memory.md. Computes the graduated + code-shifted injectors CLI-side, then calls core `compactMemory` per
 * node. DEFAULT DRY-RUN: it runs `compactMemory` on a scratch COPY and reports the retire plan without
 * touching the live file; `--apply` runs it on the live file (the only write). Both injectors degrade to ∅
 * on any error (git/OKF absent) with a one-line note — the verb never aborts the whole run.
 */
export async function runMemoryCompactCli(argv: string[], deps: MemoryCompactDeps = {}): Promise<void> {
  const print = deps.print ?? ((s: string) => void process.stdout.write(s));
  const err = (s: string): void => void process.stderr.write(s);
  const args = parseArgs(argv);
  if (!args.templateDir) {
    err(`piflowctl memory compact: a template directory is required\n  ${MEMORY_COMPACT_USAGE}\n`);
    process.exitCode = 1;
    return;
  }
  const maxLessons = args.maxLessons ?? DEFAULT_MAX_LESSONS;

  // Discover nodes (scoped by --node substring). Empty ⇒ nothing to compact.
  let nodes = discoverNodes(args.templateDir);
  if (args.node) nodes = nodes.filter((n) => n.includes(args.node!));

  // Compute the injected retire sets (unless disabled). Each degrades to ∅ with a one-line stderr note.
  let graduated = new Set<string>();
  if (!args.noGraduated) {
    try {
      graduated = (deps.readGraduatedSigs ?? readGraduatedSigsFromGit)(args.templateDir, nodes);
    } catch {
      err('memory compact: git unavailable — graduated injector skipped\n');
      graduated = new Set();
    }
  }

  let codeShifted = new Set<string>();
  if (!args.noCodeShifted) {
    try {
      codeShifted = codeShiftedInjector(args.templateDir, nodes, { runGate: deps.runGate });
    } catch {
      err('memory compact: OKF gate unavailable — code-shifted injector skipped\n');
      codeShifted = new Set();
    }
  }

  // Per node: dry-run compacts a COPY (live file untouched); --apply compacts the live file.
  const results: CompactResult[] = [];
  const scratch = args.apply ? null : mkdtempSync(path.join(tmpdir(), 'piflow-compact-dry-'));
  try {
    for (const node of nodes) {
      const live = path.join(args.templateDir, 'nodes', node, 'memory.md');
      if (!existsSync(live)) continue;
      let res: CompactResult;
      if (args.apply) {
        res = compactMemory(live, { maxLessons, graduated, codeShifted });
      } else {
        const copy = path.join(scratch!, `${node}.md`);
        copyFileSync(live, copy);
        const dry = compactMemory(copy, { maxLessons, graduated, codeShifted });
        res = { file: live, retired: dry.retired, keptSigs: dry.keptSigs }; // report against the LIVE path
      }
      results.push(res);
    }
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }

  report(results, args, maxLessons, graduated, codeShifted, print);
}

/** Print the per-node retire plan + a rollup. `--json` emits `{ node, file, retired, keptSigs }[]`. */
function report(
  results: CompactResult[],
  args: CompactArgs,
  maxLessons: number,
  graduated: Set<string>,
  codeShifted: Set<string>,
  print: (s: string) => void,
): void {
  const nodeOf = (file: string): string => path.basename(path.dirname(file));
  if (args.json) {
    print(
      JSON.stringify(
        results.map((r) => ({ node: nodeOf(r.file), file: r.file, retired: r.retired, keptSigs: r.keptSigs })),
        null,
        2,
      ) + '\n',
    );
    return;
  }

  const banner = args.apply
    ? `piflowctl memory compact — APPLY (max-lessons ${maxLessons})`
    : `piflowctl memory compact — DRY-RUN (nothing written; pass --apply to compact; max-lessons ${maxLessons})`;
  print(`${banner}\n`);

  const counts: Record<RetiredLesson['reason'], number> = { graduated: 0, 'code-shifted': 0, 'cap-eviction': 0 };
  let totalRetired = 0;
  let touchedNodes = 0;
  for (const r of results) {
    if (r.retired.length === 0) continue;
    touchedNodes++;
    print(`\n${nodeOf(r.file)}:\n`);
    for (const t of r.retired) {
      counts[t.reason]++;
      totalRetired++;
      print(`  retire ${t.sig}  (recurrence ${t.recurrence}, ${t.reason})\n`);
    }
    print(`  kept ${r.keptSigs.length} lesson(s)\n`);
  }

  const verb = args.apply ? 'retired' : 'would retire';
  print(
    `\ncompact: ${verb} ${totalRetired} lesson(s) across ${touchedNodes} node(s) ` +
      `(${counts.graduated} graduated, ${counts['code-shifted']} code-shifted, ${counts['cap-eviction']} cap-eviction)\n`,
  );
  if (!args.apply && totalRetired > 0) print(`(dry-run — re-run with --apply to write)\n`);
}
