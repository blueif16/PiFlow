// `piflowctl node <run> <nodeId> --resume [-m "<message>"]` (and `--stop`) — operate on ONE node of an
// existing run.
//
// `--resume` does a CONVERSATIONAL WARM RESUME of the node's stored pi session: piflow persists each
// warm-eligible node's pi session under the RUN dir at `piSessionsDir(runDir)` (= `<runDir>/.pi-sessions`),
// keyed by the node id, and the node's journal entry records `sessionId`/`sessionDir` (commit ecd4df1).
// This command finds that session and re-opens the SAME conversation via pi's native `--session-dir`/
// `--session` flags (mirroring gui/scripts/lib/control-session.mjs's dead-pi resume; NOT its `--mode rpc`
// transport — a node DAG uses `--mode json`). With `-m/--message` it sends one headless message
// (`@<tmpfile>`, the runner's prompt-staging discipline); without one it drops `-p`/`--mode json` for a
// LIVE interactive session.
//
// IMPORTANT — this is a CONVERSATIONAL warm resume of the node's pi session, NOT a full runner-integrated
// re-execution: it does NOT re-stage the node's sandbox/tools/gates or re-run the contract. That heavier,
// runner-driven resume is a follow-up; this command is the thin user surface over the persisted session.
//
// `--stop` STOPS a node's (or, as a fallback, a run's) live `pi` by signalling its DETACHED process group.
// PER-NODE FIRST: the runner persists each node's spawned-pi pid to `.pi/nodes/<id>/pid.json` at spawn (via
// the ExecOpts.onSpawn seam) and REMOVES it on finish — so a PRESENT record ⇒ a LIVE host-signalable process.
// The child is spawned DETACHED as its own group leader (pid == pgid; sandbox/local.ts), so `--stop` reads
// that record and signals `kill(-pgid)` with the runner's SIGTERM→SIGKILL grace, stopping THAT node alone.
// The node's warm session under `.pi-sessions` persists, so `node <run> <id> --resume` continues it after.
// PER-RUN FALLBACK: when the node is not running (no pid.json — finished / never started / a remote VM whose
// process a host stop cannot signal), `--stop` falls back to the run CONTROLLER's group (`controllerPid` in
// `.pi/run.json`, recorded at run start by status.ts) — a whole-run group-kill. If NEITHER a node pid nor a
// controller pid is recorded, `--stop` FAILS with an actionable message — it NEVER guesses or signals a stale
// pid. The pure planners (`buildNodeStopAction` / `buildStopAction`) build the signal PLAN so the wiring is
// unit-testable without killing a real process; the kill itself is a thin wrapper (`signalProcess`).

import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { loadJournal as coreLoadJournal, piSessionsDir, piDir, runJsonFile, nodeDir, type Journal, type RunStatus } from '@piflow/core';

/** Shell-quote a single token (paths may contain spaces). Mirrors command.ts `q`. */
function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Inputs to the PURE warm-resume argv builder. Unit-testable WITHOUT spawning pi. */
export interface NodeResumeCommandInput {
  /** The resolved run dir (= `{{RUN}}`). The session lives under `piSessionsDir(runDir)`. */
  runDir: string;
  /** The node id — also the pi session id (warm-resume keys the session by node id). */
  nodeId: string;
  /** In-sandbox path of a staged one-shot message (referenced `@<file>`); omit for an interactive resume. */
  messageFile?: string;
  /** No message ⇒ a LIVE session (drop `-p`/`--mode json`); a message ⇒ headless one-shot. */
  interactive: boolean;
}

/**
 * Build the `pi` command that RESUMES a node's stored session — PURE (no spawn, no fs), so the wiring is
 * unit-tested directly. It addresses the persisted per-node conversation by id under the run's session dir:
 *   - `--session-dir <piSessionsDir(runDir)> --session <nodeId>`  — RESUME (never `--session-id`, which
 *     would CREATE a fresh conversation; warm-resume continues the EXISTING one, command.ts §4a).
 *   - a MESSAGE resume is headless (`-p --mode json -a`) and references the staged message as `@<file>`.
 *   - an INTERACTIVE resume DROPS `-p`/`--mode json` so the user gets a live session (control-session parity).
 * Provider/model are INHERITED from the user's pi config (no `--provider`/`--model`), matching the
 * control-session host — a warm resume must not re-pin a gateway the original run may not have used.
 */
export function buildNodeResumeCommand(input: NodeResumeCommandInput): string {
  const { runDir, nodeId, messageFile, interactive } = input;
  const sessionFlags = ['--session-dir', q(piSessionsDir(runDir)), '--session', q(nodeId)];
  if (interactive) {
    // A LIVE session — no print mode, no json stream. The user drives it.
    return ['pi', ...sessionFlags].join(' ');
  }
  // A headless one-shot message resume: print mode + json event stream + auto-approve, message as @<file>.
  const parts = ['pi', '-p', '--mode', 'json', '-a', ...sessionFlags];
  if (messageFile) parts.push(`@${q(messageFile)}`);
  return parts.join(' ');
}

/** One step of the kill escalation: send `signal` `afterMs` after the stop was issued. */
export interface StopSignalStep {
  signal: 'SIGTERM' | 'SIGKILL';
  /** Delay before this step fires (SIGTERM = 0, SIGKILL = the kill grace, mirroring exec-runner's escalation). */
  afterMs: number;
}

/** The PLAN a `--stop` executes: the pid to signal + the ordered SIGTERM→SIGKILL escalation. */
export type StopAction =
  | { ok: true; pid: number; signalSequence: StopSignalStep[] }
  | { ok: false; reason: string };

/** Inputs to the PURE stop planner. `runState` is the run's `.pi/run.json` digest (it carries the pid). */
export interface BuildStopActionInput {
  runDir: string;
  runState: RunStatus | null;
}

/**
 * The on-disk shape of `.pi/nodes/<id>/pid.json` (the runner's per-node pid record). Mirrors core's
 * `NodePidRecord`: the detached child's pid (== pgid, the group leader) + when it spawned. Re-declared here
 * (a 3-field contract) so the CLI need not import a core path helper — it composes the file path from the
 * already-exported `nodeDir`.
 */
export interface NodePidRecord {
  pid: number;
  /** The process-GROUP id `--stop` signals via `kill(-pgid)`. Equals `pid` (the detached child leads its group). */
  pgid: number;
  startedAt: string;
}

/** Inputs to the PURE per-NODE stop planner. `pidRecord` is the node's `.pi/nodes/<id>/pid.json` (or null). */
export interface BuildNodeStopActionInput {
  nodeId: string;
  pidRecord: NodePidRecord | null;
}

/**
 * Build the per-NODE stop PLAN — PURE (no `process.kill`, no fs), so the wiring is unit-tested without
 * killing a real process. A node's live `pi` pid is persisted to `.pi/nodes/<id>/pid.json` at spawn and
 * REMOVED on finish (core's runner), so a PRESENT record with a valid pid ⇒ a LIVE host-signalable process,
 * and an ABSENT/malformed one ⇒ the node is NOT running (finished / never started / runs in a remote VM).
 * Returns the recorded GROUP (pgid) + the SIGTERM→SIGKILL escalation to apply to it — the SAME grace
 * `buildStopAction` uses. When there is no live pid it returns NOT-OK with an actionable reason and NO pid —
 * it NEVER guesses or signals a stale/bogus pid. The actual signalling is a thin wrapper around this plan.
 */
export function buildNodeStopAction(input: BuildNodeStopActionInput): StopAction {
  const rec = input.pidRecord;
  // Prefer the recorded GROUP id (pgid) — a detached node leads its own group, so `kill(-pgid)` reaps the
  // whole tree. Validate it as a positive integer: a missing record, or a malformed/zero pid, is treated as
  // ABSENT (never signalled).
  const pgid = rec?.pgid ?? rec?.pid;
  if (!rec || typeof pgid !== 'number' || !Number.isInteger(pgid) || pgid <= 0) {
    return {
      ok: false,
      reason: `node "${input.nodeId}" is not running — no live pi pid is recorded at .pi/nodes/${input.nodeId}/pid.json (the node has finished, never started, or runs in a remote sandbox whose process a host stop cannot signal).`,
    };
  }
  return {
    ok: true,
    pid: pgid,
    signalSequence: [
      { signal: 'SIGTERM', afterMs: 0 },
      { signal: 'SIGKILL', afterMs: STOP_KILL_GRACE_MS },
    ],
  };
}

/** ms to wait after SIGTERM before SIGKILL — the same kill grace the exec-runner uses (exec-runner.ts:30). */
export const STOP_KILL_GRACE_MS = 3000;

/**
 * Build the stop PLAN for a run — PURE (no `process.kill`, no fs), so the wiring is unit-tested without
 * killing a real process. It reads the CONTROLLING pid the runner recorded into `.pi/run.json`
 * (`controllerPid`, status.ts) and returns the SIGTERM→SIGKILL escalation to apply to that process group
 * — the SAME grace the runner's watchdog kill uses (exec-runner.ts). When no pid was recorded (an older
 * run, or one that died before its first status write), it returns a NOT-OK plan with an actionable reason
 * — it NEVER guesses a pid. The actual signalling is a thin wrapper around this plan (see `runNodeCli`).
 */
export function buildStopAction(input: BuildStopActionInput): StopAction {
  const pid = input.runState?.controllerPid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return {
      ok: false,
      reason: `no controlling pid is recorded for this run (.pi/run.json carries no controllerPid) — re-run with 'piflowctl run --detach' (which records the pid) to make it stoppable.`,
    };
  }
  return {
    ok: true,
    pid,
    // SIGTERM first (graceful), then SIGKILL after the kill grace — the exec-runner's escalation order.
    signalSequence: [
      { signal: 'SIGTERM', afterMs: 0 },
      { signal: 'SIGKILL', afterMs: STOP_KILL_GRACE_MS },
    ],
  };
}

/** Inputs to `resolveNodeRunDir`. */
export interface ResolveNodeRunInput {
  /** The `<run>` positional — either a direct path to a run dir, OR a run id under `.piflow/<wf>/runs/<id>`. */
  run: string;
  /** Where to anchor an id lookup (default `process.cwd()`). */
  cwd?: string;
}

/**
 * Resolve the `<run>` arg → an existing run dir, REUSING run.ts's `.piflow/<wf>/runs/<id>` convention.
 *   1. A path that is (or contains a `.pi/`) directory ⇒ that dir (resolved absolute).
 *   2. Else treat `run` as a run ID and search every `<cwd>/.piflow/<wf>/runs/<id>` home for a match
 *      (the canonical home run.ts writes into; `out/<id>` is the loose fallback).
 * Throws an actionable error if no run dir is found (naming the run id + where it looked).
 */
export function resolveNodeRunDir(input: ResolveNodeRunInput): string {
  const cwd = input.cwd ?? process.cwd();
  // (1) a direct path to a run dir (it exists OR holds a `.pi/`).
  const asPath = path.resolve(cwd, input.run);
  if (existsSync(piDir(asPath)) || existsSync(asPath)) {
    if (existsSync(piDir(asPath)) || path.isAbsolute(input.run) || input.run.includes(path.sep)) return asPath;
  }
  // (2) a run ID under a canonical home: <cwd>/.piflow/<wf>/runs/<id>.
  const piflowHome = path.join(cwd, '.piflow');
  if (existsSync(piflowHome)) {
    for (const wf of safeReaddir(piflowHome)) {
      const candidate = path.join(piflowHome, wf, 'runs', input.run);
      if (existsSync(piDir(candidate)) || existsSync(candidate)) return candidate;
    }
  }
  // (3) the loose `out/<id>` fallback.
  const outCandidate = path.join(cwd, 'out', input.run);
  if (existsSync(piDir(outCandidate)) || existsSync(outCandidate)) return outCandidate;

  throw new Error(
    `piflowctl node: no run "${input.run}" found — looked for a path, a canonical ${path.join('.piflow', '<wf>', 'runs', input.run)}, and out/${input.run} under ${cwd}.`,
  );
}

/** `readdirSync` that returns [] (never throws) on a missing/unreadable dir. */
function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

/** `readdirSync` of FILE names (returns [] on a missing/unreadable dir) — the pi session store readers. */
function safeReaddirFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * The node ids that have a pi session ON DISK under `piSessionsDir(runDir)`. pi names each session file
 * `<ISO-timestamp>_<sessionId>.jsonl`, and piflow mints `sessionId === node.id`; the ISO timestamp carries
 * NO underscore, so the FIRST `_` cleanly splits it from the (possibly underscored) node id. This store —
 * NOT the journal — is the ground truth for `--resume`: a `--stop`-killed node has its session file but no
 * journal `sessionId` (finishNode never ran).
 */
function storedSessionNodeIds(runDir: string, readSessionDir: (dir: string) => string[]): string[] {
  const ids = new Set<string>();
  for (const f of readSessionDir(piSessionsDir(runDir))) {
    if (!f.endsWith('.jsonl')) continue;
    const us = f.indexOf('_');
    if (us < 0) continue;
    ids.add(f.slice(us + 1, -'.jsonl'.length));
  }
  return [...ids];
}

/** The injectable seam — defaults are the real fs/core/spawn; a test passes fakes (NO real pi). */
export interface NodeDeps {
  /** Load the run's `.pi/journal.json` (to confirm `nodes.<id>.sessionId`). Default core `loadJournal`. */
  loadJournal?: (runDir: string) => Promise<Journal | null>;
  /**
   * Read the run's pi session store — the FILE names under `piSessionsDir(runDir)` (`<ts>_<id>.jsonl`). The
   * GROUND TRUTH for `--resume`: a `--stop`-killed node has a session file here but NO journal `sessionId`.
   * Default reads the real dir (returns [] when absent). Injectable for tests.
   */
  readSessionDir?: (sessionDir: string) => string[];
  /** Resolve `<run>` → a run dir. Default `resolveNodeRunDir`. */
  resolveRunDir?: (run: string, cwd?: string) => string;
  /** Spawn the built resume command; returns the child's exit code. Default a real `spawnSync` under a shell. */
  spawnResume?: (cmd: string, runDir: string) => number;
  /** Stage the `-m` message to a temp file and return its path (`@<file>`). Default a real tmp write. */
  writeMessageFile?: (message: string) => Promise<string>;
  /** Read a run's `.pi/run.json` digest (for `--stop`'s recorded pid). Default reads `runJsonFile(runDir)`. */
  loadRunStatus?: (runDir: string) => RunStatus | null;
  /**
   * Read a node's `.pi/nodes/<id>/pid.json` (the per-NODE stop record). Default reads the file under
   * `nodeDir(runDir, id)`; returns null when absent/torn (the node is not running). Injectable for tests.
   */
  loadNodePid?: (runDir: string, nodeId: string) => NodePidRecord | null;
  /**
   * Signal a process GROUP (the boundary `--stop` mocks under test — NEVER kills a real process there).
   * Default `process.kill(-pid, signal)` (the leading `-` targets the detached group, mirroring
   * sandbox/worktree.ts:141). Returns true if the signal was delivered (false ⇒ already gone / no perms).
   */
  signalProcess?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => boolean;
  /** Sleep `ms` between the SIGTERM and the SIGKILL escalation. Default real `setTimeout`; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  print?: (line: string) => void;
  error?: (line: string) => void;
}

/** The parsed `node` argv. */
export interface ParsedNodeArgs {
  run: string;
  nodeId: string;
  resume: boolean;
  stop: boolean;
  message?: string;
}

/** Parse the flat `node` argv → `{ run, nodeId, resume, stop, message }`. First two positionals = run, nodeId. */
export function parseNodeArgs(argv: string[]): ParsedNodeArgs {
  const out: ParsedNodeArgs = { run: '', nodeId: '', resume: false, stop: false };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--resume') out.resume = true;
    else if (k === '--stop') out.stop = true;
    else if (k === '-m' || k === '--message') out.message = argv[++i];
    else if (!k.startsWith('-')) positionals.push(k);
  }
  out.run = positionals[0] ?? '';
  out.nodeId = positionals[1] ?? '';
  return out;
}

/** The list of node ids that ARE warm-resumable (have a recorded `sessionId`), for the guard's error. */
function resumableNodes(journal: Journal | null): string[] {
  if (!journal) return [];
  return Object.entries(journal.nodes)
    .filter(([, n]) => typeof n.sessionId === 'string' && n.sessionId.length > 0)
    .map(([id]) => id);
}

/**
 * `piflowctl node <run> <nodeId> --resume [-m "<msg>"]` (or `--stop`) — the handler. Returns the process
 * exit code (0 on success). Injectable deps keep it spawn-free under test.
 *
 * --resume: resolve runDir → load the journal → confirm `nodes.<id>.sessionId` exists (else FAIL, naming the
 *           resumable nodes) → build the resume command (PURE) → spawn it. With `-m` the message is staged to
 *           a tmp file and sent headless; without one the resume is interactive (a live session).
 * --stop:   honest not-yet-supported (no per-node PID is recorded by `--detach`) → exit non-zero.
 */
export async function runNodeCli(argv: string[], deps: NodeDeps = {}): Promise<number> {
  const loadJournal = deps.loadJournal ?? coreLoadJournal;
  const readSessionDir = deps.readSessionDir ?? safeReaddirFiles;
  const resolveRunDir = deps.resolveRunDir ?? ((run: string, cwd?: string) => resolveNodeRunDir({ run, cwd }));
  const spawnResume =
    deps.spawnResume ??
    ((cmd: string, runDir: string) => spawnSync(cmd, { cwd: runDir, stdio: 'inherit', shell: true }).status ?? 1);
  const writeMessageFile =
    deps.writeMessageFile ??
    (async (message: string) => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'piflow-node-resume-'));
      const file = path.join(dir, 'message.md');
      await writeFile(file, message);
      return file;
    });
  const loadRunStatus =
    deps.loadRunStatus ??
    ((runDir: string): RunStatus | null => {
      try {
        return JSON.parse(readFileSync(runJsonFile(runDir), 'utf8')) as RunStatus;
      } catch {
        return null;
      }
    });
  const loadNodePid =
    deps.loadNodePid ??
    ((runDir: string, nodeId: string): NodePidRecord | null => {
      try {
        return JSON.parse(readFileSync(path.join(nodeDir(runDir, nodeId), 'pid.json'), 'utf8')) as NodePidRecord;
      } catch {
        return null;
      }
    });
  const signalProcess =
    deps.signalProcess ??
    ((pid: number, signal: 'SIGTERM' | 'SIGKILL'): boolean => {
      // `-pid` targets the detached process GROUP (the runner spawns each node detached; worktree.ts:141).
      try { process.kill(-pid, signal); return true; } catch { return false; }
    });
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.(); }));
  const print = deps.print ?? ((s: string) => process.stdout.write(s + '\n'));
  const error = deps.error ?? ((s: string) => process.stderr.write(s + '\n'));

  const parsed = parseNodeArgs(argv);
  if (!parsed.run || !parsed.nodeId) {
    error('piflowctl node: a run and a node id are required (piflowctl node <run> <nodeId> --resume [-m "<message>"]).');
    return 1;
  }
  if (parsed.resume === parsed.stop) {
    // neither, or both — exactly one action is required.
    error('piflowctl node: pass exactly one of --resume or --stop.');
    return 1;
  }

  // ── --stop: signal a node's (or, as a fallback, the run's) process group. ──
  // PER-NODE FIRST: a node's live `pi` pid is persisted to `.pi/nodes/<id>/pid.json` at spawn (removed on
  // finish), so if a LIVE one is recorded we signal THAT node's group — a true per-NODE stop. If the node is
  // not running (no pid.json), we FALL BACK to the per-RUN controllerPid (signals the whole run's group).
  // If NEITHER exists, a clear actionable failure — `--stop` NEVER guesses or signals a stale pid.
  if (parsed.stop) {
    let stopRunDir: string;
    try {
      stopRunDir = resolveRunDir(parsed.run);
    } catch (e) {
      error((e as Error).message);
      return 1;
    }

    // Execute a stop PLAN: SIGTERM, then SIGKILL after the kill grace if the group is still alive (the
    // exec-runner's watchdog escalation). `signalProcess` returning false ⇒ the group is already gone.
    const applyStop = async (action: Extract<StopAction, { ok: true }>): Promise<number> => {
      let firstAlive = false;
      for (const step of action.signalSequence) {
        if (step.afterMs > 0) {
          if (!firstAlive) break; // SIGTERM already found it gone — no need to escalate.
          await sleep(step.afterMs);
        }
        const delivered = signalProcess(action.pid, step.signal);
        if (step.signal === 'SIGTERM') firstAlive = delivered;
        if (!delivered && step.signal === 'SIGTERM') {
          print(`piflowctl node: pid ${action.pid} was already gone — nothing to stop.`);
          return 0;
        }
      }
      return 0;
    };

    // (1) PER-NODE: signal this specific node's live process group if its pid.json records one.
    const nodeAction = buildNodeStopAction({ nodeId: parsed.nodeId, pidRecord: loadNodePid(stopRunDir, parsed.nodeId) });
    if (nodeAction.ok) {
      print(
        `piflowctl node: stopping node "${parsed.nodeId}" of run "${parsed.run}" — signalling its process group (pid ${nodeAction.pid}) with SIGTERM→SIGKILL. (Its warm session under .pi-sessions persists — resume with: piflowctl node ${parsed.run} ${parsed.nodeId} --resume.)`,
      );
      return applyStop(nodeAction);
    }

    // (2) PER-RUN FALLBACK: the node is not running — signal the whole run's controlling group instead.
    const runAction = buildStopAction({ runDir: stopRunDir, runState: loadRunStatus(stopRunDir) });
    if (runAction.ok) {
      print(
        `piflowctl node: node "${parsed.nodeId}" is not running (no per-node pid recorded) — signalling the whole RUN's controlling process group (pid ${runAction.pid}) with SIGTERM→SIGKILL instead.`,
      );
      return applyStop(runAction);
    }

    // (3) NEITHER: nothing to signal. Surface BOTH reasons (the node's + the run's) so the message is actionable.
    error(
      `piflowctl node ${parsed.run} ${parsed.nodeId} --stop: cannot stop — ${nodeAction.reason} No run-level controller pid either: ${runAction.reason}`,
    );
    return 1;
  }

  // ── --resume: resolve → guard → spawn. ──
  let runDir: string;
  try {
    runDir = resolveRunDir(parsed.run);
  } catch (e) {
    error((e as Error).message);
    return 1;
  }

  // The GATE is the ON-DISK session store (what `pi --session <id>` actually reads) — NOT the journal: a
  // `--stop`-killed node has its `.pi-sessions/<ts>_<id>.jsonl` but no journal `sessionId` (finishNode never
  // ran), so gating on the journal made stop→resume non-composable. The journal `sessionId` is a secondary
  // signal (a cleanly-finished node has both), so the predicate is the UNION; the file presence wins.
  const journal = await loadJournal(runDir);
  const onDiskIds = storedSessionNodeIds(runDir, readSessionDir);
  const journalSessionId = journal?.nodes?.[parsed.nodeId]?.sessionId;
  const hasSession = onDiskIds.includes(parsed.nodeId) || (typeof journalSessionId === 'string' && journalSessionId.length > 0);
  if (!hasSession) {
    const resumable = [...new Set([...onDiskIds, ...resumableNodes(journal)])].sort();
    const which = resumable.length
      ? `Resumable nodes (have a stored session): ${resumable.join(', ')}.`
      : `No node in this run has a stored pi session (a cold inmemory/cloud run, or it never ran with --sandbox local).`;
    error(
      `piflowctl node: node "${parsed.nodeId}" has no stored pi session under ${piSessionsDir(runDir)} (nor a recorded sessionId in ${journalFileHint(runDir)}) — cannot warm-resume it. ${which}`,
    );
    return 1;
  }

  const interactive = parsed.message === undefined;
  const messageFile = interactive ? undefined : await writeMessageFile(parsed.message as string);
  const cmd = buildNodeResumeCommand({ runDir, nodeId: parsed.nodeId, messageFile, interactive });

  print(
    interactive
      ? `piflowctl node: warm-resuming "${parsed.nodeId}" (live session) from its stored conversation under ${piSessionsDir(runDir)}. (Conversational resume — NOT a runner re-execution.)`
      : `piflowctl node: warm-resuming "${parsed.nodeId}" with a message from its stored conversation under ${piSessionsDir(runDir)}. (Conversational resume — NOT a runner re-execution.)`,
  );
  const code = spawnResume(cmd, runDir);
  return code;
}

/** A human-friendly pointer to the journal for the guard's error (relative when possible). */
function journalFileHint(runDir: string): string {
  return path.join(runDir, '.pi', 'journal.json');
}
