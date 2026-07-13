// (P3 · MUST-2) The RUNTIME seam of the inline hitl gate — a producer that runs its MODEL, then pauses for
// a human, and on REJECT re-runs the producer through the SAME P2 retry engine (default warm, carrying the
// reviewer's reason). Behavioral tests through the injectable buildCommand/execRunner/checkpointWait seams on
// a `kind:'local'` provider (warm-eligible). No real pi, no real wall-clock wait. Each test BITES a distinct
// load-bearing property; the test-the-test mutation for each is noted inline.

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile, InMemorySandboxProvider } from '../src/index.js';
import type {
  NodeIntent,
  WorkflowSpec,
  NodeSpec,
  ResolveResult,
  SandboxProvider,
  Sandbox,
  CreateOpts,
  CheckpointSpec,
  GatePolicy,
  Hook,
  PiCommandOptions,
} from '../src/index.js';
import { runWorkflow, defaultExecRunner } from '../src/runner/runner.js';
import type { CheckpointWaiter } from '../src/runner/runner.js';
import { defaultPiCommand } from '../src/runner/command.js';
import { summarizeGates } from '../src/runner/node-lifecycle.js';
import { readMarker, type CheckpointReply } from '../src/runner/checkpoint.js';

const wfOf = (nodes: NodeIntent[]): WorkflowSpec => ({ meta: { name: 't', description: 'd' }, nodes });
const tmpOut = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'piflow-hitl-'));

// A tier map so the producer (`fast`) and an escalation target (`deep`) resolve offline.
const MODEL_ROUTING = {
  tiers: { active: true, tiers: { fast: 'weak-model', deep: 'strong-model' } },
  modelsIndex: new Map<string, string>(),
} as const;

/** A provider that REPORTS `kind:'local'` (warm-resume-eligible) over an in-memory sandbox. */
function localKindProvider(): SandboxProvider {
  const base = new InMemorySandboxProvider();
  return { kind: 'local', create: (opts: CreateOpts): Promise<Sandbox> => base.create(opts) };
}

interface Attempt {
  cmd: string;
  session: PiCommandOptions['session'];
  prompt: string;
}

interface HarnessOpts {
  checkpoint: CheckpointSpec;
  policy?: GatePolicy;
  retryMax: number;
  escalateTier?: string;
  checkpointReply: 'interactive' | 'default';
  /** Injected waiter: the boolean/string reply per ASK (1-indexed); undefined ⇒ use the default headless path. */
  replies?: (Array<boolean | string>);
  reason?: string;
  postHook?: () => void;
}

interface HarnessResult {
  attempts: Attempt[];
  status: Awaited<ReturnType<typeof runWorkflow>>['status'];
  node: NodeSpec;
  built: string[];
}

/**
 * Run a SINGLE producer with an inline hitl gate. The producer's model (the stub) always writes the artifact
 * (so the node would settle `ok`), then the inline gate fires. The injected `checkpointWait` returns the
 * scripted reply per attempt (reading the marker to echo its hash); an accept promotes, a reject re-runs.
 * Captures each attempt's command + session opts + staged prompt (harvested from the exec stdout).
 */
async function runInlineGate(o: HarnessOpts): Promise<HarnessResult> {
  const producer: NodeIntent = {
    label: 'Producer',
    prompt: 'produce the artifact',
    tier: 'fast',
    tools: {},
    io: {
      reads: [],
      produces: ['out.txt'],
      artifacts: [{ path: 'out.txt' }],
      ...(o.escalateTier ? { escalate: { tier: o.escalateTier } } : {}),
    },
    gate: { checkpoint: o.checkpoint, ...(o.policy ? { policy: o.policy } : {}) },
    op: [{ when: 'on-failure', action: { kind: 'retry', max: o.retryMax, scope: 'feedback', session: 'warm' } }],
    ...(o.postHook
      ? { hooks: { post: [{ id: 'pub', phase: 'post', when: 'on-success', run: async () => o.postHook!(), inputs: [], outputs: [] } as Hook] } }
      : {}),
  };
  const g = compile(wfOf([producer]));
  const outDir = await tmpOut();
  const attempts: Attempt[] = [];
  const built: string[] = [];

  const builder = (
    nodeSpec: NodeSpec & { sandbox: { output: string } },
    resolved: ResolveResult,
    ctx: { promptFile: string; provider?: string; model?: string },
    opts?: PiCommandOptions,
  ): string => {
    built.push(nodeSpec.id);
    const cmd = defaultPiCommand(nodeSpec, resolved, ctx, opts);
    attempts.push({ cmd, session: opts?.session, prompt: '' });
    const art = nodeSpec.io.artifacts[0].path;
    const dest = path.join(outDir, art);
    // Always write the artifact (in-place local skips collect ⇒ the artifact gate stats the host run dir).
    return `cat ${ctx.promptFile} && echo '<<<PROMPT_END>>>' && mkdir -p ${path.dirname(dest)} && printf '%s' ok > ${dest}`;
  };

  const captureExec = async (sandbox: Sandbox, cmd: string, opts: Parameters<typeof defaultExecRunner>[2]) => {
    const r = await defaultExecRunner(sandbox, cmd, opts);
    const harvested = r.result.stdout.split('<<<PROMPT_END>>>')[0];
    const slot = attempts.find((a) => a.prompt === '');
    if (slot) slot.prompt = harvested;
    return r;
  };

  let asks = 0;
  const checkpointWait: CheckpointWaiter = async ({ run, nodeId, accept }) => {
    asks++;
    const marker = await readMarker(run, nodeId);
    if (!marker) return null;
    const scripted = o.replies?.[asks - 1];
    const value = scripted ?? true;
    const reply: CheckpointReply = { nodeId, hash: marker.hash, value };
    if (value === false && o.reason) reply.reason = o.reason;
    return accept(reply) ? reply : null;
  };

  const { status } = await runWorkflow(g, {
    run: 'hitl',
    outDir,
    provider: localKindProvider(),
    buildCommand: builder as Parameters<typeof runWorkflow>[1]['buildCommand'],
    execRunner: captureExec,
    checkpointReply: o.checkpointReply,
    checkpointWait,
    modelRouting: MODEL_ROUTING,
  });
  const node = g.nodes['producer'];
  await fs.rm(outDir, { recursive: true, force: true });
  return { attempts, status, node, built };
}

describe('inline hitl gate — the producer runs its MODEL, then the checkpoint gates AFTER (not the no-pi lane)', () => {
  it('COLLISION: the producer SPAWNS its model (not short-circuited by node.checkpoint) and the gate is visible', async () => {
    // test-the-test: storing the checkpoint on `node.checkpoint` routes the node to runCheckpoint at
    // runner.ts dispatch ⇒ the builder is never called ⇒ `built` lacks 'producer' ⇒ RED.
    const { built, node, status } = await runInlineGate({
      checkpoint: { kind: 'confirm', prompt: 'Approve?', default: true },
      retryMax: 1,
      checkpointReply: 'default', // headless ⇒ take default:true ⇒ ACCEPT
    });
    expect(built, 'the producer must SPAWN its model (inline gate, not the no-pi checkpoint lane)').toContain('producer');
    expect(status.nodes['producer']?.status, 'an accepted inline gate promotes the node').toBe('ok');
    // (H3) the inline gate stays legible in the GateSummary.
    expect(summarizeGates(node)?.checkpoint, 'the inline gate must appear in the GateSummary').toBe('confirm');
  });

  it('ACCEPT: an approve promotes the node with ZERO re-attempts', async () => {
    const { attempts, status } = await runInlineGate({
      checkpoint: { kind: 'confirm', prompt: 'Approve?', default: true },
      retryMax: 1,
      checkpointReply: 'default',
    });
    expect(status.nodes['producer']?.status).toBe('ok');
    expect(attempts, 'an accept runs the producer exactly once').toHaveLength(1);
  });

  it('REJECT ⇒ warm RESUME carrying the reviewer reason into the re-run prompt', async () => {
    // Dual-bite: the reject must (a) re-run WARM (resume the producer session) AND (b) the reason must land
    // in the re-run's consult preamble. Fails today (a reject would finish ok) AND fails if consultPreamble
    // lacks the rejectReason branch (the re-run prompt would omit the reason).
    const REASON = 'the intro paragraph is far too long';
    const { attempts, status } = await runInlineGate({
      checkpoint: { kind: 'confirm', prompt: 'Approve?' },
      policy: { onFail: 'retry', max: 1, session: 'warm' },
      retryMax: 1,
      checkpointReply: 'interactive',
      replies: [false, true], // attempt 1 REJECT (+reason), attempt 2 ACCEPT
      reason: REASON,
    });
    expect(attempts, 'a reject must trigger a re-run (2 attempts)').toHaveLength(2);
    expect(status.nodes['producer']?.status, 'the accepting re-run promotes the node').toBe('ok');
    // (a) attempt 2 RESUMES the producer's own session (warm).
    expect(attempts[1].session?.resume, 'a reject re-run must resume WARM').toBe(true);
    expect(attempts[1].cmd).toContain("--session 'producer'");
    // (b) the reviewer's reason reaches the re-run prompt via consultPreamble.
    expect(attempts[1].prompt, 'the reviewer reason must reach the warm re-run').toContain(REASON);
    expect(attempts[1].prompt.toLowerCase()).toContain('reviewer');
  });

  it('ITEM-4: a reject reason containing "missing input" STILL re-runs (st=error, not blocked→halt)', async () => {
    // test-the-test: setting the reject to `st='blocked'` (instead of 'error') makes classifyFailure route a
    // reason matching /upstream|missing input/ to `halt` ⇒ NO retry ⇒ attempts===1 ⇒ RED. `error` avoids it.
    const { attempts, status } = await runInlineGate({
      checkpoint: { kind: 'confirm', prompt: 'Approve?' },
      policy: { onFail: 'retry', max: 1, session: 'warm' },
      retryMax: 1,
      checkpointReply: 'interactive',
      replies: [false, true],
      reason: 'missing input from the design doc — add the error case',
    });
    expect(attempts, 'a free-text "missing input" reject must NOT be misclassified as halt').toHaveLength(2);
    expect(status.nodes['producer']?.status).toBe('ok');
  });

  it('NO-ESCALATE (H1): a human reject NEVER escalates the model, even with an escalate config', async () => {
    // test-the-test: dropping the `!sig.humanReject` escalate guard lets the spent-budget reject escalate to
    // the `deep` (strong-model) tier ⇒ a 2nd attempt on strong-model ⇒ RED here.
    const { attempts, status } = await runInlineGate({
      checkpoint: { kind: 'confirm', prompt: 'Approve?' },
      policy: { onFail: 'retry', max: 0 },
      retryMax: 0, // budget spent ⇒ the escalate lane is REACHABLE...
      escalateTier: 'deep', // ...and configured, but a human reject must NOT take it
      checkpointReply: 'interactive',
      replies: [false, false], // reject; there must be NO escalate re-run
      reason: 'not good enough',
    });
    // The reject actually took effect (non-vacuity: a node that never fired the seam would end `ok`).
    expect(status.nodes['producer']?.status, 'a rejected node ends error').toBe('error');
    expect(attempts, 'a rejected producer with spent budget must NOT escalate-rerun').toHaveLength(1);
    expect(attempts.every((a) => !a.cmd.includes('strong-model')), 'the reject must never swap to the escalate model').toBe(true);
  });

  it('SEAM ORDER: a success POST-hook does NOT fire for a node the human then rejects', async () => {
    // test-the-test: moving the inline seam to AFTER the POST hooks lets the success hook fire on the first
    // (ok) pass BEFORE the reject flips st ⇒ `postFired` gets an entry ⇒ RED.
    const rejected: string[] = [];
    await runInlineGate({
      checkpoint: { kind: 'confirm', prompt: 'Approve?' },
      policy: { onFail: 'retry', max: 0 },
      retryMax: 0,
      checkpointReply: 'interactive',
      replies: [false],
      reason: 'no',
      postHook: () => rejected.push('post-ran'),
    });
    expect(rejected, 'a rejected node must NOT fire its on-success POST hook').toHaveLength(0);

    // Twin (non-vacuity): an ACCEPT DOES fire the on-success post hook.
    const accepted: string[] = [];
    await runInlineGate({
      checkpoint: { kind: 'confirm', prompt: 'Approve?', default: true },
      retryMax: 0,
      checkpointReply: 'default',
      postHook: () => accepted.push('post-ran'),
    });
    expect(accepted, 'an accepted node DOES fire its on-success POST hook').toHaveLength(1);
  });
});
