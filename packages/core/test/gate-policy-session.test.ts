// (P2 · unified gate policy) The `session` (warm/cold) knob — RESUME vs RERUN — as a first-class GatePolicy
// field, DECOUPLED from "a retry action exists".
//
// Two layers, each with its own gate:
//   A. LOWERING (pure) — `lowerGate` maps a GatePolicy onto the op.action{retry}: `session` passes through
//      (default 'warm'); the budget reads `max` (or the `retryMax` alias); `retryScope` still rides `scope`
//      and does NOT change `session`. These are example tests on the pure transform.
//   B. RUNTIME (behavioral) — `runNodeWithRetries` picks warm/cold from the action's `session`, NOT the mere
//      presence of the action. Three named contracts through the injectable buildCommand/execRunner seam (no
//      real pi), on a `kind:'local'` provider (warm-eligible):
//        • RESUME  (session:'warm')  → attempt-2 resumes the SAME session (--session) with a FEEDBACK-ONLY prompt.
//        • RERUN   (session:'cold')  → attempt-2 does NOT resume (--session-id create) and the FULL prompt is re-sent.
//        • back-compat (retryScope:'feedback') → still warm-resumes unchanged.
//
// The RERUN case is the one that BITES the pre-P2 conflation: before P2 every l1Active retry warm-resumed, so a
// cold+feedback retry was unrequestable; RERUN asserts cold is honored independently. (test-the-test: forcing the
// runtime back to "always warm" turns RERUN red, and forcing "always cold" turns RESUME/back-compat red.)

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile, InMemorySandboxProvider, lowerGate } from '../src/index.js';
import type {
  NodeIntent,
  WorkflowSpec,
  NodeSpec,
  ResolveResult,
  SandboxProvider,
  Sandbox,
  CreateOpts,
  GatePolicy,
  ActionBody,
  OpSpec,
  PiCommandOptions,
} from '../src/index.js';
import { runWorkflow, defaultExecRunner } from '../src/runner/runner.js';
import { defaultPiCommand } from '../src/runner/command.js';
import { summarizeGates } from '../src/runner/node-lifecycle.js';

const wf = (nodes: NodeIntent[]): WorkflowSpec => ({ meta: { name: 't', description: 'd' }, nodes });
const tmpOut = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'piflow-gp-'));

/** Extract the FIRST retry action a floor-gate policy lowers to (the op.action{retry} entry). */
function retryActionFor(policy: GatePolicy): Extract<ActionBody, { kind: 'retry' }> {
  const ops = lowerGate({ kind: 'floor', check: 'non-empty', path: 'out.txt', policy }, 'producer').ops;
  const op = ops.find((o) => o.action?.kind === 'retry');
  if (!op) throw new Error('expected a retry action op to be lowered');
  return op.action as Extract<ActionBody, { kind: 'retry' }>;
}

// ── A · LOWERING (pure) ──────────────────────────────────────────────────────────────────────────────

describe('lowerGate — GatePolicy.session (and the back-compat aliases) → op.action{retry}', () => {
  it('session:"warm" passes through to the retry action', () => {
    expect(retryActionFor({ onFail: 'retry', session: 'warm', max: 1 }).session).toBe('warm');
  });

  it('session:"cold" passes through to the retry action (RERUN is expressible)', () => {
    expect(retryActionFor({ onFail: 'retry', session: 'cold', max: 1 }).session).toBe('cold');
  });

  it('defaults session to "warm" when the policy names none (preserves pre-P2 feedback-retry behavior)', () => {
    // A bare feedback retry (no session) must lower to warm — else an existing template would silently flip to cold.
    expect(retryActionFor({ onFail: 'retry', max: 1 }).session).toBe('warm');
  });

  it('back-compat: retryScope:"feedback" maps to session:"warm" and retryMax maps to max', () => {
    const a = retryActionFor({ onFail: 'retry', retryMax: 3, retryScope: 'feedback' });
    expect(a.session).toBe('warm'); // retryScope:'feedback' ⇒ warm
    expect(a.scope).toBe('feedback'); // the corrective LANE still rides `scope` (L2 'fix' routing seam)
    expect(a.max).toBe(3); // retryMax → max
  });

  it('back-compat: retryScope:"fix" still maps to session:"warm" (the fix lane stays aliased to warm)', () => {
    const a = retryActionFor({ onFail: 'retry', retryMax: 1, retryScope: 'fix' });
    expect(a.session).toBe('warm');
    expect(a.scope).toBe('fix'); // scope preserved for the L2 stub
  });

  it('the new `max` field wins as the budget (with retryMax as the fallback alias)', () => {
    expect(retryActionFor({ onFail: 'retry', max: 5 }).max).toBe(5);
    expect(retryActionFor({ onFail: 'retry', retryMax: 2 }).max).toBe(2);
  });

  it('a judge gate lowers its reroute budget from `max` OR the retryMax alias (P1 spelling still works)', () => {
    const byMax = lowerGate({ kind: 'judge', judgeTier: 'deep', rubric: 'r', policy: { onFail: 'reroute', max: 4 } }, 'prod').ops;
    const byLegacy = lowerGate({ kind: 'judge', judgeTier: 'deep', rubric: 'r', policy: { retryMax: 2 } }, 'prod').ops;
    const budget = (ops: OpSpec[]): number =>
      (ops.find((o) => o.action?.kind === 'rerouteTo')!.action as Extract<ActionBody, { kind: 'rerouteTo' }>).max;
    expect(budget(byMax)).toBe(4);
    expect(budget(byLegacy)).toBe(2); // the P1 judge-materialization spelling
  });
});

// ── A' · DISPLAY (pure) ──────────────────────────────────────────────────────────────────────────────

describe('summarizeGates — the retry entry surfaces the session knob', () => {
  it('folds `session` into the retry label alongside `scope`', () => {
    const node = {
      id: 'n',
      label: 'n',
      io: { reads: [], produces: [], externalInputs: [], dependsOn: [], artifacts: [] },
      sandbox: { provider: 'local', workspace: '.', read: [], write: [], output: 'out/n' },
      op: [{ when: 'on-failure', action: { kind: 'retry', max: 2, scope: 'feedback', session: 'cold' } }] as OpSpec[],
    } as unknown as NodeSpec;
    const s = summarizeGates(node);
    const retry = s?.entries.find((e) => e.kind === 'retry');
    expect(retry, 'a retry entry must be present').toBeDefined();
    // Minimal, legible: `retry ×2 (feedback·cold)` — the session is visible, not hidden.
    expect(retry!.label).toContain('cold');
    expect(retry!.label).toContain('feedback');
  });
});

// ── B · RUNTIME (behavioral) ─────────────────────────────────────────────────────────────────────────

/** A provider that REPORTS `kind:'local'` (warm-resume-eligible) while backing each node with an in-memory sandbox. */
function localKindProvider(): SandboxProvider {
  const base = new InMemorySandboxProvider();
  return { kind: 'local', create: (opts: CreateOpts): Promise<Sandbox> => base.create(opts) };
}

interface Attempt {
  cmd: string;
  session: PiCommandOptions['session'];
  prompt: string;
}

/**
 * Run a single producer whose retry action is LOWERED from `policy` (so the whole GatePolicy→action→runtime
 * chain is exercised). Attempt 1 fails (writes nothing → artifact missing → retry); attempt 2 writes the
 * artifact → the node ends `ok`. Returns the captured per-attempt command + injected session opts + staged prompt.
 */
async function captureRetry(policy: GatePolicy): Promise<Attempt[]> {
  const retryOp = lowerGate({ kind: 'floor', check: 'non-empty', path: 'out.txt', policy }, 'producer').ops.find(
    (o) => o.action?.kind === 'retry',
  )!;
  const node: NodeIntent = {
    label: 'Producer',
    prompt: 'produce the artifact',
    tools: {},
    io: { reads: [], produces: ['out.txt'], artifacts: [{ path: 'out.txt' }], retry: { max: 1 } },
    op: [retryOp],
  };
  const g = compile(wf([node]));
  const outDir = await tmpOut();
  const attempts: Attempt[] = [];

  const builder = (
    nodeSpec: NodeSpec & { sandbox: { output: string } },
    resolved: ResolveResult,
    ctx: { promptFile: string; provider?: string; model?: string },
    opts?: PiCommandOptions,
  ): string => {
    const cmd = defaultPiCommand(nodeSpec, resolved, ctx, opts);
    attempts.push({ cmd, session: opts?.session, prompt: '' });
    // In-place (local) SKIPS collect — the artifact gate stat()s the HOST run dir directly. Attempt 1 fails
    // (no artifact); attempt 2 writes it → the node ends `ok`.
    const art = nodeSpec.io.artifacts[0].path;
    const dest = path.join(outDir, art);
    const tail = attempts.length === 1 ? 'exit 1' : `mkdir -p ${path.dirname(dest)} && printf '%s' ok > ${dest}`;
    return `cat ${ctx.promptFile} && echo '<<<PROMPT_END>>>' && ${tail}`;
  };

  const captureExec = async (sandbox: Sandbox, cmd: string, opts: Parameters<typeof defaultExecRunner>[2]) => {
    const r = await defaultExecRunner(sandbox, cmd, opts);
    const harvested = r.result.stdout.split('<<<PROMPT_END>>>')[0];
    const slot = attempts.find((a) => a.prompt === '');
    if (slot) slot.prompt = harvested;
    return r;
  };

  await runWorkflow(g, {
    run: 'gp-session',
    outDir,
    provider: localKindProvider(),
    buildCommand: builder as Parameters<typeof runWorkflow>[1]['buildCommand'],
    execRunner: captureExec,
  });
  await fs.rm(outDir, { recursive: true, force: true });
  return attempts;
}

describe('runNodeWithRetries — session (warm/cold) picks RESUME vs RERUN independently of "has a retry action"', () => {
  it('RESUME (session:"warm") — attempt-2 resumes the SAME session with a FEEDBACK-ONLY prompt', async () => {
    const attempts = await captureRetry({ onFail: 'retry', session: 'warm', max: 1 });
    expect(attempts).toHaveLength(2);

    // attempt 2 RESUMES (--session, not --session-id) → warm.
    expect(attempts[1].session, 'attempt 2 must carry a session').toBeDefined();
    expect(attempts[1].session!.resume, 'warm ⇒ resume the existing session').toBe(true);
    expect(attempts[1].cmd).toContain("--session 'producer'");
    expect(attempts[1].cmd).not.toContain('--session-id');
    // Feedback-ONLY: the critique, NOT the original prompt (it already lives in the resumed session tree).
    expect(attempts[1].prompt).toMatch(/CONSULT|failure class|missing required artifact/i);
    expect(attempts[1].prompt).not.toContain('produce the artifact');
  });

  it('RERUN (session:"cold") — attempt-2 does NOT resume and the FULL prompt is re-sent (breaks the l1Active conflation)', async () => {
    const attempts = await captureRetry({ onFail: 'retry', session: 'cold', max: 1 });
    expect(attempts).toHaveLength(2);

    // attempt 2 stays COLD: a fresh session (create, not resume) — NO `--session <id>` resume flag.
    expect(attempts[1].session?.resume, 'cold ⇒ NOT a resume').toBeFalsy();
    expect(attempts[1].cmd).not.toMatch(/--session '/); // the resume flag (note the trailing space) is absent
    // The FULL resolved prompt is re-sent (with the critique prepended) — this is what distinguishes RERUN from RESUME.
    expect(attempts[1].prompt).toContain('produce the artifact');
    expect(attempts[1].prompt).toMatch(/CONSULT|failure class|missing required artifact/i);
  });

  it('back-compat: an existing retryScope:"feedback" policy still warm-resumes unchanged', async () => {
    const attempts = await captureRetry({ onFail: 'retry', retryMax: 1, retryScope: 'feedback' });
    expect(attempts).toHaveLength(2);

    // The legacy spelling maps to session:'warm' ⇒ the attempt-2 command resumes, feedback-only (today's behavior).
    expect(attempts[1].session!.resume, 'retryScope:feedback ⇒ warm resume (unchanged)').toBe(true);
    expect(attempts[1].cmd).toContain("--session 'producer'");
    expect(attempts[1].prompt).not.toContain('produce the artifact');
  });
});
