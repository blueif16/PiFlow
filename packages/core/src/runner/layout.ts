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
