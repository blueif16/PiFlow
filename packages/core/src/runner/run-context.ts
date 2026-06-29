// The shared mutable run state (`RunContext`) + the host↔sandbox staging helpers — extracted verbatim
// from runner.ts (the §2.1 cluster F split). This is THE PIVOT module: the lane / retry / lifecycle
// modules import `RunContext` (a type) and `readHostFile`/`stageHostPathIntoSandbox` (values) FROM HERE,
// a LEAF, so they never have to import back into runner.ts — which would be a circular edge (RISK 1).
// `RunContext` and these helpers are internal seams (not on the barrel), re-exported from runner.ts only
// for symmetry with the rest of the split.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  Workflow,
  Sandbox,
  SandboxProvider,
  ToolRegistry,
  SecretResolver,
  Escalator,
  PiCommandOptions,
  ReturnMode,
  RunState,
} from '../types.js';
import type { SchemaValidator } from './schema.js';
import type { EventSink } from './events.js';
import type { CommandBuilder } from './command.js';
import type { ModelTiers } from './model-routing.js';
import type { FailureSignals } from '../checks.js';
import type { NodeUpdate } from '../workflow/ops/promote.js';
import type { Limiter } from './limit.js';
import type { RunStatus } from './status.js';
import type { ExecRunner, ExecWatchdogOpts, CheckpointWaiter } from './exec-runner.js';

export interface RunContext {
  wf: Workflow;
  outDir: string;
  registry: ToolRegistry;
  buildCommand: CommandBuilder;
  execRunner: ExecRunner;
  providerName: string;
  model?: string;
  /**
   * G1 — global routing config (the activatable tier map + pi's models.json index), loaded ONCE at run start.
   * The per-node effective model/provider is resolved from this via `resolveNodeModel` at the build call.
   */
  modelRouting: { tiers: ModelTiers; modelsIndex: Map<string, string> };
  /** ENV-FREE command-builder opts (thinking / extra -e extensions) forwarded at the call site. */
  commandOpts: PiCommandOptions;
  recordEvents: boolean;
  onEvent?: EventSink;
  watchdog: ExecWatchdogOpts;
  status: RunStatus;
  /** Resolved schema validator (default ajv-2020 / injected / null=disabled) for the schema gate. */
  validateSchema: SchemaValidator | null;
  /** The MCP server map staged into `_pi/mcp.json` for bridge-tool nodes (mcp./oc.) (verbatim; bridge owns validation). */
  mcpConfig?: { servers: Record<string, unknown> };
  /** The provider's backend kind — drives the cloud (daytona/e2b) env ALLOWLIST vs local passthrough policy. */
  providerKind: SandboxProvider['kind'];
  /** Per-node secret resolver (the scoped-token / sealing-broker seam). Undefined ⇒ `defaultSecretResolver`. */
  secretResolver?: SecretResolver;
  /** (M1) Provider/gateway credential env var names forwarded into a CLOUD VM exec env (the allowlist). */
  cloudSecrets?: string[];
  /** (G12 — M4) The notify host seam. Undefined ⇒ `defaultEscalator` (warn → console). */
  escalator: Escalator;
  /**
   * (G12 — M4) The per-node FailureSignals `runNode` computed at its verdict point, keyed by node id —
   * the EMPIRICAL inputs `classifyFailure`/`consultPreamble` read in `runNodeWithRetries` (the retry /
   * escalate lanes). Set on every terminal verdict; absent ⇒ no failure to classify (the node ran ok).
   */
  failureSignals: Map<string, FailureSignals>;
  /** Run-level default for the return handshake (a node's own `returnMode` wins; else this; else the artifact heuristic). */
  returnProtocol?: ReturnMode;
  /** `{{WORKSPACE}}` — the canonical out-of-thread tree tokens resolve against (default repoRoot). */
  workspace: string;
  /** The run-level args `{{arg.<key>}}` tokens resolve against (`--arg k=v`). */
  args: Record<string, string>;
  /**
   * The per-thread RunState `{{state.<channel>}}` tokens resolve against. Loaded once at run start and
   * folded at each stage barrier (S3). MUTABLE: the barrier replaces it after each stage's merge.
   */
  runState: RunState;
  /**
   * The promote updates each node emitted this stage, keyed by node id — drained + barrier-merged at the
   * stage barrier (LangGraph super-step: independent emits, ONE serial merge). A node writes only its own
   * key (lane-safe); a non-ok node never writes (it promotes nothing).
   */
  promotesByNode: Map<string, NodeUpdate>;
  /**
   * The G2 concurrency cap — ONE global FIFO limiter for the whole run. Each stage lane's
   * `runNodeWithRetries` is wrapped in it, so no more than `maxConcurrent` real `pi` children run at
   * once (and a node's retries share the lane's single slot — the wrap is OUTSIDE the retry loop).
   */
  limiter: Limiter;
  /**
   * COLLECT MUTEX — a one-slot FIFO limiter that SERIALIZES the per-node output collection (`downloadDir`)
   * across a parallel stage. The exec runs concurrently (the expensive part), but every lane copies its
   * sandbox output dir back into the SHARED host run dir ONE-AT-A-TIME. WHY: two parallel nodes whose
   * artifacts land under a common subdir (e.g. both write `shared/*`) race in the recursive copy on
   * creating that common dir — one `fs.cp` throws EEXIST and (pre-fix) the error was swallowed, silently
   * dropping that node's file → a MISLEADING "required artifact missing". Serializing collect removes the
   * overlap entirely. (Separate from `limiter`, the G2 exec cap, which gates the `pi` spawns, not collect.)
   */
  collectMutex: Limiter;
  /** OPT-IN run-wide total-node ceiling (undefined ⇒ no cap); exceeding it HALTS via a synthetic record. */
  maxNodesPerRun?: number;
  /** Count of nodes that have ACQUIRED a slot this run (incremented once per node at admission) — for `maxNodesPerRun`. */
  spawnedNodes: { n: number };
  /**
   * G4 journal context — present whenever journaling is active (always, today). `meta` keys the
   * journal doc (runId/source); `envHash` is each node's envelope hash, computed ONCE at run-start (the
   * SAME hash `decideResume` consulted) so `finishNode` records the identity the next resume compares
   * against — never re-derived divergently. A node that RAN to a good verdict writes its entry here.
   */
  journal: { meta: { runId: string; source: string }; envHash: Record<string, string> };
  /** (G5) Whether a checkpoint PARKS for a reply (`'interactive'`) or takes the headless policy now (`'default'`). */
  checkpointReply: 'interactive' | 'default';
  /** (G5) The wait/poll seam (injectable in tests). */
  checkpointWait: CheckpointWaiter;
}

/** Read a host-side input file as bytes (for staging a downstream node's reads). */
export async function readHostFile(ctx: RunContext, rel: string): Promise<Uint8Array | null> {
  try {
    return await fs.readFile(path.resolve(ctx.outDir, rel));
  } catch {
    return null;
  }
}

/**
 * Stage a host path (a seeded dest under `outDir`) INTO the sandbox at the same relative path, so the
 * model reads it (the filesystem-as-contract bridge, mirroring the io.reads staging). A FILE writes once;
 * a DIRECTORY is walked and each file written at its run-relative posix path. `rel` is run-relative;
 * `'.'` (a dir seed at the run root) stages the dir's tree directly under the sandbox root.
 */
export async function stageHostPathIntoSandbox(sandbox: Sandbox, outDir: string, rel: string): Promise<void> {
  const abs = path.resolve(outDir, rel);
  let isDir = false;
  try {
    isDir = (await fs.stat(abs)).isDirectory();
  } catch {
    return; // nothing to stage (a skipped seed reaches here only when staged:true, so this is defensive)
  }
  if (!isDir) {
    const data = await fs.readFile(abs);
    await sandbox.writeFile(toPosixRel(rel), data);
    return;
  }
  // Walk the dir; stage each file at its run-relative posix path.
  const walk = async (dirAbs: string): Promise<void> => {
    for (const ent of await fs.readdir(dirAbs, { withFileTypes: true })) {
      const childAbs = path.join(dirAbs, ent.name);
      if (ent.isDirectory()) await walk(childAbs);
      else {
        const childRel = path.relative(outDir, childAbs);
        await sandbox.writeFile(toPosixRel(childRel), await fs.readFile(childAbs));
      }
    }
  };
  await walk(abs);
}

/** Normalize a host path-relative string to a posix sandbox-relative path (no leading `./`). */
function toPosixRel(rel: string): string {
  return rel.split(path.sep).join('/').replace(/^\.\//, '');
}
