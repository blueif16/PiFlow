import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildNodeResumeCommand,
  buildStopAction,
  buildNodeStopAction,
  resolveNodeRunDir,
  runNodeCli,
  type NodeDeps,
  type NodePidRecord,
} from '../src/node.js';
import { piSessionsDir, journalFile, piDir, runJsonFile, nodeDir, type Journal, type RunStatus } from '@piflow/core';

// ─────────────────────────────────────────────────────────────────────────────
// (A) buildNodeResumeCommand — the PURE argv builder (no spawn, no fs).
// This is a CONVERSATIONAL warm resume of the node's stored pi session: it RESUMES an
// existing session (`--session <id>`), never CREATES one (`--session-id`).
// ─────────────────────────────────────────────────────────────────────────────
describe('buildNodeResumeCommand — the pure warm-resume argv builder', () => {
  const runDir = '/runs/flaky-pecan';
  const nodeId = 'w1a';

  // Split the built command into argv tokens so flag assertions don't collide with substrings inside
  // shell-quoted paths (e.g. the run name "flaky-pecan" contains "-p"). We assert on TOKENS, not substrings.
  const tokens = (cmd: string): string[] => cmd.match(/'(?:[^'\\]|\\.)*'|\S+/g) ?? [];
  // The value immediately after a flag token (with its surrounding single-quotes stripped).
  const valueAfter = (cmd: string, flag: string): string | undefined => {
    const t = tokens(cmd);
    const i = t.indexOf(flag);
    if (i < 0 || i + 1 >= t.length) return undefined;
    return t[i + 1].replace(/^'(.*)'$/, '$1');
  };

  it('with a message file: stamps --session-dir <piSessionsDir>, --session <nodeId>, @<file>; never --session-id', () => {
    const msgFile = '/tmp/resume-w1a.md';
    const cmd = buildNodeResumeCommand({ runDir, nodeId, messageFile: msgFile, interactive: false });
    const t = tokens(cmd);

    // RESUMES the stored session by id under the per-run session dir.
    expect(t).toContain('--session-dir');
    expect(valueAfter(cmd, '--session-dir')).toBe(piSessionsDir(runDir));
    // It addresses the session by the node id exactly via --session (RESUME), not --session-id (CREATE).
    expect(t).toContain('--session');
    expect(valueAfter(cmd, '--session')).toBe(nodeId);
    // The message is staged as a FILE and referenced with @<file> (the runner's prompt-staging discipline).
    expect(t.some((tok) => tok.replace(/^'(.*)'$/, '$1') === `@${msgFile}` || tok === `@'${msgFile}'`)).toBe(true);
    // RESUME, not CREATE — must NOT emit --session-id (that would start a fresh conversation).
    expect(t).not.toContain('--session-id');
  });

  it('interactive (no message): drops -p / --mode json for a LIVE session, still --session <nodeId>', () => {
    const cmd = buildNodeResumeCommand({ runDir, nodeId, interactive: true });
    const t = tokens(cmd);

    // A live session: NOT headless print-mode (assert on TOKENS — "-p" must not be a flag token).
    expect(t).not.toContain('-p');
    expect(t).not.toContain('--mode');
    expect(t).not.toContain('json');
    // Still resumes THIS node's stored session.
    expect(t).toContain('--session');
    expect(valueAfter(cmd, '--session')).toBe(nodeId);
    expect(t).not.toContain('--session-id');
    // No staged-message ref in an interactive resume.
    expect(t.some((tok) => tok.startsWith('@'))).toBe(false);
  });

  it('with a message but non-interactive (message mode): runs headless -p --mode json', () => {
    const cmd = buildNodeResumeCommand({ runDir, nodeId, messageFile: '/tmp/m.md', interactive: false });
    const t = tokens(cmd);
    expect(t).toContain('-p');
    expect(t).toContain('--mode');
    expect(t).toContain('json');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (B) resolveNodeRunDir — reuse run.ts's `.piflow/<wf>/runs/<id>` convention.
// ─────────────────────────────────────────────────────────────────────────────
describe('resolveNodeRunDir — run-dir resolution reuses run.ts conventions', () => {
  let TMP: string;
  beforeEach(async () => {
    TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-node-resolve-'));
  });
  afterEach(async () => {
    await fs.rm(TMP, { recursive: true, force: true });
  });

  it('a --run <id> under .piflow/<wf>/runs/<id> resolves to that run dir; session dir is piSessionsDir(it)', async () => {
    // Lay down a canonical layout: <cwd>/.piflow/<wf>/runs/<id>/.pi/run.json
    const wf = 'game-omni';
    const runId = 'flaky-pecan';
    const runDir = path.join(TMP, '.piflow', wf, 'runs', runId);
    await fs.mkdir(piDir(runDir), { recursive: true });
    await fs.writeFile(journalFile(runDir), JSON.stringify({ version: 3, runId, source: wf, nodes: {} }));

    const resolved = resolveNodeRunDir({ run: runId, cwd: TMP });
    expect(resolved).toBe(runDir);
    // The session dir the resume addresses is piSessionsDir of the RESOLVED run dir.
    expect(piSessionsDir(resolved)).toBe(path.join(runDir, '.pi-sessions'));
  });

  it('a direct path to a run dir resolves to itself', async () => {
    const runDir = path.join(TMP, 'out', 'some-run');
    await fs.mkdir(piDir(runDir), { recursive: true });
    const resolved = resolveNodeRunDir({ run: runDir, cwd: TMP });
    expect(resolved).toBe(path.resolve(runDir));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (C) runNodeCli --resume — the GUARD: a node with no recorded sessionId FAILS
// with an actionable error naming the resumable nodes, and NEVER spawns.
// ─────────────────────────────────────────────────────────────────────────────
describe('runNodeCli --resume — resolve + guard', () => {
  let TMP: string;
  let spawned: string[];
  let errs: string[];

  function deps(journal: Journal | null, runDir: string): NodeDeps {
    spawned = [];
    errs = [];
    return {
      loadJournal: async () => journal,
      resolveRunDir: () => runDir,
      spawnResume: (cmd: string) => {
        spawned.push(cmd);
        return 0;
      },
      writeMessageFile: async () => '/tmp/msg.md',
      print: () => {},
      error: (s: string) => errs.push(s),
    };
  }

  beforeEach(async () => {
    TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-node-guard-'));
  });
  afterEach(async () => {
    await fs.rm(TMP, { recursive: true, force: true });
  });

  it('a node with NO recorded sessionId fails with an actionable error naming resumable nodes, and does not spawn', async () => {
    const journal: Journal = {
      version: 3,
      runId: 'r',
      source: 'wf',
      nodes: {
        w0: { hash: 'sha256:x', inputHashes: {}, outputHashes: {}, status: 'ok', producedAt: 't', sessionId: 'w0', sessionDir: piSessionsDir(TMP) },
        w1: { hash: 'sha256:y', inputHashes: {}, outputHashes: {}, status: 'ok', producedAt: 't' }, // NO sessionId
      },
    };
    const code = await runNodeCli(['r', 'w1', '--resume'], deps(journal, TMP));

    expect(code).not.toBe(0); // fails
    expect(spawned).toHaveLength(0); // never spawned
    const msg = errs.join('\n');
    expect(msg).toContain('w1'); // names the requested node
    expect(msg.toLowerCase()).toContain('no'); // "no recorded/stored session …"
    expect(msg).toContain('w0'); // names the RESUMABLE node(s)
  });

  it('a node WITH a recorded sessionId spawns a resume command (does not error)', async () => {
    const journal: Journal = {
      version: 3,
      runId: 'r',
      source: 'wf',
      nodes: {
        w0: { hash: 'sha256:x', inputHashes: {}, outputHashes: {}, status: 'ok', producedAt: 't', sessionId: 'w0', sessionDir: piSessionsDir(TMP) },
      },
    };
    const code = await runNodeCli(['r', 'w0', '--resume', '-m', 'continue please'], deps(journal, TMP));

    expect(code).toBe(0);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toContain('--session');
    expect(spawned[0]).toContain('w0');
    expect(errs).toHaveLength(0);
  });

  // REGRESSION (stop→resume must compose): a node KILLED by `--stop` errors mid-run, so `finishNode`
  // never records its `sessionId` in the journal — yet its `.pi-sessions/<ts>_<id>.jsonl` persists (that's
  // what `--stop`'s message promises). Resume must find the session in the ON-DISK store, not the journal.
  it('a STOPPED node (no journal sessionId) WITH an on-disk session is resumable — stop→resume composes', async () => {
    const journal: Journal = {
      version: 3,
      runId: 'r',
      source: 'wf',
      nodes: {
        // killed mid-run: status error, NO sessionId recorded (the exact post-`--stop` journal shape)
        execute: { hash: 'sha256:z', inputHashes: {}, outputHashes: {}, status: 'error', producedAt: 't' },
      },
    };
    const d = deps(journal, TMP);
    // the persisted session pi left on disk under piSessionsDir(runDir): `<ISO-timestamp>_<sessionId>.jsonl`
    d.readSessionDir = () => ['2026-06-29T03-37-36-188Z_execute.jsonl'];
    const code = await runNodeCli(['r', 'execute', '--resume', '-m', 'continue'], d);

    expect(code).toBe(0); // resumes (does NOT error on the missing journal sessionId)
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toContain('--session');
    expect(spawned[0]).toContain('execute');
    expect(errs).toHaveLength(0);
  });

  // The on-disk store is the GROUND TRUTH: a node with a journal sessionId but whose session FILE is gone
  // (cleaned/missing) is NOT resumable — and the error lists the ids that ARE present on disk.
  it('no on-disk session AND no journal sessionId ⇒ fails, naming the on-disk-resumable ids', async () => {
    const journal: Journal = { version: 3, runId: 'r', source: 'wf', nodes: {} };
    const d = deps(journal, TMP);
    d.readSessionDir = () => ['2026-06-29T03-10-00-000Z_explore.jsonl', '2026-06-29T03-20-00-000Z_plan.jsonl'];
    const code = await runNodeCli(['r', 'execute', '--resume'], d);

    expect(code).not.toBe(0);
    expect(spawned).toHaveLength(0);
    const msg = errs.join('\n');
    expect(msg).toContain('execute'); // the requested (absent) node
    expect(msg).toContain('explore'); // the on-disk resumable ids
    expect(msg).toContain('plan');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (D-pure) buildStopAction — the PURE pid-resolve + signal-PLAN (no process.kill).
// A run records its CONTROLLER pid into `.pi/run.json` at start; --stop signals THAT
// process group with the runner's SIGTERM→SIGKILL grace. This function builds the plan;
// the actual kill is a thin wrapper, so tests assert WITHOUT killing a real process.
// ─────────────────────────────────────────────────────────────────────────────
describe('buildStopAction — the pure pid-resolve + signal plan', () => {
  const runDir = '/runs/flaky-pecan';
  function status(over: Partial<RunStatus>): RunStatus {
    return {
      run: 'flaky-pecan',
      startedAt: 't',
      updatedAt: 't',
      done: false,
      ok: null,
      durationMs: null,
      stage: null,
      totals: null,
      nodes: {},
      ...over,
    };
  }

  it('with a recorded controllerPid: returns that pid + the SIGTERM→SIGKILL grace sequence', () => {
    const action = buildStopAction({ runDir, runState: status({ controllerPid: 4242, done: false }) });
    expect(action.ok).toBe(true);
    if (!action.ok) throw new Error('unreachable');
    expect(action.pid).toBe(4242);
    // The kill grace is the exec-runner's SIGTERM-then-SIGKILL escalation, in order.
    expect(action.signalSequence.map((s) => s.signal)).toEqual(['SIGTERM', 'SIGKILL']);
    // SIGTERM fires first (graceMs 0), SIGKILL after a grace > 0 — the escalation is delayed, not simultaneous.
    expect(action.signalSequence[0].afterMs).toBe(0);
    expect(action.signalSequence[1].afterMs).toBeGreaterThan(0);
  });

  it('a runState with NO controllerPid: returns a NOT-OK plan (no pid to signal) with an actionable reason', () => {
    const action = buildStopAction({ runDir, runState: status({}) });
    expect(action.ok).toBe(false);
    if (action.ok) throw new Error('unreachable');
    // The reason must be actionable — it names that no controlling pid was recorded (an attended/older run).
    expect(action.reason.toLowerCase()).toContain('pid');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (C-node) buildNodeStopAction — the PURE per-NODE pid-resolve + signal-PLAN (no process.kill).
// A node's live `pi` pid is persisted to `.pi/nodes/<id>/pid.json` at spawn (and removed on finish), so a
// PRESENT record ⇒ a LIVE host-signalable process; absent ⇒ the node is not running (finished / never
// started / remote). This plans the GROUP SIGTERM→SIGKILL; the kill is a thin wrapper, so we assert WITHOUT
// killing a real process.
// ─────────────────────────────────────────────────────────────────────────────
describe('buildNodeStopAction — the pure per-node pid-resolve + signal plan', () => {
  it('with a LIVE recorded pid record: returns that pgid + the SIGTERM→SIGKILL grace sequence', () => {
    const rec: NodePidRecord = { pid: 7777, pgid: 7777, startedAt: '2026-06-28T00:00:00.000Z' };
    const action = buildNodeStopAction({ nodeId: 'w1a', pidRecord: rec });
    expect(action.ok).toBe(true);
    if (!action.ok) throw new Error('unreachable');
    // It signals the recorded GROUP (pgid), not a guessed pid — the detached node leads its own group.
    expect(action.pid).toBe(7777);
    expect(action.signalSequence.map((s) => s.signal)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(action.signalSequence[0].afterMs).toBe(0);
    expect(action.signalSequence[1].afterMs).toBeGreaterThan(0);
  });

  it('with NO pid record (node not running / finished / remote): NOT-OK, no pid to signal, actionable reason', () => {
    const action = buildNodeStopAction({ nodeId: 'w1a', pidRecord: null });
    expect(action.ok).toBe(false);
    if (action.ok) throw new Error('unreachable');
    // Must NOT carry a pid (nothing to signal) and must explain — names the node + that it is not running.
    expect((action as { pid?: number }).pid).toBeUndefined();
    expect(action.reason).toContain('w1a');
    expect(action.reason.toLowerCase()).toMatch(/not running|no .*pid|finished|remote/);
  });

  it('a malformed record (no positive integer pid) is treated as ABSENT — never signals a bogus pid', () => {
    const action = buildNodeStopAction({ nodeId: 'w1a', pidRecord: { pid: 0, pgid: 0, startedAt: 't' } });
    expect(action.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (D-node) runNodeCli --stop on a node WITH a persisted pid.json signals THAT node's group (mocked) and
// exits 0 — a true PER-NODE stop, distinct from the per-run controllerPid path. The signal boundary is
// mocked; we NEVER kill a real process.
// ─────────────────────────────────────────────────────────────────────────────
describe('runNodeCli --stop — per-NODE stop reads .pi/nodes/<id>/pid.json (signal boundary mocked)', () => {
  let TMP: string;
  beforeEach(async () => {
    TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-nodestop-'));
  });
  afterEach(async () => {
    await fs.rm(TMP, { recursive: true, force: true });
  });

  async function writeNodePidFile(runDir: string, id: string, rec: NodePidRecord): Promise<void> {
    const dir = nodeDir(runDir, id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'pid.json'), JSON.stringify(rec));
  }

  it('a node WITH a persisted pid.json: signals THAT pid (SIGTERM first), exits 0, never spawns', async () => {
    const runDir = path.join(TMP, 'run-n');
    await fs.mkdir(piDir(runDir), { recursive: true });
    await writeNodePidFile(runDir, 'w1a', { pid: 8484, pgid: 8484, startedAt: 't' });
    const signals: { pid: number; signal: string }[] = [];
    const errs: string[] = [];
    const spawned: string[] = [];

    const code = await runNodeCli(['run-n', 'w1a', '--stop'], {
      resolveRunDir: () => runDir,
      spawnResume: (cmd) => { spawned.push(cmd); return 0; },
      signalProcess: (pid, signal) => { signals.push({ pid, signal }); return true; },
      sleep: async () => {},
      print: () => {},
      error: (s) => errs.push(s),
    });

    expect(code).toBe(0);
    expect(spawned).toHaveLength(0);
    // Signalled the NODE's recorded pid (8484), NOT a run-level controllerPid (none was set).
    expect(signals.some((s) => s.pid === 8484 && s.signal === 'SIGTERM')).toBe(true);
    expect(errs).toHaveLength(0);
  });

  it('a node with NO pid.json and NO controllerPid: fails actionably and NEVER signals', async () => {
    const runDir = path.join(TMP, 'run-none');
    await fs.mkdir(piDir(runDir), { recursive: true });
    // run.json with no controllerPid; node w9 has no pid.json.
    const s: RunStatus = {
      run: 'r', startedAt: 't', updatedAt: 't', done: false, ok: null,
      durationMs: null, stage: null, totals: null, nodes: {},
    };
    await fs.writeFile(runJsonFile(runDir), JSON.stringify(s));
    const signals: { pid: number; signal: string }[] = [];
    const errs: string[] = [];

    const code = await runNodeCli(['run-none', 'w9', '--stop'], {
      resolveRunDir: () => runDir,
      signalProcess: (pid, signal) => { signals.push({ pid, signal }); return true; },
      print: () => {},
      error: (s) => errs.push(s),
    });

    expect(code).not.toBe(0);
    expect(signals).toHaveLength(0); // never guesses a pid
    expect(errs.join('\n')).toContain('w9');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (D) runNodeCli --stop — resolves the run dir, reads the recorded controllerPid from
// `.pi/run.json`, signals it (mocked); a run with NO recorded pid FAILS actionably and
// NEVER signals. The signal boundary is mocked — we NEVER kill a real process.
// ─────────────────────────────────────────────────────────────────────────────
describe('runNodeCli --stop — signal a detached run (signal boundary mocked)', () => {
  let TMP: string;
  beforeEach(async () => {
    TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-node-stop-'));
  });
  afterEach(async () => {
    await fs.rm(TMP, { recursive: true, force: true });
  });

  async function writeRunJson(runDir: string, over: Partial<RunStatus>): Promise<void> {
    await fs.mkdir(piDir(runDir), { recursive: true });
    const s: RunStatus = {
      run: 'r', startedAt: 't', updatedAt: 't', done: false, ok: null,
      durationMs: null, stage: null, totals: null, nodes: {}, ...over,
    };
    await fs.writeFile(runJsonFile(runDir), JSON.stringify(s));
  }

  it('a run WITH a recorded controllerPid: signals that pid (SIGTERM→SIGKILL) and exits 0; never spawns', async () => {
    const runDir = path.join(TMP, 'run-a');
    await writeRunJson(runDir, { controllerPid: 9191, done: false });
    const signals: { pid: number; signal: string }[] = [];
    const errs: string[] = [];
    const spawned: string[] = [];

    const code = await runNodeCli(['run-a', 'w0', '--stop'], {
      resolveRunDir: () => runDir,
      spawnResume: (cmd) => { spawned.push(cmd); return 0; },
      signalProcess: (pid, signal) => { signals.push({ pid, signal }); return true; },
      sleep: async () => {}, // no real grace wait under test
      print: () => {},
      error: (s) => errs.push(s),
    });

    expect(code).toBe(0);
    expect(spawned).toHaveLength(0); // a stop never spawns pi
    // It signalled the RECORDED pid, SIGTERM first.
    expect(signals.some((s) => s.pid === 9191 && s.signal === 'SIGTERM')).toBe(true);
    expect(errs).toHaveLength(0);
  });

  it('a run with NO recorded controllerPid (older/attended run): fails actionably and NEVER signals', async () => {
    const runDir = path.join(TMP, 'run-b');
    await writeRunJson(runDir, { done: false }); // no controllerPid
    const signals: { pid: number; signal: string }[] = [];
    const errs: string[] = [];

    const code = await runNodeCli(['run-b', 'w0', '--stop'], {
      resolveRunDir: () => runDir,
      signalProcess: (pid, signal) => { signals.push({ pid, signal }); return true; },
      print: () => {},
      error: (s) => errs.push(s),
    });

    expect(code).not.toBe(0);
    expect(signals).toHaveLength(0); // NEVER guesses a pid
    const msg = errs.join('\n').toLowerCase();
    expect(msg).toContain('pid'); // names the missing capability
    expect(msg).toContain('detach'); // actionable: re-run with --detach to record one
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (E) stop → resume COMPOSITION — the "stop AND resume a node" end-to-end requirement.
// After a per-node --stop, the node's WARM SESSION under `.pi-sessions` (and the journal's recorded
// sessionId) is UNTOUCHED, so `--resume` continues the SAME conversation. We prove: (1) --stop signals the
// node's group and leaves the session file intact; (2) the subsequent --resume resolves to a real resume
// command addressing that exact session. Signal + spawn boundaries are mocked — no real process, no real pi.
// ─────────────────────────────────────────────────────────────────────────────
describe('stop → resume composition — a stopped node remains warm-resumable', () => {
  let TMP: string;
  beforeEach(async () => {
    TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-stopresume-'));
  });
  afterEach(async () => {
    await fs.rm(TMP, { recursive: true, force: true });
  });

  it('--stop signals the node and leaves its .pi-sessions session intact; --resume then continues it', async () => {
    const runDir = path.join(TMP, 'run-sr');
    const nodeId = 'w1a';
    await fs.mkdir(piDir(runDir), { recursive: true });

    // The node ran on a local provider: it has a persisted live pid (running) AND a warm session on disk +
    // a journal entry recording that session (what --resume keys on).
    const nodeDirPath = nodeDir(runDir, nodeId);
    await fs.mkdir(nodeDirPath, { recursive: true });
    const rec: NodePidRecord = { pid: 6363, pgid: 6363, startedAt: 't' };
    await fs.writeFile(path.join(nodeDirPath, 'pid.json'), JSON.stringify(rec));

    // The warm session file pi persisted under <run>/.pi-sessions, keyed by the node id.
    const sessionDir = piSessionsDir(runDir);
    await fs.mkdir(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, `${nodeId}.jsonl`);
    await fs.writeFile(sessionFile, '{"role":"user","content":"produce"}\n');

    const journal: Journal = {
      version: 3,
      runId: 'run-sr',
      source: 'wf',
      nodes: {
        [nodeId]: {
          hash: 'sha256:x', inputHashes: {}, outputHashes: {}, status: 'ok', producedAt: 't',
          sessionId: nodeId, sessionDir,
        },
      },
    };

    // ── (1) STOP the node — signal boundary mocked. ──
    const signals: { pid: number; signal: string }[] = [];
    const stopCode = await runNodeCli([runDir, nodeId, '--stop'], {
      resolveRunDir: () => runDir,
      signalProcess: (pid, signal) => { signals.push({ pid, signal }); return true; },
      sleep: async () => {},
      print: () => {},
      error: () => {},
    });
    expect(stopCode).toBe(0);
    expect(signals.some((s) => s.pid === 6363 && s.signal === 'SIGTERM')).toBe(true);

    // The stop does NOT touch the warm session — it is still byte-intact on disk, so the node stays resumable.
    expect(await fs.readFile(sessionFile, 'utf8')).toBe('{"role":"user","content":"produce"}\n');

    // ── (2) RESUME the stopped node — it resolves to a real resume command addressing THIS session. ──
    const spawned: string[] = [];
    const resumeCode = await runNodeCli([runDir, nodeId, '--resume'], {
      resolveRunDir: () => runDir,
      loadJournal: async () => journal,
      spawnResume: (cmd) => { spawned.push(cmd); return 0; },
      print: () => {},
      error: () => {},
    });
    expect(resumeCode).toBe(0);
    expect(spawned).toHaveLength(1);
    // The resume RESUMES this node's stored session by id (warm continuation), under the same session dir.
    expect(spawned[0]).toContain('--session');
    expect(spawned[0]).toContain(nodeId);
    expect(spawned[0]).toContain(sessionDir);
    expect(spawned[0]).not.toContain('--session-id'); // resume, not create
  });
});
