// `piflowctl issues <list | show <name>>` — the READ-ONLY query over the optimize-substrate issue ledger
// (docs/specs/optimize-substrate-plan.md §M5.3). A top-level verb (registered like `blueprint`), NOT part of
// the run-status payload: the ledger is node-TYPE-scoped and durable, so it is read on demand off the template,
// never threaded through a 3s-polled run.json. `list` prints the ledger (severity-desc, then firstSeen-asc —
// the SAME order fix selection consumes; severity is consumed here, not write-only); `show <name>` dumps one
// issue file. `--json` for agents, a table for humans.

import { promises as fs } from 'node:fs';
import { listIssues, type IssueRecord } from '@piflow/core';
import { resolveTemplateDir, type ResolveTemplateOpts } from './optimize-substrate.js';

export interface IssuesArgs {
  /** list | show (defaults to list; a leading flag ⇒ list). */
  sub: 'list' | 'show';
  /** the issue NAME for `show`. */
  name?: string;
  node?: string;
  status?: string; // csv of Status values
  json: boolean;
  template?: string;
}

export function parseIssuesArgs(argv: string[]): IssuesArgs {
  const [subRaw, ...tail] = argv;
  const hasSub = subRaw === 'list' || subRaw === 'show';
  const rest = hasSub ? tail : argv;
  const out: IssuesArgs = { sub: subRaw === 'show' ? 'show' : 'list', json: false };
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (k === '--node') out.node = rest[++i];
    else if (k === '--status') out.status = rest[++i];
    else if (k === '--json') out.json = true;
    else if (k === '--template') out.template = rest[++i];
    else if (!k.startsWith('-') && out.sub === 'show' && out.name === undefined) out.name = k; // the `show <name>` positional
  }
  return out;
}

/** The injectable seam — defaults are real core/fs; a test pins the templateDir + listIssues. */
export interface IssuesDeps {
  print?: (s: string) => void;
  printErr?: (s: string) => void;
  cwd?: string;
  resolveTemplate?: (opts: ResolveTemplateOpts) => string;
  listIssues?: typeof listIssues;
}

const stdout = (s: string): void => void process.stdout.write(s + '\n');
const stderr = (s: string): void => void process.stderr.write(s + '\n');

/** A compact fixed-width table (humans). Columns: node · name · severity · status · firstSeen · title. */
function renderTable(records: IssueRecord[]): string {
  const rows = records.map((r) => [r.node, r.issue.name, r.issue.severity, r.issue.status, r.issue.firstSeen, r.issue.title]);
  const header = ['NODE', 'NAME', 'SEVERITY', 'STATUS', 'FIRSTSEEN', 'TITLE'];
  const all = [header, ...rows];
  const widths = header.map((_, c) => Math.max(...all.map((row) => String(row[c] ?? '').length)));
  return all.map((row) => row.map((cell, c) => (c === row.length - 1 ? String(cell) : String(cell ?? '').padEnd(widths[c]))).join('  ')).join('\n');
}

/** The JSON row shape (agents) — the node + the parsed Issue + its file path. */
function jsonRow(r: IssueRecord): { node: string; file: string; issue: IssueRecord['issue'] } {
  return { node: r.node, file: r.file, issue: r.issue };
}

/**
 * `piflowctl issues <list | show <name>> [--node <id>] [--status <csv>] [--json]`. Returns the process exit code
 * (0 ok; 1 on a `show` miss / an unresolvable template). Read-only — never mutates the ledger.
 */
export async function runIssuesCli(argv: string[], deps: IssuesDeps = {}): Promise<number> {
  const a = parseIssuesArgs(argv);
  const print = deps.print ?? stdout;
  const printErr = deps.printErr ?? stderr;
  const list = deps.listIssues ?? listIssues;

  let templateDir: string;
  try {
    templateDir = (deps.resolveTemplate ?? resolveTemplateDir)({ ...(a.node ? { node: a.node } : {}), ...(a.template ? { template: a.template } : {}), cwd: deps.cwd });
  } catch (e) {
    printErr(`piflowctl issues: ${(e as Error).message}`);
    return 1;
  }

  const statusFilter = a.status ? (a.status.split(',').map((s) => s.trim()).filter(Boolean) as IssueRecord['issue']['status'][]) : undefined;
  const records = await list(templateDir, { ...(a.node ? { node: a.node } : {}), ...(statusFilter ? { status: statusFilter } : {}) });

  if (a.sub === 'show') {
    if (!a.name) {
      printErr('piflowctl issues show <name> — an issue name is required (see: piflowctl issues list).');
      return 1;
    }
    const hit = records.find((r) => r.issue.name === a.name);
    if (!hit) {
      printErr(`piflowctl issues show: no issue "${a.name}"${a.node ? ` for node "${a.node}"` : ''} (never invent one — list the ledger).`);
      return 1;
    }
    if (a.json) {
      print(JSON.stringify(jsonRow(hit), null, 2));
    } else {
      print(await fs.readFile(hit.file, 'utf8')); // the full issue file verbatim (frontmatter + context brief)
    }
    return 0;
  }

  // list
  if (a.json) {
    print(JSON.stringify(records.map(jsonRow), null, 2));
    return 0;
  }
  if (records.length === 0) {
    print(`(no issues${a.node ? ` for node "${a.node}"` : ''}${statusFilter ? ` with status ${statusFilter.join('|')}` : ''})`);
    return 0;
  }
  print(renderTable(records));
  return 0;
}
