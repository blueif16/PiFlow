// The OPTIMIZE-SUBSTRATE CLI verbs (docs/specs/optimize-substrate-plan.md §M5) — the per-node measurement →
// issue-decomposition → per-issue-fix pipeline surfaced under `piflowctl optimize <subverb>`:
//
//   piflowctl optimize triage --node <id> [--run <id> | --topk K]     # phase 1: measure THEN judge
//   piflowctl optimize fix    --node <id> [--issue <name> | --status open,regressed] [--watch]
//   piflowctl optimize        --node <id> [--run <id> | --topk K]     # both phases (the bare-`--node` full loop)
//   piflowctl optimize adopt  --manifest <path>                       # land a staged substrate manifest (human step)
//
// DISPATCH (routeOptimize) is a PURE decision extracted from cli.ts so it is unit-tested directly (the plan's
// M5.1 table): the substrate SUBVERBS win FIRST — each GATED on `--node` (or `--manifest` for adopt) so a
// classic run literally NAMED `triage`/`fix` never misroutes — then the classic `--rounds/--adopt/--fix` flag
// paths (byte-unchanged), then the bare-`--node` full loop, then the classic `optimize <rundir>` fallthrough.
//
// Every stage that spawns an agent (measure's run-ops, the judge turn, the fixer turn, the prove-rerun) is an
// INJECTED seam defaulting to the real `@piflow/core` function — so the whole surface is unit-tested with
// fakes, no live claude/pi (the M7 live demo is what proves real agent behaviour). Runs process SEQUENTIALLY:
// each triaged/fixed run spawns an agent, so sequential keeps the output legible and avoids concurrent spawns
// (the plan leaves this to the implementer; independent runs make Promise.all safe, but legibility wins here).

import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import {
  runSubstrateMeasure, runSubstrateJudge, fixIssue, adoptSubstrateManifest, listIssues, renderSubstrateEvent,
  type SubstrateEvent, type FixIssueResult, type IssueRecord, type Status, type SubstrateManifest,
} from '@piflow/core';
import { resolveNodeRunDir } from './node.js';
import { templateDirFor } from './optimize-fix.js';
import { scanRunsHome, nodeRanFresh, parseNodeRef, type ScanRunsHomeDeps, type NodeRef } from './runs-scan.js';

// ── dispatch routing (the M5.1 table, pure + testable) ──────────────────────────────────────────────────────

/** Which handler `piflowctl optimize <rest…>` routes to. `classic-*` = the shipped routing loop, byte-unchanged. */
export type OptimizeRoute =
  | 'substrate-triage' | 'substrate-fix' | 'substrate-adopt' | 'substrate-full'
  | 'classic-rounds' | 'classic-adopt' | 'classic-fix' | 'classic';

/** Value-taking flags across BOTH the substrate + classic optimize surfaces — so `firstPositional` can tell a
 *  flag's VALUE apart from a bare `<rundir>` positional (the discriminator between the full-loop and classic). */
const OPTIMIZE_VALUE_FLAGS = new Set([
  '--archetype', '--node', '--run', '--topk', '--template', '--workspace', '--cap', '--tolerance',
  '--tier', '--model', '--status', '--issue', '--staging-dir', '--backup-dir', '--manifest', '--since',
  '--edit-budget', '--token-budget', '--fix-cycle-ceiling', '--binding',
]);

/** The FIRST bare positional (a `<rundir>`) in `argv`, skipping every `--flag` and its consumed value, or
 *  undefined when there is none. This is how the dispatcher tells `optimize <rundir>` (classic) from
 *  `optimize --node <id>` (the substrate full loop) — the classic verbs always carry the rundir positionally. */
export function firstPositional(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      if (OPTIMIZE_VALUE_FLAGS.has(a)) i++; // this flag consumes the next token as its value
      continue;
    }
    if (a.startsWith('-')) continue; // a short flag
    return a;
  }
  return undefined;
}

/**
 * Route `piflowctl optimize <rest…>` to its handler (M5.1). Subverbs FIRST, each gated so a classic invocation
 * can never trip them; then the classic flag paths UNCHANGED; then the bare-`--node` full loop; else classic.
 * PURE — cli.ts calls this then dispatches, and the routing table is unit-tested here directly.
 */
export function routeOptimize(rest: string[]): OptimizeRoute {
  if (rest[0] === 'triage' && rest.includes('--node')) return 'substrate-triage';
  if (rest[0] === 'fix' && rest.includes('--node')) return 'substrate-fix';
  if (rest[0] === 'adopt' && rest.includes('--manifest')) return 'substrate-adopt';
  if (rest.includes('--rounds')) return 'classic-rounds';
  if (rest.includes('--adopt')) return 'classic-adopt';
  if (rest.includes('--fix')) return 'classic-fix';
  if (firstPositional(rest) === undefined && rest.includes('--node')) return 'substrate-full';
  return 'classic';
}

// ── template / runs-home resolution (the existing CLI conventions) ──────────────────────────────────────────

/** `.piflow/<wf>/template` → its sibling `.piflow/<wf>/runs` (mirrors run.ts:518); a loose template → `../runs`. */
export function runsHomeFor(templateDir: string): string {
  const tdir = path.resolve(templateDir);
  return path.basename(tdir) === 'template' ? path.join(path.dirname(tdir), 'runs') : path.join(tdir, '..', 'runs');
}

/** Every `<cwd>/.piflow/<wf>/template` dir that exists (a project may host several workflows). [] if none. */
function discoverTemplates(cwd: string): string[] {
  const piflow = path.join(cwd, '.piflow');
  let wfs: string[];
  try {
    wfs = readdirSync(piflow, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  return wfs.map((wf) => path.join(piflow, wf, 'template')).filter((t) => existsSync(t));
}

export interface ResolveTemplateOpts {
  /** the node the verb operates on (disambiguates WHICH workflow when a project hosts several). */
  node?: string;
  /** explicit `--template <dir>` — always wins. */
  template?: string;
  /** `--run <id>` — resolves the run dir, then its `…/template` (templateDirFor). */
  run?: string;
  cwd?: string;
}

/**
 * Resolve the product template dir a substrate verb works against, following the existing CLI conventions:
 * `--template` (explicit) > `--run` (→ the run's `…/template`) > discovery under `<cwd>/.piflow/<wf>/template`
 * (the one holding `nodes/<node>` when `node` is given, else the sole workflow). Throws an actionable error
 * when it cannot resolve one (never guesses).
 */
export function resolveTemplateDir(opts: ResolveTemplateOpts): string {
  const cwd = opts.cwd ?? process.cwd();
  if (opts.template) return path.resolve(cwd, opts.template);
  if (opts.run) return templateDirFor(resolveNodeRunDir({ run: opts.run, cwd }));
  const templates = discoverTemplates(cwd);
  if (opts.node) {
    const hit = templates.find((t) => existsSync(path.join(t, 'nodes', opts.node!, 'node.json')));
    if (hit) return hit;
  } else if (templates.length === 1) {
    return templates[0];
  }
  const forNode = opts.node ? ` holding nodes/${opts.node}/` : '';
  throw new Error(
    `piflowctl optimize: could not resolve a template${forNode} — pass --template <dir>, or run from a project with .piflow/<wf>/template${forNode}.`,
  );
}

/** `{ templateDir, runsHome }` for a node-scoped substrate verb (resolveTemplateDir + its sibling runs home). */
export function resolveSubstrateScope(opts: ResolveTemplateOpts): { templateDir: string; runsHome: string } {
  const templateDir = resolveTemplateDir(opts);
  return { templateDir, runsHome: runsHomeFor(templateDir) };
}

/** `<runDir>/optimize/substrate/triaged.<node>.json` — the marker the judge stamps for a triaged (run, node). */
export function triagedMarker(runDir: string, node: string): string {
  return path.join(runDir, 'optimize', 'substrate', `triaged.${node}.json`);
}

// ── arg parsing ─────────────────────────────────────────────────────────────────────────────────────────────

export interface SubstrateTriageArgs {
  node: string;
  run?: string;
  topk: number;
  template?: string;
  workspace?: string;
  tier?: string;
  model?: string;
  cap?: number;
}

export function parseSubstrateTriageArgs(argv: string[]): SubstrateTriageArgs {
  const out: SubstrateTriageArgs = { node: '', topk: 1 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--node') out.node = argv[++i] ?? '';
    else if (k === '--run') out.run = argv[++i];
    else if (k === '--topk') out.topk = Math.max(1, Number(argv[++i]) || 1);
    else if (k === '--template') out.template = argv[++i];
    else if (k === '--workspace') out.workspace = argv[++i];
    else if (k === '--tier') out.tier = argv[++i];
    else if (k === '--model') out.model = argv[++i];
    else if (k === '--cap') out.cap = Number(argv[++i]);
    // unknown flags/tokens are ignored (the full loop feeds this parser fix-only flags too).
  }
  return out;
}

/** Per-pass cap on issues one `fix` pass processes (config-with-defaults; overridable via `--cap`). */
export const DEFAULT_FIX_CAP = 5;

export interface SubstrateFixArgs {
  node: string;
  run?: string;
  issue?: string;
  status: string; // csv of Status values; default open,regressed
  template?: string;
  workspace?: string;
  watch: boolean;
  watchJson: boolean;
  cap: number;
  prove: boolean;
  tier?: string;
  model?: string;
  tolerance?: number;
  stagingDir?: string;
}

export function parseSubstrateFixArgs(argv: string[]): SubstrateFixArgs {
  const out: SubstrateFixArgs = { node: '', status: 'open,regressed', watch: false, watchJson: false, cap: DEFAULT_FIX_CAP, prove: true };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--node') out.node = argv[++i] ?? '';
    else if (k === '--run') out.run = argv[++i];
    else if (k === '--issue') out.issue = argv[++i];
    else if (k === '--status') out.status = argv[++i] ?? out.status;
    else if (k === '--template') out.template = argv[++i];
    else if (k === '--workspace') out.workspace = argv[++i];
    else if (k === '--watch') out.watch = true;
    else if (k === '--watch-json') { out.watch = true; out.watchJson = true; }
    else if (k === '--cap') out.cap = Math.max(1, Number(argv[++i]) || DEFAULT_FIX_CAP);
    else if (k === '--no-prove') out.prove = false;
    else if (k === '--tier') out.tier = argv[++i];
    else if (k === '--model') out.model = argv[++i];
    else if (k === '--tolerance') out.tolerance = Number(argv[++i]);
    else if (k === '--staging-dir') out.stagingDir = argv[++i];
    // unknown flags/tokens ignored (the full loop feeds this parser triage-only flags too).
  }
  return out;
}

export interface SubstrateAdoptArgs {
  manifest: string;
  template?: string;
  backupDir?: string;
  watch: boolean;
  watchJson: boolean;
}

export function parseSubstrateAdoptArgs(argv: string[]): SubstrateAdoptArgs {
  const out: SubstrateAdoptArgs = { manifest: '', watch: false, watchJson: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--manifest') out.manifest = argv[++i] ?? '';
    else if (k === '--template') out.template = argv[++i];
    else if (k === '--backup-dir') out.backupDir = argv[++i];
    else if (k === '--watch') out.watch = true;
    else if (k === '--watch-json') { out.watch = true; out.watchJson = true; }
  }
  return out;
}

// ── dotted --node <run>.<node> resolution (parseNodeRef, runs-scan.ts) ──────────────────────────────────────

/** The bare node id encoded in a `--node` value that MAY be a dotted `<run>.<node>` reference — segment 1
 *  (node ids never contain dots; this is a plain string split, no fs access, so it is safe to compute BEFORE
 *  `resolveScope` even needs a runs home). A dot-free value passes through unchanged. */
function bareNodeId(nodeArg: string): string {
  return nodeArg.includes('.') ? (nodeArg.split('.')[1] ?? nodeArg) : nodeArg;
}

/**
 * Reconcile a possibly-dotted `--node` value with an optional EXPLICIT `--run`, once `runsHome` is known
 * (`resolveScope` already ran on the bare node id — see `bareNodeId`). A dotted ref pins a run exactly like
 * `--run` would (`parseNodeRef`); an explicit `--run` that DISAGREES with the ref's run is a contradiction
 * (clear error); agreeing — or omitting `--run` altogether — is fine, and the ref's run becomes the effective
 * pin. A plain (dot-free) node is a no-op passthrough (the explicit `--run`, if any, is untouched).
 */
export function resolveNodeAndRun(nodeArg: string, explicitRun: string | undefined, runsHome: string): NodeRef {
  const ref = parseNodeRef(nodeArg, runsHome);
  if (ref.run && explicitRun && ref.run !== explicitRun) {
    throw new Error(
      `piflowctl optimize: --node "${nodeArg}" pins run "${ref.run}", but --run "${explicitRun}" was also given ` +
      `and they disagree — pass one, or make them agree.`,
    );
  }
  return { node: ref.node, run: ref.run ?? explicitRun };
}

// ── shared deps + tiny helpers ──────────────────────────────────────────────────────────────────────────────

/** The injectable seam shared by the substrate verbs — every default is the real core/fs; a test passes fakes
 *  so nothing live-spawns (the M7 demo proves real agents). */
export interface SubstrateCliDeps {
  print?: (s: string) => void;
  printErr?: (s: string) => void;
  cwd?: string;
  /** override scope resolution (tests pin templateDir + runsHome directly). */
  resolveScope?: (opts: ResolveTemplateOpts) => { templateDir: string; runsHome: string };
  /** resolve a `--run <id>` to a run dir. Default `resolveNodeRunDir`. */
  resolveRunDir?: (run: string, cwd?: string) => string;
  /** the runs-home scan seam (fs/core). */
  scan?: ScanRunsHomeDeps;
  measure?: typeof runSubstrateMeasure;
  judge?: typeof runSubstrateJudge;
  listIssues?: typeof listIssues;
  fixIssue?: typeof fixIssue;
  adoptManifest?: typeof adoptSubstrateManifest;
}

const stdout = (s: string): void => void process.stdout.write(s + '\n');
const stderr = (s: string): void => void process.stderr.write(s + '\n');

/** Build the `--watch`/`--watch-json` SubstrateEvent sink (human render vs raw JSONL), or undefined when off —
 *  the exact rendering split optimize-fix.ts uses for OptimizeEvent, reused here for SubstrateEvent. */
function watchSink(watch: boolean, watchJson: boolean, print: (s: string) => void): ((e: SubstrateEvent) => void) | undefined {
  if (!watch) return undefined;
  return (e) => print(watchJson ? JSON.stringify(e) : renderSubstrateEvent(e));
}

// ── triage (measure THEN judge; hard-feeds-soft is this verb's OWN contract) ─────────────────────────────────

/** Select the run dir(s) to triage: `--run` pins ONE exact run (bypassing the marker — reproducible demos);
 *  else the newest `--topk K` runs where the node ran fresh AND lacks the triaged marker (recency scan). */
async function selectTriageRuns(
  a: SubstrateTriageArgs,
  runsHome: string,
  deps: SubstrateCliDeps,
): Promise<string[]> {
  if (a.run) {
    const resolve = deps.resolveRunDir ?? ((run, cwd) => resolveNodeRunDir({ run, cwd }));
    return [resolve(a.run, deps.cwd)];
  }
  const summaries = await scanRunsHome(runsHome, deps.scan); // newest-first
  const fresh = summaries.filter((s) => nodeRanFresh(s.status, a.node) && !existsSync(triagedMarker(s.runDir, a.node)));
  return fresh.slice(0, a.topk).map((s) => s.runDir);
}

/**
 * `piflowctl optimize triage --node <id> [--run <id> | --topk K]` — phase 1 only. For each selected run:
 * `runSubstrateMeasure` FIRST (persisting `measure.<node>.json`), THEN `runSubstrateJudge` — hard-feeds-soft is
 * THIS verb's contract, not an ambient assumption (M4.2). Runs process sequentially. Returns nothing; prints a
 * per-run summary. A missing `--node` exits 2.
 */
export async function runSubstrateTriageCli(argv: string[], deps: SubstrateCliDeps = {}): Promise<void> {
  const a = parseSubstrateTriageArgs(argv);
  const print = deps.print ?? stdout;
  const printErr = deps.printErr ?? stderr;
  if (!a.node) {
    printErr('piflowctl optimize triage: --node <id> is required (the node TYPE to triage).');
    process.exitCode = 2;
    return;
  }
  const dottedNode = a.node.includes('.');
  let templateDir: string;
  let runsHome: string;
  try {
    ({ templateDir, runsHome } = (deps.resolveScope ?? resolveSubstrateScope)({ node: bareNodeId(a.node), template: a.template, run: a.run, cwd: deps.cwd }));
    if (dottedNode) {
      const ref = resolveNodeAndRun(a.node, a.run, runsHome);
      a.node = ref.node;
      a.run = ref.run;
    }
  } catch (e) {
    printErr((e as Error).message);
    process.exitCode = 2;
    return;
  }
  const workspace = a.workspace ? path.resolve(deps.cwd ?? process.cwd(), a.workspace) : (deps.cwd ?? process.cwd());
  const measure = deps.measure ?? runSubstrateMeasure;
  const judge = deps.judge ?? runSubstrateJudge;

  const runDirs = await selectTriageRuns(a, runsHome, deps);
  if (runDirs.length === 0) {
    print(`optimize triage: no fresh, un-triaged run found for node "${a.node}" (nothing to do).`);
    return;
  }

  for (const runDir of runDirs) {
    await measure(runDir, a.node, { workspace }); // hard measurement FIRST (persists measure.<node>.json)
    const r = await judge(runDir, a.node, {
      workspace, templateDir,
      ...(a.cap !== undefined ? { cap: a.cap } : {}),
      ...(a.tier ? { tier: a.tier } : {}),
      ...(a.model ? { model: a.model } : {}),
    });
    const capNote = r.capped.length ? ` (+${r.capped.length} capped)` : '';
    print(`optimize triage[${path.basename(runDir)}] node=${a.node}: ${r.issues.length} issue(s) touched${capNote}`);
  }
}

// ── fix (select issues → per-issue fixIssue → stage; adopt is separate) ──────────────────────────────────────

/** The parent run the fix replays a node of (spawnChildRun) + reads the base graded metrics from: `--run`
 *  pins it; else the NEWEST run bearing this node's triaged marker (the run we most recently triaged). */
async function resolveParentRun(a: SubstrateFixArgs, runsHome: string, deps: SubstrateCliDeps): Promise<string | undefined> {
  if (a.run) {
    const resolve = deps.resolveRunDir ?? ((run, cwd) => resolveNodeRunDir({ run, cwd }));
    return resolve(a.run, deps.cwd);
  }
  const summaries = await scanRunsHome(runsHome, deps.scan); // newest-first
  return summaries.find((s) => existsSync(triagedMarker(s.runDir, a.node)))?.runDir;
}

/** Select the issues this pass fixes: `--issue <name>` (one) OR `--status <csv>` (default open,regressed) from
 *  `listIssues` (already severity-desc, firstSeen-asc), capped at `--cap`. */
async function selectFixIssues(a: SubstrateFixArgs, templateDir: string, deps: SubstrateCliDeps): Promise<{ records: IssueRecord[]; total: number } | { error: string }> {
  const list = deps.listIssues ?? listIssues;
  if (a.issue) {
    const all = await list(templateDir, { node: a.node });
    const hit = all.filter((r) => r.issue.name === a.issue);
    if (hit.length === 0) return { error: `no issue named "${a.issue}" for node "${a.node}" (see: piflowctl issues --node ${a.node}).` };
    return { records: hit, total: hit.length };
  }
  const statuses = a.status.split(',').map((s) => s.trim()).filter(Boolean) as Status[];
  const records = await list(templateDir, { node: a.node, status: statuses });
  return { records: records.slice(0, a.cap), total: records.length };
}

/**
 * `piflowctl optimize fix --node <id> [--issue <name> | --status open,regressed] [--watch]` — select the issues
 * (severity-desc, firstSeen-asc, capped at `--cap`), then `fixIssue` each SEQUENTIALLY against the parent run
 * (`--run` or the newest triaged run). `--watch` streams each SubstrateEvent (`--watch-json` = raw JSONL).
 * Stages a manifest per issue; ADOPT is the separate `optimize adopt` step. Missing `--node`/parent run exits 2.
 */
export async function runSubstrateFixCli(argv: string[], deps: SubstrateCliDeps = {}): Promise<void> {
  const a = parseSubstrateFixArgs(argv);
  const print = deps.print ?? stdout;
  const printErr = deps.printErr ?? stderr;
  if (!a.node) {
    printErr('piflowctl optimize fix: --node <id> is required (the node TYPE whose issues to fix).');
    process.exitCode = 2;
    return;
  }
  const dottedNode = a.node.includes('.');
  let templateDir: string;
  let runsHome: string;
  try {
    ({ templateDir, runsHome } = (deps.resolveScope ?? resolveSubstrateScope)({ node: bareNodeId(a.node), template: a.template, run: a.run, cwd: deps.cwd }));
    if (dottedNode) {
      const ref = resolveNodeAndRun(a.node, a.run, runsHome);
      a.node = ref.node;
      a.run = ref.run;
    }
  } catch (e) {
    printErr((e as Error).message);
    process.exitCode = 2;
    return;
  }
  const workspace = a.workspace ? path.resolve(deps.cwd ?? process.cwd(), a.workspace) : (deps.cwd ?? process.cwd());

  const parentRunDir = await resolveParentRun(a, runsHome, deps);
  if (!parentRunDir) {
    printErr(`piflowctl optimize fix: no triaged run found for node "${a.node}" — run 'piflowctl optimize triage --node ${a.node}' first, or pass --run <id>.`);
    process.exitCode = 2;
    return;
  }

  const selection = await selectFixIssues(a, templateDir, deps);
  if ('error' in selection) {
    printErr(`piflowctl optimize fix: ${selection.error}`);
    process.exitCode = 2;
    return;
  }
  const { records, total } = selection;
  if (records.length === 0) {
    print(`optimize fix: no ${a.issue ? `issue "${a.issue}"` : `open|regressed issue`} to fix for node "${a.node}".`);
    return;
  }

  const onEvent = watchSink(a.watch, a.watchJson, print);
  const fix = deps.fixIssue ?? fixIssue;
  let staged = 0;
  let discarded = 0;
  for (const rec of records) {
    const res: FixIssueResult = await fix(rec.file, {
      parentRunDir, templateDir, workspace,
      prove: a.prove,
      ...(onEvent ? { onEvent } : {}),
      ...(a.tolerance !== undefined ? { tolerance: a.tolerance } : {}),
      ...(a.stagingDir ? { stagingDir: path.resolve(deps.cwd ?? process.cwd(), a.stagingDir) } : {}),
      ...(a.tier ? { tier: a.tier } : {}),
      ...(a.model ? { model: a.model } : {}),
    });
    if (res.decision === 'staged') staged++;
    else discarded++;
  }
  const left = total - records.length;
  const leftNote = left > 0 ? ` (${left} left by --cap ${a.cap})` : '';
  print(`optimize fix: node=${a.node} — ${records.length} issue(s) processed, ${staged} staged, ${discarded} discarded${leftNote}; adopt is a separate step.`);
}

// ── full loop (bare `--node`) = triage THEN fix with the default selector ────────────────────────────────────

/**
 * `piflowctl optimize --node <id> [--run <id> | --topk K]` — the LOCKED default: run the triage pass, then fix
 * EVERY resulting open|regressed issue (the default fix selector), under the per-pass cap. Both phases share the
 * same argv (each parser ignores the other's flags) + the same injected seams.
 */
export async function runSubstrateFullLoopCli(argv: string[], deps: SubstrateCliDeps = {}): Promise<void> {
  await runSubstrateTriageCli(argv, deps);
  await runSubstrateFixCli(argv, deps);
}

// ── adopt (land a staged substrate manifest — the human step wrapping adoptSubstrateManifest) ────────────────
// PLAN DELTA: the plan under-specified the substrate adopt spelling. Chosen: `optimize adopt --manifest <path>`
// — a POSITIONAL subverb (`adopt`) + a `--manifest` flag, so it is disjoint from the classic `optimize --adopt
// <manifest>` FLAG path (which routes to runOptimizeAdoptCli, byte-unchanged). `--manifest` is required so the
// subverb only ever fires on the intended shape, never on a classic invocation.

/** The template dir for the manifest's issues: `--template` > derived from the canonical manifest path
 *  (`<runDir>/optimize/substrate/staging/manifest.json` → `…/template`) > discovery by the first record's node. */
function resolveAdoptTemplateDir(manifestPath: string, manifest: SubstrateManifest, template: string | undefined, cwd: string): string {
  if (template) return path.resolve(cwd, template);
  // canonical: manifest.json → staging → substrate → optimize → <runDir>; then templateDirFor(<runDir>).
  const canonicalRunDir = path.resolve(path.dirname(manifestPath), '..', '..', '..');
  const canonical = templateDirFor(canonicalRunDir);
  if (existsSync(canonical)) return canonical;
  const node = manifest.records[0]?.node;
  return resolveTemplateDir({ ...(node ? { node } : {}), cwd });
}

/**
 * `piflowctl optimize adopt --manifest <path> [--template <dir>] [--backup-dir <d>] [--watch]` — land every
 * `staged` record of a substrate manifest onto the live product (adoptSubstrateManifest → adoptFile + commit +
 * stampAttempt + status resolved). A missing/malformed manifest exits 2. Prints an adopted/skipped summary.
 */
export async function runSubstrateAdoptCli(argv: string[], deps: SubstrateCliDeps = {}): Promise<void> {
  const a = parseSubstrateAdoptArgs(argv);
  const print = deps.print ?? stdout;
  const printErr = deps.printErr ?? stderr;
  const cwd = deps.cwd ?? process.cwd();
  if (!a.manifest) {
    printErr('piflowctl optimize adopt: --manifest <path> is required (the staged substrate manifest.json to land).');
    process.exitCode = 2;
    return;
  }
  const manifestPath = path.resolve(cwd, a.manifest);
  let manifest: SubstrateManifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as SubstrateManifest;
  } catch (e) {
    printErr(`piflowctl optimize adopt: could not read manifest '${a.manifest}': ${(e as Error).message}`);
    process.exitCode = 2;
    return;
  }
  if (!Array.isArray(manifest?.records)) {
    printErr(`piflowctl optimize adopt: '${a.manifest}' is not a substrate manifest (no records[]).`);
    process.exitCode = 2;
    return;
  }

  let templateDir: string;
  try {
    templateDir = resolveAdoptTemplateDir(manifestPath, manifest, a.template, cwd);
  } catch (e) {
    printErr(`piflowctl optimize adopt: ${(e as Error).message}`);
    process.exitCode = 2;
    return;
  }

  const onEvent = watchSink(a.watch, a.watchJson, print);
  const adopt = deps.adoptManifest ?? adoptSubstrateManifest;
  const result = await adopt(manifest, {
    templateDir,
    ...(a.backupDir ? { backupDir: path.resolve(cwd, a.backupDir) } : {}),
    ...(onEvent ? { onEvent } : {}),
  });
  print(`optimize adopt: ${result.adopted.length} issue(s) landed; ${result.skipped.length} skipped.`);
  for (const ad of result.adopted) print(`  + ${ad.node}/${ad.issue} → ${ad.commit.slice(0, 7)} (${ad.files.length} file(s))`);
  for (const sk of result.skipped) print(`  · skipped ${sk.issue}: ${sk.reason}`);
}
