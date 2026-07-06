// `piflowctl runs [--node <id>] [--status ok|error] [--since <days|ISO>] [--json]` — the CROSS-RUN summary the
// single-run `status <rundir>` never offered (docs/specs/optimize-substrate-plan.md §M5.4). A top-level verb
// (registered like `blueprint`), it rides the SAME runs-home scan as `optimize triage --topk` (one shared
// helper, `runs-scan.ts` — never duplicated), reads each run.json, and filters `--node` (the node executed
// fresh) / `--status` (the run's overall outcome) / `--since`. CHILD runs (optimize-substrate's replay-from-
// node-start) render INDENTED under their parent — lineage is carried in the name + the run.json `parent` field.

import { scanRunsHome, nodeRanFresh, runLevelStatus, type RunSummary, type ScanRunsHomeDeps } from './runs-scan.js';
import { resolveTemplateDir, runsHomeFor, type ResolveTemplateOpts } from './optimize-substrate.js';

export interface RunsArgs {
  node?: string;
  status?: 'ok' | 'error';
  since?: string; // <days> (a number ⇒ that many days ago) OR an ISO date string
  json: boolean;
  template?: string;
}

export function parseRunsArgs(argv: string[]): RunsArgs {
  const out: RunsArgs = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--node') out.node = argv[++i];
    else if (k === '--status') { const v = argv[++i]; if (v === 'ok' || v === 'error') out.status = v; }
    else if (k === '--since') out.since = argv[++i];
    else if (k === '--json') out.json = true;
    else if (k === '--template') out.template = argv[++i];
  }
  return out;
}

/** Parse a `--since` value → the earliest `startedAt` to include. A finite NUMBER ⇒ that many days ago; else an
 *  ISO date string (`new Date`). Returns null on an unparseable value (⇒ no `--since` filter). */
export function parseSince(value: string, now: Date = new Date()): Date | null {
  const n = Number(value);
  if (Number.isFinite(n)) return new Date(now.getTime() - n * 86_400_000);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The injectable seam — defaults are the real fs/core scan + template resolution. */
export interface RunsDeps {
  print?: (s: string) => void;
  printErr?: (s: string) => void;
  cwd?: string;
  /** pin the runs home directly (tests); else derived from the resolved template. */
  runsHome?: string;
  resolveTemplate?: (opts: ResolveTemplateOpts) => string;
  scan?: ScanRunsHomeDeps;
  now?: Date;
}

const stdout = (s: string): void => void process.stdout.write(s + '\n');
const stderr = (s: string): void => void process.stderr.write(s + '\n');

/** One rendered run row (the JSON shape + the per-line fields). */
interface RunRow {
  id: string;
  status: 'ok' | 'error' | 'running';
  startedAt: string;
  parent: string | null;
  spawnedBy: { by: string; issue?: string; issueId?: string } | null;
}

function toRow(s: RunSummary): RunRow {
  return {
    id: s.id,
    status: runLevelStatus(s.status),
    startedAt: s.status.startedAt,
    parent: s.status.parent ?? null,
    spawnedBy: s.status.spawnedBy ?? null,
  };
}

/**
 * Render the filtered runs as a parent→child TREE: roots (no parent, or a parent NOT in the filtered set) at
 * depth 0, each child INDENTED under its parent (recursively), both ordered newest-first (the scan's order is
 * preserved). A child whose parent was filtered out is promoted to a root so it is never dropped.
 */
function renderTree(summaries: RunSummary[], print: (s: string) => void): void {
  const present = new Set(summaries.map((s) => s.id));
  const childrenOf = new Map<string, RunSummary[]>();
  const roots: RunSummary[] = [];
  for (const s of summaries) {
    const parent = s.status.parent;
    if (parent && present.has(parent)) {
      const arr = childrenOf.get(parent) ?? [];
      arr.push(s);
      childrenOf.set(parent, arr);
    } else {
      roots.push(s);
    }
  }
  const line = (s: RunSummary, depth: number): void => {
    const row = toRow(s);
    const attribution = row.spawnedBy?.issue ? ` ← ${row.spawnedBy.by}:${row.spawnedBy.issue}` : row.spawnedBy ? ` ← ${row.spawnedBy.by}` : '';
    print(`${'  '.repeat(depth)}${row.id}  [${row.status}]  ${row.startedAt}${attribution}`);
    for (const child of childrenOf.get(s.id) ?? []) line(child, depth + 1);
  };
  for (const r of roots) line(r, 0);
}

/**
 * `piflowctl runs [--node <id>] [--status ok|error] [--since <days|ISO>] [--json]`. Returns the exit code
 * (0 ok; 1 on an unresolvable template). Read-only.
 */
export async function runRunsCli(argv: string[], deps: RunsDeps = {}): Promise<number> {
  const a = parseRunsArgs(argv);
  const print = deps.print ?? stdout;
  const printErr = deps.printErr ?? stderr;

  let runsHome: string;
  if (deps.runsHome) {
    runsHome = deps.runsHome;
  } else {
    try {
      runsHome = runsHomeFor((deps.resolveTemplate ?? resolveTemplateDir)({ ...(a.node ? { node: a.node } : {}), ...(a.template ? { template: a.template } : {}), cwd: deps.cwd }));
    } catch (e) {
      printErr(`piflowctl runs: ${(e as Error).message}`);
      return 1;
    }
  }

  const summaries = await scanRunsHome(runsHome, deps.scan); // newest-first
  const since = a.since ? parseSince(a.since, deps.now) : null;
  const filtered = summaries.filter((s) => {
    if (a.node && !nodeRanFresh(s.status, a.node)) return false;
    if (a.status && runLevelStatus(s.status) !== a.status) return false;
    if (since && new Date(s.status.startedAt) < since) return false;
    return true;
  });

  if (a.json) {
    print(JSON.stringify(filtered.map(toRow), null, 2));
    return 0;
  }
  if (filtered.length === 0) {
    print('(no runs match)');
    return 0;
  }
  renderTree(filtered, print);
  return 0;
}
