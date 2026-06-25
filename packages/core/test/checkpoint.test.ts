// G5 — HUMAN CHECKPOINT (HITL). Two gates (test-discipline §0):
//   PURE LOGIC (validateReply / hashCheckpoint) → example tests with independently-justified assertions.
//   ORCHESTRATION GLUE (the runner's checkpoint lane) → integration tests through `runWorkflow` with the
//     injected `checkpointWait` seam + a temp run dir. The observable seams (doc §8): the marker file
//     `.pi/checkpoints/<id>.json`, the reply file `<id>.reply.json`, the `__checkpoints__` journal in
//     `.pi/state.json`, the §G4 `journal.json` entry, and the observe `RunViewNode.checkpoint` +
//     `awaiting-input` derived status. No live `pi` (a checkpoint spawns none), so fully offline.
import { describe, it, expect } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile } from '../src/index.js';
import type { NodeIntent, WorkflowSpec } from '../src/index.js';
import { runWorkflow, type CheckpointWaiter } from '../src/runner/index.js';
import {
  hashCheckpoint,
  validateReply,
  buildMarker,
  readMarker,
  type CheckpointMarker,
} from '../src/runner/checkpoint.js';
import {
  checkpointMarkerFile,
  checkpointReplyFile,
  stateFile,
} from '../src/runner/layout.js';
import { loadJournal } from '../src/runner/journal.js';
import { buildRunView } from '../src/observe/runView.js';
import { readRunModel } from '../src/observe/read.js';

// ── helpers (mirror runner.test.ts) ─────────────────────────────────────────────────────────────

function n(label: string, reads: string[], produces: string[], over: Partial<NodeIntent> = {}): NodeIntent {
  return {
    label,
    prompt: `do ${label}`,
    tools: {},
    io: { reads, produces, artifacts: produces.map((p) => ({ path: p })) },
    ...over,
  };
}
const wf = (nodes: NodeIntent[]): WorkflowSpec => ({ meta: { name: 't', description: 'd' }, nodes });

async function tmpOut(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'piflow-checkpoint-'));
}

/** The offline stub builder (mirrors runner.test.ts): writes each declared artifact + an ok return. */
function stubBuilder() {
  return (node: { id: string; io: { artifacts: { path: string }[] }; sandbox: { output: string } }): string => {
    const writes = node.io.artifacts
      .map((a) => {
        const dest = `${node.sandbox.output}/${a.path}`;
        const dir = dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : '.';
        return `mkdir -p ${dir} && printf '%s' ${node.id} > ${dest}`;
      })
      .join(' && ');
    const ret = `printf '%s' '\`\`\`json\\n{"status":"ok","summary":"${node.id} done"}\\n\`\`\`'`;
    return writes ? `${writes} && ${ret}` : ret;
  };
}

/** A checkpoint NodeIntent: a zero-artifact node carrying a `checkpoint` block (it spawns no `pi`). */
function checkpoint(label: string, reads: string[], spec: NodeIntent['checkpoint']): NodeIntent {
  return { label, prompt: `ask ${label}`, tools: {}, io: { reads, produces: [], artifacts: [] }, checkpoint: spec };
}

/** Read the `__checkpoints__` journal off `.pi/state.json`. */
async function readCkJournal(runDir: string): Promise<Record<string, { status: string; reply?: unknown; hash: string }>> {
  try {
    const st = JSON.parse(await fs.readFile(stateFile(runDir), 'utf8')) as Record<string, unknown>;
    return (st.__checkpoints__ ?? {}) as Record<string, { status: string; reply?: unknown; hash: string }>;
  } catch {
    return {};
  }
}

/** A waiter that polls the seam's `read()` synchronously a fixed number of times (no wall-clock sleep). */
const fastWait =
  (rounds = 50): CheckpointWaiter =>
  async ({ read, accept, deadline }) => {
    for (let i = 0; i < rounds; i++) {
      const reply = await read();
      if (reply && accept(reply)) return reply;
      if (Date.now() >= deadline) return null;
    }
    return null;
  };

// ── 1. PURE: hashCheckpoint + validateReply (the runner's authority) ──────────────────────────────

describe('hashCheckpoint — the question identity', () => {
  it('flips when the prompt / kind / choices / default change (an edited question must re-prompt)', () => {
    const base = { kind: 'select' as const, prompt: 'A or B?', choices: ['A', 'B'], default: 'A' };
    const h = hashCheckpoint(base);
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashCheckpoint({ ...base, prompt: 'A or C?' })).not.toBe(h);
    expect(hashCheckpoint({ ...base, kind: 'input' })).not.toBe(h);
    expect(hashCheckpoint({ ...base, choices: ['A', 'C'] })).not.toBe(h);
    expect(hashCheckpoint({ ...base, default: 'B' })).not.toBe(h);
    // identical inputs → identical hash.
    expect(hashCheckpoint(base)).toBe(h);
  });
});

describe('validateReply — the runner re-validates every reply (never trusts the courier)', () => {
  const marker: CheckpointMarker = buildMarker('cp', 'Cp', { kind: 'select', prompt: 'A or B?', choices: ['A', 'B'], default: 'A' }, 'now');

  it('ACCEPTS a valid select reply with a matching hash', () => {
    const v = validateReply(marker, { nodeId: 'cp', hash: marker.hash, value: 'B' });
    expect(v).toEqual({ ok: true, value: 'B' });
  });

  it('REJECTS a reply whose echoed hash does not match (stale / re-asked question)', () => {
    const v = validateReply(marker, { nodeId: 'cp', hash: 'sha256:deadbeef', value: 'B' });
    expect(v.ok).toBe(false);
  });

  it('REJECTS a select value not in choices', () => {
    const v = validateReply(marker, { nodeId: 'cp', hash: marker.hash, value: 'Z' });
    expect(v.ok).toBe(false);
  });

  it('enforces the kind shape: confirm⇒boolean, input⇒non-empty string', () => {
    const cm: CheckpointMarker = buildMarker('c', 'C', { kind: 'confirm', prompt: 'ok?' }, 'now');
    expect(validateReply(cm, { nodeId: 'c', hash: cm.hash, value: true }).ok).toBe(true);
    expect(validateReply(cm, { nodeId: 'c', hash: cm.hash, value: 'yes' }).ok).toBe(false);
    const im: CheckpointMarker = buildMarker('i', 'I', { kind: 'input', prompt: 'name?' }, 'now');
    expect(validateReply(im, { nodeId: 'i', hash: im.hash, value: 'Ada' }).ok).toBe(true);
    expect(validateReply(im, { nodeId: 'i', hash: im.hash, value: '' }).ok).toBe(false);
  });
});

// ── 2. INTEGRATION: marker written + the lane PARKS (no deadlock; a sibling is not blocked) ────────

describe('runWorkflow — checkpoint marker + parking (doc §8.1)', () => {
  it('writes the pending marker, derives awaiting-input, and does NOT block an independent sibling', async () => {
    // Stage 1: a checkpoint node (parks) PLUS an independent producer (must still run to completion).
    const g = compile(
      wf([
        checkpoint('Gate', [], { kind: 'select', prompt: 'Ship A or B?', choices: ['A', 'B'], default: 'A', timeoutMs: 0 }),
        n('Sibling', [], ['sib.txt']),
      ]),
    );
    const outDir = await tmpOut();

    // A waiter that NEVER finds a reply within a bounded number of rounds (the park is observable: it
    // returns null, then headless:default fires). The sibling must finish regardless.
    let waitCalls = 0;
    const wait: CheckpointWaiter = async (args) => { waitCalls++; return fastWait(3)(args); };

    const { status } = await runWorkflow(g, {
      run: 'park', outDir, buildCommand: stubBuilder(), checkpointReply: 'interactive', checkpointWait: wait,
    });

    // The marker was written with the right question + a hash.
    const marker = await readMarker(outDir, 'gate');
    expect(marker).toMatchObject({ nodeId: 'gate', kind: 'select', prompt: 'Ship A or B?', choices: ['A', 'B'], default: 'A' });
    expect(marker!.hash).toBe(hashCheckpoint({ kind: 'select', prompt: 'Ship A or B?', choices: ['A', 'B'], default: 'A' }));
    // The waiter was actually consulted (the lane parked) …
    expect(waitCalls).toBe(1);
    // … and the INDEPENDENT sibling ran to completion (no deadlock, no slot held by the parked checkpoint).
    expect(status.nodes.sibling.status).toBe('ok');
    expect(existsSync(path.join(outDir, 'sib.txt'))).toBe(true);
  });
});

// ── 3. INTEGRATION: a valid reply unblocks with that value (doc §8.2) ──────────────────────────────

describe('runWorkflow — a valid reply resolves the checkpoint (doc §8.2)', () => {
  it('resumes with the replied value: node ok, journal carries it, run completes', async () => {
    const g = compile(wf([checkpoint('Gate', [], { kind: 'select', prompt: 'A or B?', choices: ['A', 'B'], default: 'A' })]));
    const outDir = await tmpOut();
    const marker = buildMarker('gate', 'Gate', { kind: 'select', prompt: 'A or B?', choices: ['A', 'B'], default: 'A' }, 'x');

    // The waiter writes a valid reply file on its first poll (the courier, simulated), then reads it back.
    const wait: CheckpointWaiter = async (args) => {
      await fs.mkdir(path.dirname(checkpointReplyFile(outDir, 'gate')), { recursive: true });
      await fs.writeFile(checkpointReplyFile(outDir, 'gate'), JSON.stringify({ nodeId: 'gate', hash: marker.hash, value: 'B', by: 'test' }));
      return fastWait(5)(args);
    };

    const { status } = await runWorkflow(g, { run: 'reply', outDir, buildCommand: stubBuilder(), checkpointReply: 'interactive', checkpointWait: wait });

    expect(status.nodes.gate.status).toBe('ok');
    expect(status.ok).toBe(true);
    // The chosen value reached the run: the `__checkpoints__` journal + the §G4 journal both carry 'B'.
    const ck = await readCkJournal(outDir);
    expect(ck.gate).toMatchObject({ status: 'resolved', reply: 'B' });
    const journal = await loadJournal(outDir);
    expect(journal!.nodes.gate.checkpointReply).toBe('B');
  });
});

// ── 4. INTEGRATION: headless default never hangs and journals the default (doc §8.3) ──────────────

describe('runWorkflow — headless takes the default (doc §8.3)', () => {
  it('with checkpointReply:default and no reply, journals the declared default and completes', async () => {
    const g = compile(wf([checkpoint('Gate', [], { kind: 'select', prompt: 'A or B?', choices: ['A', 'B'], default: 'A', headless: 'default' })]));
    const outDir = await tmpOut();

    // 'default' mode skips the wait entirely — the run must NOT hang and must journal the default.
    const { status } = await runWorkflow(g, { run: 'headless', outDir, buildCommand: stubBuilder(), checkpointReply: 'default' });

    expect(status.nodes.gate.status).toBe('ok');
    expect(status.done).toBe(true);
    const journal = await loadJournal(outDir);
    expect(journal!.nodes.gate.checkpointReply).toBe('A'); // the declared default
  });
});

// ── 5. INTEGRATION: a malformed/invalid reply is rejected; the wait persists, then a valid one wins ──

describe('runWorkflow — a bad reply is rejected, the wait persists (doc §8.4)', () => {
  it('a choice-not-in-choices reply does not resolve; a later valid reply does', async () => {
    const g = compile(wf([checkpoint('Gate', [], { kind: 'select', prompt: 'A or B?', choices: ['A', 'B'], default: 'A' })]));
    const outDir = await tmpOut();
    const marker = buildMarker('gate', 'Gate', { kind: 'select', prompt: 'A or B?', choices: ['A', 'B'], default: 'A' }, 'x');

    // First poll sees an INVALID reply (value 'Z' ∉ choices) — must be rejected. Then a VALID 'B' lands.
    let polls = 0;
    const wait: CheckpointWaiter = async ({ read, accept, deadline }) => {
      await fs.mkdir(path.dirname(checkpointReplyFile(outDir, 'gate')), { recursive: true });
      for (let i = 0; i < 20; i++) {
        if (i === 0) await fs.writeFile(checkpointReplyFile(outDir, 'gate'), JSON.stringify({ nodeId: 'gate', hash: marker.hash, value: 'Z' }));
        if (i === 2) await fs.writeFile(checkpointReplyFile(outDir, 'gate'), JSON.stringify({ nodeId: 'gate', hash: marker.hash, value: 'B' }));
        polls++;
        const r = await read();
        if (r && accept(r)) return r;
        if (Date.now() >= deadline) return null;
      }
      return null;
    };

    const { status } = await runWorkflow(g, { run: 'badreply', outDir, buildCommand: stubBuilder(), checkpointReply: 'interactive', checkpointWait: wait });

    // It did NOT resolve on the bad reply (it kept polling past i=0) and resolved on 'B'.
    expect(polls).toBeGreaterThan(1);
    expect(status.nodes.gate.status).toBe('ok');
    const ck = await readCkJournal(outDir);
    expect(ck.gate).toMatchObject({ status: 'resolved', reply: 'B' });
  });
});

// ── 6. INTEGRATION: headless:abort halts (doc §8.5) ───────────────────────────────────────────────

describe('runWorkflow — headless:abort halts the run (doc §8.5)', () => {
  it('with no reply and headless:abort, the node errors and a downstream node never runs', async () => {
    const g = compile(
      wf([
        checkpoint('Gate', [], { kind: 'confirm', prompt: 'proceed?', headless: 'abort', timeoutMs: 0 }),
        n('After', ['gate.flag'], ['after.txt'], { io: { reads: [], produces: ['after.txt'], artifacts: [{ path: 'after.txt' }], dependsOn: ['gate'] } }),
      ]),
    );
    const outDir = await tmpOut();
    const { status } = await runWorkflow(g, {
      run: 'abort', outDir, buildCommand: stubBuilder(), checkpointReply: 'interactive', checkpointWait: fastWait(2),
    });

    expect(status.nodes.gate.status).toBe('error');
    expect(status.ok).toBe(false);
    // The downstream node never ran (it stays pending — the run halted at the barrier).
    expect(status.nodes.after.status).toBe('pending');
    expect(existsSync(path.join(outDir, 'after.txt'))).toBe(false);
  });
});

// ── 7. INTEGRATION: crash-mid-wait re-enters the wait, does not re-ask/duplicate (doc §8.7) ────────

describe('runWorkflow — crash-resume re-enters the wait (doc §8.7)', () => {
  it('a pending marker + journal on disk: a re-run does NOT re-ask, and a reply then resolves once', async () => {
    const g = compile(wf([checkpoint('Gate', [], { kind: 'input', prompt: 'name?' })]));
    const outDir = await tmpOut();
    // The "crash mid-wait" state, written directly (a real run was KILLED while parked, before any
    // headless default could fire): a pending marker + a pending `__checkpoints__` journal slot, FIXED
    // `askedAt` so we can prove the resume re-uses it rather than re-asking with a fresh timestamp.
    const askedAt = '2026-01-01T00:00:00.000Z';
    const marker = buildMarker('gate', 'Gate', { kind: 'input', prompt: 'name?' }, askedAt);
    await fs.mkdir(path.join(outDir, '.pi', 'checkpoints'), { recursive: true });
    await fs.writeFile(checkpointMarkerFile(outDir, 'gate'), JSON.stringify(marker));
    await fs.writeFile(stateFile(outDir), JSON.stringify({ __checkpoints__: { gate: { status: 'pending', hash: marker.hash, askedAt } } }));

    // RESUME run: a reply is on disk. The runner must re-enter the wait (re-using the SAME marker askedAt —
    // it did NOT re-ask), pick the reply up, and resolve ONCE — journaling the reply.
    const wait: CheckpointWaiter = async (args) => {
      await fs.writeFile(checkpointReplyFile(outDir, 'gate'), JSON.stringify({ nodeId: 'gate', hash: marker.hash, value: 'Ada' }));
      return fastWait(5)(args);
    };
    const { status } = await runWorkflow(g, { run: 'crash', outDir, buildCommand: stubBuilder(), checkpointReply: 'interactive', checkpointWait: wait });

    expect(status.nodes.gate.status).toBe('ok');
    const resumedMarker = await readMarker(outDir, 'gate');
    expect(resumedMarker!.askedAt).toBe(askedAt); // re-entered the SAME wait, did not re-ask
    const ck = await readCkJournal(outDir);
    expect(ck.gate).toMatchObject({ status: 'resolved', reply: 'Ada' });
  });
});

// ── 8. OBSERVE: the run-view surfaces the checkpoint field + awaiting-input (doc §8.6) ─────────────

describe('observe — the run-view surfaces the checkpoint (doc §8.6)', () => {
  it('a pending marker → RunViewNode.checkpoint.status pending + node status awaiting-input; resolved after', async () => {
    // Build a minimal run dir by hand (no runner): run.json with one node + a pending marker.
    const outDir = await tmpOut();
    await fs.mkdir(path.join(outDir, '.pi', 'checkpoints'), { recursive: true });
    await fs.writeFile(
      path.join(outDir, '.pi', 'run.json'),
      JSON.stringify({ run: 'obs', source: 't', startedAt: 'x', updatedAt: 'x', done: false, ok: null, durationMs: null, stage: null, totals: null, nodes: { gate: { id: 'gate', label: 'Gate', status: 'awaiting-input', artifacts: [], issues: [] } } }),
    );
    const marker = buildMarker('gate', 'Gate', { kind: 'confirm', prompt: 'ok?', default: true }, 'now');
    await fs.writeFile(checkpointMarkerFile(outDir, 'gate'), JSON.stringify(marker));

    // PENDING — both readers surface it.
    const { view } = buildRunView(outDir);
    const node = view.nodes.find((x) => x.id === 'gate')!;
    expect(node.status).toBe('awaiting-input');
    expect(node.checkpoint).toMatchObject({ status: 'pending', kind: 'confirm', prompt: 'ok?', hash: marker.hash });
    const model = await readRunModel(outDir);
    expect(model.nodes.find((x) => x.id === 'gate')!.status).toBe('awaiting-input');
    expect(model.nodes.find((x) => x.id === 'gate')!.checkpoint!.status).toBe('pending');

    // RESOLVED — the runner flips the record to `ok` AND writes the `__checkpoints__` journal slot; the
    // SAME builder now shows resolved + reply, and `awaiting-input` no longer applies.
    await fs.writeFile(
      path.join(outDir, '.pi', 'run.json'),
      JSON.stringify({ run: 'obs', source: 't', startedAt: 'x', updatedAt: 'x', done: true, ok: true, durationMs: 1, stage: null, totals: null, nodes: { gate: { id: 'gate', label: 'Gate', status: 'ok', artifacts: [], issues: [] } } }),
    );
    await fs.writeFile(stateFile(outDir), JSON.stringify({ __checkpoints__: { gate: { status: 'resolved', hash: marker.hash, askedAt: 'now', reply: true } } }));
    const { view: v2 } = buildRunView(outDir);
    const node2 = v2.nodes.find((x) => x.id === 'gate')!;
    expect(node2.checkpoint).toMatchObject({ status: 'resolved', reply: true });
    // awaiting-input no longer applies once resolved (the record's raw `ok` status governs again).
    expect(node2.status).toBe('ok');
  });
});
