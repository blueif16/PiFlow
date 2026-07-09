// optimize/substrate/issues.ts — the M2 ISSUE LEDGER (docs/specs/optimize-substrate-plan.md §M2). The second
// optimization system's worklist: one markdown file per issue, `<templateDir>/nodes/<node>/issues/<name>.md` —
// the DIRECTORY is the table, a single file is the row. Distinct from the shipped `optimize/` §7 Score+Triage
// worklist (types.ts `Defect`) — this is the substrate's own durable, reopenable record, one file per defect.
//
// FRONTMATTER FORMAT (no yaml dependency in @piflow/core today — @piflow/core/package.json carries only
// ajv/ajv-formats/esbuild/the MCP sdk, no yaml/js-yaml/gray-matter; adding one is out of this milestone's
// scope, so we PIN a strict, minimal, versioned-by-convention format instead):
//   ---
//   <key>: <value>      — one scalar per line, in the FIXED order below, "key: value" (split on the FIRST
//                          ": " so a value may itself contain a bare colon, e.g. a title). `reason: null`
//                          is the literal word `null`, not JSON.
//   attempts: [...]      — a SINGLE-LINE JSON array (the one structured field), e.g.
//                          `attempts: [{"commit":"c1","verifiedByRun":"tS2.gameplay"}]`.
//   ---
//   <body>                — everything after the closing delimiter, verbatim (the ~30–40 line context brief).
// The parser is FAIL-CLOSED: a missing key, an extra/unknown key, a duplicate key, a line without ": ", an
// unparseable `attempts`, or any structurally-invalid value throws — never a silent best-effort read. This is
// deliberately narrower than YAML: no nesting, no multi-line scalars, no quoting layer. If a richer format is
// ever needed, swap this module's parse/render pair for a real YAML lib without touching the Issue shape.
//
// IDENTITY (id/name/firstSeen are TOOL-computed only — an agent draft never authors them):
//   id   = sha256("v1\n" + nodeId + "\n" + sig") — a PURE function of the STABLE identity line only. Title,
//          prose, severity, attempts, timestamps are EXCLUDED from the hash on purpose: rewriting the human-
//          facing context brief on every reopen (per the plan) must never mint a new id.
//   name = a pie name minted via the EXISTING `generateRunName` (names/generator.ts) against the issue names
//          already on file — reused verbatim, not re-implemented here.
// Dedup/reopen is two-layer: an agent's semantic re-read of the ledger is the PRIMARY path (M4); computeIssueId
// is the MECHANICAL backstop — two drafts with the same (nodeId, sig) always resolve to the same id, so a
// caller that looks the id up via `listIssues` finds the SAME file instead of minting a duplicate.
//
// STATUS MACHINE (guards throw on any edge outside this graph — piflow-memory-v1.5 grilling, contract lane):
//   open → active → fix-landed → verifying → resolved         (the full fix cycle)
//                     fix-landed ────────────→ resolved        (skip-proof path, proving configured off)
//                                  verifying ──→ open           (proven-REJECT: the prove-rerun's candidate did
//                                                                NOT improve — walk back to `open`, reason null,
//                                                                NO attempt stamped: nothing landed. Re-attemptable.)
//                                               resolved → regressed  (reopen: hash re-match of a resolved issue)
//                                               regressed → active   (regressed behaves like `open` for selection/dispatch)
// `reason` (fixed|wontfix|false-positive|superseded) is set ONLY alongside a transition INTO `resolved`, and is
// cleared back to null the moment an issue is reopened (a regressed issue is no longer "closed").
//
// `attempts` is APPEND-ONLY: writeIssueFile enforces it on every overwrite of an existing file — no existing
// row's fields may change and no row may be dropped, with exactly ONE sanctioned exception: `reopen()` may
// attach `regressedIn` to the LAST existing row (and only that field, only on that row). Any other mutation of
// a past row is rejected before a single byte is written.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// ── the data shape ──────────────────────────────────────────────────────────────────────────────────────

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type Status = 'open' | 'active' | 'fix-landed' | 'verifying' | 'resolved' | 'regressed';
export type Reason = 'fixed' | 'wontfix' | 'false-positive' | 'superseded';
/** Per-issue VERIFY TIER (WS3) — how much proof a fix of THIS issue must earn before it can rest adopt-ready:
 *  `none` (trivial/typo — commit, no rerun, no gate), `rerun` (prove + the numeric gate only), `full` (prove +
 *  the gate agent). Absent from an issue ⇒ the node's `optimize.verifyDefault` (itself defaulting to `full`). */
export type VerifyTier = 'none' | 'rerun' | 'full';

/** One row in an issue's append-only attempt history. `regressedIn` is stamped ONLY by `reopen()`. */
export interface Attempt {
  commit: string;
  verifiedByRun: string;
  /** set by `reopen()` on the LAST row when the fix that landed this attempt regressed. */
  regressedIn?: string;
}

/** One issue file, parsed: the frontmatter fields + the verbatim markdown context brief. */
export interface Issue {
  /** `sha256:<hex>` — TOOL-computed from (nodeId, sig); never hand-authored. */
  id: string;
  /** a pie name (names/generator.ts) — TOOL-minted; the file is named `<name>.md`. */
  name: string;
  /** rewritable one-liner. */
  title: string;
  severity: Severity;
  status: Status;
  /** set ONLY on a transition into `resolved`; null otherwise (incl. after a reopen). */
  reason: Reason | null;
  /** the STABLE identity line the id hashes over — mechanical for hard-check issues, agent-authored for judge issues. */
  sig: string;
  /** TOOL-computed on first mint; never changes after. */
  firstSeen: string;
  /** updated whenever the issue is re-observed (incl. on reopen). */
  lastSeen: string;
  /** append-only fix history. */
  attempts: Attempt[];
  /** OPTIONAL per-issue verify tier (WS3) — none|rerun|full. Absent ⇒ the node's `optimize.verifyDefault` (→
   *  `full`). The ONE optional frontmatter key: omitted from the on-disk file when unset, so a pre-WS3 issue
   *  round-trips byte-for-byte unchanged. */
  verify?: VerifyTier;
  /** the ~30–40 line context brief, rewritten by triage on every reopen; verbatim below the frontmatter. */
  body: string;
}

const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low'];
const STATUSES: readonly Status[] = ['open', 'active', 'fix-landed', 'verifying', 'resolved', 'regressed'];
const REASONS: readonly Reason[] = ['fixed', 'wontfix', 'false-positive', 'superseded'];
const VERIFY_TIERS: readonly VerifyTier[] = ['none', 'rerun', 'full'];

/** The frontmatter's REQUIRED keys, in the FIXED serialization order (also the required-key set the parser
 *  enforces — every one MUST be present). */
const FRONTMATTER_KEYS = ['id', 'name', 'title', 'severity', 'status', 'reason', 'sig', 'firstSeen', 'lastSeen', 'attempts'] as const;
/** OPTIONAL frontmatter keys — ALLOWED but never required. A pre-WS3 file omits them entirely (byte-stable);
 *  a `verify` line renders BEFORE `attempts` only when the tier is set. Kept off `FRONTMATTER_KEYS` so the
 *  fail-closed missing-key check never demands them. */
const OPTIONAL_FRONTMATTER_KEYS = ['verify'] as const;
const KNOWN_FRONTMATTER_KEYS = new Set<string>([...FRONTMATTER_KEYS, ...OPTIONAL_FRONTMATTER_KEYS]);

// ── identity: the hash recipe ───────────────────────────────────────────────────────────────────────────

/**
 * `id = sha256("v1\n" + nodeId + "\n" + sig)`, rendered as `sha256:<hex>`. PURE — a function of the node id
 * and the STABLE `sig` line ONLY. Title/severity/prose/attempts/timestamps never enter the hash: rewriting an
 * issue's context brief (the plan's documented reopen behavior) must never mint a new identity. The `"v1\n"`
 * prefix versions the recipe — a future v2 recipe would prefix differently rather than silently reinterpret
 * old ids.
 */
export function computeIssueId(nodeId: string, sig: string): string {
  return 'sha256:' + createHash('sha256').update(`v1\n${nodeId}\n${sig}`).digest('hex');
}

// ── validateIssue — the standalone, fail-closed structural validator ───────────────────────────────────────

/** Throw a uniformly-prefixed validation error. */
function invalid(msg: string): never {
  throw new Error(`invalid issue: ${msg}`);
}

/**
 * Validate an in-memory `Issue`'s structural + business-rule invariants. FAIL-CLOSED: anything not exactly
 * right throws, never coerces/defaults. Called by `writeIssueFile` before every write and by `parseIssueFile`
 * after every parse, so a caller never observes/persists a half-valid issue.
 */
export function validateIssue(issue: Issue): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(issue.id)) invalid(`id must be "sha256:<64-hex>", got ${JSON.stringify(issue.id)}`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(issue.name)) invalid(`name must be a lowercase kebab slug, got ${JSON.stringify(issue.name)}`);
  if (!issue.title || issue.title.includes('\n')) invalid('title must be a non-empty single line');
  if (!SEVERITIES.includes(issue.severity)) invalid(`severity must be one of ${SEVERITIES.join('|')}, got ${JSON.stringify(issue.severity)}`);
  if (!STATUSES.includes(issue.status)) invalid(`status must be one of ${STATUSES.join('|')}, got ${JSON.stringify(issue.status)}`);
  if (issue.status === 'resolved') {
    if (!issue.reason || !REASONS.includes(issue.reason)) invalid(`reason must be set to one of ${REASONS.join('|')} when status is resolved`);
  } else if (issue.reason !== null) {
    invalid('reason must be null unless status is resolved (set only on close)');
  }
  if (!issue.sig || issue.sig.includes('\n')) invalid('sig must be a non-empty single line');
  if (!issue.firstSeen || issue.firstSeen.includes('\n')) invalid('firstSeen must be a non-empty single line');
  if (!issue.lastSeen || issue.lastSeen.includes('\n')) invalid('lastSeen must be a non-empty single line');
  if (!Array.isArray(issue.attempts)) invalid('attempts must be an array');
  const allowedAttemptKeys = ['commit', 'verifiedByRun', 'regressedIn'];
  issue.attempts.forEach((a, i) => {
    if (!a || typeof a !== 'object') invalid(`attempts[${i}] must be an object`);
    for (const k of Object.keys(a)) if (!allowedAttemptKeys.includes(k)) invalid(`attempts[${i}] has unknown key "${k}"`);
    if (typeof a.commit !== 'string' || !a.commit) invalid(`attempts[${i}].commit must be a non-empty string`);
    if (typeof a.verifiedByRun !== 'string' || !a.verifiedByRun) invalid(`attempts[${i}].verifiedByRun must be a non-empty string`);
    if (a.regressedIn !== undefined && (typeof a.regressedIn !== 'string' || !a.regressedIn))
      invalid(`attempts[${i}].regressedIn must be a non-empty string when present`);
  });
  if (issue.verify !== undefined && !VERIFY_TIERS.includes(issue.verify))
    invalid(`verify must be one of ${VERIFY_TIERS.join('|')} when present, got ${JSON.stringify(issue.verify)}`);
}

// ── the strict minimal frontmatter codec (parse/render pair; see the module header for the format) ─────────

/** Split the frontmatter block into `key → raw value`, FAILING CLOSED on anything not "key: value" (one per line). */
function parseFrontmatterLines(block: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const raw of block.split('\n')) {
    if (raw === '') continue; // a blank line inside the block is tolerated (never required)
    const idx = raw.indexOf(': ');
    if (idx === -1) throw new Error(`malformed issue frontmatter line (expected "key: value"): ${JSON.stringify(raw)}`);
    const key = raw.slice(0, idx);
    if (key in map) throw new Error(`duplicate issue frontmatter key: ${key}`);
    map[key] = raw.slice(idx + 2);
  }
  return map;
}

/** Parse one issue file's RAW text into an `Issue`. FAIL-CLOSED on any structural deviation from the format. */
function parseIssueContent(raw: string): Issue {
  const lines = raw.split('\n');
  if (lines[0] !== '---') throw new Error('issue file must open with a "---" frontmatter delimiter');
  const closeIdx = lines.indexOf('---', 1);
  if (closeIdx === -1) throw new Error('issue file frontmatter is never closed with a second "---"');
  const map = parseFrontmatterLines(lines.slice(1, closeIdx).join('\n'));
  const body = lines.slice(closeIdx + 1).join('\n');

  const missing = FRONTMATTER_KEYS.filter((k) => !(k in map));
  if (missing.length) throw new Error(`issue frontmatter missing required key(s): ${missing.join(', ')}`);
  const extra = Object.keys(map).filter((k) => !KNOWN_FRONTMATTER_KEYS.has(k));
  if (extra.length) throw new Error(`issue frontmatter has unknown key(s): ${extra.join(', ')}`);

  let attempts: unknown;
  try {
    attempts = JSON.parse(map.attempts);
  } catch {
    throw new Error(`attempts must be a single-line JSON array, got: ${map.attempts}`);
  }
  if (!Array.isArray(attempts)) throw new Error('attempts must be a JSON array');

  const issue: Issue = {
    id: map.id,
    name: map.name,
    title: map.title,
    severity: map.severity as Severity,
    status: map.status as Status,
    reason: map.reason === 'null' ? null : (map.reason as Reason),
    sig: map.sig,
    firstSeen: map.firstSeen,
    lastSeen: map.lastSeen,
    attempts: attempts as Attempt[],
    ...('verify' in map ? { verify: map.verify as VerifyTier } : {}),
    body,
  };
  validateIssue(issue);
  return issue;
}

/** Render an `Issue` back to the exact on-disk text (the codec's write half; deterministic key order). */
function renderIssueContent(issue: Issue): string {
  validateIssue(issue);
  const lines = [
    `id: ${issue.id}`,
    `name: ${issue.name}`,
    `title: ${issue.title}`,
    `severity: ${issue.severity}`,
    `status: ${issue.status}`,
    `reason: ${issue.reason === null ? 'null' : issue.reason}`,
    `sig: ${issue.sig}`,
    `firstSeen: ${issue.firstSeen}`,
    `lastSeen: ${issue.lastSeen}`,
    // OPTIONAL — rendered only when set, right before `attempts`, so an unset issue stays byte-identical to a pre-WS3 file.
    ...(issue.verify !== undefined ? [`verify: ${issue.verify}`] : []),
    `attempts: ${JSON.stringify(issue.attempts)}`,
  ];
  return `---\n${lines.join('\n')}\n---\n${issue.body}`;
}

// ── attempts: the append-only guard (the ONE sanctioned mutation is `regressedIn` on the last row) ──────────

function attemptsRowEqual(a: Attempt, b: Attempt): boolean {
  return a.commit === b.commit && a.verifiedByRun === b.verifiedByRun && (a.regressedIn ?? null) === (b.regressedIn ?? null);
}

/**
 * Enforce append-only: `next` must contain every row of `previous`, in order, byte-for-byte — EXCEPT the very
 * last previous row may gain a `regressedIn` it did not have before (what `reopen()` does), so long as its
 * `commit`/`verifiedByRun` are unchanged. Anything else (a dropped row, a reordered row, a changed `commit`/
 * `verifiedByRun`, `regressedIn` appearing on a non-last row) throws before a single byte is written.
 */
function assertAttemptsAppendOnly(previous: Attempt[], next: Attempt[]): void {
  if (next.length < previous.length) throw new Error('attempts is append-only: a write may not remove existing rows');
  previous.forEach((before, i) => {
    const after = next[i];
    const isLastPreviousRow = i === previous.length - 1;
    if (isLastPreviousRow && before.regressedIn === undefined && after.regressedIn !== undefined) {
      if (before.commit !== after.commit || before.verifiedByRun !== after.verifiedByRun)
        throw new Error(`attempts is append-only: row ${i} changed commit/verifiedByRun while attaching regressedIn`);
      return; // the one sanctioned mutation (reopen's regressedIn stamp)
    }
    if (!attemptsRowEqual(before, after)) throw new Error(`attempts is append-only: row ${i} was mutated`);
  });
}

/** Read + parse an existing issue file, or `null` if it does not exist yet. A PARSE error still propagates
 *  (a corrupt on-disk file blocks further writes rather than silently being clobbered). */
async function readExistingIssueMaybe(file: string): Promise<Issue | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  return parseIssueContent(raw);
}

// ── the file-based API ──────────────────────────────────────────────────────────────────────────────────

/** Read + parse one issue file. Throws (never returns null) on a missing or malformed file — a caller that
 *  wants "maybe absent" semantics should catch, matching this module's fail-closed stance. */
export async function parseIssueFile(file: string): Promise<Issue> {
  return parseIssueContent(await fs.readFile(file, 'utf8'));
}

/**
 * Write an `Issue` to `file` (creating parent dirs as needed). Validates first (fail-closed) and, when a
 * PRIOR version of the file exists, enforces the attempts append-only law against it before writing a byte.
 */
export async function writeIssueFile(file: string, issue: Issue): Promise<void> {
  validateIssue(issue);
  const previous = await readExistingIssueMaybe(file);
  if (previous) assertAttemptsAppendOnly(previous.attempts, issue.attempts);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, renderIssueContent(issue));
}

/** Append ONE new attempt row (never mutates existing rows) and persist. Returns the updated issue. */
export async function stampAttempt(file: string, entry: { commit: string; verifiedByRun: string }): Promise<Issue> {
  const issue = await parseIssueFile(file);
  const updated: Issue = { ...issue, attempts: [...issue.attempts, { commit: entry.commit, verifiedByRun: entry.verifiedByRun }] };
  await writeIssueFile(file, updated);
  return updated;
}

/**
 * Reopen a RESOLVED issue: `status → regressed`, `reason → null` (no longer closed), `lastSeen → run`, and
 * `regressedIn: run` stamped onto the LAST attempt row (the fix that regressed) — attempts otherwise intact.
 * This is the mechanical hash-dedup backstop's landing spot: a caller that resolves a new draft's computed id
 * to this SAME file (via `listIssues`) calls this instead of minting a duplicate. Throws (via `assertTransition`)
 * if the issue is not currently `resolved`.
 */
export async function reopen(file: string, opts: { run: string }): Promise<Issue> {
  const issue = await parseIssueFile(file);
  assertTransition(issue.status, 'regressed');
  const attempts = issue.attempts.map((a, i, arr) => (i === arr.length - 1 ? { ...a, regressedIn: opts.run } : a));
  const updated: Issue = { ...issue, status: 'regressed', reason: null, lastSeen: opts.run, attempts };
  await writeIssueFile(file, updated);
  return updated;
}

// ── the status machine's transition helpers ─────────────────────────────────────────────────────────────

/** The documented status graph — every OTHER edge is invalid. */
export const ALLOWED_TRANSITIONS: Readonly<Record<Status, readonly Status[]>> = {
  open: ['active'],
  active: ['fix-landed'],
  'fix-landed': ['verifying', 'resolved'], // the skip-proof path when proving is configured off
  verifying: ['resolved', 'open'], // resolved on adopt; back to `open` when the prove-rerun REJECTED the candidate

  resolved: ['regressed'],
  regressed: ['active'], // regressed behaves like `open` for selection/dispatch
};

/** PURE guard: throw unless `from → to` is an edge in `ALLOWED_TRANSITIONS`. */
export function assertTransition(from: Status, to: Status): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) throw new Error(`invalid issue status transition: ${from} -> ${to}`);
}

/**
 * Transition the issue at `file` to `to`, guarded by `assertTransition`, and persist. A transition INTO
 * `resolved` requires `opts.reason` (fixed|wontfix|false-positive|superseded); any other target clears
 * `reason` to null (only `resolved` ever carries one). Throws — and leaves the file untouched — on an
 * invalid edge or a resolve without a reason.
 */
export async function transitionIssue(file: string, to: Status, opts: { reason?: Reason } = {}): Promise<Issue> {
  const issue = await parseIssueFile(file);
  assertTransition(issue.status, to);
  if (to === 'resolved' && !opts.reason) throw new Error("transitioning to 'resolved' requires a reason");
  const updated: Issue = { ...issue, status: to, reason: to === 'resolved' ? (opts.reason as Reason) : null };
  await writeIssueFile(file, updated);
  return updated;
}

// ── listIssues — the read-only query over the ledger directory ─────────────────────────────────────────────

export interface IssueRecord {
  node: string;
  /** absolute path to the issue's `.md` file. */
  file: string;
  issue: Issue;
}

export interface ListIssuesOpts {
  /** scope to one node's `issues/` dir; omitted ⇒ scan every node dir under `<templateDir>/nodes`. */
  node?: string;
  status?: Status | Status[];
}

/** `<templateDir>/nodes` directory names, or `[]` if the dir is missing/unreadable — never throw. */
async function discoverNodes(templateDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(path.join(templateDir, 'nodes'), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1 };

/** severity DESC, then firstSeen ASC (a fixed-width date-seq id sorts correctly as a plain string). */
function compareIssues(a: IssueRecord, b: IssueRecord): number {
  const bySeverity = SEVERITY_RANK[b.issue.severity] - SEVERITY_RANK[a.issue.severity];
  if (bySeverity !== 0) return bySeverity;
  if (a.issue.firstSeen < b.issue.firstSeen) return -1;
  if (a.issue.firstSeen > b.issue.firstSeen) return 1;
  return 0;
}

/**
 * List issues under `templateDir`, optionally scoped to one `node` and/or filtered by `status`. A node with no
 * `issues/` dir yet contributes nothing (never throws — a fresh node has no ledger). Default sort: severity
 * DESC, then firstSeen ASC (the order fix selection consumes).
 */
export async function listIssues(templateDir: string, opts: ListIssuesOpts = {}): Promise<IssueRecord[]> {
  const nodes = opts.node ? [opts.node] : await discoverNodes(templateDir);
  const statusFilter = opts.status === undefined ? null : new Set(Array.isArray(opts.status) ? opts.status : [opts.status]);

  const records: IssueRecord[] = [];
  for (const node of nodes) {
    const dir = path.join(templateDir, 'nodes', node, 'issues');
    let entries: string[];
    try {
      entries = (await fs.readdir(dir)).filter((f) => f.endsWith('.md'));
    } catch {
      continue; // no issues dir for this node yet — nothing to list
    }
    for (const entry of entries) {
      const file = path.join(dir, entry);
      const issue = await parseIssueFile(file);
      if (statusFilter && !statusFilter.has(issue.status)) continue;
      records.push({ node, file, issue });
    }
  }
  return records.sort(compareIssues);
}
