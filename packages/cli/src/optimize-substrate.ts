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
  runSubstrateMeasure, runSubstrateJudge, fixIssue, fixIssueWithRetries, makeConsecutiveExhaustedBreaker,
  verifyStage, scanRecords, adoptSubstrateManifest, listIssues, renderSubstrateEvent, nodeHasCriteria,
  runBlameMeasure, runBlameJudge, blameDir, blameSummaryPath, parseBlameSummaryTail, deriveNodeOrder,
  type SubstrateEvent, type FixIssueResult, type IssueRecord, type Status, type SubstrateManifest,
  type SubstrateManifestRecord, type VerifyTier, type BlameSummary,
} from '@piflow/core';

/** The valid per-issue verify tiers (WS3) — the `--verify` override guard. */
const VERIFY_TIERS: readonly VerifyTier[] = ['none', 'rerun', 'full'];
import { resolveNodeRunDir } from './node.js';
import { templateDirFor } from './optimize-fix.js';
import { scanRunsHome, nodeRanFresh, parseNodeRef, type ScanRunsHomeDeps, type NodeRef } from './runs-scan.js';

// ── dispatch routing (the M5.1 table, pure + testable) ──────────────────────────────────────────────────────

/** Which handler `piflowctl optimize <rest…>` routes to. `classic-*` = the shipped routing loop, byte-unchanged. */
export type OptimizeRoute =
  | 'substrate-triage' | 'substrate-fix' | 'substrate-verify' | 'substrate-adopt' | 'substrate-full'
  | 'substrate-blame'
  | 'classic-rounds' | 'classic-adopt' | 'classic-fix' | 'classic';

/** Value-taking flags across BOTH the substrate + classic optimize surfaces — so `firstPositional` can tell a
 *  flag's VALUE apart from a bare `<rundir>` positional (the discriminator between the full-loop and classic). */
const OPTIMIZE_VALUE_FLAGS = new Set([
  '--archetype', '--node', '--run', '--topk', '--template', '--workspace', '--cap', '--tolerance',
  '--tier', '--model', '--status', '--issue', '--staging-dir', '--backup-dir', '--manifest', '--since',
  '--edit-budget', '--token-budget', '--fix-cycle-ceiling', '--binding', '--verify',
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
  if (rest[0] === 'verify' && rest.includes('--node')) return 'substrate-verify';
  // adopt is uniform now: `--manifest <path>` (hidden back-compat) OR `--node [--issue]` (the WS2 regrammar).
  if (rest[0] === 'adopt' && (rest.includes('--manifest') || rest.includes('--node'))) return 'substrate-adopt';
  // blame (docs/design/optimize-blame.md WS-B3): unlike triage/fix/verify/adopt, blame has no required companion
  // flag (`--node`/`--manifest`) — its `<run>` positional is itself OPTIONAL (`--latest`/no-positional both
  // resolve to the newest run). So the gate is `rest.length > 1`: a BARE `optimize blame` (nothing else) is
  // indistinguishable from the classic `optimize <rundir>` where the rundir happens to be literally named
  // "blame" — back-compat wins that one case; ANY companion token (a run positional, `--latest`, any flag) picks
  // the subverb. Gated BEFORE the classic `--rounds`/`--adopt`/`--fix` flag checks below (same reason every other
  // substrate subverb is gated first: a classic invocation must never be able to trip a substrate route).
  if (rest[0] === 'blame' && rest.length > 1) return 'substrate-blame';
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

// ── Phase-3 observe hooks: PERSISTENT default `outDir`s for the judge/fixer base-agent spawns, so a triage/fix
// pass's agent run dir reaches the existing observe instruments (`piflowctl telemetry|status|trace <dir>`)
// exactly like a workflow node's run — never the base agent's ephemeral (deleted) default. ─────────────────────

/** The judge spawn's persisted run dir for `(runDir, node)` — one per triaged RUN (never collides: each
 *  selected run in a triage pass already has its own `runDir`). */
export function judgeAgentOutDir(runDir: string, node: string): string {
  return path.join(runDir, 'optimize', 'substrate', 'agents', `judge.${node}`);
}

/** The fixer spawn's persisted run dir for `(parentRunDir, node, issue)` — issue-qualified because a single
 *  `optimize fix` pass may process SEVERAL issues of the same node against the SAME parent run; a node-only
 *  path would have the second fixer spawn silently overwrite the first's observe dir. */
export function fixerAgentOutDir(parentRunDir: string, node: string, issue: string): string {
  return path.join(parentRunDir, 'optimize', 'substrate', 'agents', `fix.${node}.${issue}`);
}

/** The blame judge/verify spawn's PERSISTENT run dir for `runDir` (docs/design/optimize-blame.md §4; mirrors
 *  `judgeAgentOutDir`/`fixerAgentOutDir` above) — one per blamed RUN, never node/issue-qualified: a run's blame
 *  pass is a run-level singleton (both the judge AND verify turns land here, sequentially). */
export function blameAgentOutDir(runDir: string): string {
  return path.join(runDir, 'optimize', 'substrate', 'agents', 'blame');
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
  /** `--dry-run`: measure, then build the judge composition + resolved config and PRINT it — spawn NOTHING.
   *  Inherited from the base agent's preview seam; the same shape any base agent would ingest. */
  dryRun?: boolean;
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
    else if (k === '--dry-run') out.dryRun = true;
    // unknown flags/tokens are ignored (the full loop feeds this parser fix-only flags too).
  }
  return out;
}

/** Per-pass cap on issues one `fix` pass processes (config-with-defaults; overridable via `--cap`). */
export const DEFAULT_FIX_CAP = 5;
/** Outer-loop defaults: the per-issue retry ceiling + the system-wide consecutive-exhausted halt (design §8). */
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BREAKER = 3;

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
  /** `--verify <tier>` (WS3): optional per-pass OVERRIDE of the issue-frontmatter/node-default verify tier
   *  (none|rerun|full). Absent ⇒ the issue/node spine decides per issue. Invalid values are ignored. */
  verify?: VerifyTier;
  /** `--max-attempts N`: the per-issue retry ceiling — the PRIMARY bound of the outer loop (default 3). */
  maxAttempts?: number;
  /** `--breaker N`: system-wide halt after N CONSECUTIVE issues exhaust their retry budget (default 3; 0 = off). */
  breaker?: number;
  /** `--dry-run`: compose the fixer spawn (prompt + jail + skill + config) and PRINT it — spawn/mutate NOTHING
   *  (no issue transition, no candidate copy, no manifest). Inherited from the base agent's preview seam. */
  dryRun?: boolean;
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
    else if (k === '--verify') { const v = argv[++i]; if ((VERIFY_TIERS as readonly string[]).includes(v)) out.verify = v as VerifyTier; }
    else if (k === '--max-attempts') out.maxAttempts = Math.max(1, Number(argv[++i]) || DEFAULT_MAX_ATTEMPTS);
    else if (k === '--breaker') { const n = Number(argv[++i]); out.breaker = Number.isFinite(n) && n >= 0 ? n : DEFAULT_BREAKER; }
    else if (k === '--dry-run') out.dryRun = true;
    // unknown flags/tokens ignored (the full loop feeds this parser triage-only flags too).
  }
  return out;
}

/** `optimize verify --node <id> [--issue <name>] [--run <id>]` — the gate-only verb (WS2.2): re-gate an
 *  existing candidate record (its `candidateSha` + the proved child) with NO fixer and NO re-prove. */
export interface SubstrateVerifyArgs {
  node: string;
  run?: string;
  issue?: string;
  template?: string;
  workspace?: string;
  tier?: string;
  model?: string;
  watch: boolean;
  watchJson: boolean;
}

export function parseSubstrateVerifyArgs(argv: string[]): SubstrateVerifyArgs {
  const out: SubstrateVerifyArgs = { node: '', watch: false, watchJson: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--node') out.node = argv[++i] ?? '';
    else if (k === '--run') out.run = argv[++i];
    else if (k === '--issue') out.issue = argv[++i];
    else if (k === '--template') out.template = argv[++i];
    else if (k === '--workspace') out.workspace = argv[++i];
    else if (k === '--tier') out.tier = argv[++i];
    else if (k === '--model') out.model = argv[++i];
    else if (k === '--watch') out.watch = true;
    else if (k === '--watch-json') { out.watch = true; out.watchJson = true; }
    // unknown flags ignored.
  }
  return out;
}

export interface SubstrateAdoptArgs {
  /** hidden back-compat alias — a staged manifest.json path. The WS2 grammar is `--node [--issue]`. */
  manifest: string;
  node?: string;
  run?: string;
  issue?: string;
  template?: string;
  backupDir?: string;
  /** WS-B5 TRAIN: `--no-gc` ⇒ do NOT delete the throwaway `optimize/<node>/<issue>/*` branches after a land
   *  (default is to GC them; the landed cherry-pick sha in the attempt is the durable record). */
  noGc?: boolean;
  watch: boolean;
  watchJson: boolean;
}

export function parseSubstrateAdoptArgs(argv: string[]): SubstrateAdoptArgs {
  const out: SubstrateAdoptArgs = { manifest: '', watch: false, watchJson: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--manifest') out.manifest = argv[++i] ?? '';
    else if (k === '--node') out.node = argv[++i];
    else if (k === '--run') out.run = argv[++i];
    else if (k === '--issue') out.issue = argv[++i];
    else if (k === '--template') out.template = argv[++i];
    else if (k === '--backup-dir') out.backupDir = argv[++i];
    else if (k === '--no-gc') out.noGc = true;
    else if (k === '--watch') out.watch = true;
    else if (k === '--watch-json') { out.watch = true; out.watchJson = true; }
  }
  return out;
}

/** `optimize blame <run> [--latest] [flags]` (docs/design/optimize-blame.md §4/§10 WS-B3) — the RUN-LEVEL
 *  attribution pass. Unlike the per-node subverbs, `<run>` itself is OPTIONAL: omitting it (or passing
 *  `--latest`) resolves the newest run under the discovered template. */
export interface SubstrateBlameArgs {
  /** the `<run>` positional — a run dir path OR a run id/name (resolveNodeRunDir). Absent ⇒ resolve latest. */
  run?: string;
  /** `--latest` — explicitly resolve the newest run (also the default behaviour when `run` is absent). */
  latest: boolean;
  template?: string;
  workspace?: string;
  tier?: string;
  model?: string;
  /** `--no-verify-round` turns OFF the judge's single §4-step-4 re-check pass. Default `true`. */
  verifyRound: boolean;
  /** `--no-memorize` turns OFF the blame-memorize step (WS-B6). Default `true`. */
  memorize: boolean;
  watch: boolean;
  watchJson: boolean;
  /** `--dry-run`: compose the judge spawn and PRINT it — write/spawn NOTHING (the base agent's preview seam). */
  dryRun?: boolean;
}

export function parseSubstrateBlameArgs(argv: string[]): SubstrateBlameArgs {
  const out: SubstrateBlameArgs = { latest: false, verifyRound: true, memorize: true, watch: false, watchJson: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--latest') out.latest = true;
    else if (k === '--template') out.template = argv[++i];
    else if (k === '--workspace') out.workspace = argv[++i];
    else if (k === '--tier') out.tier = argv[++i];
    else if (k === '--model') out.model = argv[++i];
    else if (k === '--no-verify-round') out.verifyRound = false;
    else if (k === '--no-memorize') out.memorize = false;
    else if (k === '--watch') out.watch = true;
    else if (k === '--watch-json') { out.watch = true; out.watchJson = true; }
    else if (k === '--dry-run') out.dryRun = true;
    else if (!k.startsWith('-') && out.run === undefined) out.run = k; // the ONE positional
    // unknown flags ignored.
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

/**
 * The ONE selector shared by `fix`/`verify`/`adopt` (WS2.3): resolve `(templateDir, runsHome, node, run)` from a
 * possibly-dotted `--node` + an optional `--run`. Resolves the scope on the BARE node id, then reconciles a
 * dotted ref with `--run` (`resolveNodeAndRun`). Throws (caller → exit 2) on an unresolvable scope or a
 * dotted/`--run` contradiction. Each verb layers its OWN eligibility on top (fix: open|regressed issues;
 * verify: records with a candidateSha; adopt: staged records).
 */
export function resolveSubstrateSelector(
  a: { node: string; run?: string; template?: string },
  deps: SubstrateCliDeps,
): { templateDir: string; runsHome: string; node: string; run?: string } {
  const { templateDir, runsHome } = (deps.resolveScope ?? resolveSubstrateScope)({ node: bareNodeId(a.node), template: a.template, run: a.run, cwd: deps.cwd });
  if (a.node.includes('.')) {
    const ref = resolveNodeAndRun(a.node, a.run, runsHome);
    return { templateDir, runsHome, node: ref.node, run: ref.run };
  }
  return { templateDir, runsHome, node: a.node, run: a.run };
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
  verifyStage?: typeof verifyStage;
  adoptManifest?: typeof adoptSubstrateManifest;
  /** the run-level hard-measure fold (WS-B1). Default `runBlameMeasure`. */
  blameMeasure?: typeof runBlameMeasure;
  /** the blame judge + verify round (WS-B2). Default `runBlameJudge`. */
  blameJudge?: typeof runBlameJudge;
  /** blame-memorize into template-root `memory.md` (WS-B6 — NOT YET BUILT). Default `undefined`: the verb works
   *  end-to-end before that lane ships; B6 sets the real default import here, decoupling the two lanes. */
  blameMemorize?: (runDir: string, opts: { templateDir: string; workspace: string; summary: BlameSummary }) => Promise<unknown>;
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
    const outDir = judgeAgentOutDir(runDir, a.node);
    const r = await judge(runDir, a.node, {
      workspace, templateDir,
      outDir, // PERSIST the judge spawn's run dir — never the base agent's ephemeral (deleted) default.
      ...(a.cap !== undefined ? { cap: a.cap } : {}),
      ...(a.tier ? { tier: a.tier } : {}),
      ...(a.model ? { model: a.model } : {}),
      ...(a.dryRun ? { dryRun: true } : {}),
    });
    if (a.dryRun && r.dryRun) {
      printSubstrateDryRun(`optimize triage[${path.basename(runDir)}] node=${a.node}`, r.dryRun, print);
      continue;
    }
    const capNote = r.capped.length ? ` (+${r.capped.length} capped)` : '';
    print(`optimize triage[${path.basename(runDir)}] node=${a.node}: ${r.issues.length} issue(s) touched${capNote}`);
    print(`observe: piflowctl telemetry ${outDir}`);
  }
}

/** Print a substrate DRY-RUN composition — the base agent's composed spec (`plan`): the resolved config
 *  header, then the exact `prompt` (the full ingested context) the agent WOULD receive. Nothing was spawned.
 *  The ONE printer every substrate preview shares (the judge's triage --dry-run AND the fixer's fix --dry-run);
 *  `header` names the verb/target, the plan shape is the base agent's. */
function printSubstrateDryRun(
  header: string,
  plan: {
    executor?: string; skill?: string; tier?: string; model?: string; tools?: unknown; prompt?: string;
    sandbox?: { provider?: string; read?: string[]; write?: string[]; execCwd?: string };
  },
  print: (s: string) => void,
): void {
  const sb = plan.sandbox ?? {};
  print(`${header} — DRY RUN (base-agent preview; nothing spawned)`);
  print(`  executor : ${plan.executor ?? '?'}    skill: ${plan.skill ?? '(none)'}    tier: ${plan.tier ?? '(substrate default)'}${plan.model ? `    model: ${plan.model}` : ''}`);
  print(`  sandbox  : ${sb.provider ?? '(run default)'}`);
  print(`  cwd      : ${sb.execCwd ?? ''}`);
  print(`  readScope: ${(sb.read ?? []).join('  ·  ')}`);
  print(`  owns     : ${(sb.write ?? []).join('  ·  ')}`);
  print(`  tools    : ${JSON.stringify(plan.tools ?? {})}`);
  print(`  ── ingested composition (the exact prompt the agent would receive) ──`);
  print(plan.prompt ?? '(no prompt built)');
}

// ── fix (select issues → per-issue fixIssue → stage; adopt is separate) ──────────────────────────────────────

/** The parent run a node-scoped verb operates on: `--run` pins it; else the NEWEST run bearing this node's
 *  triaged marker (the run we most recently triaged — where its candidate records live). Shared by fix/verify. */
async function resolveParentRun(a: { run?: string; node: string }, runsHome: string, deps: SubstrateCliDeps): Promise<string | undefined> {
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
  let templateDir: string;
  let runsHome: string;
  try {
    const sel = resolveSubstrateSelector(a, deps); // the ONE selector (dotted-ref + scope) shared with verify/adopt
    templateDir = sel.templateDir;
    runsHome = sel.runsHome;
    a.node = sel.node;
    a.run = sel.run;
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
  let escalated = 0;
  let processed = 0;
  let halted = false;
  // The SECOND-level (system-wide) breaker: N consecutive issues exhausting their retry budget ⇒ halt (§8).
  const breaker = makeConsecutiveExhaustedBreaker(a.breaker ?? DEFAULT_BREAKER);

  for (const rec of records) {
    const outDir = fixerAgentOutDir(parentRunDir, a.node, rec.issue.name);
    // The base fix opts every attempt shares (the retry loop adds attemptTag + retry per attempt).
    const fixOpts = {
      parentRunDir, templateDir, workspace,
      prove: a.prove,
      outDir, // PERSIST the fixer spawn's run dir — never the base agent's ephemeral (deleted) default.
      ...(onEvent ? { onEvent } : {}),
      ...(a.tolerance !== undefined ? { tolerance: a.tolerance } : {}),
      ...(a.verify ? { verify: a.verify } : {}), // WS3 per-pass tier override (issue/node spine otherwise)
      ...(a.tier ? { tier: a.tier } : {}),
      ...(a.model ? { model: a.model } : {}),
    };

    // DRY-RUN — a single spawn PREVIEW, never a retry (a preview mutates/decides nothing).
    if (a.dryRun) {
      const res = await fix(rec.file, { ...fixOpts, dryRun: true });
      if (res.dryRun) printSubstrateDryRun(`optimize fix[${path.basename(parentRunDir)}] node=${a.node} issue=${rec.issue.name}`, res.dryRun, print);
      continue;
    }

    // The OUTER loop: bounded, diversifying retries that consume the gate's drop-back (§8). `fixOnce` honors the
    // injected fixIssue seam so a test drives each attempt.
    const res = await fixIssueWithRetries(rec.file, {
      ...fixOpts,
      ...(a.maxAttempts !== undefined ? { maxAttempts: a.maxAttempts } : {}),
      fixOnce: fix,
    });
    processed++;

    if (res.outcome === 'accepted') {
      staged++;
    } else if (res.outcome === 'exhausted') {
      discarded++;
      escalated++;
      print(`optimize fix: issue "${rec.issue.name}" EXHAUSTED after ${res.attempts.length} attempt(s) [${res.stoppedBy}] — escalating (best candidate KEPT, not landed):`);
      for (const opt of res.escalation?.options ?? []) print(`  • ${opt}`);
    } else {
      discarded++; // passthrough — a non-retryable discard (numeric-path / no-edit)
    }
    print(`observe: piflowctl telemetry ${outDir}`);

    if (breaker.record(res.outcome)) {
      printErr(
        `optimize fix: SYSTEM-WIDE BREAKER tripped — ${breaker.streak} consecutive issues exhausted their retry budget. ` +
          `This is an ARCHITECTURE signal (the fixer is too weak, or the issues are framed wrong), not a per-issue miss. ` +
          `Halting; escalate before re-running (raise --breaker to override).`,
      );
      halted = true;
      break;
    }
  }
  if (a.dryRun) return; // a preview processed/staged/discarded nothing — no tally to print.
  const left = total - processed;
  const leftNote = left > 0 ? ` (${left} left${halted ? ' — HALTED by --breaker' : ` by --cap ${a.cap}`})` : '';
  const escNote = escalated > 0 ? `, ${escalated} escalated` : '';
  print(`optimize fix: node=${a.node} — ${processed} issue(s) processed, ${staged} staged, ${discarded} discarded${escNote}${leftNote}; adopt is a separate step.`);
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

// ── verify (WS2.2) — the DECOUPLED gate: re-gate an existing candidate record; NO fixer, NO re-prove ──────────

/** The verify verb's per-issue observe dir for the gate spawn — mirrors the fixer's, keyed by (parent, node, issue). */
export function verifyAgentOutDir(parentRunDir: string, node: string, issue: string): string {
  return path.join(parentRunDir, 'optimize', 'substrate', 'agents', `verify.${node}.${issue}`);
}

/**
 * `piflowctl optimize verify --node <id> [--issue <name>] [--run <id>]` — the gate-only stage (WS2.2). Resolve
 * the candidate record(s) for the node (one via `--issue`, else EVERY record carrying a `candidateSha`) under the
 * scoped run, then run `verifyStage` on each: the independent gate agent judges the already-proved candidate,
 * writes `verdict.json`, and lands the decision. NO fixer, NO re-prove. Prints each verdict; on a reject, prints
 * the drop-back category + steer. Missing `--node`/parent run exits 2.
 */
export async function runSubstrateVerifyCli(argv: string[], deps: SubstrateCliDeps = {}): Promise<void> {
  const a = parseSubstrateVerifyArgs(argv);
  const print = deps.print ?? stdout;
  const printErr = deps.printErr ?? stderr;
  if (!a.node) {
    printErr('piflowctl optimize verify: --node <id> is required (the node TYPE whose candidate to gate).');
    process.exitCode = 2;
    return;
  }
  let templateDir: string;
  let runsHome: string;
  try {
    const sel = resolveSubstrateSelector(a, deps);
    templateDir = sel.templateDir;
    runsHome = sel.runsHome;
    a.node = sel.node;
    a.run = sel.run;
  } catch (e) {
    printErr((e as Error).message);
    process.exitCode = 2;
    return;
  }
  const workspace = a.workspace ? path.resolve(deps.cwd ?? process.cwd(), a.workspace) : (deps.cwd ?? process.cwd());

  const parentRunDir = await resolveParentRun(a, runsHome, deps);
  if (!parentRunDir) {
    printErr(`piflowctl optimize verify: no triaged run found for node "${a.node}" — run 'optimize fix --node ${a.node}' first, or pass --run <id>.`);
    process.exitCode = 2;
    return;
  }

  // Eligibility (Defect 4a): the gate AGENT judges against the node's `optimize.criteria` — a numeric-only node
  // (measure but no criteria/judge) has NOTHING for the gate to judge, so its records are NOT verify-eligible
  // (and buildGatePrompt would throw). Fail-open on an unreadable node.json (the per-issue try/catch is the net).
  let hasCriteria = true;
  try { hasCriteria = await nodeHasCriteria(templateDir, a.node); } catch { hasCriteria = true; }
  if (!hasCriteria) {
    print(`optimize verify: node "${a.node}" has no optimize.criteria — the gate agent has no bar to judge against (a numeric-only node is gated by 'optimize fix', not the gate). Nothing to verify.`);
    return;
  }

  // Eligibility: records for this node that carry a candidateSha (a git-gate-able candidate) AND are NOT already
  // rejected — a `discarded` candidate (e.g. an oracle-touched fixer-side rejection) is NEVER silently re-gated
  // by a plain verify (Defect 1); verify acts on candidates awaiting a gate, not on already-rejected ones.
  const all = await scanRecords(parentRunDir);
  const records = all.filter((r) => r.node === a.node && !!r.candidateSha && r.decision !== 'discarded' && (a.issue ? r.issue === a.issue : true));
  if (records.length === 0) {
    print(`optimize verify: no verifiable candidate record${a.issue ? ` "${a.issue}"` : ''} for node "${a.node}" (a record needs a candidateSha and must not be already discarded; run 'optimize fix' first).`);
    return;
  }

  const onEvent = watchSink(a.watch, a.watchJson, print);
  const verify = deps.verifyStage ?? verifyStage;
  const resolveRunDir = deps.resolveRunDir ?? ((run, cwd) => resolveNodeRunDir({ run, cwd }));
  let staged = 0;
  let discarded = 0;
  let errored = 0;
  for (const rec of records) {
    // (Defect 4b) each issue's gate is isolated: a per-issue throw (e.g. buildGatePrompt has no bar) is reported
    // as a CLEAN line and the loop CONTINUES — never a raw stack trace that aborts the whole pass.
    try {
      const issuePath = path.join(templateDir, 'nodes', a.node, 'issues', `${rec.issue}.md`);
      // the gate inspects the candidate artifact in the prove-rerun's child run; resolve it, else fall back to the
      // parent run dir (best-effort — a live verify needs the child dir; the injected seam ignores it).
      let childDir = parentRunDir;
      if (rec.verifiedByRun && rec.verifiedByRun !== 'unproven') {
        try { childDir = resolveRunDir(rec.verifiedByRun, deps.cwd); } catch { /* fall back to the parent run */ }
      }
      const vs = await verify({ runDir: parentRunDir, node: a.node, issue: rec.issue }, {
        templateDir, workspace, childDir, issuePath,
        outDir: verifyAgentOutDir(parentRunDir, a.node, rec.issue),
        ...(onEvent ? { onEvent } : {}),
        ...(a.tier ? { tier: a.tier } : {}),
        ...(a.model ? { model: a.model } : {}),
      });
      if (vs.decision === 'staged') staged++;
      else discarded++;
      print(`optimize verify[${path.basename(parentRunDir)}] node=${a.node} issue=${rec.issue}: ${vs.decision} — ${vs.gateVerdict.rationale}`);
      if (vs.decision === 'discarded' && vs.dropback) {
        print(`  drop-back: ${vs.dropback.category}${vs.dropback.steer ? ` — ${vs.dropback.steer}` : ''}`);
      }
      if (vs.verdictPath) print(`  verdict: ${vs.verdictPath}`);
    } catch (e) {
      errored++;
      printErr(`optimize verify[${path.basename(parentRunDir)}] node=${a.node} issue=${rec.issue}: could not verify — ${(e as Error).message}`);
    }
  }
  const errNote = errored > 0 ? `, ${errored} errored` : '';
  print(`optimize verify: node=${a.node} — ${records.length} verified (${staged} staged, ${discarded} discarded${errNote}); adopt is a separate step.`);
}

// ── adopt (land staged records onto the live product — the human step wrapping adoptSubstrateManifest) ────────
// WS2 regrammar: `optimize adopt --node <id> [--issue <name>] [--run <id>]` resolves the staged record(s) via
// `scanRecords` and cherry-picks each `candidateSha`. `--manifest <path>` survives as a HIDDEN back-compat alias
// (a staged manifest.json). Both spellings are disjoint from the classic `optimize --adopt <manifest>` FLAG path
// (runOptimizeAdoptCli, byte-unchanged).

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

/** Print the adopted/skipped summary shared by both adopt spellings. */
function printAdoptSummary(result: { adopted: { node: string; issue: string; commit: string; files: string[] }[]; skipped: { issue: string; reason: string }[] }, print: (s: string) => void): void {
  print(`optimize adopt: ${result.adopted.length} issue(s) landed; ${result.skipped.length} skipped.`);
  for (const ad of result.adopted) print(`  + ${ad.node}/${ad.issue} → ${ad.commit.slice(0, 7)} (${ad.files.length} file(s))`);
  for (const sk of result.skipped) print(`  · skipped ${sk.issue}: ${sk.reason}`);
}

/**
 * `piflowctl optimize adopt --node <id> [--issue <name>] [--run <id>]` — land the staged record(s) onto the live
 * product (adoptSubstrateManifest → cherry-pick candidateSha + stampAttempt + status resolved). Resolves records
 * via `scanRecords` for the scoped run (all `staged` records, or the one named by `--issue`). `--manifest <path>`
 * is a HIDDEN back-compat alias. A missing/malformed input exits 2. Prints an adopted/skipped summary.
 */
export async function runSubstrateAdoptCli(argv: string[], deps: SubstrateCliDeps = {}): Promise<void> {
  const a = parseSubstrateAdoptArgs(argv);
  const print = deps.print ?? stdout;
  const printErr = deps.printErr ?? stderr;
  const cwd = deps.cwd ?? process.cwd();
  const adopt = deps.adoptManifest ?? adoptSubstrateManifest;
  const onEvent = watchSink(a.watch, a.watchJson, print);

  // Path A — the WS2 grammar: adopt by --node/--issue, records resolved via scanRecords for the scoped run.
  if (!a.manifest && a.node) {
    let templateDir: string;
    let runsHome: string;
    let node: string;
    let run: string | undefined;
    try {
      const sel = resolveSubstrateSelector({ node: a.node, run: a.run, template: a.template }, deps);
      ({ templateDir, runsHome, node, run } = sel);
    } catch (e) {
      printErr(`piflowctl optimize adopt: ${(e as Error).message}`);
      process.exitCode = 2;
      return;
    }
    const parentRunDir = await resolveParentRun({ run, node }, runsHome, deps);
    if (!parentRunDir) {
      printErr(`piflowctl optimize adopt: no triaged run found for node "${node}" — pass --run <id>, or run 'optimize fix' first.`);
      process.exitCode = 2;
      return;
    }
    const all = await scanRecords(parentRunDir);
    const records: SubstrateManifestRecord[] = all.filter((r) => r.node === node && r.decision === 'staged' && (a.issue ? r.issue === a.issue : true));
    if (records.length === 0) {
      print(`optimize adopt: no staged record${a.issue ? ` "${a.issue}"` : ''} to land for node "${node}".`);
      return;
    }
    // WS-B5 TRAIN: land upstream-first using the run's blame graph when present. BEST-EFFORT — a run with no
    // blame summary (or a malformed tail) degrades to the default node/issue-asc landing order (any throw ignored).
    let nodeOrder: string[] | undefined;
    try {
      nodeOrder = deriveNodeOrder(parseBlameSummaryTail(await fs.readFile(blameSummaryPath(parentRunDir), 'utf8')));
    } catch { /* no readable blame summary — default order */ }
    const result = await adopt({ records }, {
      templateDir,
      runDir: parentRunDir,
      gcBranches: !a.noGc,
      ...(nodeOrder ? { nodeOrder } : {}),
      ...(a.backupDir ? { backupDir: path.resolve(cwd, a.backupDir) } : {}),
      ...(onEvent ? { onEvent } : {}),
    });
    printAdoptSummary(result, print);
    return;
  }

  // Path B — the HIDDEN back-compat alias: a staged manifest.json path.
  if (!a.manifest) {
    printErr('piflowctl optimize adopt: --node <id> [--issue <name>] is required (or the --manifest <path> back-compat alias).');
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

  const result = await adopt(manifest, {
    templateDir,
    ...(a.backupDir ? { backupDir: path.resolve(cwd, a.backupDir) } : {}),
    ...(onEvent ? { onEvent } : {}),
  });
  printAdoptSummary(result, print);
}

// ── blame (docs/design/optimize-blame.md §4/§10 WS-B3) — the RUN-LEVEL attribution verb ───────────────────────
// `piflowctl optimize blame <run> [--latest]` measures every node the run is missing a report for (blame is
// SELF-SUFFICIENT — it never requires a prior `optimize triage` pass), folds the run-level hard measure, then
// runs the judge + verify round and writes prose `<node>.md` blame files + the parsed `blame.md` summary tail
// under `<runDir>/optimize/blame/`. Idempotent: a re-run clears stale `<node>.md` files (never `dissent.*.md`,
// which is TRIAGE-owned — §4.1) before the judge writes fresh ones.

/** Every node id under `<templateDir>/nodes/` (dirs only), sorted — the plain id LIST step 1 needs BEFORE the
 *  judge composes the responsibility roster off the same dirs (roster.ts's own discovery, duplicated here since
 *  this module needs just the ids, not the full entries). Missing/unreadable `nodes/` degrades to `[]`, never
 *  throws — mirrors every other best-effort fs read in this file. */
function discoverNodeIds(templateDir: string): string[] {
  try {
    return readdirSync(path.join(templateDir, 'nodes'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** Idempotent rewrite (§1.2 decision 2 / §4 step 5): delete every PREVIOUSLY-GENERATED `*.md` under
 *  `<runDir>/optimize/blame/` before a fresh judge spawn, so a node blamed last pass but NOT this pass can never
 *  linger as a stale attribution. `dissent.<node>.md` is the node-triage seam's contest trace (§4.1) — TRIAGE-
 *  owned, NEVER cleared here. A missing blame dir (first-ever pass) is a no-op, never a throw. */
async function clearStaleBlameFiles(runDir: string): Promise<void> {
  const dir = blameDir(runDir);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return; // no blame dir yet — nothing stale
  }
  await Promise.all(
    names
      .filter((f) => f.endsWith('.md') && !f.startsWith('dissent.'))
      .map((f) => fs.rm(path.join(dir, f), { force: true })),
  );
}

/**
 * `piflowctl optimize blame <run> [--latest] [flags]` — the run-level BLAME pass over one finished run.
 *   1. measure (mechanical): every node under the template missing a `measure.<node>.json` report gets one
 *      (`runSubstrateMeasure`) — blame is self-sufficient, it never assumes a prior `optimize triage`.
 *   2. the run-level hard-measure fold (mechanical): `runBlameMeasure` → `blame/measure.json`.
 *   3. the judge + one verify round (`runBlameJudge`, PERSISTED to `blameAgentOutDir`) — writes the prose
 *      `<node>.md` files + the parsed `blame.md` summary tail. Idempotent: stale `<node>.md` files from a PRIOR
 *      pass are cleared first (never on `--dry-run` — a preview writes/deletes nothing).
 *   4. blame-memorize (WS-B6, unless `--no-memorize`) — an ADVISORY step: `deps.blameMemorize` defaults to
 *      `undefined` (not yet wired), and any throw is caught + reported, never aborting a landed blame pass.
 *   5. print the blamed nodes (w/ severity), edges, unattributed count, files written, and an observe hint.
 * Resolution: an explicit `<run>` positional resolves directly (`resolveNodeRunDir`); `--latest` (or no
 * positional at all) resolves the template first (`--template` > single-workflow discovery), then the newest
 * run under it (`scanRunsHome`, newest-first) — exit 2 with an actionable message when there is none.
 */
export async function runSubstrateBlameCli(argv: string[], deps: SubstrateCliDeps = {}): Promise<void> {
  const a = parseSubstrateBlameArgs(argv);
  const print = deps.print ?? stdout;
  const printErr = deps.printErr ?? stderr;
  const cwd = deps.cwd ?? process.cwd();

  let runDir: string;
  let templateDir: string;
  try {
    if (a.run && !a.latest) {
      const resolve = deps.resolveRunDir ?? ((run, c) => resolveNodeRunDir({ run, cwd: c }));
      runDir = resolve(a.run, cwd);
      templateDir = a.template ? path.resolve(cwd, a.template) : templateDirFor(runDir);
    } else {
      // `--latest` (or NO positional): resolve the template first (--template > single-workflow discovery),
      // then the newest run under it.
      const sel = (deps.resolveScope ?? resolveSubstrateScope)({ template: a.template, cwd });
      const summaries = await scanRunsHome(sel.runsHome, deps.scan); // newest-first
      if (summaries.length === 0) {
        printErr(`piflowctl optimize blame: no runs found under ${sel.runsHome} — run the workflow first, then 'optimize blame --latest'.`);
        process.exitCode = 2;
        return;
      }
      templateDir = sel.templateDir;
      runDir = summaries[0].runDir;
    }
  } catch (e) {
    printErr((e as Error).message);
    process.exitCode = 2;
    return;
  }

  const workspace = a.workspace ? path.resolve(cwd, a.workspace) : cwd;

  // (1) measure — every node the run is missing a report for (mechanical, free; self-sufficient).
  const measure = deps.measure ?? runSubstrateMeasure;
  for (const node of discoverNodeIds(templateDir)) {
    const reportPath = path.join(runDir, 'optimize', 'substrate', `measure.${node}.json`);
    if (!existsSync(reportPath)) await measure(runDir, node, { workspace });
  }

  // (2) the run-level hard-measure fold (mechanical, free).
  const blameMeasure = deps.blameMeasure ?? runBlameMeasure;
  await blameMeasure(runDir, { workspace });

  // Idempotent rewrite — clear stale per-node blame files BEFORE the judge spawn, never on a --dry-run preview
  // (a preview writes/deletes nothing). Dissent traces are always preserved (clearStaleBlameFiles's own law).
  if (!a.dryRun) await clearStaleBlameFiles(runDir);

  // (3) the judge + one verify round.
  const outDir = blameAgentOutDir(runDir);
  const onEvent = watchSink(a.watch, a.watchJson, print);
  const blameJudge = deps.blameJudge ?? runBlameJudge;
  const result = await blameJudge(runDir, {
    templateDir, workspace, outDir,
    verifyRound: a.verifyRound,
    ...(onEvent ? { onEvent } : {}),
    ...(a.tier ? { tier: a.tier } : {}),
    ...(a.model ? { model: a.model } : {}),
    ...(a.dryRun ? { dryRun: true } : {}),
  });

  if (a.dryRun) {
    if (result.dryRun) printSubstrateDryRun(`optimize blame[${path.basename(runDir)}]`, result.dryRun, print);
    return; // a preview composed the judge spawn and wrote/spawned NOTHING — no memorize, no tally to print.
  }

  // (4) blame-memorize (WS-B6) — advisory: a throw is reported and the blame pass still stands as landed.
  if (a.memorize && deps.blameMemorize) {
    try {
      await deps.blameMemorize(runDir, { templateDir, workspace, summary: result.summary });
    } catch (e) {
      printErr(`optimize blame: blame-memorize failed (advisory — the blame pass itself still landed): ${(e as Error).message}`);
    }
  }

  // (5) print.
  const bySeverity = result.summary.blamed.length
    ? result.summary.blamed.map((b) => `${b.node}[${b.severity}]`).join(', ')
    : '(none)';
  print(`optimize blame[${path.basename(runDir)}]: ${result.summary.blamed.length} node(s) blamed — ${bySeverity}`);
  print(`  edges: ${result.summary.edges.length ? result.summary.edges.map(([o, d]) => `${o}→${d}`).join(', ') : '(none)'}`);
  print(`  unattributed: ${result.summary.unattributed.length}`);
  print(`  files: ${result.files.length ? result.files.map((f) => path.basename(f)).join(', ') : '(none)'}`);
  print(`observe: piflowctl telemetry ${outDir}`);
}
