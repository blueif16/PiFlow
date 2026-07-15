// (warm-resume L1 · expert-representations) Per-node session-id foundation + same-model warm retry.
//
// docs/research/2026-06-28-warm-resume-pi-surfaces.md §4. On the SAME-MODEL L1 retry the runner re-invokes
// pi against the SAME per-node session (id = node id, dir = <run>/.pi-sessions) so the producer resumes its
// own conversation rather than re-running cold. We assert the BEHAVIORAL contract end-to-end through the
// injectable buildCommand/execRunner seam — no real pi spawns:
//
//   4. an L1 (scope:'feedback') retry → attempt-2's built command carries `--session <nodeId>` whose id
//      MATCHES attempt-1's `--session-id <nodeId>` (warm resume of the SAME session), and the attempt-2
//      prompt is FEEDBACK-ONLY (the critique, NOT prefix+original+markers).
//   5. an ESCALATION retry (different model) does NOT carry `--session` — escalation stays COLD (the warm
//      path must not leak across a model swap, §4d).
//   6. the node's JOURNAL entry carries the minted session id (a future `node <run> <id> --resume` finds it).
//
// Warm resume is SCOPED to local (in-place) providers, where the `.pi-sessions` dir persists across attempts
// (§4d / §5.4). The tests run on a `kind:'local'` provider so the warm path is active; an inmemory/cloud node
// stays cold (covered by the unchanged self-correction-l1 + escalate-loop suites).

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile, InMemorySandboxProvider } from '../src/index.js';
import type { NodeIntent, WorkflowSpec, NodeSpec, ResolveResult, SandboxProvider, Sandbox, CreateOpts } from '../src/index.js';
import { runWorkflow, defaultExecRunner } from '../src/runner/runner.js';
import { defaultPiCommand } from '../src/runner/command.js';
import { piSessionsDir } from '../src/runner/layout.js';
import type { PiCommandOptions } from '../src/types.js';

const wf = (nodes: NodeIntent[]): WorkflowSpec => ({ meta: { name: 't', description: 'd' }, nodes });
const tmpOut = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'piflow-wr-'));

/**
 * A provider that REPORTS `kind:'local'` (so the runner treats it as in-place ⇒ warm-resume eligible) while
 * still backing each node with an in-memory sandbox. Lets us exercise the warm command-build path without a
 * real `pi` or a real local workspace. (The warm decision keys on `ctx.providerKind`, set from `provider.kind`.)
 */
function localKindProvider(): SandboxProvider {
  const base = new InMemorySandboxProvider();
  return {
    kind: 'local',
    create: (opts: CreateOpts): Promise<Sandbox> => base.create(opts),
  };
}

/** What each captured attempt records: the built command + the session opts the runner injected. */
interface Attempt {
  cmd: string;
  session: PiCommandOptions['session'];
  prompt: string;
}

describe('warm-resume L1 — same-model retry resumes the per-node session', () => {
  it('attempt-2 carries --session <nodeId> matching attempt-1 --session-id <nodeId>, with a feedback-only prompt (behaviors 4 & 6)', async () => {
    // A producer with an op.action{retry, scope:'feedback'} (what SA-B gate-authoring emits) + a budget.
    const node: NodeIntent = {
      label: 'Producer',
      prompt: 'produce the artifact',
      tools: {},
      io: {
        reads: [],
        produces: ['out.txt'],
        artifacts: [{ path: 'out.txt' }],
        retry: { max: 1 },
      },
      op: [{ when: 'on-failure', action: { kind: 'retry', max: 1, scope: 'feedback' } }],
    };
    const g = compile(wf([node]));
    const outDir = await tmpOut();

    const attempts: Attempt[] = [];
    // The builder CAPTURES the real headless command (incl. the runner-injected session opts) per attempt,
    // and ALSO reads the staged prompt back out of the sandbox so we can assert the feedback-only shape.
    const builder = (
      nodeSpec: NodeSpec & { sandbox: { output: string } },
      resolved: ResolveResult,
      ctx: { promptFile: string; provider?: string; model?: string },
      opts?: PiCommandOptions,
    ): string => {
      const cmd = defaultPiCommand(nodeSpec, resolved, ctx, opts);
      const i = attempts.length;
      // We can't readFile the sandbox here, so cat the prompt into stdout and harvest it in execRunner.
      attempts.push({ cmd, session: opts?.session, prompt: '' });
      // In-place (local) SKIPS collect — the artifact gate stat()s the HOST run dir directly. So the success
      // attempt writes the artifact at its absolute host path (the shell runs on the real fs). attempt 1 fails
      // (no artifact) → L1 retry fires; attempt 2 writes the artifact → the node ends `ok` (journal written).
      const art = nodeSpec.io.artifacts[0].path;
      const dest = path.join(outDir, art);
      const tail = i === 0 ? `exit 1` : `mkdir -p ${path.dirname(dest)} && printf '%s' ok > ${dest}`;
      return `cat ${ctx.promptFile} && echo '<<<PROMPT_END>>>' && ${tail}`;
    };

    const captureExec = async (sandbox: Sandbox, cmd: string, opts: Parameters<typeof defaultExecRunner>[2]) => {
      const r = await defaultExecRunner(sandbox, cmd, opts);
      const m = r.result.stdout.split('<<<PROMPT_END>>>')[0];
      // map the harvested prompt back onto the last-pushed attempt that lacks one.
      const slot = attempts.find((a) => a.prompt === '');
      if (slot) slot.prompt = m;
      return r;
    };

    await runWorkflow(g, {
      run: 'wr-l1',
      outDir,
      provider: localKindProvider(),
      buildCommand: builder as Parameters<typeof runWorkflow>[1]['buildCommand'],
      execRunner: captureExec,
    });

    expect(attempts).toHaveLength(2);

    // ── attempt 1: CREATE the session (--session-id), id = the node id ──────────────────────────────
    expect(attempts[0].session, 'attempt 1 must request a session (create)').toBeDefined();
    expect(attempts[0].session!.resume).toBeFalsy();
    expect(attempts[0].session!.id).toBe('producer');
    expect(attempts[0].cmd).toContain("--session-id 'producer'");
    expect(attempts[0].cmd).not.toContain('--no-session');
    // The session dir is the DETERMINISTIC `<runDir>/.pi/sessions` (= piSessionsDir(outDir)) — a DEDICATED
    // subdir UNDER `.pi/` (a sibling of the journal/state files, never MIXED INTO them), NEVER the sandbox
    // workspace. This exact equality is the CLI contract: a future `node <run> <id> --resume` resolves the
    // session by this path alone; and sessions now live UNDER `.pi/` so the run stays self-contained.
    expect(attempts[0].session!.dir).toBe(piSessionsDir(outDir));
    expect(attempts[0].session!.dir).toMatch(/(^|\/)\.pi(\/|$)/);

    // ── attempt 2: RESUME the SAME session (--session), warm (behavior 4) ──────────────────────────
    expect(attempts[1].session, 'attempt 2 must resume a session').toBeDefined();
    expect(attempts[1].session!.resume).toBe(true);
    expect(attempts[1].session!.id).toBe('producer');
    expect(attempts[1].cmd).toContain("--session 'producer'");
    expect(attempts[1].cmd).not.toContain('--session-id');
    // SAME id + SAME dir as attempt 1 (warm continuation of one session, not a fresh one) — and that dir is
    // the SAME deterministic `<runDir>/.pi-sessions`, so the resume on attempt 2 reads the very file attempt 1
    // wrote (and the CLI later resolves the identical path).
    expect(attempts[1].session!.id).toBe(attempts[0].session!.id);
    expect(attempts[1].session!.dir).toBe(attempts[0].session!.dir);
    expect(attempts[1].session!.dir).toBe(piSessionsDir(outDir));

    // ── the resume prompt is FEEDBACK-ONLY: the critique, NOT prefix+original+markers ───────────────
    expect(attempts[0].prompt).toContain('produce the artifact');
    expect(attempts[1].prompt).toMatch(/CONSULT|failure class|missing required artifact/i);
    // a warm resume must NOT re-feed the original prompt (it is already in the session tree).
    expect(attempts[1].prompt).not.toContain('produce the artifact');

    // ── behavior 6: the journal records the minted session id AND its deterministic dir ─────────────
    // The recorded dir IS the CLI's lookup key, so it must equal `piSessionsDir(outDir)` exactly — that is
    // what lets `node <run> <id> --resume` find the session without re-deriving the path.
    const journal = JSON.parse(await fs.readFile(path.join(outDir, '.pi', 'journal.json'), 'utf8'));
    expect(journal.nodes.producer.sessionId, 'journal must record the minted session id').toBe('producer');
    expect(journal.nodes.producer.sessionDir, 'journal must record the deterministic session dir').toBe(
      piSessionsDir(outDir),
    );

    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('when attempt-1 left a real session FILE, the warm resume addresses it by PATH — not the bare id pi can\'t resolve', async () => {
    // ROOT-CAUSE REGRESSION (run 260715-02/plan): a bare `--session <nodeId>` under a custom `--session-dir`
    // makes pi SCAN + classify the session "different project" → an unanswerable fork prompt in headless `-p`
    // → the warm attempt no-ops and events.jsonl is starved. The fix: once attempt-1 has PERSISTED the session
    // file (`<ISO-ts>_<nodeId>.jsonl`), the resume must address it by its ABSOLUTE PATH (pi's direct-path
    // branch — no scan, no fork). This test plants a real session file on attempt-1 (the in-place shell runs on
    // the host fs) and asserts attempt-2's built command references THAT path. FAILS pre-fix (`--session 'producer'`).
    const node: NodeIntent = {
      label: 'Producer',
      prompt: 'produce the artifact',
      tools: {},
      io: { reads: [], produces: ['out.txt'], artifacts: [{ path: 'out.txt' }], retry: { max: 1 } },
      op: [{ when: 'on-failure', action: { kind: 'retry', max: 1, scope: 'feedback' } }],
    };
    const g = compile(wf([node]));
    const outDir = await tmpOut();
    const sessDir = piSessionsDir(outDir);
    const sessFile = path.join(sessDir, '2026-07-15T21-14-54-714Z_producer.jsonl');

    const attempts: Attempt[] = [];
    const builder = (
      nodeSpec: NodeSpec & { sandbox: { output: string } },
      resolved: ResolveResult,
      ctx: { promptFile: string; provider?: string; model?: string },
      opts?: PiCommandOptions,
    ): string => {
      const cmd = defaultPiCommand(nodeSpec, resolved, ctx, opts);
      const i = attempts.length;
      attempts.push({ cmd, session: opts?.session, prompt: '' });
      const art = nodeSpec.io.artifacts[0].path;
      const dest = path.join(outDir, art);
      // attempt 1: PERSIST a native session file (as pi's `--session-id` create would), then FAIL → warm retry.
      // attempt 2: write the artifact so the node ends ok.
      const tail = i === 0
        ? `mkdir -p '${sessDir}' && printf '%s' '{"type":"session","version":3,"id":"producer"}' > '${sessFile}' && exit 1`
        : `mkdir -p ${path.dirname(dest)} && printf '%s' ok > ${dest}`;
      return `${tail}`;
    };

    await runWorkflow(g, {
      run: 'wr-ref',
      outDir,
      provider: localKindProvider(),
      buildCommand: builder as Parameters<typeof runWorkflow>[1]['buildCommand'],
    });

    expect(attempts).toHaveLength(2);
    // attempt-1 CREATES by id (unchanged).
    expect(attempts[0].session!.resume).toBeFalsy();
    expect(attempts[0].cmd).toContain("--session-id 'producer'");
    // THE FIX: attempt-2 resumes by the LOCATED FILE PATH (resolvable), not the bare id.
    expect(attempts[1].session!.resume).toBe(true);
    expect(attempts[1].session!.resumeRef, 'the runner must locate + carry the session file path').toBe(sessFile);
    expect(attempts[1].cmd).toContain(`--session '${sessFile}'`);
    expect(attempts[1].cmd).not.toContain("--session 'producer'");
    expect(attempts[1].cmd).not.toContain('--session-id');

    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('an ESCALATION retry (different model) stays COLD — no --session flag (behavior 5)', async () => {
    // A node that escalates to a stronger tier. The escalation attempt swaps the model; it must NOT warm-
    // resume (warm carries the original model in its tree; §4d). The escalation command stays cold (create-
    // only on attempt 1, no `--session` resume on attempt 2).
    const node: NodeIntent = {
      label: 'Build',
      prompt: 'do Build',
      tools: {},
      io: { reads: [], produces: ['out.txt'], artifacts: [{ path: 'out.txt' }], escalate: { tier: 'deep' } },
    };
    const g = compile(wf([node]));
    const outDir = await tmpOut();

    const attempts: Attempt[] = [];
    const models: (string | undefined)[] = [];
    const builder = (
      nodeSpec: NodeSpec & { sandbox: { output: string } },
      resolved: ResolveResult,
      ctx: { promptFile: string; provider?: string; model?: string },
      opts?: PiCommandOptions,
    ): string => {
      models.push(ctx.model);
      attempts.push({ cmd: defaultPiCommand(nodeSpec, resolved, ctx, opts), session: opts?.session, prompt: '' });
      const out = nodeSpec.sandbox.output;
      // attempt 1 produces nothing (→ blocked → escalate); attempt 2 (the consult) writes the artifact.
      return attempts.length === 1 ? 'true' : `mkdir -p ${out} && printf '%s' done > ${out}/out.txt`;
    };

    await runWorkflow(g, {
      run: 'wr-esc',
      outDir,
      provider: localKindProvider(),
      buildCommand: builder as Parameters<typeof runWorkflow>[1]['buildCommand'],
      modelRouting: { tiers: { active: true, tiers: { deep: 'strong-model' } }, modelsIndex: new Map() },
    });

    // The escalation fired: exactly two attempts ran (the cheap default, then ONE consult on the stronger
    // model). (We assert the COMMAND shape, not the node verdict — behavior 5 is purely about warm leaking.)
    expect(attempts).toHaveLength(2);
    expect(models[1]).toBe('strong-model');
    // Session wiring IS active here (the provider is `local`, warm-eligible): attempt 1 CREATES a session.
    // This anchors the next assertion — it is NOT vacuously passing because sessions are off entirely.
    expect(attempts[0].session, 'session wiring must be active on the local provider').toBeDefined();
    expect(attempts[0].session!.resume).toBeFalsy(); // create on the first attempt
    // THE CRITICAL ASSERTION: the escalation attempt (2) stayed COLD — NO `--session` resume flag, no resume
    // opt — even though sessions are on. Warm-resume must NOT leak across the model swap (§4d).
    expect(attempts[1].session?.resume).toBeFalsy();
    expect(attempts[1].cmd).not.toMatch(/--session '/);

    await fs.rm(outDir, { recursive: true, force: true });
  });
});
