// optimize/substrate/judge.ts — the M4 SOFT judge stage (docs/specs/optimize-substrate-plan.md §M4). Three
// layers, kept separately testable:
//   • `buildJudgePrompt`   — pure(-ish) prompt ASSEMBLY: the node's `optimize.judge` file (token-resolved;
//     HALT if declared but missing) + the M3 measure report (embedded VERBATIM as opaque text — never
//     imported/typed here; a clear marker when absent) + memory.md (best-effort) + the existing-issues
//     ledger (so the agent reopens-over-creates) + a git-only history-search instruction + the SEPARATION
//     LAW (identify + contextualize ONLY — zero fix proposals; criteria/gold are judging references, never
//     injected into the worker node's own prompt).
//   • `postProcessJudgeDrafts` — the MECHANICAL, tool-side post-processor: an agent-authored DRAFT (the
//     minimal title/severity/sig/status:open + body subset — id/name/dates are NEVER agent-authored, per
//     substrate/issues.ts's header) is identity-stamped into a full `Issue`; a sig-hash collision against an
//     existing issue MERGES (reopen when `resolved`, a plain `lastSeen` bump otherwise) instead of minting a
//     duplicate; a per-pass cap keeps the N most-severe NEW issues and reports the rest untouched for a later
//     pass; a file that is neither a valid full Issue nor a valid draft fails CLOSED, naming itself.
//   • `runSubstrateJudge` — wires (1) build the prompt, (2) spawn ONE judge turn via `substrate/agent.ts`
//     (readScope = [runDir, templateDir, workspace]; owns = the node's `issues/` dir), (3) post-process,
//     (4) write the analyzed marker `<runDir>/optimize/substrate/triaged.<node>.json`.
//
// The measure report is read as OPAQUE TEXT on purpose (never `JSON.parse`d, never a shared type with M3) —
// the plan's own law: this module must not couple to M3's report shape, only to its file's EXISTENCE.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveTokens } from '../../workflow/resolver.js';
import {
  computeIssueId, listIssues, parseIssueFile, reopen, writeIssueFile,
  type Issue, type IssueRecord, type Severity,
} from './issues.js';
import {
  inheritedAgentOpts, runBaseAgent,
  type RunBaseAgentResult, type BaseAgentChildOpts,
} from './agent.js';
import { generateRunName } from '../../names/generator.js';

/** Default cap on brand-new issues a single judge pass may land (the plan's documented default). Overridable
 *  per call — "config-with-defaults everywhere", never hardcoded past this one constant. */
export const DEFAULT_JUDGE_CAP = 5;

/** The DEFAULT triage playbook skill — staged for EVERY judge spawn (fixed id, no per-node knob in v1),
 *  mirroring the fixer's `FIXER_SKILL`. The runner resolves it via `locateSkillStage` (Ring 1
 *  `<piflowHome>/skills/piflow-triage`); a miss is advisory. */
export const TRIAGE_SKILL = 'piflow-triage';

// ── (1) buildJudgePrompt — prompt assembly ──────────────────────────────────────────────────────────────

export interface BuildJudgePromptOpts {
  /** `{{RUN}}` — the run being judged (holds the M3 measure report + hosts the triaged marker). */
  runDir: string;
  /** `{{WORKSPACE}}` — the product repo root the `judge` path may token-resolve against. */
  workspace: string;
  /** The template dir (`nodes/<id>/{node.json,memory.md,issues/}` live here). */
  templateDir: string;
}

/** `<templateDir>/nodes/<node>/node.json`'s raw shape — only the `optimize` block matters here (M0). The
 *  loader deliberately never wires this onto the compiled NodeSpec; consumers read it straight off disk. */
interface RawNodeJson {
  // `criteria` is the current spelling of the shared bar; `judge` is the back-compat READ alias (either works).
  optimize?: { measure?: unknown; criteria?: string; judge?: string };
}

async function readNodeJson(templateDir: string, nodeId: string): Promise<RawNodeJson> {
  const file = path.join(templateDir, 'nodes', nodeId, 'node.json');
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e) {
    throw new Error(`buildJudgePrompt: cannot read "${file}" for node "${nodeId}": ${(e as Error).message}`);
  }
  try {
    return JSON.parse(raw) as RawNodeJson;
  } catch (e) {
    throw new Error(`buildJudgePrompt: "${file}" is not valid JSON: ${(e as Error).message}`);
  }
}

/** Read a file, or `null` on ENOENT (any OTHER error still propagates — a real read failure is never silent). */
async function readFileMaybe(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** Render the existing-issues ledger for the prompt, so the judge agent reopens-over-creates. */
function renderExistingIssues(records: IssueRecord[]): string {
  if (records.length === 0) return '(no issues on file yet for this node)';
  return records
    .map((r) => `- ${r.issue.name} [${r.issue.severity}] status=${r.issue.status} sig="${r.issue.sig}" — ${r.issue.title}`)
    .join('\n');
}

const SEPARATION_LAW = [
  'SEPARATION LAW: your job is to IDENTIFY and CONTEXTUALIZE quality defects — ZERO fix proposals. Do not',
  'write or suggest a code change, a patch, or a "fix" section. Any criteria/gold references below are',
  'JUDGING references ONLY — they are never instructions for what to build.',
].join(' ');

const GIT_HISTORY_INSTRUCTION = [
  'Before drafting a NEW issue, check whether this exact defect was already investigated: run',
  "`git log --grep '^skillsys(<node>)'` (git ONLY — never `gh`, never a network lookup) within your read",
  'scope to see prior fixes/discussion for this node, and avoid re-flagging something already reasoned about.',
].join(' ');

const OUTPUT_SPEC = [
  'For a NEW issue, write a markdown file under the issues directory with EXACTLY this frontmatter subset —',
  'do NOT author `id`/`name`/`firstSeen`/`lastSeen`/`attempts`/`reason` (those are tool-stamped):',
  '---\ntitle: <one-liner>\nseverity: critical|high|medium|low\nsig: <node>::<stable-tag>\nstatus: open\n---',
  '<a ~30-40 line context brief>',
  'To REOPEN or refine an EXISTING issue, edit its file directly (never touch `id`); prefer this over a new draft.',
].join('\n');

/**
 * Assemble the judge agent's FULL prompt for `(nodeId)` under `opts`. Reads the node's declared
 * `optimize.judge` file (token-resolved; HALTS if the field is absent OR the resolved file is missing), the
 * M3 measure report (opaque text; a clear marker on absence), `memory.md` (best-effort), and the existing
 * issue ledger. Never spawns anything — pure assembly over the filesystem.
 */
export async function buildJudgePrompt(nodeId: string, opts: BuildJudgePromptOpts): Promise<string> {
  const { runDir, workspace, templateDir } = opts;
  const nodeJson = await readNodeJson(templateDir, nodeId);
  // The shared bar: `optimize.criteria`, or the back-compat `optimize.judge` alias (either works; criteria wins).
  const judgeRaw = nodeJson.optimize?.criteria ?? nodeJson.optimize?.judge;
  if (!judgeRaw) {
    throw new Error(
      `buildJudgePrompt: node "${nodeId}" has no "optimize.criteria" (or the legacy "optimize.judge") configured in its node.json — nothing to judge with.`,
    );
  }
  const judgeResolved = path.resolve(templateDir, resolveTokens(judgeRaw, { run: runDir, workspace }));
  const judgeContent = await readFileMaybe(judgeResolved);
  if (judgeContent === null) {
    throw new Error(
      `buildJudgePrompt: node "${nodeId}"'s declared optimize.criteria file was not found: ${judgeResolved} (declared as "${judgeRaw}" in nodes/${nodeId}/node.json)`,
    );
  }

  const measurePath = path.join(runDir, 'optimize', 'substrate', `measure.${nodeId}.json`);
  const measureContent = await readFileMaybe(measurePath);
  const measureSection = measureContent ?? `(measure report NOT AVAILABLE — no ${path.basename(measurePath)} found under optimize/substrate/ for this run)`;

  const memoryPath = path.join(templateDir, 'nodes', nodeId, 'memory.md');
  const memoryContent = await readFileMaybe(memoryPath);
  const memorySection = memoryContent ?? '(no memory.md on file yet for this node)';

  const existingIssues = await listIssues(templateDir, { node: nodeId });

  return [
    `<role>You are the SOFT JUDGE for the "${nodeId}" node — the substrate's quality-defect identifier.</role>`,
    `<separation_law>${SEPARATION_LAW}</separation_law>`,
    `<judge_instructions>\n${judgeContent}\n</judge_instructions>`,
    `<measure_report path="${measurePath}">\n${measureSection}\n</measure_report>`,
    `<memory path="${memoryPath}">\n${memorySection}\n</memory>`,
    `<existing_issues>\n${renderExistingIssues(existingIssues)}\n</existing_issues>`,
    `<git_history_instruction>${GIT_HISTORY_INSTRUCTION}</git_history_instruction>`,
    `<output_spec>\n${OUTPUT_SPEC}\n</output_spec>`,
  ].join('\n\n');
}

// ── (2) postProcessJudgeDrafts — the mechanical, fail-closed post-processor ─────────────────────────────

const DRAFT_KEYS = ['title', 'severity', 'sig', 'status'] as const;
const DRAFT_SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low'];
const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1 };

interface Draft {
  title: string;
  severity: Severity;
  sig: string;
  body: string;
}

/** Parse the AGENT-authored draft subset (title/severity/sig/status:open + body). Fail-closed: anything not
 *  exactly this shape throws (mirrors issues.ts's own strict frontmatter codec, kept local — drafts are a
 *  DELIBERATELY narrower shape than a full Issue, so they cannot round-trip through `parseIssueFile`). */
function parseDraftContent(raw: string): Draft {
  const lines = raw.split('\n');
  if (lines[0] !== '---') throw new Error('draft must open with a "---" frontmatter delimiter');
  const closeIdx = lines.indexOf('---', 1);
  if (closeIdx === -1) throw new Error('draft frontmatter is never closed with a second "---"');
  const map: Record<string, string> = {};
  for (const line of lines.slice(1, closeIdx)) {
    if (line === '') continue;
    const idx = line.indexOf(': ');
    if (idx === -1) throw new Error(`malformed draft frontmatter line (expected "key: value"): ${JSON.stringify(line)}`);
    const key = line.slice(0, idx);
    if (key in map) throw new Error(`duplicate draft frontmatter key: ${key}`);
    map[key] = line.slice(idx + 2);
  }
  const body = lines.slice(closeIdx + 1).join('\n');

  const missing = DRAFT_KEYS.filter((k) => !(k in map));
  if (missing.length) throw new Error(`draft frontmatter missing required key(s): ${missing.join(', ')}`);
  const extra = Object.keys(map).filter((k) => !(DRAFT_KEYS as readonly string[]).includes(k));
  if (extra.length) {
    throw new Error(
      `draft frontmatter has unknown key(s): ${extra.join(', ')} (a draft may declare only ${DRAFT_KEYS.join('/')} — id/name/dates are tool-stamped)`,
    );
  }
  const severity = map.severity as Severity;
  if (!DRAFT_SEVERITIES.includes(severity)) {
    throw new Error(`draft severity must be one of ${DRAFT_SEVERITIES.join('|')}, got ${JSON.stringify(map.severity)}`);
  }
  if (map.status !== 'open') {
    throw new Error(`draft status must be "open" (got ${JSON.stringify(map.status)}) — only the tool transitions status after minting`);
  }
  if (!map.title || map.title.includes('\n')) throw new Error('draft title must be a non-empty single line');
  if (!map.sig || map.sig.includes('\n')) throw new Error('draft sig must be a non-empty single line');
  return { title: map.title, severity, sig: map.sig, body };
}

export interface PostProcessOpts {
  /** Cap on brand-new issues landed THIS pass. Default `DEFAULT_JUDGE_CAP` (5). */
  cap?: number;
}

export interface PostProcessResult {
  /** Names of every issue touched this pass (new mints, reopens, and plain re-seen merges). */
  landed: string[];
  /** Basenames of draft files left UNLANDED by the cap (untouched on disk — available for a later pass). */
  capped: string[];
}

/**
 * The mechanical post-process over `<templateDir>/nodes/<nodeId>/issues/`: every file that does NOT already
 * parse as a full, valid `Issue` is treated as an agent-authored DRAFT. A draft whose computed id
 * (`computeIssueId(nodeId, sig)`) matches an EXISTING issue merges into it (reopen when `resolved`, a plain
 * `lastSeen` bump otherwise) — the draft file is removed, never duplicated. A brand-new draft is minted into
 * a full Issue under a fresh pie name, subject to `cap` (kept: the most-severe-first `cap` drafts; the rest
 * are left on disk, reported in `capped`). A file that is NEITHER a valid Issue nor a valid draft throws,
 * naming itself (fail-closed — never silently dropped).
 */
export async function postProcessJudgeDrafts(
  templateDir: string,
  nodeId: string,
  run: string,
  opts: PostProcessOpts = {},
): Promise<PostProcessResult> {
  const cap = opts.cap ?? DEFAULT_JUDGE_CAP;
  const dir = path.join(templateDir, 'nodes', nodeId, 'issues');
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith('.md'));
  } catch {
    return { landed: [], capped: [] }; // no issues dir yet — nothing to process
  }

  // ONE tolerant scan (NOT the shared `listIssues` — it is fail-closed over EVERY `.md` file, and this
  // directory legitimately mixes already-valid issues with agent-authored DRAFTS mid-pass). A file that
  // parses as a full, valid Issue is "existing"; one that doesn't is a draft CANDIDATE; one that is neither
  // is malformed — fail closed, naming the file, before anything is written.
  const existing: { file: string; issue: Issue }[] = [];
  const drafts: { file: string; draft: Draft }[] = [];
  for (const f of files) {
    const file = path.join(dir, f);
    const raw = await fs.readFile(file, 'utf8');
    try {
      existing.push({ file, issue: await parseIssueFile(file) }); // already a full, valid issue — no action.
    } catch (fullErr) {
      try {
        drafts.push({ file, draft: parseDraftContent(raw) });
      } catch (draftErr) {
        throw new Error(
          `malformed issue file "${f}": not a valid issue (${(fullErr as Error).message}) and not a valid draft (${(draftErr as Error).message})`,
        );
      }
    }
  }
  // id -> {file, issue}, MUTATED as we land brand-new issues so a same-pass duplicate sig also merges.
  const byId = new Map<string, { file: string; issue: Issue }>(existing.map((e) => [e.issue.id, e]));
  const existingNames = new Set(existing.map((e) => e.issue.name));

  // Severity DESC so the cap keeps the MOST SEVERE new issues, never an arbitrary/file-order N.
  drafts.sort((a, b) => SEVERITY_RANK[b.draft.severity] - SEVERITY_RANK[a.draft.severity]);

  const landed: string[] = [];
  const capped: string[] = [];
  let newCount = 0;
  for (const { file, draft } of drafts) {
    const id = computeIssueId(nodeId, draft.sig);
    const hit = byId.get(id);
    if (hit) {
      // Hash-dedup backstop: merge into the EXISTING record, drop the draft — never a duplicate file.
      const updated =
        hit.issue.status === 'resolved'
          ? await reopen(hit.file, { run })
          : await (async (): Promise<Issue> => {
              const next: Issue = { ...hit.issue, lastSeen: run };
              await writeIssueFile(hit.file, next);
              return next;
            })();
      byId.set(id, { file: hit.file, issue: updated });
      landed.push(updated.name);
      if (path.resolve(file) !== path.resolve(hit.file)) await fs.rm(file, { force: true });
      continue;
    }
    if (newCount >= cap) {
      // Overflow: move the draft OUT of the flat issues/ dir into a `.pending/` sibling — never delete
      // (it is available for a later pass), and never leave it in the FLAT dir the shared, fail-closed
      // `listIssues` scans (a bare draft file there would break every subsequent read of the ledger).
      const pendingDir = path.join(dir, '.pending');
      await fs.mkdir(pendingDir, { recursive: true });
      const base = path.basename(file);
      await fs.rename(file, path.join(pendingDir, base));
      capped.push(base);
      continue;
    }
    newCount++;
    const name = generateRunName(existingNames);
    existingNames.add(name);
    const issue: Issue = {
      id, name, title: draft.title, severity: draft.severity, status: 'open', reason: null,
      sig: draft.sig, firstSeen: run, lastSeen: run, attempts: [], body: draft.body,
    };
    const dest = path.join(dir, `${name}.md`);
    await writeIssueFile(dest, issue);
    byId.set(id, { file: dest, issue });
    if (path.resolve(dest) !== path.resolve(file)) await fs.rm(file, { force: true });
    landed.push(name);
  }
  return { landed, capped };
}

// ── (3) runSubstrateJudge — the full pass ───────────────────────────────────────────────────────────────

/** The judge's opts = its OWN specialization (workspace/templateDir/cap) + the base agent's whole inherited
 *  field surface + the `runAgent` test seam, EMBEDDED via `BaseAgentChildOpts` (agent.ts) — never a
 *  re-declared subset (anything left off a copy is silently lost; `dryRun`, tier/model, timeoutMs, and every
 *  future base field arrive here automatically). On `dryRun`, the pass returns the composed plan WITHOUT
 *  spawning, post-processing, or stamping the marker. */
export interface SubstrateJudgeOpts extends BaseAgentChildOpts {
  /** `{{WORKSPACE}}` — the product repo root. */
  workspace: string;
  /** The template dir (`nodes/<id>/{node.json,memory.md,issues/}`). */
  templateDir: string;
  /** Cap on brand-new issues landed this pass. Default `DEFAULT_JUDGE_CAP`. */
  cap?: number;
}

export interface SubstrateJudgeResult {
  /** ISO timestamp this pass completed (mirrors the written marker). */
  when: string;
  /** Names of every issue touched this pass (new + reopened + re-seen). Empty on a dry-run. */
  issues: string[];
  /** Basenames of draft files left unlanded by the cap this pass. Empty on a dry-run. */
  capped: string[];
  /** The judge agent's parsed final text (debugging/telemetry — never re-parsed for control flow). Absent on a dry-run. */
  agentText?: string;
  /** The judge agent's full node status record. Absent on a dry-run. */
  agentStatus?: RunBaseAgentResult['status'];
  /** The judge spawn's PERSISTED run dir (present ONLY when the caller passed `outDir` to the base agent) —
   *  point the existing observe instruments at it (`piflowctl telemetry|status|trace <dir>`), exactly like a
   *  workflow node's own run. Absent on the ephemeral default (already deleted) and on a dry-run. */
  agentRunDir?: string;
  /** Present ONLY on a dry-run: the BASE agent's composed spec (`plan`) that WOULD have been spawned — the
   *  full ingested `prompt` + resolved sandbox/tier/model/tools/skill. Forwarded verbatim from the base agent. */
  dryRun?: RunBaseAgentResult['plan'];
}

/**
 * Run ONE full judge pass over `(runDir, nodeId)`: build the prompt, spawn the judge agent (readScope =
 * `[runDir, templateDir, workspace]`, owns = the node's `issues/` dir), mechanically post-process whatever
 * it wrote, and stamp the analyzed marker `<runDir>/optimize/substrate/triaged.<node>.json`.
 */
export async function runSubstrateJudge(runDir: string, nodeId: string, opts: SubstrateJudgeOpts): Promise<SubstrateJudgeResult> {
  const { workspace, templateDir } = opts;
  const prompt = await buildJudgePrompt(nodeId, { runDir, workspace, templateDir });
  const issuesDirPath = path.join(templateDir, 'nodes', nodeId, 'issues');
  const readScope = [runDir, templateDir, workspace];
  const owns = [issuesDirPath];
  const runAgent = opts.runAgent ?? runBaseAgent;

  const agentResult = await runAgent({
    prompt,
    cwd: workspace,
    readScope,
    owns,
    skill: TRIAGE_SKILL, // stage the default triage playbook (Ring 1); a miss degrades to the promptless playbook.
    // The base agent's WHOLE inherited surface (tier/model/timeoutMs/provider/seams/dryRun/…), forwarded as
    // one projection — never a hand-enumerated subset (dryRun's preview short-circuit rides this too).
    ...inheritedAgentOpts(opts),
  });

  // DRY-RUN: the base agent returned the composed plan (no spawn). Forward it and STOP — the judge's only job
  // here was to ASSEMBLE the config (the additive layer); it does not post-process drafts or stamp a marker.
  if (opts.dryRun) {
    return { when: new Date().toISOString(), issues: [], capped: [], dryRun: agentResult.plan };
  }

  const run = path.basename(path.resolve(runDir));
  const { landed, capped } = await postProcessJudgeDrafts(templateDir, nodeId, run, { cap: opts.cap });

  const markerDir = path.join(runDir, 'optimize', 'substrate');
  await fs.mkdir(markerDir, { recursive: true });
  const when = new Date().toISOString();
  await fs.writeFile(path.join(markerDir, `triaged.${nodeId}.json`), JSON.stringify({ when, issues: landed }, null, 2) + '\n');

  return {
    when, issues: landed, capped,
    agentText: agentResult.text, agentStatus: agentResult.status, agentRunDir: agentResult.runDir,
  };
}
