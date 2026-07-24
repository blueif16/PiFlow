// ─────────────────────────────────────────────────────────────────────────────
// Per-run `.pi/` layout (D7) — the engine-owned metadata namespace, IDENTICAL across every project.
//
// A project decides only WHERE `${RUN}` roots (the opaque `run` base dir passed in); the INTERNAL shape
// below is SDK-owned and never drifts project to project:
//
//   ${run}/.pi/state.json · run.json · nodes/<id>/{io.json, prompt.md, tools.ts, mcp.json, events.jsonl}
//
// Core NEVER hardcodes the consumer's `.piflow/<wf>/runs/<id>/` convention — `run` is treated as an
// opaque base dir. All helpers are PURE path joins (no I/O) except `writeNodeIo` (mkdir + write).
// ─────────────────────────────────────────────────────────────────────────────

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { NodeIo } from '../types.js';

/** `${run}/.pi` — the engine-owned metadata namespace. */
export const piDir = (run: string): string => path.join(run, '.pi');

/** `${run}/.pi/state.json` — the RunState channels (D6 per-thread checkpoint). */
export const stateFile = (run: string): string => path.join(piDir(run), 'state.json');

/** `${run}/.pi/run.json` — the run-status digest. */
export const runJsonFile = (run: string): string => path.join(piDir(run), 'run.json');

/** `${run}/.pi/nodes/<id>` — a node's dedicated folder. */
export const nodeDir = (run: string, id: string): string => path.join(piDir(run), 'nodes', id);

// ── (warm-resume) per-run pi SESSION storage — a DEDICATED subdir UNDER `.pi/`. ──────────────────
// pi persists its own `<timestamp>_<uuid>.jsonl` session files under `--session-dir`. We keep them in
// `${run}/.pi/sessions` — a DEDICATED subdir of the engine `.pi/` machinery dir, a SIBLING of the
// journal/state files and `.pi/nodes` (never MIXED INTO them, so the observe/journal readers — which read
// only the NAMED `.pi/` files — never see them; warm-resume-pi-surfaces.md §4d). Keeping them under `.pi/`
// makes the run SELF-CONTAINED — no stray `.pi-sessions/` at the run root. Used as the `--session-dir` for a
// per-node warm session (id = the node id); a future `node <run> <id> --resume` finds the session here.

/** `${run}/.pi/sessions` — the per-run pi session-storage dir (a dedicated subdir UNDER `.pi/`). */
export const piSessionsDir = (run: string): string => path.join(piDir(run), 'sessions');

// ── per-node CLAUDE-CODE config jail — a claude node's `CLAUDE_CONFIG_DIR`, OUTSIDE `.pi/`. ──────────
// A `claude-code` node runs with `CLAUDE_CONFIG_DIR` pointed at a per-node dir under the RUN dir (the
// jail-writable workdir lane), so the executor's own state never touches the host's `~/.claude`. Claude
// persists its session transcript beneath it as `projects/<cwd-slug>/<sessionId>.jsonl` — the `claude-code`
// transcript adapter's native source (observe/transcript-claude.ts). It sits OUTSIDE `.pi/` because `.pi/`
// is the ENGINE-owned namespace; this dir is a foreign executor's own store, which the engine only sites.
// The slug is Claude's own encoding of the cwd, so a reader LOCATES the file (glob + sessionId) rather than
// reconstructing the slug — the same "locate, never reconstruct" discipline `locatePiSessionFile` uses.

/** `${run}/.claude-config/<id>` — a claude-code node's `CLAUDE_CONFIG_DIR` jail. */
export const claudeConfigDir = (run: string, id: string): string =>
  path.join(run, '.claude-config', id);

/** `${run}/.claude-config/<id>/projects` — where Claude Code roots its per-cwd session transcripts. */
export const claudeProjectsDir = (run: string, id: string): string =>
  path.join(claudeConfigDir(run, id), 'projects');

/** `${run}/.pi/nodes/<id>/io.json` — the per-node I/O ledger record. */
export const nodeIoFile = (run: string, id: string): string => path.join(nodeDir(run, id), 'io.json');

/** `${run}/.pi/nodes/<id>/prompt.md` — the realized prompt. */
export const nodePromptFile = (run: string, id: string): string =>
  path.join(nodeDir(run, id), 'prompt.md');

/** `${run}/.pi/nodes/<id>/tools.ts` — the realized tool-extension source. */
export const nodeToolsFile = (run: string, id: string): string =>
  path.join(nodeDir(run, id), 'tools.ts');

/** `${run}/.pi/nodes/<id>/mcp.json` — the realized MCP config. */
export const nodeMcpFile = (run: string, id: string): string =>
  path.join(nodeDir(run, id), 'mcp.json');

/** `${run}/.pi/nodes/<id>/events.jsonl` — the behavior stream. */
export const nodeEventsFile = (run: string, id: string): string =>
  path.join(nodeDir(run, id), 'events.jsonl');

// ── (per-node stop) the node's LIVE-pi pid record — the home a `node <run> <id> --stop` reads. ──────────
// When a node runs on a HOST-SIGNALABLE (in-place/local/inmemory) provider, the runner persists the spawned
// pi's pid here at spawn (via ExecOpts.onSpawn) and REMOVES it on finish — so the file existing means a LIVE
// host process is signallable, and its absence means the node is not running (finished / never started /
// remote). A separate CLI signals the recorded GROUP (pid == pgid, the detached leader) SIGTERM→SIGKILL. A
// CLOUD node's process lives in the VM (no host pid to signal) ⇒ the runner writes NO file there.

/** `${run}/.pi/nodes/<id>/pid.json` — the node's live-pi pid record (present ⇔ a host-signalable live process). */
export const nodePidFile = (run: string, id: string): string => path.join(nodeDir(run, id), 'pid.json');

/** The on-disk shape of `pid.json`: the detached child's pid (== pgid, the group leader) + when it spawned. */
export interface NodePidRecord {
  pid: number;
  /** The process-GROUP id `--stop` signals via `kill(-pgid)`. Equals `pid` (the detached child leads its group). */
  pgid: number;
  startedAt: string;
}

/**
 * Persist a node's live-pi pid to `.pi/nodes/<id>/pid.json` ATOMICALLY (tmp+rename, mirroring writeStatus),
 * so a concurrent `--stop` reader never sees a torn record. Records `{pid, pgid:pid, startedAt}` — pid==pgid
 * because the child is spawned detached (its own group leader). Best-effort: a write failure is swallowed (a
 * missing pid file only costs stoppability, never the run). mkdir -p the node dir first.
 */
export async function writeNodePid(run: string, id: string, pid: number): Promise<void> {
  try {
    const dir = nodeDir(run, id);
    await fs.mkdir(dir, { recursive: true });
    const rec: NodePidRecord = { pid, pgid: pid, startedAt: new Date().toISOString() };
    const finalPath = nodePidFile(run, id);
    const tmpPath = path.join(dir, `.pid.${process.pid}.tmp`);
    await fs.writeFile(tmpPath, JSON.stringify(rec));
    await fs.rename(tmpPath, finalPath);
  } catch {
    /* best-effort — a missing pid file only costs per-node stoppability, never the run */
  }
}

/**
 * Remove a node's `pid.json` (the node exited ⇒ the pid is STALE and must never be signalled). Best-effort:
 * an absent file is fine (already gone / never written). Called from `finishNode` on every terminal verdict.
 */
export async function clearNodePid(run: string, id: string): Promise<void> {
  try {
    await fs.rm(nodePidFile(run, id), { force: true });
  } catch {
    /* already gone — fine */
  }
}

// ── (G5) human-checkpoint marker/reply files — per-run data in the RUN dir (SDK/data boundary). ──
// Each checkpoint node owns a nodeId-scoped pair under `.pi/checkpoints/`: the runner WRITES `<id>.json`
// (the question), a courier (GUI/console/TUI) WRITES `<id>.reply.json` (the answer). nodeId-scoped so ≥2
// concurrent checkpoints never collide (the same per-node isolation as `.pi/nodes/<id>/`).

/** `${run}/.pi/checkpoints` — the checkpoint marker/reply namespace. */
export const checkpointsDir = (run: string): string => path.join(piDir(run), 'checkpoints');

/** `${run}/.pi/checkpoints/<id>.json` — the pending-question MARKER (runner-written). */
export const checkpointMarkerFile = (run: string, id: string): string =>
  path.join(checkpointsDir(run), `${id}.json`);

/** `${run}/.pi/checkpoints/<id>.reply.json` — the human REPLY (courier-written). */
export const checkpointReplyFile = (run: string, id: string): string =>
  path.join(checkpointsDir(run), `${id}.reply.json`);

/**
 * Write a node's `io.json` ledger record (mkdir -p the node dir first; pretty-printed). Returns the
 * path written. The ONE I/O helper here — every other layout helper is a pure join.
 */
export async function writeNodeIo(run: string, record: NodeIo): Promise<string> {
  const dir = nodeDir(run, record.id);
  await fs.mkdir(dir, { recursive: true });
  const file = nodeIoFile(run, record.id);
  await fs.writeFile(file, JSON.stringify(record, null, 2));
  return file;
}
