// optimize/substrate/gate.ts — the GATE agent (the optimize loop's third and last base-agent turn, twin of
// judge.ts/fix.ts). Given ONE fixer's candidate (the node re-run against its edited harness), it renders a
// STRUCTURED VERDICT — accept (stage for a human to adopt) | reject (drop back to a fresh fixer) — with an
// evidence-cited rationale. It is the SOFT-bar judgment for nodes with no numeric oracle: where `evaluateGate`
// (optimize/gate.ts) can only say "unmeasurable → route to human", this agent actually judges the fix against
// the node's OWN criteria (`optimize.judge`) — the same bar a regular run applies — plus a reward-hack audit a
// numeric gate can never make.
//
// THIN BY DESIGN — this module is judge.ts-shaped: (1) `buildGatePrompt` assembles the inputs, (2)
// `runSubstrateGate` spawns ONE blind base agent via `runBaseAgent` (skill: `piflow-gate`), (3) a fail-closed
// parse of the verdict FILE the agent wrote. The JUDGMENT lives entirely in the `piflow-gate` skill, never in
// code here — exactly as triage's judgment lives in `piflow-triage` and the fixer's in `piflow-fixer`. The
// agent is BLIND: a fresh context separate from the fixer, so it never inherits the fixer's self-justification.
//
// THE VERDICT IS A FILE, not parsed prose (mirrors judge.ts's draft-file contract): the agent WRITES
// `verdict.json` into an owned dir; this module reads + validates it fail-closed. A test injects a `runAgent`
// seam that writes a fake verdict.json — never a live spawn.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveTokens } from '../../workflow/resolver.js';
import {
  inheritedAgentOpts, runBaseAgent,
  type RunBaseAgentResult, type BaseAgentChildOpts,
} from './agent.js';

/** The DEFAULT gate playbook skill — staged for EVERY gate spawn (fixed id, no per-node knob in v1), mirroring
 *  the judge's `TRIAGE_SKILL` and the fixer's `FIXER_SKILL`. The runner resolves it via `locateSkillStage`
 *  (Ring 1 `<piflowHome>/skills/piflow-gate`); a miss degrades to the promptless playbook (advisory), never a
 *  hard fail. */
export const GATE_SKILL = 'piflow-gate';

// ── the verdict shape (the consumer is fix.ts — deterministic code — so it is STRICT typed JSON) ────────────

/** The coarse failure category on a REJECT — restates the fixer's OWN goal back at it (NOT the gate's rubric),
 *  so a fresh fixer's retry is diversified without being taught to the test. */
export type GateRejectCategory = 'reward-hack' | 'band-aid' | 'didnt-reach-root' | 'regressed-elsewhere';

const REJECT_CATEGORIES: readonly GateRejectCategory[] = ['reward-hack', 'band-aid', 'didnt-reach-root', 'regressed-elsewhere'];

/** The gate agent's structured verdict (written by the agent as `verdict.json`, parsed fail-closed here). */
export interface GateVerdictFile {
  /** accept ⇒ stage the candidate for a human to adopt; reject ⇒ drop back to a fresh fixer. */
  decision: 'accept' | 'reject';
  /** the evidence-cited rationale — for the HUMAN (the real quality eye), never fed to the fixer. */
  rationale: string;
  /** REJECT only: the coarse failure category (the goal-aligned drop-back signal). */
  category?: GateRejectCategory;
  /** REJECT only: the diversification steer ("try a different harness element; the root may be upstream").
   *  Composed WITH the prior diff + static ground-truths by fix.ts into the fresh fixer's dispatch — the gate's
   *  CRITERIA/rubric are NEVER included (that would teach the retry to the test). */
  steer?: string;
}

// ── (1) buildGatePrompt — prompt assembly (mirrors judge.ts) ──────────────────────────────────────────────

export interface BuildGatePromptOpts {
  /** `{{RUN}}` — the CANDIDATE (prove-rerun) run dir; holds the NEW output artifact the gate judges. */
  runDir: string;
  /** `{{WORKSPACE}}` — the product repo root the `judge` path token-resolves against. */
  workspace: string;
  /** The template dir (`nodes/<id>/node.json` carries `optimize.judge`). */
  templateDir: string;
  /** The original ISSUE file verbatim — the defect spec the fix must have closed. */
  issueFileText: string;
  /** The fixer's candidate DIFF (unified text). May be '' when a diff could not be computed. */
  fixerDiff: string;
  /** The fixer's own written ACCOUNT ("how I fixed it") — a CLAIM to cross-check, never evidence on its own. */
  fixerAccount: string;
  /** The ABSOLUTE path the agent MUST write its `verdict.json` to (inside its owned dir). */
  verdictPath: string;
}

/** `<templateDir>/nodes/<node>/node.json`'s raw shape — only the shared BAR matters here: `optimize.criteria`,
 *  or the back-compat `optimize.judge` alias (either works; criteria wins). */
interface RawNodeJson {
  optimize?: { criteria?: string; judge?: string };
}

async function readNodeJson(templateDir: string, nodeId: string): Promise<RawNodeJson> {
  const file = path.join(templateDir, 'nodes', nodeId, 'node.json');
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e) {
    throw new Error(`buildGatePrompt: cannot read "${file}" for node "${nodeId}": ${(e as Error).message}`);
  }
  try {
    return JSON.parse(raw) as RawNodeJson;
  } catch (e) {
    throw new Error(`buildGatePrompt: "${file}" is not valid JSON: ${(e as Error).message}`);
  }
}

/** Read a file, or `null` on ENOENT (any OTHER error still propagates). */
async function readFileMaybe(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

const SEPARATION_LAW = [
  'SEPARATION LAW: you JUDGE only. You NEVER edit or fix the node (that is the fixer), and you NEVER adopt to',
  'the live product (that is a separate, explicit human step). The criteria/gold below are YOUR judging oracle',
  '— they were withheld from the fixer; NEVER leak them into the drop-back steer (that teaches the retry to the',
  'test). Uncertain ⇒ REJECT, stated plainly.',
].join(' ');

/**
 * Assemble the gate agent's FULL prompt for `(nodeId)`. Reads the node's declared `optimize.judge` file
 * (token-resolved; HALTS if the field is absent OR the resolved file is missing — the gate has no bar without
 * it), and embeds the issue, the fixer diff + account, and the exact `verdict.json` output contract. Points
 * the agent at the candidate run dir for the NEW artifact (readable in its scope). Never spawns anything.
 */
export async function buildGatePrompt(nodeId: string, opts: BuildGatePromptOpts): Promise<string> {
  const { runDir, workspace, templateDir, issueFileText, fixerDiff, fixerAccount, verdictPath } = opts;
  const nodeJson = await readNodeJson(templateDir, nodeId);
  // The shared bar: `optimize.criteria`, or the back-compat `optimize.judge` alias (either works; criteria wins).
  const judgeRaw = nodeJson.optimize?.criteria ?? nodeJson.optimize?.judge;
  if (!judgeRaw) {
    throw new Error(
      `buildGatePrompt: node "${nodeId}" has no "optimize.criteria" (or the legacy "optimize.judge") configured in its node.json — the gate has no bar to judge against.`,
    );
  }
  const judgeResolved = path.resolve(templateDir, resolveTokens(judgeRaw, { run: runDir, workspace }));
  const judgeContent = await readFileMaybe(judgeResolved);
  if (judgeContent === null) {
    throw new Error(
      `buildGatePrompt: node "${nodeId}"'s declared optimize.criteria file was not found: ${judgeResolved} (declared as "${judgeRaw}" in nodes/${nodeId}/node.json)`,
    );
  }

  const diffSection = fixerDiff.trim() ? fixerDiff : '(no diff was captured — inspect the candidate harness under the run dir directly)';
  const accountSection = fixerAccount.trim() ? fixerAccount : '(the fixer left no written account)';

  const OUTPUT_SPEC = [
    `Write your verdict as JSON to EXACTLY this path: ${verdictPath}`,
    'The file MUST be a single JSON object with these keys:',
    '  "decision": "accept" | "reject"   — accept ⇒ stage for a human to adopt; reject ⇒ drop back to a fresh fixer',
    '  "rationale": "<evidence-cited prose — cite a diff hunk / output line / criterion per claim; for the HUMAN>"',
    '  "category": "reward-hack" | "band-aid" | "didnt-reach-root" | "regressed-elsewhere"   — REQUIRED on reject, omit on accept',
    '  "steer": "<one-line diversification steer for the fresh fixer — try a DIFFERENT harness element; NEVER restate the criteria>"   — on reject',
    'Write ONLY that file. Do not edit any other file.',
  ].join('\n');

  return [
    `<role>You are the GATE agent for the "${nodeId}" node — the independent verifier of ONE fixer's candidate edit. You decide ACCEPT (stage for a human to adopt) or REJECT (drop back to a fresh fixer). You are blind to the fixer's reasoning and you never fix or adopt.</role>`,
    `<playbook>Your GATE playbook — the three checks (read the board · refute-by-default reward-hack audit · quality vs the node's own bar) and the drop-back packet — is staged as the "${GATE_SKILL}" skill for this turn. Follow it.</playbook>`,
    `<separation_law>${SEPARATION_LAW}</separation_law>`,
    `<the_bar path="${judgeResolved}">\nThe node's OWN quality criteria — the SAME bar a regular run applies. Judge the candidate against THIS; invent no stricter bar.\n\n${judgeContent}\n</the_bar>`,
    `<issue>\nThe defect the fix was supposed to close. The fix must fix its ROOT, not silence its detector.\n\n${issueFileText}\n</issue>`,
    `<candidate_artifact run="${runDir}">The node was RE-RUN against the fixer's edited harness; its new output artifact (and the node's own deterministic gates' results) live under this run dir — read them to judge whether the defect is actually ABSENT now and nothing else regressed.</candidate_artifact>`,
    `<fixer_diff>\n${diffSection}\n</fixer_diff>`,
    `<fixer_account>\nThe fixer's OWN account — a CLAIM to cross-check against the diff + artifact, never evidence on its own.\n\n${accountSection}\n</fixer_account>`,
    `<output_spec>\n${OUTPUT_SPEC}\n</output_spec>`,
    `<self_check>Before writing the verdict: all three checks run? every claim cites a diff/output/criterion line? judged on the node's OWN bar across the whole board? on reject — category set and steer carries NO criteria leak? uncertainty ⇒ reject stated plainly? If any is No, you are not done.</self_check>`,
  ].join('\n\n');
}

// ── (2) parseGateVerdict — the fail-closed verdict-file parse ────────────────────────────────────────────────

/**
 * Parse the agent-written `verdict.json` raw text into a validated `GateVerdictFile`. FAIL-CLOSED: anything not
 * exactly the shape throws (never a silent best-effort read — a malformed verdict must block, not auto-accept).
 */
export function parseGateVerdict(raw: string): GateVerdictFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`gate verdict is not valid JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('gate verdict must be a JSON object');
  const v = parsed as Record<string, unknown>;

  if (v.decision !== 'accept' && v.decision !== 'reject') {
    throw new Error(`gate verdict "decision" must be "accept" or "reject", got ${JSON.stringify(v.decision)}`);
  }
  if (typeof v.rationale !== 'string' || !v.rationale.trim()) throw new Error('gate verdict "rationale" must be a non-empty string');

  const out: GateVerdictFile = { decision: v.decision, rationale: v.rationale };
  if (v.decision === 'reject') {
    if (!REJECT_CATEGORIES.includes(v.category as GateRejectCategory)) {
      throw new Error(`gate verdict "category" must be one of ${REJECT_CATEGORIES.join('|')} on a reject, got ${JSON.stringify(v.category)}`);
    }
    out.category = v.category as GateRejectCategory;
    if (v.steer !== undefined) {
      if (typeof v.steer !== 'string') throw new Error('gate verdict "steer" must be a string when present');
      out.steer = v.steer;
    }
  } else {
    // accept: category/steer are drop-back-only — reject their presence so a mislabeled verdict can't smuggle one.
    if (v.category !== undefined) throw new Error('gate verdict "category" must be omitted on an accept');
    if (v.steer !== undefined) throw new Error('gate verdict "steer" must be omitted on an accept');
  }
  return out;
}

// ── (3) runSubstrateGate — the full pass ──────────────────────────────────────────────────────────────────

/** The gate's opts = its OWN specialization (dirs + the fix inputs) + the base agent's whole inherited field
 *  surface + the `runAgent` test seam, EMBEDDED via `BaseAgentChildOpts` (agent.ts) — never a re-declared
 *  subset (anything left off a copy is silently lost; `dryRun`, tier/model, timeoutMs, provider, the observe
 *  seams and every future base field arrive here automatically, exactly as they do for judge.ts / fix.ts). */
export interface RunSubstrateGateOpts extends BaseAgentChildOpts {
  /** `{{WORKSPACE}}` — the product repo root. */
  workspace: string;
  /** The template dir (`nodes/<id>/node.json`). */
  templateDir: string;
  /** The original issue file verbatim (the defect spec). */
  issueFileText: string;
  /** The fixer's candidate diff (unified text; '' when unavailable). */
  fixerDiff: string;
  /** The fixer's written account (its final text; '' when none). */
  fixerAccount: string;
  /** The edited candidate harness dir — granted read so the gate can inspect the edit in place. Optional. */
  candidateRef?: string;
  /** Where the gate writes `verdict.json`. Default `<runDir>/optimize/substrate/gate`. */
  gateOutDir?: string;
}

export interface RunSubstrateGateResult {
  /** The parsed, validated verdict. ABSENT on a dry-run (nothing was judged). */
  verdict?: GateVerdictFile;
  /** The gate agent's parsed final text (telemetry only — control flow reads the verdict FILE). Absent on dry-run. */
  agentText?: string;
  /** The gate agent's full node status record. Absent on a dry-run. */
  agentStatus?: RunBaseAgentResult['status'];
  /** The gate spawn's PERSISTED run dir (present ONLY when the caller passed `outDir`) — point the observe
   *  instruments at it exactly like a node's run. Absent on the ephemeral default and on a dry-run. */
  agentRunDir?: string;
  /** The absolute `verdict.json` path (so a caller can surface it). Absent on a dry-run. */
  verdictPath?: string;
  /** Present ONLY on a dry-run: the composed one-node spec that WOULD have been spawned (forwarded verbatim
   *  from the base agent's preview seam). */
  dryRun?: RunBaseAgentResult['plan'];
}

/**
 * Run ONE full gate pass over the candidate run `(runDir, nodeId)`: build the prompt, spawn the blind gate
 * agent (readScope = `[runDir, templateDir, workspace, candidateRef?]`; owns = the gate's out dir), and read +
 * validate the `verdict.json` it wrote. On `dryRun`, return the composed plan WITHOUT spawning or reading a
 * verdict (the base-agent preview seam every base agent inherits).
 */
export async function runSubstrateGate(runDir: string, nodeId: string, opts: RunSubstrateGateOpts): Promise<RunSubstrateGateResult> {
  const { workspace, templateDir, issueFileText, fixerDiff, fixerAccount } = opts;
  const gateOutDir = opts.gateOutDir ?? path.join(runDir, 'optimize', 'substrate', 'gate');
  const verdictPath = path.join(gateOutDir, 'verdict.json');
  const runAgent = opts.runAgent ?? runBaseAgent;

  const prompt = await buildGatePrompt(nodeId, {
    runDir, workspace, templateDir, issueFileText, fixerDiff, fixerAccount, verdictPath,
  });
  const readScope = [runDir, templateDir, workspace, ...(opts.candidateRef ? [opts.candidateRef] : [])];

  const agentResult = await runAgent({
    prompt,
    cwd: workspace,
    readScope,
    owns: [gateOutDir],
    skill: GATE_SKILL, // stage the default gate playbook (Ring 1); a miss degrades to the promptless playbook.
    // The base agent's WHOLE inherited surface (tier/model/timeoutMs/provider/seams/dryRun/…), forwarded as one
    // projection — never a hand-enumerated subset (dryRun's preview short-circuit rides this too).
    ...inheritedAgentOpts(opts),
  });

  // DRY-RUN: the base agent returned the composed plan (no spawn). Forward it and STOP — no verdict was written.
  if (opts.dryRun) {
    return { dryRun: agentResult.plan };
  }

  const raw = await readFileMaybe(verdictPath);
  if (raw === null) {
    throw new Error(
      `runSubstrateGate: node "${nodeId}" gate agent wrote no verdict at ${verdictPath} — a gate turn that renders no verdict is treated as a hard failure, never a silent accept.`,
    );
  }
  const verdict = parseGateVerdict(raw);

  return {
    verdict,
    verdictPath,
    agentText: agentResult.text,
    agentStatus: agentResult.status,
    agentRunDir: agentResult.runDir,
  };
}
