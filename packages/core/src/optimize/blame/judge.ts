// optimize/blame/judge.ts — the run-level BLAME judge + its one verify round (docs/design/optimize-blame.md
// §3/§4). The run-level twin of substrate/judge.ts, one grammar up: where the node judge attributes a node's
// own defects to that node, the BLAME judge attributes end-to-end defects on the run's FINAL artifact to the
// OWNING node, speaking in prose to each node's triage. Base-agent-shaped exactly like substrate/judge.ts +
// substrate/gate.ts — two independently-testable layers:
//   • `buildBlamePrompt` — pure prompt ASSEMBLY over the filesystem: tagged sections joined by blank lines, in
//     a fixed order. It embeds the RUN-LEVEL soft criteria (meta.json `optimize.criteria`, token-resolved —
//     HARD-THROW if the key or file is missing: the doc pre-flight, "no soft bar, no blame pass"), the AUTO-
//     COMPOSED responsibility roster, the evidence pack (the run-level measure report as OPAQUE text — never
//     JSON.parse'd into the prompt, the same law substrate/judge.ts holds — plus a listing of the per-node
//     measure reports + a pointer at the failure-onset rootCauses walk), template-root memory.md (recurrence),
//     the §3 judge discipline as MUST lines, and the output contract. `mode:"verify"` swaps role+task for the
//     single §4-step-4 re-check round.
//   • `runBlameJudge` — the full pass WIRING: mkdir the blame dir, spawn the judge turn via the `runAgent`
//     seam (readScope = [runDir, templateDir, workspace]; owns = the blame dir; NO skill — v1 discipline is
//     in-prompt), then (default) the verify turn the same way, then read + FAIL-CLOSED-parse the summary tail
//     (a pass that wrote no summary is a HARD failure, mirroring gate.ts's no-verdict throw). The spawn is the
//     ONLY model turn; a test injects `runAgent` and never live-spawns.
//
// FOLLOW-UP: v1 stages NO skill for the blame spawns (the judge/verify discipline lives entirely in the
// assembled prompt). A dedicated `piflow-blame` playbook skill is the natural next step, mirroring how triage/
// gate/fixer moved their judgment into a skill — deferred to keep this lane in-prompt and self-contained.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveTokens } from '../../workflow/resolver.js';
import {
  inheritedAgentOpts, runBaseAgent,
  type RunBaseAgentResult, type BaseAgentChildOpts,
} from '../substrate/agent.js';
import { safeEmit, type SubstrateEventSink } from '../substrate/events.js';
import { composeRoster, renderRoster } from './roster.js';
import { parseBlameSummaryTail, type BlameSummary } from './summary.js';
import { blameDir, blameMeasurePath, blameSummaryPath } from './paths.js';

// ── (1) buildBlamePrompt — prompt assembly ──────────────────────────────────────────────────────────────

export interface BuildBlamePromptOpts {
  /** `{{RUN}}` — the finished run being blamed (holds the evidence pack + hosts the blame dir). */
  runDir: string;
  /** `{{WORKSPACE}}` — the product repo root the criteria path may token-resolve against. */
  workspace: string;
  /** The template dir (`meta.json` carries `optimize.criteria`; `nodes/<id>/node.json` feed the roster). */
  templateDir: string;
  /** `judge` — first attribution pass; `verify` — the single §4-step-4 re-check over the written blame files. */
  mode: 'judge' | 'verify';
}

/** `<templateDir>/meta.json`'s raw shape — only the RUN-LEVEL `optimize.criteria` matters here (WS-B0). Read
 *  straight off disk, never the compiled WorkflowSpec (the block is optimizer-facing only). */
interface RawMetaJson {
  optimize?: { criteria?: string };
}

async function readMetaJson(templateDir: string): Promise<RawMetaJson> {
  const file = path.join(templateDir, 'meta.json');
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e) {
    throw new Error(
      `buildBlamePrompt: cannot read "${file}": ${(e as Error).message} — the run-level SOFT criteria is mandatory (no soft bar, no blame pass).`,
    );
  }
  try {
    return JSON.parse(raw) as RawMetaJson;
  } catch (e) {
    throw new Error(`buildBlamePrompt: "${file}" is not valid JSON: ${(e as Error).message}`);
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

const SEPARATION_LAW = [
  'SEPARATION LAW: blame files carry EVIDENCE and defect descriptions — NEVER the template criteria content.',
  'The criteria/gold below are JUDGE-FACING references ONLY (the Goodhart fence): never copy, quote, or',
  'paraphrase them into a blame file, a node brief, or anything a fixer will read.',
].join(' ');

/** The §3 judge discipline as MUST lines — enforced by the prompt (the blame files carry no parser). Pinned
 *  verbatim by the tests, so edits here are contract changes. */
const JUDGE_DISCIPLINE = [
  'MUST: every attribution cites OPENABLE evidence inline — a file path, a measure key, or a failure-onset',
  '  hop — at the point each claim is made.',
  'MUST: "the defect is visible in this node\'s output" ALONE FAILS — that is the manifestation trap; trace to',
  '  where the defect ORIGINATED, not merely where it surfaced (47% of naive attributions pick the surfacing node).',
  'MUST: blame the DECISION point over the execution point — the node that decided the harmful action, not the',
  '  node that merely executed it.',
  'MUST: when a cause is genuinely joint, name it in BOTH nodes\' files, cross-referenced in prose — never force',
  '  a single owner.',
  'MUST: state recurrence context where the memory shows it (e.g. "3rd consecutive generation").',
  'MUST: a defect you cannot attribute WITH evidence goes to the summary\'s `unattributed` list — NEVER forced',
  '  onto a node to give it an owner.',
  'MUST: judge ARTIFACTS and MEASURES, never a node\'s self-narrated success — open the artifact before blaming.',
].join('\n');

const OUTPUT_SPEC = [
  'Write ONE prose file per blamed node at optimize/blame/<node>.md, opening with the heading',
  '`# blame — <node> @ <run id>`, ~30-60 lines, evidence pointers inline, NO frontmatter (these files have no',
  'parser — they are read by the node\'s triage agent and a human).',
  'PLUS optimize/blame/blame.md: the run-level prose summary, ending in EXACTLY ONE fenced json tail — the ONLY',
  'machine-read surface — with this shape (verbatim keys):',
  '```json',
  '{ "blamed": [{ "node": "<id>", "severity": "critical|high|medium|low", "observedAt": ["<node>"] }],',
  '  "edges": [["<owner>", "<observedAt>"]], "unattributed": ["<defect the evidence could not attribute>"] }',
  '```',
  'Write ONLY files under optimize/blame/ — that dir is your ENTIRE write scope.',
].join('\n');

const SELF_CHECK = [
  'Before finishing: re-read the discipline. Confirm EVERY attribution cites openable evidence, the',
  'manifestation-trap check fired on each, decisions were blamed over executions, and the blame.md fenced json',
  'tail parses as the shape above. If any is No, you are not done.',
].join(' ');

/**
 * Assemble the blame agent's FULL prompt. Reads the run-level `optimize.criteria` (token-resolved; HARD-THROWS
 * if the key is absent OR the resolved file is missing — the doc pre-flight, no soft bar means no blame pass),
 * composes the responsibility roster, and lays the evidence pack + memory + discipline + output contract into
 * tagged sections joined by blank lines, in a fixed order. `mode:"verify"` swaps only role+task. Never spawns.
 */
export async function buildBlamePrompt(opts: BuildBlamePromptOpts): Promise<string> {
  const { runDir, workspace, templateDir, mode } = opts;
  const isVerify = mode === 'verify';

  // CRITERIA — the load-bearing SOFT bar; HARD-THROW when absent (pre-flight: no soft bar, no blame pass).
  const meta = await readMetaJson(templateDir);
  const criteriaRaw = meta.optimize?.criteria;
  if (!criteriaRaw) {
    throw new Error(
      `buildBlamePrompt: template meta.json has no "optimize.criteria" — the run-level SOFT bar is mandatory (pre-flight: no soft bar, no blame pass).`,
    );
  }
  const criteriaResolved = path.resolve(templateDir, resolveTokens(criteriaRaw, { run: runDir, workspace }));
  const criteriaContent = await readFileMaybe(criteriaResolved);
  if (criteriaContent === null) {
    throw new Error(
      `buildBlamePrompt: the declared optimize.criteria file was not found: ${criteriaResolved} (declared as "${criteriaRaw}" in meta.json)`,
    );
  }

  // ROSTER — auto-composed off each node.json (never hand-synced).
  const rosterMd = renderRoster(await composeRoster(templateDir));

  // EVIDENCE PACK — the run-level measure report as OPAQUE text (NEVER JSON.parse'd into the prompt: the same
  // law substrate/judge.ts holds — this module must not couple to the report's shape), a LISTING of the
  // per-node measure reports that exist, and a pointer at the failure-onset rootCauses walk inside the report.
  const measureReport = await readFileMaybe(blameMeasurePath(runDir));
  const measureSection = measureReport
    ?? `(run-level measure report NOT AVAILABLE — no ${path.basename(blameMeasurePath(runDir))} under optimize/blame/ for this run)`;
  const substrateDir = path.join(runDir, 'optimize', 'substrate');
  let perNodeList: string;
  try {
    const files = (await fs.readdir(substrateDir)).filter((f) => /^measure\..+\.json$/.test(f)).sort();
    perNodeList = files.length
      ? files.map((f) => `- ${path.join(substrateDir, f)}`).join('\n')
      : '(no per-node measure.<node>.json reports under optimize/substrate/ for this run)';
  } catch {
    perNodeList = '(no per-node measure.<node>.json reports under optimize/substrate/ for this run)';
  }

  // MEMORY — template-root recurrence context (best-effort; blame recurrence rides template-root memory.md, §7).
  const memoryPath = path.join(templateDir, 'memory.md');
  const memorySection = (await readFileMaybe(memoryPath)) ?? '(no template-root memory.md yet — no cross-run recurrence context)';

  const role = isVerify
    ? `<role>You are the BLAME VERIFY ROUND — a single re-check pass over the blame files an earlier run-level judge turn already wrote for THIS run. You open no new attributions; you confirm or retract the ones on disk.</role>`
    : `<role>You are the RUN-LEVEL BLAME JUDGE. You attribute end-to-end defects on the run's FINAL artifact to the node that caused each, speaking in prose to that node's triage. You judge artifacts and measures — NEVER a node's self-narrated success.</role>`;
  const task = isVerify
    ? `<task>Re-check EACH existing blame file's attributions against the cited evidence: OPEN the artifact / measure key / failure-onset hop each claim points to and confirm it actually supports the owner. Apply the manifestation-trap check (surfacing ≠ origin) and the decision-vs-execution check. FIX or DROP any attribution the evidence does not support, then rewrite the blame files IN PLACE and the blame.md summary tail. This is ONE round — do NOT expand scope or mint new attributions.</task>`
    : `<task>View the run's FINAL artifact from the global standpoint, name what falls short of the criteria bar, and attribute each defect to the node that OWNS the decision that caused it. Consume the failure-onset walk in the evidence pack and OPEN the cited artifacts before blaming. Write one prose blame file per blamed node plus the run summary — attribution context, never fix instructions. You have read access to the WHOLE run dir (${runDir}).</task>`;

  return [
    role,
    task,
    `<separation_law>${SEPARATION_LAW}</separation_law>`,
    `<criteria path="${criteriaResolved}">\nThe run-level FINAL-ARTIFACT bar — the SAME judge-facing criteria a blame pass attributes against; invent no stricter bar, and NEVER leak it into a blame file (separation law).\n\n${criteriaContent}\n</criteria>`,
    `<responsibility_roster>\nWhat each node OWNS producing — auto-composed from every node.json (id · phase · produces · owns). Attribute AGAINST this map; it is the answer to "whose job was this".\n\n${rosterMd}\n</responsibility_roster>`,
    `<evidence_index>\nYou have READ access to the whole run dir (${runDir}) — OPEN artifacts before blaming; do not blame from this index alone.\n\n<run_measure_report path="${blameMeasurePath(runDir)}">\nThe run-level hard-measure fold, as OPAQUE text (do NOT trust its self-summary over the artifacts).\n\n${measureSection}\n</run_measure_report>\n\n<per_node_measure_reports>\nOpen any of these per-node hard reports for that node's own measures:\n${perNodeList}\n</per_node_measure_reports>\n\n<root_causes>\nThe run measure report above carries a digest.rootCauses[] array — the failure-onset backward walk (the earliest decisive upstream node per failed node, and the file link that propagated it). CONSUME it as the primary causality signal; do not re-derive causality from vibes.\n</root_causes>\n</evidence_index>`,
    `<memory path="${memoryPath}">\nCross-run recurrence context (template-root). State recurrence in a blame file where this shows it.\n\n${memorySection}\n</memory>`,
    `<judge_discipline>\n${JUDGE_DISCIPLINE}\n</judge_discipline>`,
    `<output_spec>\n${OUTPUT_SPEC}\n</output_spec>`,
    `<self_check>${SELF_CHECK}</self_check>`,
  ].join('\n\n');
}

// ── (2) runBlameJudge — the full pass ───────────────────────────────────────────────────────────────────

/** The blame judge's opts = its OWN specialization (workspace/templateDir/verifyRound/onEvent) + the base
 *  agent's whole inherited field surface + the `runAgent` test seam, EMBEDDED via `BaseAgentChildOpts` — never
 *  a re-declared subset (the same silent-loss guard SubstrateJudgeOpts uses; dryRun/tier/model/timeoutMs and
 *  every future base field arrive here automatically). */
export interface RunBlameJudgeOpts extends BaseAgentChildOpts {
  /** `{{WORKSPACE}}` — the product repo root. */
  workspace: string;
  /** The template dir (`meta.json` + `nodes/<id>/node.json`). */
  templateDir: string;
  /** Run the single §4-step-4 verify re-check after the judge turn. Default `true`. */
  verifyRound?: boolean;
  /** OPTIONAL live-progress sink (a projection, never load-bearing — a throwing sink is swallowed). */
  onEvent?: SubstrateEventSink;
}

export interface RunBlameJudgeResult {
  /** The parsed, validated run summary tail (the ONLY machine-read blame surface). Empty on a dry-run. */
  summary: BlameSummary;
  /** Absolute paths of the per-node prose blame files written (`<node>.md`, excluding blame.md/dissent.*). */
  files: string[];
  /** The judge turn's parsed final text (telemetry only). Absent on a dry-run. */
  judgeText?: string;
  /** The verify turn's parsed final text (telemetry only). Absent on a dry-run or when `verifyRound:false`. */
  verifyText?: string;
  /** The last spawn's PERSISTED run dir (present ONLY when the caller passed `outDir`) — point the observe
   *  instruments at it like a node. Absent on the ephemeral default and on a dry-run. */
  agentRunDir?: string;
  /** Present ONLY on a dry-run: the composed one-node spec the JUDGE turn WOULD have spawned. */
  dryRun?: RunBaseAgentResult['plan'];
}

/**
 * Run ONE full blame pass over `runDir`: mkdir the blame dir, spawn the judge turn (readScope =
 * `[runDir, templateDir, workspace]`, owns = the blame dir, NO skill), then (default) the verify turn the same
 * way, then read + FAIL-CLOSED-parse the summary tail. A pass that wrote no summary is a HARD failure (mirrors
 * gate.ts's no-verdict throw). On `dryRun`, return the judge turn's composed plan WITHOUT spawning verify.
 */
export async function runBlameJudge(runDir: string, opts: RunBlameJudgeOpts): Promise<RunBlameJudgeResult> {
  const { workspace, templateDir } = opts;
  const dir = blameDir(runDir);
  await fs.mkdir(dir, { recursive: true });

  const runAgent = opts.runAgent ?? runBaseAgent;
  const readScope = [runDir, templateDir, workspace];
  const owns = [dir];

  const spawn = async (mode: 'judge' | 'verify'): Promise<RunBaseAgentResult> => {
    const prompt = await buildBlamePrompt({ runDir, workspace, templateDir, mode });
    return runAgent({
      prompt,
      cwd: workspace,
      readScope,
      owns,
      // NO skill — v1 blame discipline is entirely in-prompt (see the module header FOLLOW-UP note).
      ...inheritedAgentOpts(opts),
    });
  };

  // JUDGE round.
  const judge = await spawn('judge');

  // DRY-RUN: the base agent returned the composed plan (no spawn). Forward the JUDGE plan and STOP — no verify
  // turn, no summary parse (nothing was written), mirroring substrate/judge.ts's dry-run short-circuit.
  if (opts.dryRun) {
    return { summary: { blamed: [], edges: [], unattributed: [] }, files: [], dryRun: judge.plan };
  }

  let agentRunDir = judge.runDir;
  let verifyText: string | undefined;

  // VERIFY round (default on) — the single §4-step-4 re-check, spawned the SAME way.
  const verifyRound = opts.verifyRound ?? true;
  if (verifyRound) {
    const verify = await spawn('verify');
    verifyText = verify.text;
    if (verify.runDir) agentRunDir = verify.runDir;
  }

  // Read + FAIL-CLOSED-parse the summary tail — a blame pass that wrote NO summary is a HARD failure (never a
  // silent empty), mirroring gate.ts's no-verdict throw.
  const summaryRaw = await readFileMaybe(blameSummaryPath(runDir));
  if (summaryRaw === null) {
    throw new Error(
      `runBlameJudge: the blame agent wrote no summary at ${blameSummaryPath(runDir)} — a blame pass that emits no summary tail is a hard failure, never a silent empty attribution.`,
    );
  }
  const summary = parseBlameSummaryTail(summaryRaw);

  // List the per-node prose blame files (`<node>.md`), excluding the summary + any dissent trace.
  let files: string[] = [];
  try {
    files = (await fs.readdir(dir))
      .filter((f) => f.endsWith('.md') && f !== 'blame.md' && !f.startsWith('dissent.'))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    /* the dir was just created; a read failure here leaves files empty (the summary parse already succeeded) */
  }

  // Events — a projection, never load-bearing (§: the stream narrates the loop, it never gates it).
  safeEmit(opts.onEvent, { type: 'blame-judged', blamed: summary.blamed.length });
  if (verifyRound) safeEmit(opts.onEvent, { type: 'blame-verified', blamed: summary.blamed.length });

  const result: RunBlameJudgeResult = { summary, files, judgeText: judge.text };
  if (verifyText !== undefined) result.verifyText = verifyText;
  if (agentRunDir !== undefined) result.agentRunDir = agentRunDir;
  return result;
}
