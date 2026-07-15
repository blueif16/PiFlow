// optimize/substrate/fix.ts — the M6 FIX phase (docs/design/optimize-issue-lifecycle-redesign.md WS0). Per ONE
// issue: activate → candidate WORKTREE → fixer agent → commit → (prove) → gate → stage; then ADOPT is a SEPARATE
// exported human step. Everything here is core-GENERIC (no product binding): the candidate closure, the oracle
// fence, the edits-applied diff, and the graded-delta fold are all mechanical, derived from the node's own
// `node.json`.
//
// ── CANDIDATE = A GIT COMMIT, NOT A COPY (WS0) ───────────────────────────────────────────────────────────────
// The candidate is `{ baseSha, candidateSha }` on a throwaway branch — NOT a physical tree copy. The fixer edits
// a git WORKTREE checked out at HEAD (`prepareCandidateWorktree`: `git worktree add -B optimize/<node>/<issue>/
// attempt-N <wt> HEAD`), then `git add -A && commit` mints `candidateSha`. `editsApplied` = the count of
// `git diff --name-only baseSha candidateSha`. This scales to whole-repo fixes and makes tracking a hash.
//
// ── ORACLE FENCE = SANDBOX + A DIFF GUARD (belt + suspenders; WS0) ──────────────────────────────────────────
// The fixer spawns with `cwd = worktreeDir` and sandbox `readScope`/`owns` = the node's `{{WORKSPACE}}`-read
// closure MINUS the oracle: collect every `{{WORKSPACE}}` path referenced by `contract.readScope` +
// `contract.execReads` + `hooks` + `op` (the INCLUDE set), drop any referenced by `optimize.measure`/`judge`
// (the EXCLUDE/oracle set) via the prefix rule, then map each surviving rel to `join(worktreeDir, rel)`. The
// oracle paths simply are not in the allowlist, so the default-on seatbelt/bwrap jail denies the fixer any
// read/write of the scorer/criteria — no jail code changes (the fence is AUTOMATIC via `runBaseAgent`). Because
// a sandbox grant is dir-coarse (an oracle FILE inside an included DIR is still reachable), the DIFF GUARD is
// the second layer: after commit, if the diff touches ANY oracle path the candidate is a FIXER-SIDE REJECTION
// (`oracleTouchedByDiff`) — discarded outright, never proved or gated (it never games the score).
//
// ── GRADED-DELTA FOLD RULE (M6.3 — the accept decision) ──────────────────────────────────────────────────
// After a prove-rerun, compare ONLY the numeric keys present in BOTH the parent's and the child's
// `measure.<node>.json` `.graded` map (the SHARED keys). Direction is higher-is-better by default; a key
// matched by the injectable `lowerIsBetter` predicate is inverted. Per key, `adj = lowerIsBetter ? base−cand :
// cand−base`; `improved = adj > 0`, `regressed = adj < −tolerance`. The multi-key verdict is FOLDED onto the
// scalar (base, candidate) pair that `evaluateGate` (gate.ts) already ratchets on (`candidate > base` = strict
// improvement), so we REUSE its two load-bearing rules verbatim:
//   • NO shared keys ⇒ base=null, candidate=null ⇒ evaluateGate ⇒ stage-for-human (NEVER auto-accept).
//   • any key regressed beyond tolerance ⇒ base=0, candidate=−1 ⇒ reject.
//   • else ≥1 key improved ⇒ base=0, candidate=+1 ⇒ accept (strict improvement).
//   • else all flat within tolerance ⇒ base=0, candidate=0 ⇒ reject (no improvement).
//   • editsApplied < 1 ⇒ evaluateGate rejects first (gate.ts:47), before any of the above.
// The scalar is an internal accept SIGNAL only; the human-facing per-key RAW deltas ride the manifest's
// `deltaSummary`. The gate `bucket` is pinned to `SKILL` — a non-ARCH, non-FUNCTIONALITY bucket — so we get
// ONLY the two rules above, never the ARCH always-stage or the FUNCTIONALITY product-checks gate (neither
// models a substrate fix). ADOPTION stays a SEPARATE human step regardless of landPolicy: `fixIssue` NEVER
// auto-adopts — the strongest a fix reaches here is `staged`.
//
// ── PROVE / ORACLE IMMUTABILITY (M6.3) ───────────────────────────────────────────────────────────────────
// Prove re-runs the node against the candidate WORKTREE (its HEAD IS candidateSha) via `spawnChildRun`, then
// measures the CHILD run with `workspace = the LIVE product root` — so pristine, un-copied scorer scripts grade
// a candidate-produced artifact. The candidate never gained a scorer (the fence + diff guard); the live root is
// never edited (only adopt touches it, by cherry-picking candidateSha). Oracle immutability is mechanical.
//
// ── ADOPT = CHERRY-PICK (git-native; WS0) + the TRAIN (docs/design/optimize-blame.md §6, WS-B5) ───────────────
// `adoptSubstrateManifest` lands a staged record by `git cherry-pick candidateSha` onto the live branch (the
// candidate commit already carries the `optimize(<node>): <title>` subject + `Issue:` trailer identity, so
// cherry-pick preserves it), then stamps the issue (`commit`=the landed sha, `verifiedByRun`) and transitions
// it → `resolved`. On a pick CONFLICT it ABORTS the cherry-pick and SKIPS the record — never a forced apply.
//
// The TRAIN adds queue semantics on top (the shipped conflict⇒skip stays as the last resort):
//   • ORDER — records land in `orderRecords(records, nodeOrder)` order (blame upstream-first, then node asc,
//     then issue asc). Completion order NEVER dictates landing order (§6 single-writer train).
//   • STALENESS — per staged record, BEFORE the pick, a PURE verdict over `(baseSha, HEAD, interveningPaths,
//     closure)` (`assessStaleness`, train.ts): `fresh` (base unmoved) lands as today; `disjoint` (base moved
//     but provably outside the node's include-closure) lands WITH a base-drift note; `overlap` (moved inside
//     the closure, or missing evidence) RE-PROVES via the injected `opts.reprove` seam (accept ⇒ land w/ a
//     re-proved note) or BOUNCES (reject / no seam).
//   • BOUNCE — a stale-base record is NOT picked: its lifecycle `record.json` is rewritten `discarded` with a
//     `{category:'stale-base'}` dropback (ONLY when `opts.runDir` is passed — without it the lifecycle dir is
//     unreachable from a record alone, so the bounce DEGRADES to the issue walk-back + skip reason only), and
//     the issue is walked back to `open` by the LEGAL edge (guarded by `assertTransition`): `verifying → open`
//     for a proven candidate, `fix-landed → open` for a skip-proof one — both return the issue to the open pool
//     re-fixable, never stranded. Only a status with NO legal edge to `open` is LEFT (skip reason carries it).
//   • BRANCH GC — after a land+resolve, `opts.gcBranches` (default ON) deletes every `refs/heads/optimize/
//     <node>/<issue>/*` branch (the landed cherry-pick sha in the issue attempt is the durable record). NEVER
//     on a skip/bounce — an escalation candidate keeps its branch.
//
// ── RESTING STATE AFTER THE GATE (the issue's status is never stranded) ──────────────────────────────────
// The prove path moves the issue to `verifying` before the rerun. After the gate decides, the issue must land
// on an honest resting state — a proven-REJECT must NOT strand it at `verifying` (M2 originally had no back-edge
// out of `verifying` for a rejected candidate; TASK 0 added `verifying → open`). So: a `discarded` decision that
// went through a prove-rerun (childId !== null) walks the issue BACK to `open` — reason stays null, NO attempt is
// stamped (nothing landed), so a later triage/fix re-attempts it. A `staged` candidate stays at `verifying`
// awaiting the human adopt (verifying → resolved); the skip-proof/unmeasured/no-edit/oracle-touched paths never
// entered `verifying` (they rest at `fix-landed`/`active`), so they need no walk-back.

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';

import type { DefectBucket } from '../types.js';
import { evaluateGate, type GateVerdict, type LandPolicy } from '../gate.js';
import { parseIssueFile, stampAttempt, transitionIssue, assertTransition, type VerifyTier, type Severity } from './issues.js';
import { assessStaleness, orderRecords, pathInClosure } from './train.js';
import {
  inheritedAgentOpts, runBaseAgent,
  type RunBaseAgentOpts, type RunBaseAgentResult, type BaseAgentChildOpts,
} from './agent.js';
import { spawnChildRun, type SpawnChildRunOpts, type SpawnChildRunResult } from './child-run.js';
import { runSubstrateMeasure, type RunSubstrateMeasureOpts, type MeasureReport } from './measure.js';
import { loadState } from '../../workflow/state.js';
import {
  runSubstrateGate,
  type RunSubstrateGateOpts, type RunSubstrateGateResult, type GateVerdictFile, type GateRejectCategory,
} from './gate.js';
import { safeEmit, type SubstrateEvent, type SubstrateEventSink } from './events.js';

/** The gate bucket every substrate fix uses — a non-ARCH, non-FUNCTIONALITY bucket, so `evaluateGate` applies
 *  ONLY the editsApplied<1 and null⇒stage-for-human rules (see the fold-rule header). */
const SUBSTRATE_GATE_BUCKET: DefectBucket = 'SKILL';

/** Sentinel `verifiedByRun` for the skip-proof path (no child run verified the fix). The Issue attempt schema
 *  requires a NON-EMPTY string (issues.ts `validateIssue`), so `null` cannot be stored — this documents it. */
export const UNPROVEN_BY_RUN = 'unproven';

// ── the git exec helper (ONE pattern: argv-array execFileSync, no shell → no escaping; mirrors worktree.ts) ──

/** Run `git -C <root> <args…>` and return trimmed stdout. Throws on nonzero (the thrown error carries
 *  `.stdout`/`.stderr` Buffers — the caller may try/catch to read them, e.g. a cherry-pick conflict). */
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

// ── the {{WORKSPACE}}-ref closure (mechanical; the whole include/exclude derivation) ────────────────────────

/** Matches `{{WORKSPACE}}` optionally followed by `/a/path` (path chars only — never swallows trailing quotes,
 *  whitespace, or arg separators, so it works whether the token is a bare readScope entry or embedded in an
 *  op `run.args` string). Capture group 1 is the `/path` suffix (or undefined for a bare `{{WORKSPACE}}`). */
const WORKSPACE_REF = /\{\{\s*WORKSPACE\s*\}\}(\/[A-Za-z0-9._\-/]*)?/g;

/** Normalize a captured `/path` suffix into a clean POSIX workspace-relative path, or `null` to DROP it (a
 *  bare `{{WORKSPACE}}`, an empty/`.`/workspace-escaping path — none of which is a safe fence/guard target). */
function normalizeRel(raw: string | undefined): string | null {
  if (!raw) return null; // bare {{WORKSPACE}} → the whole product root; never a fence/guard target
  let rel = path.posix.normalize(raw.replace(/^\/+/, ''));
  if (!rel || rel === '.' || rel === '..' || rel.startsWith('../')) return null;
  rel = rel.replace(/\/+$/, '');
  return rel || null;
}

/** Recursively collect every normalized `{{WORKSPACE}}`-relative path referenced by any STRING inside `value`
 *  (walks arrays/objects). Product-agnostic — it inspects only the token, never a field name. */
export function collectWorkspaceRefs(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (value == null) return into;
  if (typeof value === 'string') {
    for (const m of value.matchAll(WORKSPACE_REF)) {
      const rel = normalizeRel(m[1]);
      if (rel) into.add(rel);
    }
    return into;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectWorkspaceRefs(v, into);
    return into;
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectWorkspaceRefs(v, into);
  }
  return into;
}

/** PURE, exported: does ANY string inside `value` grant the WHOLE workspace root — a BARE `{{WORKSPACE}}` (no
 *  subpath, or a `{{WORKSPACE}}/` with an empty suffix)? Walks arrays/objects exactly like `collectWorkspaceRefs`,
 *  inspecting only the token. `collectWorkspaceRefs`/`normalizeRel` deliberately DROP the bare token (correct for
 *  the oracle EXCLUDE set — the whole root is never a fence/guard TARGET), which ALSO empties the INCLUDE set for a
 *  whole-repo read grant like `readScope: ["{{RUN}}", "{{WORKSPACE}}"]`. This helper is how the fence RECOVERS that
 *  intent: a bare grant means "the whole candidate worktree is the fixer's writable fence." */
export function grantsWorkspaceRoot(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'string') {
    for (const m of value.matchAll(WORKSPACE_REF)) {
      if (m[1] === undefined || m[1] === '/') return true; // a bare {{WORKSPACE}} (or a trailing "/") → the root
    }
    return false;
  }
  if (Array.isArray(value)) return value.some((v) => grantsWorkspaceRoot(v));
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).some((v) => grantsWorkspaceRoot(v));
  return false;
}

/** `<templateDir>/nodes/<id>/node.json`'s raw shape — the optimizer-facing block the loader never wires on.
 *  `criteria` is the current spelling of the shared bar; `judge` is the back-compat READ alias (either works). */
interface RawNodeJson {
  contract?: { readScope?: unknown; execReads?: unknown };
  hooks?: unknown;
  op?: unknown;
  optimize?: { measure?: unknown; criteria?: unknown; judge?: unknown; verifyDefault?: unknown };
}

/** Read + parse the node's `node.json` off disk. Throws (naming the file) if it is missing or invalid — the
 *  node MUST exist to fix it (this is not a degrade-to-default read like the measure/judge stages). */
async function readNodeJsonRaw(templateDir: string, nodeId: string): Promise<RawNodeJson> {
  const file = path.join(templateDir, 'nodes', nodeId, 'node.json');
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e) {
    throw new Error(`fixIssue: cannot read "${file}" for node "${nodeId}": ${(e as Error).message}`);
  }
  try {
    return JSON.parse(raw) as RawNodeJson;
  } catch (e) {
    throw new Error(`fixIssue: "${file}" is not valid JSON: ${(e as Error).message}`);
  }
}

/** The node's SHARED soft bar — `optimize.criteria`, or the back-compat `optimize.judge` alias (either works;
 *  `criteria` wins). A non-empty string ⇒ the node has a soft bar the gate agent can judge against. */
function nodeCriteriaRef(nj: RawNodeJson): string | undefined {
  const raw = nj.optimize?.criteria ?? nj.optimize?.judge;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/** Does the node declare a SOFT bar (`optimize.criteria`, or the `judge` alias) the gate agent can judge a fix
 *  against when there is no numeric oracle? Reads `node.json` off disk (throws only if the node is unreadable,
 *  which fixIssue already requires). Drives the gate ROUTING: unmeasurable + a bar ⇒ the gate agent, not
 *  "unmeasurable → human". */
export async function nodeHasCriteria(templateDir: string, nodeId: string): Promise<boolean> {
  return nodeCriteriaRef(await readNodeJsonRaw(templateDir, nodeId)) !== undefined;
}

/** The node's DEFAULT per-issue verify tier — `optimize.verifyDefault` when it is a valid tier, else `full`.
 *  The fallback an issue inherits when its own frontmatter omits `verify`. Reads `node.json` off disk. */
async function nodeVerifyDefault(templateDir: string, nodeId: string): Promise<VerifyTier> {
  const raw = (await readNodeJsonRaw(templateDir, nodeId)).optimize?.verifyDefault;
  return raw === 'none' || raw === 'rerun' || raw === 'full' ? raw : 'full';
}

/** The node's INCLUDE set (readScope/execReads/hooks/op {{WORKSPACE}} refs) and EXCLUDE/oracle set
 *  (optimize.measure/judge {{WORKSPACE}} refs), each a list of clean workspace-relative POSIX paths. Reused by
 *  BOTH the fence (include MINUS exclude → the fixer's jail) and the diff guard (exclude → the oracle set). */
export interface ClosureRefs {
  include: string[];
  exclude: string[];
  /** TRUE iff `contract.readScope` / `contract.execReads` carries a BARE `{{WORKSPACE}}` — a whole-repo read
   *  grant. `collectWorkspaceRefs` DROPS the bare token so `include` is empty in that case; the fence reads THIS
   *  flag to grant the whole candidate worktree instead of an empty (self-jailing) allowlist. */
  grantsWorkspaceRoot: boolean;
}

/** Derive the node's include/exclude {{WORKSPACE}}-ref sets straight off its `node.json` (the block is
 *  optimizer-facing — never on the compiled NodeSpec). Deterministic; the whole include/exclude derivation. */
export async function readClosureRefs(templateDir: string, nodeId: string): Promise<ClosureRefs> {
  const nj = await readNodeJsonRaw(templateDir, nodeId);
  const include = new Set<string>();
  collectWorkspaceRefs(nj.contract?.readScope, include);
  collectWorkspaceRefs(nj.contract?.execReads, include);
  collectWorkspaceRefs(nj.hooks, include);
  collectWorkspaceRefs(nj.op, include);

  const exclude = new Set<string>();
  collectWorkspaceRefs(nj.optimize?.measure, exclude);
  // The shared bar is an ORACLE too (the fixer must not read/edit it) — exclude BOTH the `criteria` spelling
  // and the back-compat `judge` alias.
  collectWorkspaceRefs(nj.optimize?.criteria, exclude);
  collectWorkspaceRefs(nj.optimize?.judge, exclude);

  const rootGrant = grantsWorkspaceRoot(nj.contract?.readScope) || grantsWorkspaceRoot(nj.contract?.execReads);
  return { include: [...include], exclude: [...exclude], grantsWorkspaceRoot: rootGrant };
}

/** PURE: is `rel` an oracle path — either exactly in the exclude set, or UNDER an excluded dir? The one prefix
 *  rule the fence and the diff guard share (`exclude.has(rel) || excludeList.some(ex => rel.startsWith(ex+'/')`). */
function isOracleRel(rel: string, exclude: Set<string>, excludeList: string[]): boolean {
  return exclude.has(rel) || excludeList.some((ex) => rel.startsWith(`${ex}/`));
}

/**
 * PURE, exported: does ANY changed path touch an oracle path (`optimize.measure`/`judge`)? The candidate's
 * `git diff --name-only baseSha candidateSha` names are checked with the SAME prefix rule the fence uses. `true`
 * ⇒ the candidate edited the scorer/criteria and is a FIXER-SIDE REJECTION (never proved or gated). An empty
 * exclude set (no declared oracle) can never be touched.
 */
export function oracleTouchedByDiff(changedPaths: string[], exclude: string[]): boolean {
  if (exclude.length === 0) return false;
  const set = new Set(exclude);
  return changedPaths.some((rel) => isOracleRel(rel, set, exclude));
}

/**
 * The deterministic oracle guard that TRAVELS with a candidate to EVERY land point (verifyStage's gate,
 * adopt's cherry-pick) — belt + suspenders beyond fixIssue's own fixer-side diff-guard. Re-derives the node's
 * oracle EXCLUDE set (`readClosureRefs`) and checks the candidate commit's `git diff --name-only baseSha
 * candidateSha` against it, so an oracle-touched candidate can never be re-selected, gate-accepted, and
 * cherry-picked into the live product. FAIL-OPEN only when the node's `node.json` is unreadable (no oracle set
 * can be derived here — the fixer-side guard already ran) or the diff cannot be computed.
 */
export async function candidateTouchesOracle(
  templateDir: string,
  node: string,
  repoRoot: string,
  baseSha: string,
  candidateSha: string,
): Promise<boolean> {
  let exclude: string[];
  try {
    ({ exclude } = await readClosureRefs(templateDir, node));
  } catch {
    return false; // no readable node.json → cannot derive an oracle set (the fixer-side guard already ran)
  }
  if (exclude.length === 0) return false;
  let changed: string[];
  try {
    changed = git(path.resolve(repoRoot), 'diff', '--name-only', baseSha, candidateSha).split('\n').filter(Boolean);
  } catch {
    return false; // unreachable shas / not a repo → cannot compute the diff; the other guards remain
  }
  return oracleTouchedByDiff(changed, exclude);
}

// ── the candidate git worktree (create → commit → tear down; the SHA is the candidate, not a tree) ───────────

/** The identity a candidate commit (and its adopted cherry-pick) references — its node + the issue's
 *  name/id/title (the trailer + subject inputs). */
export interface CommitIssueRef {
  node: string;
  name: string;
  /** the issue's `sha256:<hex>` id (the trailer uses its first 7 hex chars). */
  id: string;
  title: string;
}

/** A prepared candidate worktree: the base commit the fixer starts from, the on-disk checkout it edits, and the
 *  throwaway branch that owns the candidate commit after `commitCandidate`. */
export interface CandidateWorktree {
  /** the repo HEAD the worktree was checked out at (the candidate's base; base-drift is measured against it). */
  baseSha: string;
  /** the on-disk worktree checkout (the fixer's cwd; torn down after prove/gate — the branch/SHA persists). */
  worktreeDir: string;
  /** the throwaway branch `optimize/<node>/<issue>/attempt-N` the candidate commit lands on. */
  branch: string;
}

/** DETERMINISTIC (no fs mutation): the throwaway branch + the on-disk worktree PATH for one candidate attempt.
 *  The worktree lives OUTSIDE the product tree (a sibling `.piflow-optimize-worktrees/<repo-basename>/…`) so it
 *  needs no gitignore and never recurses; the path is keyed by the repo's own basename so concurrent repos
 *  never clash. Split from `prepareCandidateWorktree` so a dry-run can compose the fixer plan WITHOUT creating
 *  anything on disk. */
export function candidateWorktreeRef(
  repoRoot: string,
  spec: { node: string; issue: string; attempt: number },
): { branch: string; worktreeDir: string } {
  const root = path.resolve(repoRoot);
  const leaf = `attempt-${spec.attempt}`;
  const branch = `optimize/${spec.node}/${spec.issue}/${leaf}`;
  const base = path.join(path.dirname(root), '.piflow-optimize-worktrees', path.basename(root));
  const worktreeDir = path.join(base, spec.node, spec.issue, leaf);
  return { branch, worktreeDir };
}

/**
 * Create the per-attempt candidate worktree at `repoRoot`'s HEAD: `git worktree add -B <branch> <wtPath> HEAD`
 * on the throwaway branch `optimize/<node>/<issue>/attempt-N`, returning `{ baseSha, worktreeDir, branch }`.
 * Idempotent — a stale worktree/dir from a crashed prior attempt is dropped first. The fixer edits `worktreeDir`
 * (a full repo checkout of any size), NOT a physical closure copy.
 */
export async function prepareCandidateWorktree(
  repoRoot: string,
  spec: { node: string; issue: string; attempt: number },
): Promise<CandidateWorktree> {
  const root = path.resolve(repoRoot);
  const { branch, worktreeDir } = candidateWorktreeRef(root, spec);
  const baseSha = git(root, 'rev-parse', 'HEAD');

  // Idempotent: drop any stale worktree registration + dir at this path (a prior run/crash), then re-add.
  try { git(root, 'worktree', 'remove', '--force', worktreeDir); } catch { /* none to remove */ }
  await fs.rm(worktreeDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(worktreeDir), { recursive: true });

  git(root, 'worktree', 'add', '-B', branch, worktreeDir, 'HEAD');
  return { baseSha, worktreeDir, branch };
}

/** Tear down the candidate worktree CHECKOUT (`git worktree remove --force`); the branch + candidateSha PERSIST
 *  for adopt. Best-effort — a throw here (dir already gone) must never mask the fix verdict. */
export function removeCandidateWorktree(repoRoot: string, worktreeDir: string): void {
  try {
    git(path.resolve(repoRoot), 'worktree', 'remove', '--force', worktreeDir);
  } catch {
    /* best-effort: the branch is the durable artifact, not the checkout */
  }
}

/** Build the candidate commit's `optimize(<node>): <title>` subject (greppable per node, mirroring game-omni's
 *  `skillsys(<node>)`) + the `Issue: <node>/<name> — "<title>" (<hash7>)` trailer (commit ⇄ issue). */
function issueCommitMessage(issue: CommitIssueRef): { subject: string; trailer: string } {
  const hash7 = issue.id.replace(/^sha256:/, '').slice(0, 7);
  return {
    subject: `optimize(${issue.node}): ${issue.title}`,
    trailer: `Issue: ${issue.node}/${issue.name} — "${issue.title}" (${hash7})`,
  };
}

export interface CommitCandidateResult {
  /** the candidate commit SHA — ABSENT when the fixer edited nothing (empty diff ⇒ no commit). */
  candidateSha?: string;
  /** the repo-relative paths `baseSha..candidateSha` changed (`editsApplied` = this length); [] on no edit. */
  changed: string[];
}

/**
 * Commit whatever the fixer left in the worktree: `git add -A`, and if anything is staged, commit it with the
 * issue's subject + trailer (so a later cherry-pick preserves the identity) → `candidateSha`. Returns the
 * changed-file list (`git diff --name-only baseSha candidateSha`). A NO-OP fixer (empty staged diff) ⇒ no
 * commit, `candidateSha` undefined, `changed` []. `-c commit.gpgsign=false` so a signing-configured host never
 * blocks the headless commit.
 */
export function commitCandidate(worktreeDir: string, baseSha: string, issue: CommitIssueRef): CommitCandidateResult {
  const wt = path.resolve(worktreeDir);
  git(wt, 'add', '-A');
  const staged = git(wt, 'diff', '--cached', '--name-only').split('\n').filter(Boolean);
  if (staged.length === 0) return { changed: [] };

  const { subject, trailer } = issueCommitMessage(issue);
  // `-c user.name/email` so a HEADLESS host (CI/cloud) with no configured git identity never fails the commit
  // with "Please tell me who you are"; `-c commit.gpgsign=false` so a signing-configured host never blocks it.
  git(wt, '-c', 'commit.gpgsign=false', '-c', 'user.name=piflow-optimizer', '-c', 'user.email=optimizer@piflow.local', 'commit', '-m', subject, '-m', trailer);
  const candidateSha = git(wt, 'rev-parse', 'HEAD');
  const changed = git(wt, 'diff', '--name-only', baseSha, candidateSha).split('\n').filter(Boolean);
  return { candidateSha, changed };
}

// ── the graded-delta fold (the accept signal; see the module header) ────────────────────────────────────────

export interface FoldGradedOpts {
  /** Allowed regression margin per key (default 0 — no regression tolerated). Absorbs noisy replay deltas. */
  tolerance?: number;
  /** Keys for which a LOWER value is better (span ms, token totals, …). Default: none (all higher-is-better). */
  lowerIsBetter?: (key: string) => boolean;
}

export interface FoldGradedResult {
  /** the scalar pair `evaluateGate` ratchets on — null/null when unmeasurable (no shared keys). */
  base: number | null;
  candidate: number | null;
  /** count of numeric keys present in BOTH maps. */
  sharedKeys: number;
  /** human-facing RAW per-key delta (`candidate − base`), keyed by graded metric name. */
  deltaSummary: Record<string, number>;
  improved: boolean;
  regressed: boolean;
}

/**
 * Fold the multi-key graded comparison into the scalar (base, candidate) pair `evaluateGate` accepts, per the
 * module-header rule. PURE. `deltaSummary` carries the RAW `cand − base` per shared key (direction implied by
 * the metric name); `improved`/`regressed` are computed on the direction-ADJUSTED delta.
 */
export function foldGradedDelta(
  base: Record<string, number>,
  candidate: Record<string, number>,
  opts: FoldGradedOpts = {},
): FoldGradedResult {
  const tol = opts.tolerance ?? 0;
  const lowerIsBetter = opts.lowerIsBetter ?? (() => false);
  const shared = Object.keys(base).filter(
    (k) => k in candidate && Number.isFinite(base[k]) && Number.isFinite(candidate[k]),
  );
  const deltaSummary: Record<string, number> = {};
  let improved = false;
  let regressed = false;
  for (const k of shared) {
    const raw = candidate[k] - base[k];
    deltaSummary[k] = raw;
    const adj = lowerIsBetter(k) ? -raw : raw;
    if (adj > 0) improved = true;
    if (adj < -tol) regressed = true;
  }
  if (shared.length === 0) return { base: null, candidate: null, sharedKeys: 0, deltaSummary, improved, regressed };
  const cand = regressed ? -1 : improved ? 1 : 0;
  return { base: 0, candidate: cand, sharedKeys: shared.length, deltaSummary, improved, regressed };
}

// ── the per-issue substrate manifest (writeStagingManifest-shaped, deterministic; M6.5) ─────────────────────

export interface SubstrateManifestRecord {
  /** the issue's pie name (the human handle + the `<name>.md` filename). */
  issue: string;
  /** the issue's `sha256:<hex>` id (the manifest upsert key). */
  issueId: string;
  node: string;
  decision: 'staged' | 'discarded';
  /** the candidate's durable reference — the throwaway BRANCH `optimize/<node>/<issue>/attempt-N` (WS4 swaps
   *  this for `candidateSha` directly). Kept present so downstream readers/tests still compile. */
  candidateRef: string;
  /** the LIVE product root (a git repo) the candidate branched from; adopt cherry-picks `candidateSha` here. */
  liveRoot: string;
  /** WS-B5/§6 ADOPT-TRAIN ORDERING: the issue's severity + firstSeen, copied off the issue at stage time so the
   *  adopt train (which reads records off disk via `scanRecords`, NOT the ledger) can land higher-severity /
   *  older issues FIRST within a node (`orderRecords`). ABSENT on a pre-WS-B5 record ⇒ that record ranks after
   *  any that declare severity, then falls to issue-name asc (`orderRecords`'s own degrade). */
  severity?: Severity;
  firstSeen?: string;
  /** the repo HEAD the candidate branched from — adopt re-verifies against it on base drift. Absent on a
   *  no-worktree path (never reached in practice; a decided record always has a worktree). */
  baseSha?: string;
  /** the candidate commit SHA adopt cherry-picks — ABSENT when the fixer edited nothing (no commit). */
  candidateSha?: string;
  landPolicy: LandPolicy;
  /** `verdict.reason` — the flattened gate rationale (a reader needn't re-derive the gate). */
  reason: string;
  /** the child run that proved the fix, or `null` on the skip-proof path. */
  verifiedByRun: string | null;
  /** human-facing RAW per-key graded delta (empty on the skip path / when unmeasurable). */
  deltaSummary: Record<string, number>;
  /** The drop-back packet (coarse category + steer) for the next fixer. SOFT-gate reject ⇒ a `GateRejectCategory`;
   *  an adopt-train stale-base BOUNCE (WS-B5) ⇒ the record-level `'stale-base'` category — deliberately widened
   *  HERE (never into the gate's closed `GateRejectCategory` union, which `parseGateVerdict` validates against,
   *  so the gate agent can never emit it). Minimal ripple: only this on-disk record carries the wider category. */
  dropback?: { category: GateRejectCategory | 'stale-base'; steer?: string };
}

export interface SubstrateManifest {
  records: SubstrateManifestRecord[];
}

// ── WS1: ONE FOLDER PER ISSUE — the shared manifest.json is dissolved into a per-issue record.json ───────────
// Everything for an issue lives under its LIFECYCLE dir `runs/<run>/optimize/issues/<node>/<issue>/`: the
// `record.json` (this issue's SubstrateManifestRecord), the gate's `verdict.json`, and the `log.jsonl` event
// trail — addressed by `(node, issue)`, one hop, nothing reconstructed. `scanRecords` globs the per-issue
// record.json files back into the aggregate list that bulk ops + the back-compat `readSubstrateManifest` view
// consume; there is no shared `manifest.json` on disk anymore.

/** The per-issue LIFECYCLE dir: `<runDir>/optimize/issues/<node>/<issue>/`. Everything addressed by
 *  `(node, issue)` — record.json, verdict.json, log.jsonl — lives here. */
export function issueLifecycleDir(runDir: string, node: string, issue: string): string {
  return path.join(runDir, 'optimize', 'issues', node, issue);
}

/** The aggregate VIEW: glob every `optimize/issues/<node>/<issue>/record.json` under `runDir` and parse each
 *  into a record, ordered deterministically (node, then issue). Never throws — a missing `issues/` tree (a run
 *  with nothing staged) yields `[]`, and an unreadable/invalid single record.json (e.g. a lifecycle dir holding
 *  only a log.jsonl) is skipped, so one corrupt file never fails the whole scan. */
export async function scanRecords(runDir: string): Promise<SubstrateManifestRecord[]> {
  const issuesRoot = path.join(runDir, 'optimize', 'issues');
  let nodes: string[];
  try {
    nodes = (await fs.readdir(issuesRoot, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const records: SubstrateManifestRecord[] = [];
  for (const node of nodes.sort()) {
    const nodeDir = path.join(issuesRoot, node);
    let issues: string[];
    try {
      issues = (await fs.readdir(nodeDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      continue;
    }
    for (const issue of issues.sort()) {
      try {
        const rec = JSON.parse(await fs.readFile(path.join(nodeDir, issue, 'record.json'), 'utf8')) as SubstrateManifestRecord;
        if (rec && typeof rec === 'object' && typeof rec.issueId === 'string') records.push(rec);
      } catch {
        /* no valid record.json here — skip it (scanRecords is a lenient bulk view, never fail-the-run) */
      }
    }
  }
  return records;
}

/** Write ONE issue's `record.json` under its lifecycle dir (DETERMINISTIC bytes — no timestamp/random, so an
 *  identical decision renders identical bytes). Returns the record.json path. Replaces the shared-manifest
 *  upsert: one file per issue, no read-merge-rewrite of every other issue's record. */
async function writeIssueRecord(runDir: string, record: SubstrateManifestRecord): Promise<string> {
  const dir = issueLifecycleDir(runDir, record.node, record.issue);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'record.json');
  await fs.writeFile(file, JSON.stringify(record, null, 2));
  return file;
}

/** The aggregate manifest VIEW over a RUN dir: `{ records: scanRecords(runDir) }`. Back-compat for bulk
 *  readers/tests that consumed the old shared `manifest.json` — now reconstructed from the per-issue records. */
export async function readSubstrateManifest(runDir: string): Promise<SubstrateManifest> {
  return { records: await scanRecords(runDir) };
}

// ── the fixer prompt (agentic-prompt-design: the issue file IS the dispatch; a tight fix contract) ──────────

/** The DEFAULT fixer playbook skill — staged for EVERY fixer spawn (fixed id, no per-node knob in v1). The
 *  runner resolves it via `locateSkillStage` (Ring 1 `<piflowHome>/skills/piflow-fixer`); a miss is advisory. */
export const FIXER_SKILL = 'piflow-fixer';

/** A rejected prior attempt's residue, threaded into the NEXT fixer so a retry DIVERSIFIES instead of repeating.
 *  Carries ONLY the gate's coarse category + an optional diversification steer + what the prior fixer tried —
 *  NEVER the gate's rubric/criteria (passing rejection as context ≠ optimizing the fixer against the gate;
 *  the latter teaches hiding, not fixing — see docs/design/optimize-verification-loop.md §8). */
export interface RetryContext {
  /** 1-based attempt this fixer is on (2 = the first retry). A value ≤ 1 renders NO diversification block. */
  attempt: number;
  /** prior rejected attempts, OLDEST→NEWEST: the gate's coarse category + optional steer (no rubric). */
  priorDropbacks: { category: GateRejectCategory; steer?: string }[];
  /** each prior fixer's self-account (what it tried), oldest→newest — so the retry does not repeat the approach. */
  priorAccounts: string[];
}

/** Build the fixer agent's FULL prompt: the issue FILE verbatim (its context brief is the specification) + a
 *  root-cause fix contract, plus — on a RETRY (`retry.attempt > 1`) — a diversification block listing what the
 *  prior attempts tried and why they were rejected, ordering a genuinely DIFFERENT approach. Exported so a test
 *  can pin the contract's load-bearing MUST/MUST-NOT lines (agent behaviour itself is proven by the M7 live
 *  demo — eval, not unit). */
export function buildFixerPrompt(issueFileText: string, node: string, retry?: RetryContext): string {
  const parts = [
    `<role>You are the FIXER agent for the "${node}" node — a senior engineer who ROOT-CAUSES a quality defect and repairs it at the source, inside an ISOLATED candidate copy of the node's read closure.</role>`,
    `<playbook>Your fixer PLAYBOOK — the issue lifecycle (open→closed) and the two-foot quality/harness routing — is staged as the "${FIXER_SKILL}" skill for this turn; it is the procedure this contract assumes. Follow it.</playbook>`,
    `<issue>\nThe issue below is the WHOLE dispatch contract — its context brief is your specification. Read it in full before editing.\n\n${issueFileText}\n</issue>`,
    `<task>Root-cause the defect described in <issue>, then EDIT the files in your working directory (the candidate copy) to fix it at its ROOT — not its surface symptom.</task>`,
    [
      '<constraints>',
      '- MUST edit only files inside your working directory (the candidate copy). It is a throwaway copy proven by a re-run before anything reaches the live product.',
      '- MUST NOT run git, commit, stage, or push — landing is a SEPARATE, human-gated step. Leave your edited files in place; do nothing else.',
      '- MUST NOT edit any measurement / judge / oracle file. Those were deliberately EXCLUDED from your copy so you cannot game the score; if a file you need is absent, HALT and say so — never recreate it.',
      '- MUST fix the ROOT CAUSE. A minimal edit that only silences the symptom FAILS the re-run gate that follows this turn.',
      '</constraints>',
    ].join('\n'),
    `<self_check>Before finishing, re-read <issue> and confirm your edits address its ROOT cause (not just its symptom) and that you touched only candidate files. State, in one sentence, the root cause you fixed.</self_check>`,
  ];

  // On a retry, the block goes RIGHT BEFORE the self-check so it is the last thing read before acting — the
  // procedural-fence position that binds. It is the ONLY channel for the prior verdicts; the gate's rubric is
  // deliberately absent (Goodhart fence).
  if (retry && retry.attempt > 1) {
    const priors = retry.priorDropbacks
      .map((d, i) => {
        const tried = retry.priorAccounts[i] ? ` — it tried: ${retry.priorAccounts[i]}` : '';
        const steer = d.steer ? ` Steer for a different angle: ${d.steer}` : '';
        return `  - attempt ${i + 1} was REJECTED (category: ${d.category})${tried}.${steer}`;
      })
      .join('\n');
    const block = [
      '<prior_attempts>',
      `This is attempt ${retry.attempt}. ${retry.priorDropbacks.length} prior attempt(s) on this issue were REJECTED by the gate:`,
      priors,
      'Do NOT repeat any approach above — it has already failed. Root-cause from a genuinely DIFFERENT angle (a different harness lever, or a different root hypothesis). These notes are the ONLY carry-over: there is no scoring rubric to satisfy — fix the defect, do not tune to a gate.',
      '</prior_attempts>',
    ].join('\n');
    parts.splice(parts.length - 1, 0, block); // insert before <self_check>
  }

  return parts.join('\n\n');
}

// ── fixIssue — the per-issue orchestration ──────────────────────────────────────────────────────────────────

/** The fixer's opts = its OWN specialization (dirs/prove/fold/staging/events + the child-run seams) + the
 *  base agent's whole inherited field surface + the `runAgent` test seam, EMBEDDED via
 *  `BaseAgentChildOpts` (agent.ts) — never a re-declared subset (anything left off a copy is silently
 *  lost; `dryRun` and every future base field arrive here automatically). */
export interface FixIssueOpts extends BaseAgentChildOpts {
  /** the parent run being optimized (`spawnChildRun` replays a node of it; measure reports live under it). */
  parentRunDir: string;
  /** the product template dir (`nodes/<id>/{node.json,issues/}`). */
  templateDir: string;
  /** the LIVE product root — a GIT REPO: the candidate worktree branches from its HEAD, and it is the pristine
   *  oracle the child run is measured against. */
  workspace: string;
  /** run the prove-rerun (default true). false ⇒ skip straight to staging (skip-proof path). */
  prove?: boolean;
  /** WS3 per-issue verify TIER OVERRIDE — wins over the issue's own `verify` frontmatter and the node's
   *  `optimize.verifyDefault`. `none` skips prove+gate (trivial), `rerun` proves + the numeric gate only,
   *  `full` proves + the gate agent. Absent ⇒ the issue-frontmatter/node-default spine decides. */
  verify?: VerifyTier;
  /** graded-delta regression tolerance (default 0). */
  tolerance?: number;
  /** keys where LOWER is better, for the graded fold (default none). */
  lowerIsBetter?: (key: string) => boolean;
  /** OUTER-LOOP retry only: the per-attempt tag (`attempt-N`) → the candidate branch/worktree leaf, so each
   *  attempt's candidate is side-by-side. Absent ⇒ `attempt-1`. */
  attemptTag?: string;
  /** OUTER-LOOP retry only: the prior rejected attempts, threaded into the fixer prompt so it DIVERSIFIES
   *  (categories + steers + accounts — NEVER the gate's rubric). Absent/attempt≤1 ⇒ no diversification block. */
  retry?: RetryContext;
  /** live progress sink (fire-and-forget). */
  onEvent?: SubstrateEventSink;
  // ── test/offline seams for the CHILD prove-run (default the real functions; never live-spawn in a test) ──
  spawnChild?: (parentRunDir: string, nodeId: string, opts: SpawnChildRunOpts) => Promise<SpawnChildRunResult>;
  measure?: (runDir: string, nodeId: string, opts: RunSubstrateMeasureOpts) => Promise<MeasureReport>;
  /** Test/offline seam for the SOFT gate agent (default the real `runSubstrateGate`; never live-spawn a test). */
  gate?: (runDir: string, nodeId: string, opts: RunSubstrateGateOpts) => Promise<RunSubstrateGateResult>;
}

export interface FixIssueResult {
  issue: string;
  node: string;
  /** the candidate's durable reference — the throwaway branch `optimize/<node>/<issue>/attempt-N`. */
  candidateRef: string;
  /** the repo HEAD the candidate branched from (ABSENT on a dry-run). */
  baseSha?: string;
  /** the candidate commit SHA (ABSENT on a dry-run, a no-edit fixer, or an oracle-touched rejection). */
  candidateSha?: string;
  editsApplied: number;
  /** did a prove-rerun happen (editsApplied>=1 AND prove on AND not oracle-touched)? */
  proved: boolean;
  /** the child run id that proved the fix, or null. */
  childId: string | null;
  /** The NUMERIC gate verdict. ABSENT on a dry-run — and on the SOFT-gate / oracle-touched paths. */
  verdict?: GateVerdict;
  /** SOFT-gate path ONLY (no numeric oracle + the node has an optimize.judge): the independent gate agent's
   *  verdict. On this path `verdict` (the numeric gate) is absent and this carries the accept/reject instead. */
  gateVerdict?: GateVerdictFile;
  /** SOFT-gate REJECT ONLY: the drop-back packet (coarse category + a diversification steer) the outer loop
   *  hands a FRESH fixer — never the gate's rubric/criteria (that would teach the retry to the test). */
  dropback?: { category: GateRejectCategory; steer?: string };
  /** The fixer's own self-account (its final text — the root cause it claims to have fixed / what it tried).
   *  The outer loop threads it into the NEXT attempt's RetryContext so a retry doesn't repeat the approach. */
  fixerAccount?: string;
  /** ABSENT on a dry-run — nothing was decided. */
  decision?: 'staged' | 'discarded';
  deltaSummary: Record<string, number>;
  /** the issue's `record.json` path under its lifecycle dir. ABSENT on a dry-run — nothing was staged. */
  manifestPath?: string;
  /** ABSENT on a dry-run — no record was staged. */
  record?: SubstrateManifestRecord;
  /** Present ONLY on a dry-run: the BASE agent's composed spec (`plan`) the fixer WOULD have been spawned
   *  with — the full issue-dispatch `prompt` + the resolved candidate jail/skill/tier/model/tools. Forwarded
   *  verbatim from the base agent's preview seam. */
  dryRun?: RunBaseAgentResult['plan'];
  /** The fixer spawn's PERSISTED run dir (present ONLY when the caller passed `outDir` to the base agent) —
   *  point the existing observe instruments at it (`piflowctl telemetry|status|trace <dir>`), exactly like a
   *  workflow node's own run. Absent on the ephemeral default (already deleted) and on a dry-run. */
  fixerRunDir?: string;
}

/** Parse the 1-based attempt number out of an `attempt-N` tag (default 1 when absent/unrecognized). */
function attemptNumber(attemptTag?: string): number {
  if (!attemptTag) return 1;
  const m = /(\d+)$/.exec(attemptTag);
  return m ? Number(m[1]) : 1;
}

/** Read the parent run's already-persisted graded metrics (`.graded` of its measure report), or `{}` if the
 *  triage measure pass never ran / is unreadable (⇒ no shared keys ⇒ the gate stages for a human). */
async function readParentGraded(parentRunDir: string, nodeId: string): Promise<Record<string, number>> {
  try {
    const report = JSON.parse(
      await fs.readFile(path.join(parentRunDir, 'optimize', 'substrate', `measure.${nodeId}.json`), 'utf8'),
    ) as { graded?: Record<string, number> };
    return report.graded && typeof report.graded === 'object' ? report.graded : {};
  } catch {
    return {};
  }
}

/**
 * Fix ONE issue end-to-end (activate → candidate worktree → fixer → commit → prove → gate → stage). ADOPT is the
 * SEPARATE `adoptSubstrateManifest` step. Never mutates the live product tree (only a throwaway candidate branch
 * + the ledger's own status/manifest). The node id is derived from the issue path (`…/nodes/<node>/issues/<name>.md`).
 */
export async function fixIssue(issuePath: string, opts: FixIssueOpts): Promise<FixIssueResult> {
  const issuePathAbs = path.resolve(issuePath);
  const node = path.basename(path.dirname(path.dirname(issuePathAbs)));
  const { templateDir, workspace, parentRunDir } = opts;
  const prove = opts.prove ?? true;
  // Every emit is also APPENDED to the issue's log.jsonl trail (written under its lifecycle dir at the end).
  const eventLog: SubstrateEvent[] = [];
  const emit = (e: SubstrateEvent): void => { eventLog.push(e); safeEmit(opts.onEvent, e); };
  const runAgent = opts.runAgent ?? runBaseAgent;
  const spawnChild = opts.spawnChild ?? spawnChildRun;
  const measure = opts.measure ?? runSubstrateMeasure;

  const issue = await parseIssueFile(issuePathAbs);
  // WS1: everything for this issue lives under ONE lifecycle dir (record.json · verdict.json · log.jsonl).
  const lifecycleDir = issueLifecycleDir(parentRunDir, node, issue.name);
  const repoRoot = workspace; // the live product root is the git repo the candidate worktree branches from
  const attempt = attemptNumber(opts.attemptTag);
  const { branch, worktreeDir } = candidateWorktreeRef(repoRoot, { node, issue: issue.name, attempt });

  // The oracle FENCE (include MINUS exclude), computed once off node.json (a read, not a mutation — safe under
  // dry-run). Each surviving rel maps to a worktree-absolute dir → the fixer's readScope/owns; the oracle paths
  // are simply not in the allowlist, so the default-on jail denies them.
  const { include, exclude, grantsWorkspaceRoot: grantsRoot } = await readClosureRefs(templateDir, node);
  const excludeSet = new Set(exclude);
  const fenceRels = include.filter((rel) => !isOracleRel(rel, excludeSet, exclude));
  // A BARE `{{WORKSPACE}}` read grant means "the whole candidate worktree is the fixer's writable fence" — the
  // maximal case of the already-accepted dir-coarse grant. Without it `fenceRels` is EMPTY (collectWorkspaceRefs
  // drops the bare token), which would jail the fixer out of its OWN disposable worktree (every edit → EPERM).
  // Oracle protection stays the POST-COMMIT diff guard (`oracleTouchedByDiff`), never the dir-coarse seatbelt.
  const fencePaths = grantsRoot ? [worktreeDir] : fenceRels.map((rel) => path.join(worktreeDir, rel));

  // The fixer prompt EMBEDS the issue file verbatim (buildFixerPrompt), which routinely quotes the target
  // node's OWN config/prompt — including a legitimate `{{state.<channel>}}` token the REAL run promoted (e.g.
  // a `contract.owns` pattern). The fixer's spawn is an EPHEMERAL one-node run (agent.ts) with no state of its
  // own, so that quoted token would otherwise throw `MissingChannelError` before a single model call. Hydrate
  // it from the PINNED parent run's `.pi/state.json` — read-only, never invented: a channel genuinely absent
  // from the parent's state stays absent here too, so an actually-wrong token still fails exactly as before.
  const pinnedState = await loadState(parentRunDir);

  // The ONE fixer spawn composition — shared VERBATIM by the dry-run preview and the live spawn (never two
  // hand-copies that can drift apart). `cwd` is the worktree; the jail is the fence; the playbook is the
  // product-root skill PATH (a path-like ref the runner uses directly, no ring-search from the worktree).
  const fixerSpawn = (issueFileText: string): RunBaseAgentOpts => ({
    prompt: buildFixerPrompt(issueFileText, node, opts.retry),
    cwd: worktreeDir,
    readScope: fencePaths,
    owns: fencePaths,
    skill: path.join(workspace, '.claude', 'skills', FIXER_SKILL),
    state: pinnedState,
    ...inheritedAgentOpts(opts),
  });

  // DRY-RUN — the inherited base-agent preview: compose the exact spawn the fixer WOULD get (the worktree paths
  // are computed, never created) and return its `plan` WITHOUT mutating ANYTHING — no issue transition, no
  // worktree, no spawn, no prove/gate/stage, no events. Read-only throughout.
  if (opts.dryRun) {
    const preview = await runAgent(fixerSpawn(await fs.readFile(issuePathAbs, 'utf8')));
    return {
      issue: issue.name,
      node,
      candidateRef: branch,
      editsApplied: 0,
      proved: false,
      childId: null,
      deltaSummary: {},
      dryRun: preview.plan,
    };
  }

  // WS3: the effective per-issue VERIFY TIER — CLI override > the issue's own `verify` frontmatter > the
  // node's `optimize.verifyDefault` (→ `full`). `none` skips prove+gate (trivial); `rerun` proves + the
  // NUMERIC gate only; `full` proves + the gate agent. `proveEnabled` folds the tier into the existing prove
  // switch (a `none` tier — or an explicit `--no-prove` — turns proving off).
  const verifyTier: VerifyTier = opts.verify ?? issue.verify ?? (await nodeVerifyDefault(templateDir, node));
  const proveEnabled = prove && verifyTier !== 'none';

  // (a) activate — guarded by the status machine (open|regressed → active).
  await transitionIssue(issuePathAbs, 'active');
  emit({ type: 'issue-activated', issue: issue.name, node });

  // (b) candidate = a fresh git worktree at HEAD (NOT a copy). The SHA is the candidate.
  const wt = await prepareCandidateWorktree(repoRoot, { node, issue: issue.name, attempt });
  const baseSha = wt.baseSha;
  try {
    emit({ type: 'candidate-prepared', issue: issue.name, candidateRef: worktreeDir, included: fencePaths.length, excluded: exclude.length });

    // (c) fixer — edits the worktree; `git add -A && commit` → candidateSha; editsApplied = the diff name-count.
    emit({ type: 'fixer-started', issue: issue.name });
    const fixerResult = await runAgent(fixerSpawn(await fs.readFile(issuePathAbs, 'utf8')));
    const committed = commitCandidate(worktreeDir, baseSha, { node, name: issue.name, id: issue.id, title: issue.title });
    const editsApplied = committed.changed.length;
    const candidateSha = committed.candidateSha;
    emit({ type: 'fixer-done', issue: issue.name, editsApplied });

    // (c2) ORACLE DIFF-GUARD (belt + suspenders) — a candidate whose commit touched an oracle path is a
    // FIXER-SIDE REJECTION (never a gate reject): it is discarded outright, never proved or gated. This catches an
    // edit the dir-coarse sandbox fence could not (an oracle FILE inside an included DIR).
    const oracleTouched = editsApplied >= 1 && oracleTouchedByDiff(committed.changed, exclude);

    // A real, non-oracle-touching edit advances the ledger "candidate edit staged".
    if (editsApplied >= 1 && !oracleTouched) await transitionIssue(issuePathAbs, 'fix-landed');

    // (d) prove (self-rewind) — against the candidate WORKTREE (its HEAD IS candidateSha). Skip on no-edit /
    // oracle-touched / prove-off. Unmeasurable ⇒ base/cand stay null.
    let childId: string | null = null;
    let childDir: string | null = null;
    let base: number | null = null;
    let candidate: number | null = null;
    let deltaSummary: Record<string, number> = {};
    if (editsApplied >= 1 && !oracleTouched && proveEnabled) {
      await transitionIssue(issuePathAbs, 'verifying');
      const child = await spawnChild(parentRunDir, node, {
        templateDir,
        workspace: worktreeDir, // the node re-runs against the candidate worktree (HEAD = candidateSha)
        spawnedBy: { by: 'substrate-fix', issue: issue.name, issueId: issue.id },
        provider: opts.provider,
        buildCommand: opts.buildCommand,
      });
      childId = child.childId;
      childDir = child.childDir;
      emit({ type: 'prove-started', issue: issue.name, childId });
      // measure the CHILD with workspace = the LIVE product root → pristine scorer grades a candidate artifact.
      const childReport = await measure(child.childDir, node, { workspace });
      const fold = foldGradedDelta(await readParentGraded(parentRunDir, node), childReport.graded, {
        tolerance: opts.tolerance,
        lowerIsBetter: opts.lowerIsBetter,
      });
      base = fold.base;
      candidate = fold.candidate;
      deltaSummary = fold.deltaSummary;
      emit({ type: 'measured', issue: issue.name, sharedKeys: fold.sharedKeys });
    }

    // (e) GATE / DECISION surfaces on ONE proved candidate:
    //   • ORACLE-TOUCHED ⇒ a FIXER-SIDE rejection short-circuit (no numeric gate, no gate agent).
    //   • NUMERIC (evaluateGate) wherever a graded oracle produced shared keys — deterministic, drift-proof.
    //   • the INDEPENDENT GATE AGENT wherever the fix was proved but the node has NO number, only an
    //     `optimize.judge` bar (the SOFT path). A node with neither a number nor a judge falls to evaluateGate's
    //     stage-for-human, exactly as before.
    let decision: 'staged' | 'discarded';
    let landPolicy: LandPolicy;
    let reason: string;
    let numericVerdict: GateVerdict | undefined;
    let gateVerdict: GateVerdictFile | undefined;
    let dropback: { category: GateRejectCategory; steer?: string } | undefined;
    // Set ONLY on the SOFT path: verifyStage owns the gate agent — it writes record.json + walks the issue back
    // on a reject, so fixIssue must NOT re-write the record or re-run the walk-back for that path.
    let record: SubstrateManifestRecord | undefined;

    const numericMeasured = base !== null && candidate !== null; // shared graded keys existed
    // WS3: ONLY the `full` tier invokes the gate AGENT. `rerun` proves but stays on the NUMERIC gate even when
    // the node has criteria; `none` never proves (childDir null), so it never reaches here.
    const softGate = verifyTier === 'full' && !oracleTouched && editsApplied >= 1 && childDir !== null && !numericMeasured && (await nodeHasCriteria(templateDir, node));

    if (oracleTouched) {
      decision = 'discarded';
      landPolicy = 'stage-for-human';
      reason = 'candidate diff touched an oracle path (optimize.measure/criteria) — fixer-side rejection, never proved/gated';
      emit({ type: 'gated', issue: issue.name, accept: false, reason });
    } else if (verifyTier === 'none' && editsApplied >= 1) {
      // WS3 TRIVIAL tier: a real edit under `verify:none` is STAGED with NO prove and NO gate (a typo-class fix).
      // It rests adopt-ready exactly like the skip-proof path (childId null ⇒ status fix-landed below), but with an
      // explicit reason. A 0-edit `none` falls through to the numeric path's "no edit applied" reject.
      decision = 'staged';
      landPolicy = 'stage-for-human';
      reason = 'verify:none (trivial — no rerun/gate)';
      emit({ type: 'gated', issue: issue.name, accept: true, reason });
    } else if (softGate && childDir !== null) {
      // The SOFT gate is the DECOUPLED `verifyStage` — the SAME callable `optimize verify` runs standalone (one
      // code path, not two). It runs the gate agent, writes verdict.json + record.json under the lifecycle dir,
      // and walks a rejected issue back to `open`; fixIssue only reads its outcome. The live candidate worktree
      // still exists here (torn down below in step f), so verifyStage reuses it in place (createdWorktree=false).
      const preRecord: SubstrateManifestRecord = {
        issue: issue.name, issueId: issue.id, node, decision: 'discarded', candidateRef: branch, liveRoot: workspace,
        baseSha, landPolicy: 'stage-for-human', reason: '', verifiedByRun: childId, deltaSummary,
        severity: issue.severity, firstSeen: issue.firstSeen,
        ...(candidateSha ? { candidateSha } : {}),
      };
      const vs = await verifyStage(lifecycleDir, {
        templateDir, workspace, childDir, candidateRef: worktreeDir, issuePath: issuePathAbs,
        issueFileText: await fs.readFile(issuePathAbs, 'utf8'), fixerAccount: fixerResult.text ?? '',
        baseRecord: preRecord, onEvent: emit, gate: opts.gate,
        ...inheritedAgentOpts(opts),
      });
      decision = vs.decision;
      landPolicy = 'stage-for-human'; // a model judgment STAGES; the human adopts (never judge-gated auto-accept).
      reason = vs.gateVerdict.rationale;
      gateVerdict = vs.gateVerdict;
      dropback = vs.dropback;
      record = vs.record;
    } else {
      // NUMERIC / degenerate path — REUSE evaluateGate's editsApplied<1 + null⇒stage-for-human rules (fold header).
      numericVerdict = evaluateGate({ bucket: SUBSTRATE_GATE_BUCKET, base, candidate, editsApplied });
      emit({ type: 'gated', issue: issue.name, accept: numericVerdict.accept, reason: numericVerdict.reason });
      decision =
        editsApplied < 1
          ? 'discarded'
          : numericVerdict.accept
            ? 'staged'
            : numericVerdict.landPolicy === 'stage-for-human'
              ? 'staged' // unmeasurable/abstained with no judge → route to a human, never auto
              : 'discarded'; // a measured regression / flat result
      landPolicy = numericVerdict.landPolicy;
      reason = numericVerdict.reason;
    }

    // (e2) a PROVEN-REJECT (we entered `verifying` — childId !== null — and the gate discarded it) must not
    // strand the issue at `verifying`: walk it back to `open` (reason null, NO attempt stamped — nothing landed),
    // so a later triage/fix can re-attempt it (the `verifying → open` back-edge). The SOFT path's verifyStage
    // already did this walk-back (guarded by `!record`); a staged candidate stays at `verifying` awaiting adopt;
    // the no-edit / oracle-touched / skip-proof paths never entered `verifying`.
    if (!record && childId !== null && decision === 'discarded') await transitionIssue(issuePathAbs, 'open');

    // (g) stage the record.json (adopt is the separate human step). The SOFT path's verifyStage already wrote it.
    if (!record) {
      record = {
        issue: issue.name,
        issueId: issue.id,
        node,
        decision,
        candidateRef: branch,
        liveRoot: workspace,
        baseSha,
        landPolicy,
        reason,
        verifiedByRun: childId,
        deltaSummary,
        severity: issue.severity, // WS-B5/§6: carry the priority so the adopt train orders within a node
        firstSeen: issue.firstSeen,
        ...(candidateSha ? { candidateSha } : {}),
        ...(dropback ? { dropback } : {}),
      };
      await writeIssueRecord(parentRunDir, record); // record.json UNDER the lifecycle dir
    }
    const manifestPath = path.join(lifecycleDir, 'record.json');
    emit({ type: 'staged', issue: issue.name, decision, manifestPath });
    emit({ type: 'stopped', issue: issue.name, reason: decision === 'staged' ? 'staged for adopt' : `discarded (${reason})` });

    // WS1: persist the whole event trail as log.jsonl beside record.json (the lifecycle dir now exists).
    await fs.writeFile(path.join(lifecycleDir, 'log.jsonl'), eventLog.map((e) => JSON.stringify(e)).join('\n') + '\n');

    return {
      issue: issue.name,
      node,
      candidateRef: branch,
      baseSha,
      editsApplied,
      proved: childId !== null,
      childId,
      verdict: numericVerdict,
      ...(candidateSha ? { candidateSha } : {}),
      ...(gateVerdict ? { gateVerdict } : {}),
      ...(dropback ? { dropback } : {}),
      decision,
      deltaSummary,
      manifestPath,
      record,
      fixerRunDir: fixerResult.runDir,
      ...(fixerResult.text ? { fixerAccount: fixerResult.text } : {}),
    };
  } catch (e) {
    // GAP1 CRASH DROP-BACK — a throw ANYWHERE in this block (the fixer spawn itself, commitCandidate, the
    // prove spawn/measure, or the gate) must not strand the issue at an in-flight status with no legal path
    // back. Observed live: the fixer spawn died before a single edit landed, leaving the issue `active` forever
    // (its only forward edge WAS `fix-landed` — no back edge existed), so a later `optimize fix` could never
    // re-select it and a human had to hand-edit the frontmatter. Re-read the CURRENT on-disk status (it may
    // have advanced past `active` before the throw) and walk it back to `open` unless it is already there.
    // Best-effort: a secondary ledger read/transition error here must NEVER mask the original crash re-thrown
    // below — the crash itself is the signal the caller needs.
    try {
      const current = await parseIssueFile(issuePathAbs);
      if (current.status !== 'open') await transitionIssue(issuePathAbs, 'open');
    } catch {
      // swallow — see above
    }
    throw e;
  } finally {
    // (f) CLEANUP — tear down the candidate worktree checkout on EVERY exit (success OR a throw from
    // the fixer / commit / prove / gate); the branch + candidateSha persist for adopt/discard.
    removeCandidateWorktree(repoRoot, worktreeDir);
  }
}

// ── verifyStage — the DECOUPLED gate stage (WS2.1) ───────────────────────────────────────────────────────────
// The gate step of `fixIssue`, extracted so it is INDEPENDENTLY callable: given ONE issue's candidate record
// (its `candidateSha` + the already-proved child run), it runs the gate agent, writes `verdict.json`, finalizes
// `record.json` (decision + drop-back), and lands the issue on an honest status — NO fixer, NO re-prove.
// `fixIssue` calls this for its soft-gate branch (one code path, not two); `optimize verify` calls it standalone.

export interface VerifyStageOpts extends BaseAgentChildOpts {
  /** the product template dir (`nodes/<id>/node.json` carries the `optimize.judge` bar). */
  templateDir: string;
  /** the prove-rerun CHILD run dir — holds the candidate artifact the gate inspects. */
  childDir: string;
  /** `{{WORKSPACE}}` — the live product root. Default: the record's `liveRoot`. */
  workspace?: string;
  /** the issue `.md` to update status on. Default `<templateDir>/nodes/<node>/issues/<issue>.md`. */
  issuePath?: string;
  /** the candidate worktree granted read to the gate. Recreated at `candidateSha` when this path is absent on
   *  disk (a torn-down candidate) and torn down again afterwards; an EXISTING dir (fixIssue's live worktree)
   *  is used in place and left for its owner to tear down. */
  candidateRef?: string;
  /** the fixer's account (a claim the gate cross-checks). '' when none. */
  fixerAccount?: string;
  /** the issue file text (the defect spec). Default: read from `issuePath`. */
  issueFileText?: string;
  /** live progress sink (fire-and-forget). */
  onEvent?: SubstrateEventSink;
  /** INTERNAL fixIssue fast-path: the base record to finalize IN PLACE of reading `record.json` (which fixIssue
   *  has NOT written yet at gate time). Standalone `optimize verify` omits this → reads the lifecycle dir. */
  baseRecord?: SubstrateManifestRecord;
  /** test/offline seam for the SOFT gate agent (default the real `runSubstrateGate`; never live-spawn a test). */
  gate?: (runDir: string, nodeId: string, opts: RunSubstrateGateOpts) => Promise<RunSubstrateGateResult>;
}

export interface VerifyStageResult {
  decision: 'staged' | 'discarded';
  gateVerdict: GateVerdictFile;
  /** REJECT only: the drop-back packet (coarse category + steer) the outer loop hands a FRESH fixer. */
  dropback?: { category: GateRejectCategory; steer?: string };
  /** the finalized record (also written to `<lifecycleDir>/record.json`). */
  record: SubstrateManifestRecord;
  /** the gate's `verdict.json` path (absent only when the gate seam returned none). */
  verdictPath?: string;
}

/** Does a path exist on disk? */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Recreate a DETACHED worktree at `candidateSha` (a torn-down candidate) so the gate can read the edit in
 *  place. Path is a sibling `.piflow-optimize-worktrees/<repo>/<node>/<issue>/verify`, idempotently reset. */
async function recreateCandidateWorktree(repoRoot: string, node: string, issue: string, candidateSha: string): Promise<string> {
  const root = path.resolve(repoRoot);
  const wtPath = path.join(path.dirname(root), '.piflow-optimize-worktrees', path.basename(root), node, issue, 'verify');
  try { git(root, 'worktree', 'remove', '--force', wtPath); } catch { /* none to remove */ }
  await fs.rm(wtPath, { recursive: true, force: true });
  await fs.mkdir(path.dirname(wtPath), { recursive: true });
  git(root, 'worktree', 'add', '--detach', wtPath, candidateSha);
  return wtPath;
}

/**
 * Verify ONE issue's candidate: read its record (or the injected `baseRecord`), run the gate agent against the
 * already-proved child + the candidate worktree, write `verdict.json` + the finalized `record.json` under the
 * lifecycle dir, and land the issue's status (a REJECT walks a `verifying` issue back to `open`). NEVER re-runs
 * the fixer and NEVER re-proves. A record with no `candidateSha` (a pre-WS0 copy candidate) cannot be gated.
 */
export async function verifyStage(
  target: string | { runDir: string; node: string; issue: string },
  opts: VerifyStageOpts,
): Promise<VerifyStageResult> {
  const lifecycleDir = typeof target === 'string' ? target : issueLifecycleDir(target.runDir, target.node, target.issue);
  const emit = (e: SubstrateEvent): void => safeEmit(opts.onEvent, e);

  // (a) the candidate record: fixIssue passes it inline (record.json not written yet); standalone reads it.
  let base = opts.baseRecord;
  if (!base) {
    const file = path.join(lifecycleDir, 'record.json');
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (e) {
      throw new Error(`verifyStage: no record.json at ${file} — nothing to verify (run 'optimize fix' first): ${(e as Error).message}`);
    }
    base = JSON.parse(raw) as SubstrateManifestRecord;
  }
  const { node, issue } = base;
  const workspace = opts.workspace ?? base.liveRoot;
  const issuePath = opts.issuePath ?? path.join(opts.templateDir, 'nodes', node, 'issues', `${issue}.md`);

  // A git-native candidate IS a candidateSha; a record without one (a pre-WS0 copy candidate) cannot be gated.
  if (!base.candidateSha) {
    throw new Error(
      `verifyStage: record for ${node}/${issue} has no candidateSha — a copy-based / no-edit candidate cannot be git-gated (re-fix it under the candidate-as-commit model).`,
    );
  }

  // (a2) THE ORACLE FENCE TRAVELS (Defect 1): before the gate, re-derive the deterministic oracle guard off the
  // candidate commit. An oracle-touched candidate is a FIXER-SIDE rejection — it can NEVER be gate-accepted (else
  // adopt would cherry-pick a scorer/criteria tamper into the live product). Finalize it discarded with the
  // oracle reason and walk a `verifying` issue back to `open`, exactly like fixIssue's own diff-guard — no gate,
  // no worktree recreated.
  const baseRef = base.baseSha ?? `${base.candidateSha}~1`;
  if (await candidateTouchesOracle(opts.templateDir, node, workspace, baseRef, base.candidateSha)) {
    const reason = 'candidate diff touched an oracle path (optimize.measure/criteria) — fixer-side rejection, never gated';
    const rejectVerdict: GateVerdictFile = { decision: 'reject', rationale: reason, category: 'reward-hack' };
    emit({ type: 'gated', issue, accept: false, reason });
    const record: SubstrateManifestRecord = { ...base, decision: 'discarded', landPolicy: 'stage-for-human', reason };
    delete record.dropback;
    await fs.mkdir(lifecycleDir, { recursive: true });
    await fs.writeFile(path.join(lifecycleDir, 'record.json'), JSON.stringify(record, null, 2));
    const cur = await parseIssueFile(issuePath);
    if (cur.status === 'verifying') await transitionIssue(issuePath, 'open');
    return { decision: 'discarded', gateVerdict: rejectVerdict, record };
  }

  // (b) the candidate worktree the gate reads: an EXISTING checkout is used in place; a torn-down one is
  // recreated at candidateSha (and torn down again in the finally).
  let worktreeDir = opts.candidateRef;
  let createdWorktree = false;
  if (!worktreeDir || !(await pathExists(worktreeDir))) {
    worktreeDir = await recreateCandidateWorktree(workspace, node, issue, base.candidateSha);
    createdWorktree = true;
  }

  try {
    // (c) the gate agent — the SAME `runSubstrateGate` fixIssue uses; verdict.json lands under the lifecycle dir.
    const runGate = opts.gate ?? runSubstrateGate;
    const gateRes = await runGate(opts.childDir, node, {
      workspace,
      templateDir: opts.templateDir,
      issueFileText: opts.issueFileText ?? (await fs.readFile(issuePath, 'utf8')),
      fixerDiff: '', // the gate inspects the candidate worktree (candidateRef, in its read scope) directly
      fixerAccount: opts.fixerAccount ?? '',
      candidateRef: worktreeDir,
      gateOutDir: lifecycleDir,
      ...inheritedAgentOpts(opts),
    });
    const gateVerdict = gateRes.verdict;
    if (!gateVerdict) throw new Error(`verifyStage: the gate agent for node "${node}" returned no verdict`);

    const decision: 'staged' | 'discarded' = gateVerdict.decision === 'accept' ? 'staged' : 'discarded';
    const dropback =
      gateVerdict.decision === 'reject' && gateVerdict.category
        ? { category: gateVerdict.category, ...(gateVerdict.steer ? { steer: gateVerdict.steer } : {}) }
        : undefined;
    emit({ type: 'gated', issue, accept: decision === 'staged', reason: gateVerdict.rationale });

    // (d) finalize record.json under the lifecycle dir (decision + landPolicy + reason + drop-back). Any stale
    // drop-back from a prior reject is stripped on an accept.
    const record: SubstrateManifestRecord = {
      ...base,
      decision,
      landPolicy: 'stage-for-human',
      reason: gateVerdict.rationale,
      ...(dropback ? { dropback } : {}),
    };
    if (!dropback) delete record.dropback;
    await fs.mkdir(lifecycleDir, { recursive: true });
    await fs.writeFile(path.join(lifecycleDir, 'record.json'), JSON.stringify(record, null, 2));

    // (e) issue status: a proven-REJECT walks a `verifying` issue back to `open` (nothing landed); an ACCEPT
    // stays at `verifying` for the human adopt. Guarded so a standalone re-verify of a non-verifying issue no-ops.
    if (decision === 'discarded') {
      const cur = await parseIssueFile(issuePath);
      if (cur.status === 'verifying') await transitionIssue(issuePath, 'open');
    }

    return {
      decision,
      gateVerdict,
      ...(dropback ? { dropback } : {}),
      record,
      ...(gateRes.verdictPath ? { verdictPath: gateRes.verdictPath } : {}),
    };
  } finally {
    if (createdWorktree) removeCandidateWorktree(workspace, worktreeDir);
  }
}

// ── reproveCandidate — the adopt-train re-prove seam's shipped implementation (WS-B5, §6 table row 3) ────────
// On a closure-OVERLAP staleness verdict the train must RE-PROVE the fix against the MOVED HEAD before landing:
// REBUILD the candidate on current HEAD (cherry-pick candidateSha into a scratch worktree at HEAD — so the node
// runs against HEAD+fix, "measure vs fresh base"), re-run the node there, measure the child vs the LIVE root,
// and gate the fresh graded delta with the SAME foldGradedDelta + evaluateGate rules fixIssue uses. ACCEPT ⇒
// return the HEAD-rebuilt sha (adopt lands THAT non-stale commit, not the original). FAIL-SAFE: a cherry-pick
// CONFLICT (the real base-drift collision), a regressed/flat delta, or ANY spawn/measure error ⇒ reject, so the
// train BOUNCES — this seam can only ever turn a bounce into a proven land, never force-land on error.

export interface ReproveCandidateOpts {
  /** the product template dir (`nodes/<id>/node.json`; the child run loads the template from here). */
  templateDir: string;
  /** the parent run being optimized — the re-prove's baseline graded (`measure.<node>.json`) is read from here,
   *  and `spawnChildRun` replays the node off it. */
  parentRunDir: string;
  /** graded-delta knobs (mirror fixIssue's fold). */
  tolerance?: number;
  lowerIsBetter?: (key: string) => boolean;
  /** test/offline seams (default the real fns; a test injects fakes so the re-prove never live-spawns). */
  spawnChild?: (parentRunDir: string, nodeId: string, opts: SpawnChildRunOpts) => Promise<SpawnChildRunResult>;
  measure?: (runDir: string, nodeId: string, opts: RunSubstrateMeasureOpts) => Promise<MeasureReport>;
}

/** Rebuild a candidate ON current HEAD: a fresh DETACHED worktree at HEAD + `cherry-pick candidateSha`, so the
 *  re-prove runs the node against HEAD+fix (not the stale-base tree). Aborts + tears down on a cherry-pick
 *  CONFLICT (a real base-drift collision) then rethrows — the caller fail-safe-bounces. Path is a sibling
 *  `.piflow-optimize-worktrees/<repo>/<node>/<issue>/reprove`, idempotently reset. */
async function rebuildOnHeadWorktree(repoRoot: string, node: string, issue: string, candidateSha: string): Promise<{ wtPath: string; sha: string }> {
  const root = path.resolve(repoRoot);
  const wtPath = path.join(path.dirname(root), '.piflow-optimize-worktrees', path.basename(root), node, issue, 'reprove');
  try { git(root, 'worktree', 'remove', '--force', wtPath); } catch { /* none to remove */ }
  await fs.rm(wtPath, { recursive: true, force: true });
  await fs.mkdir(path.dirname(wtPath), { recursive: true });
  git(root, 'worktree', 'add', '--detach', wtPath, 'HEAD');
  try {
    git(wtPath, '-c', 'commit.gpgsign=false', '-c', 'user.name=piflow-optimizer', '-c', 'user.email=optimizer@piflow.local', 'cherry-pick', candidateSha);
  } catch (e) {
    try { git(wtPath, 'cherry-pick', '--abort'); } catch { /* not mid-pick */ }
    removeCandidateWorktree(root, wtPath);
    throw e;
  }
  return { wtPath, sha: git(wtPath, 'rev-parse', 'HEAD') };
}

/**
 * RE-PROVE a stale-base staged candidate against the moved HEAD (the shipped `AdoptSubstrateManifestOpts.reprove`
 * default; §6 table row 3). Rebuilds the candidate on HEAD, re-runs the node there, measures vs the LIVE root,
 * and gates the graded delta. Returns `{ accept, reason, candidateSha }` — on ACCEPT the `candidateSha` is the
 * HEAD-rebuilt sha so adopt lands it (not the stale one). FAIL-SAFE: conflict / regression / any error ⇒
 * `{ accept:false }` (the train bounces). Injected spawnChild/measure keep it unit-testable (never live-spawns a test).
 */
export async function reproveCandidate(record: SubstrateManifestRecord, opts: ReproveCandidateOpts): Promise<{ accept: boolean; reason: string; candidateSha?: string }> {
  const candidateSha = record.candidateSha;
  if (!candidateSha) return { accept: false, reason: 're-prove: record has no candidateSha to rebuild' };
  const spawnChild = opts.spawnChild ?? spawnChildRun;
  const measure = opts.measure ?? runSubstrateMeasure;
  const root = path.resolve(record.liveRoot);

  let rebuilt: { wtPath: string; sha: string };
  try {
    rebuilt = await rebuildOnHeadWorktree(root, record.node, record.issue, candidateSha);
  } catch (e) {
    return { accept: false, reason: `re-prove could not rebuild on HEAD (cherry-pick conflict / git error): ${(e as Error).message}` };
  }
  try {
    // Re-run the node against the HEAD+fix worktree, then measure the child against the LIVE (pristine) root.
    const child = await spawnChild(opts.parentRunDir, record.node, {
      templateDir: opts.templateDir,
      workspace: rebuilt.wtPath,
      spawnedBy: { by: 'substrate-reprove', issue: record.issue, issueId: record.issueId },
    });
    const childReport = await measure(child.childDir, record.node, { workspace: root });
    const fold = foldGradedDelta(await readParentGraded(opts.parentRunDir, record.node), childReport.graded, {
      ...(opts.tolerance !== undefined ? { tolerance: opts.tolerance } : {}),
      ...(opts.lowerIsBetter ? { lowerIsBetter: opts.lowerIsBetter } : {}),
    });
    const verdict = evaluateGate({ bucket: SUBSTRATE_GATE_BUCKET, base: fold.base, candidate: fold.candidate, editsApplied: 1 });
    if (!verdict.accept) return { accept: false, reason: `re-prove gate rejected against fresh HEAD: ${verdict.reason}` };
    return { accept: true, reason: `re-prove gate accepted against fresh HEAD: ${verdict.reason}`, candidateSha: rebuilt.sha };
  } catch (e) {
    return { accept: false, reason: `re-prove failed (spawn/measure error): ${(e as Error).message}` };
  } finally {
    removeCandidateWorktree(root, rebuilt.wtPath);
  }
}

// ── adoptSubstrateManifest — the SEPARATE human ADOPT step, git-native (cherry-pick; WS0) ────────────────────

export interface AdoptSubstrateManifestOpts {
  /** the template dir — to reconstruct each issue's `<templateDir>/nodes/<node>/issues/<name>.md` path. */
  templateDir: string;
  /** ACCEPTED for CLI back-compat but UNUSED by the commit-based landing — git history/reflog is the recovery
   *  path for a cherry-pick (no per-file `.bak` copy, unlike the old file-copy adopt). */
  backupDir?: string;
  /** WS-B5 TRAIN: the blame-derived upstream-first node order the records land in (before node/issue asc).
   *  Absent ⇒ pure node-asc then issue-asc — completion order NEVER dictates landing order regardless. */
  nodeOrder?: string[];
  /** WS-B5 TRAIN: the parent run dir — needed to locate each issue's lifecycle `record.json` when a stale-base
   *  BOUNCE must rewrite it (`discarded` + stale-base dropback). ABSENT ⇒ the bounce degrades to the issue
   *  walk-back + skip reason only (a record alone can't name its lifecycle dir). */
  runDir?: string;
  /** WS-B5 TRAIN: the re-prove seam for a `closure-overlap` staleness verdict — spawn a fresh child run against
   *  the moved HEAD + re-gate. `accept` ⇒ land (with a re-proved note); reject/absent ⇒ BOUNCE. Injected (never
   *  a live spawn in core): the CLI/product wires it (the shipped default is `reproveCandidate`).
   *  A re-prove that REBUILT the candidate on the moved HEAD returns that fresh `candidateSha` so adopt lands the
   *  HEAD-rebuilt (non-stale) commit instead of the original — the accept branch lands `candidateSha ?? the
   *  original` and re-runs the oracle backstop on any substitute before the pick. */
  reprove?: (record: SubstrateManifestRecord) => Promise<{ accept: boolean; reason: string; candidateSha?: string }>;
  /** WS-B5 TRAIN: GC the throwaway `optimize/<node>/<issue>/*` branches after a land+resolve. Default TRUE; the
   *  CLI `--no-gc` threads false. NEVER GCs a skip/bounce (an escalation candidate keeps its branch). */
  gcBranches?: boolean;
  onEvent?: SubstrateEventSink;
}

export interface AdoptSubstrateManifestResult {
  /** `note` (WS-B5) rides a land under BASE DRIFT: a closure-disjoint drift, or a re-proved-against-HEAD land. */
  adopted: { issue: string; node: string; commit: string; files: string[]; note?: string }[];
  skipped: { issue: string; reason: string }[];
}

/** Cherry-pick `candidateSha` onto `liveRoot`'s current branch, returning the landed commit sha + its changed
 *  files. Throws on a conflict/empty pick (the caller aborts + skips). `-c commit.gpgsign=false` so a
 *  signing-configured host never blocks the pick. */
function cherryPickCandidate(liveRoot: string, candidateSha: string): { sha: string; files: string[] } {
  const root = path.resolve(liveRoot);
  // `-c user.name/email` so a headless host with no git identity can still author the cherry-pick commit.
  git(root, '-c', 'commit.gpgsign=false', '-c', 'user.name=piflow-optimizer', '-c', 'user.email=optimizer@piflow.local', 'cherry-pick', candidateSha);
  const sha = git(root, 'rev-parse', 'HEAD');
  const files = git(root, 'diff-tree', '--no-commit-id', '--name-only', '-r', sha).split('\n').filter(Boolean);
  return { sha, files };
}

/** WS-B5 branch GC: delete every throwaway `refs/heads/optimize/<node>/<issue>/*` branch on the live repo. The
 *  landed cherry-pick sha stamped in the issue attempt is the durable record, so this is BEST-EFFORT per branch
 *  — a branch that will not delete (checked out, already gone, no such repo) never fails the adopt. NEVER called
 *  on a skip/bounce (an escalation candidate keeps its branch). */
function gcIssueBranches(repoRoot: string, node: string, issue: string): void {
  const root = path.resolve(repoRoot);
  let refs: string[];
  try {
    refs = git(root, 'for-each-ref', '--format=%(refname:short)', `refs/heads/optimize/${node}/${issue}/`).split('\n').filter(Boolean);
  } catch {
    return; // not a repo / no such refs — nothing to GC
  }
  for (const ref of refs) {
    try { git(root, 'branch', '-D', ref); } catch { /* best-effort: the landed sha is the record, not the branch */ }
  }
}

/** The stale-base dropback STEER for the next fixer — names the closure blast so a retry aims at current HEAD.
 *  Prose only (never machine-read; the `category:'stale-base'` is the typed signal). */
function staleBaseSteer(overlapCount: number, readableDiff: boolean): string {
  const blast = readableDiff
    ? `${overlapCount} intervening change${overlapCount === 1 ? '' : 's'} touching the node closure`
    : 'its intervening diff could not be read — re-proving conservatively';
  return `the live baseline moved under this fix (${blast}) — re-fix against current HEAD`;
}

/** A stale-base BOUNCE (WS-B5): the record is NOT picked. Rewrite its lifecycle `record.json` → `discarded` + a
 *  `{category:'stale-base'}` dropback (ONLY when `opts.runDir` is known — a record alone can't name its
 *  lifecycle dir, so without it the bounce DEGRADES to the walk-back + skip reason), then walk the issue back to
 *  `open` by the LEGAL edge only (guarded by `assertTransition`): `verifying → open` (proven) or `fix-landed →
 *  open` (skip-proof) — both re-fixable. Only a status with no legal edge to `open` is LEFT (skip reason honest). */
async function bounceStaleBase(record: SubstrateManifestRecord, opts: AdoptSubstrateManifestOpts, steer: string): Promise<void> {
  if (opts.runDir) {
    const dir = issueLifecycleDir(opts.runDir, record.node, record.issue);
    const bounced: SubstrateManifestRecord = {
      ...record,
      decision: 'discarded',
      reason: 'stale base (closure overlap) — bounced, not landed',
      dropback: { category: 'stale-base', steer },
    };
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'record.json'), JSON.stringify(bounced, null, 2));
  }
  const issuePath = path.join(opts.templateDir, 'nodes', record.node, 'issues', `${record.issue}.md`);
  try {
    const cur = await parseIssueFile(issuePath);
    let toOpen = false;
    try { assertTransition(cur.status, 'open'); toOpen = true; } catch { /* no legal edge to open (e.g. fix-landed) */ }
    if (toOpen) await transitionIssue(issuePath, 'open');
  } catch {
    /* unreadable issue file — the record rewrite (if any) + the skip reason already record the bounce */
  }
}

/**
 * Adopt every `staged` record of a substrate manifest into the live product by `git cherry-pick candidateSha`
 * onto its `liveRoot` (the candidate commit already carries the subject + `Issue:` trailer identity), then
 * `stampAttempt({commit: the landed sha, verifiedByRun})` and transition the issue → `resolved` (reason
 * `fixed`) — the fix-landed→resolved (skip) or verifying→resolved (prove) edge. A record with no `candidateSha`
 * (a no-edit/oracle-touched discard) is skipped up front; a re-adopt whose changes are already present is an
 * empty pick → aborted + skipped (a natural no-op).
 *
 * The WS-B5 TRAIN wraps that core: records land in `orderRecords(records, nodeOrder)` order; each staged record
 * first passes the pure `assessStaleness` verdict (fresh ⇒ land · disjoint ⇒ land WITH a base-drift note ·
 * overlap ⇒ re-prove via `opts.reprove` or BOUNCE `verifying → open` with a stale-base dropback); a
 * conflicting pick still ABORTS + skips (the last resort); and a land+resolve GCs the issue's throwaway
 * branches unless `opts.gcBranches === false`. Every skip/bounce is written into the record reason + the stream.
 */
export async function adoptSubstrateManifest(
  manifest: SubstrateManifest,
  opts: AdoptSubstrateManifestOpts,
): Promise<AdoptSubstrateManifestResult> {
  const emit = (e: SubstrateEvent): void => safeEmit(opts.onEvent, e);
  const gcBranches = opts.gcBranches ?? true;

  const result: AdoptSubstrateManifestResult = { adopted: [], skipped: [] };
  // (a) TRAIN order — completion order NEVER dictates landing order (§6): blame node order first, then node/issue asc.
  for (const record of orderRecords(manifest.records, opts.nodeOrder)) {
    if (record.decision !== 'staged') {
      result.skipped.push({ issue: record.issue, reason: `decision is "${record.decision}" (not staged)` });
      continue;
    }
    if (!record.candidateSha) {
      result.skipped.push({ issue: record.issue, reason: 'no candidate commit (candidateSha) to land' });
      continue;
    }
    const candidateSha = record.candidateSha; // pin a local — never re-narrow the record property across awaits
    // FINAL BACKSTOP (Defect 1): never cherry-pick an oracle-touched candidate into the live product, even if a
    // stale/tampered staged record slipped past the fixer-side guard + verifyStage. (Runs BEFORE staleness.)
    const oracleBaseRef = record.baseSha ?? `${candidateSha}~1`;
    if (await candidateTouchesOracle(opts.templateDir, record.node, record.liveRoot, oracleBaseRef, candidateSha)) {
      result.skipped.push({ issue: record.issue, reason: 'candidate diff touches an oracle path (optimize.measure/criteria) — refusing to land' });
      continue;
    }

    const root = path.resolve(record.liveRoot);

    // (b) STALENESS (WS-B5) — the pure verdict over (baseSha, HEAD, intervening paths, the node closure), BEFORE
    // the pick. The git reads DEGRADE (an unreadable intervening diff ⇒ undefined ⇒ conservative overlap; an
    // unreadable node.json ⇒ empty closure), never throw the whole adopt.
    let headSha: string;
    try { headSha = git(root, 'rev-parse', 'HEAD'); } catch { headSha = record.baseSha ?? ''; }
    let interveningPaths: string[] | undefined;
    if (record.baseSha) {
      try { interveningPaths = git(root, 'diff', '--name-only', record.baseSha, 'HEAD').split('\n').filter(Boolean); }
      catch { interveningPaths = undefined; }
    }
    let closure: string[] = [];
    try { ({ include: closure } = await readClosureRefs(opts.templateDir, record.node)); } catch { closure = []; }
    const verdict = assessStaleness({ baseSha: record.baseSha, headSha, interveningPaths, closure });

    // (c) OVERLAP ⇒ re-prove-or-bounce; disjoint carries a base-drift note; fresh lands clean.
    let landNote: string | undefined;
    let landSha = candidateSha; // the sha adopt actually cherry-picks — a re-prove may substitute a HEAD-rebuilt one.
    if (verdict === 'disjoint') {
      landNote = 'landed with base drift (closure-disjoint)';
    } else if (verdict === 'overlap') {
      const rp = opts.reprove ? await opts.reprove(record) : null;
      if (!rp || !rp.accept) {
        const overlap = (interveningPaths ?? []).filter((p) => pathInClosure(p, closure));
        await bounceStaleBase(record, opts, staleBaseSteer(overlap.length, interveningPaths !== undefined));
        emit({ type: 'stopped', issue: record.issue, reason: 'bounced (stale base)' });
        result.skipped.push({ issue: record.issue, reason: 'stale base (closure overlap) — bounced, not landed' });
        continue;
      }
      // A re-prove that REBUILT the candidate on the moved HEAD hands back that fresh sha — land THAT (non-stale)
      // commit, but only after the SAME oracle backstop clears it (never cherry-pick a rebuilt scorer-tamper).
      if (rp.candidateSha && rp.candidateSha !== candidateSha) {
        if (await candidateTouchesOracle(opts.templateDir, record.node, root, `${rp.candidateSha}~1`, rp.candidateSha)) {
          result.skipped.push({ issue: record.issue, reason: 're-proved candidate touches an oracle path (optimize.measure/criteria) — refusing to land' });
          continue;
        }
        landSha = rp.candidateSha;
        landNote = `re-proved against ${headSha.slice(0, 7)} (HEAD-rebuilt candidate)`;
      } else {
        landNote = `re-proved against ${headSha.slice(0, 7)}`;
      }
    }

    // (d) LAND — cherry-pick landSha (the shipped conflict⇒abort+skip stays the last resort).
    let landed: { sha: string; files: string[] };
    try {
      landed = cherryPickCandidate(root, landSha);
    } catch (e) {
      const out = `${(e as { stdout?: Buffer }).stdout ?? ''}${(e as { stderr?: Buffer }).stderr ?? ''}`;
      try { git(root, 'cherry-pick', '--abort'); } catch { /* not mid-pick — nothing to abort */ }
      const empty = /empty|nothing to commit|allow-empty/i.test(out);
      result.skipped.push({
        issue: record.issue,
        reason: empty
          ? 'candidate already applied (empty cherry-pick) — nothing to land'
          : 'cherry-pick conflict (base drift) — aborted, not landed',
      });
      continue;
    }

    const issuePath = path.join(opts.templateDir, 'nodes', record.node, 'issues', `${record.issue}.md`);
    await stampAttempt(issuePath, { commit: landed.sha, verifiedByRun: record.verifiedByRun ?? UNPROVEN_BY_RUN });
    await transitionIssue(issuePath, 'resolved', { reason: 'fixed' }); // fix-landed→resolved | verifying→resolved
    // (e) BRANCH GC (default ON) — only on a successful land+resolve; a skip/bounce keeps its branch.
    if (gcBranches) gcIssueBranches(root, record.node, record.issue);
    emit({ type: 'adopted', issue: record.issue, commit: landed.sha, files: landed.files.length, ...(landNote ? { note: landNote } : {}) });
    result.adopted.push({ issue: record.issue, node: record.node, commit: landed.sha, files: landed.files, ...(landNote ? { note: landNote } : {}) });
  }
  return result;
}
