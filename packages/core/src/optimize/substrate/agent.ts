// optimize/substrate/agent.ts — the M4 ONE spawn wrapper (docs/specs/optimize-substrate-plan.md §M4). Every
// base agent turn (the judge here; the fixer in M6) goes through `runBaseAgent` — never a
// hand-rolled `spawn('claude', …)`. It builds a LITERAL one-node `WorkflowSpec` (`executor:'claude-code'`)
// and calls `runFromConfig` (runner/entry.ts) so credentials, model routing, the sandbox jail,
// `parseClaudeResult`, and `NodeStatusRecord` telemetry are all INHERITED — byte-identical to a
// template-authored claude-code node. Nothing here re-implements any of that.
//
// MODEL SELECTION speaks the SDK's own TIER language, never a hardcoded model name: `tier` defaults to
// `'balanced'` (NEVER `'deep'` — the documented won't-commit-edits fixer failure, memory:
// optimize-fixer-tier-finding: 6 runs, 0 edits, every budget/prompt lever). An explicit `model` still WINS,
// through the exact same `resolveClaudeModel` precedence every claude-code node resolves through
// (model-routing.ts) — this module does not duplicate or shadow that precedence, it just sets the inputs.
//
// THE TEXT-CAPTURE SEAM: the claude-code driver's own `parseResult` DISCARDS a successful turn's `result`
// text (only a FAILURE carries `selfReportedError.text` — see claude-code.ts) — so a caller has no way to
// read what the agent actually said. We recover it WITHOUT touching node-lifecycle/runner: we wrap whichever
// `execRunner` would run (the real default, or a test's own) in a closure that stashes the ONE node's raw
// stdout, then re-parse it with the SAME `parseClaudeResult` the driver itself uses. Pure pass-through — the
// watchdog/kill-seam behavior is untouched; this only taps the result already flowing through it.
//
// Since every input the agent needs (measure report, memory.md, existing issues, …) is embedded by the
// CALLER (judge.ts) into the literal `prompt` string before this is ever invoked, agent.ts itself does no
// token resolution / file I/O of its own beyond the ephemeral scratch dir `runFromConfig` requires.
//
// STATE HYDRATION: a caller's embedded text (an issue file, a criteria doc, a fixer diff) commonly quotes a
// node's OWN config/prompt verbatim — which may legitimately contain a `{{state.<channel>}}` token (e.g. a
// node's `contract.owns` pattern promoted during the REAL run this text describes). `runFromConfig`'s runner
// still resolves EVERY `{{…}}` occurrence in the composed one-node prompt (it cannot tell "live token" from
// "quoted prose"), against THIS spawn's own `outDir` — which starts with NO `.pi/state.json` (an ephemeral
// scratch dir, never the pinned run). Left unfed, that throws `MissingChannelError` on a channel that is
// real, just not promoted HERE — the spawn dies before a single model call. A caller that knows which run
// its embedded text came from passes `state` (typically `loadState(pinnedRunDir)`); this module forwards it
// as `runFromConfig`'s `initialState` seed — the SAME pattern `spawnChildRun` already uses (child-run.ts).

import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { WorkflowSpec, ToolSelection, SandboxProvider, RunState } from '../../types.js';
import type { CommandBuilder } from '../../runner/command.js';
import type { ExecRunner } from '../../runner/exec-runner.js';
import { defaultExecRunner } from '../../runner/exec-runner.js';
import { runFromConfig } from '../../runner/entry.js';
import type { NodeStatusRecord } from '../../runner/status.js';
import type { ModelTiers } from '../../runner/model-routing.js';
import { parseClaudeResult } from '../../runner/claude-result.js';
import { LocalSandboxProvider } from '../../sandbox/local.js';

/** The default base-agent tier — NEVER `'deep'` (memory: optimize-fixer-tier-finding — the deep tier
 *  over-deliberates and won't commit edits). Overridable per call, like every other tier reference. */
export const BASE_AGENT_DEFAULT_TIER = 'balanced';

/** The single node id every ephemeral base-agent WorkflowSpec uses (internal bookkeeping only — never
 *  surfaced to the caller, who only ever sees the returned status/text). */
const AGENT_NODE_LABEL = 'agent';

/**
 * The Base Agent's INHERITABLE field surface — declared ONCE, here. These are the fields every CHILD base
 * agent (the judge, the fixer, any future one) forwards VERBATIM to `runBaseAgent` rather than
 * re-declaring its own hand-copied subset (anything left off such a copy is silently lost — the bug class this
 * type kills). A child's opts EXTEND `BaseAgentChildOpts` and spread `inheritedAgentOpts(opts)` into the
 * `runAgent(...)` call, so a field added HERE (+ `INHERITED_KEYS`) reaches every child automatically.
 */
export interface BaseAgentInherited {
  /** SDK tier alias, resolved via `resolveClaudeModel`'s `claude` tier block. Default `'balanced'`. */
  tier?: string;
  /** An explicit model id/alias — WINS over `tier` (mirrors `resolveClaudeModel`'s own precedence). */
  model?: string;
  /** Hard wall-clock cap for the agent's turn. Omitted ⇒ the runner's own default (no cap). */
  timeoutMs?: number;
  /** Sandbox provider. Omit ⇒ a read-scope-jailed `LocalSandboxProvider` — the DEFAULT, because every
   *  base agent runs on the `claude-code` driver, which CANNOT run on the `inmemory` provider (it
   *  supports `local` only). A test injects its own (e.g. `InMemorySandboxProvider`) to stay offline. */
  provider?: SandboxProvider;
  /** Test/offline seam — forwarded to `runFromConfig` verbatim (fakes the spawned shell command; never
   *  a live `claude` spawn in a test). */
  buildCommand?: CommandBuilder;
  /** Test/offline seam — WRAPPED (never bypassed), so the stdout-capture keeps working under a fake exec. */
  execRunner?: ExecRunner;
  /** Test seam — injects the tier/model-index resolution `runFromConfig` would otherwise read off
   *  `~/.piflow/model-tiers.json` (the SAME `RunOptions.modelRouting` seam `runner.ts` exposes). */
  modelRouting?: { tiers: ModelTiers; modelsIndex: Map<string, string> };
  /** DRY-RUN: build the one-node spec (the full composition + resolved config) and RETURN it as `plan`
   *  WITHOUT spawning. The base-agent preview seam EVERY base agent (judge, fixer) inherits — a caller's
   *  additive config (prompt, skill, tools, sandbox) is exactly what the returned plan surfaces. */
  dryRun?: boolean;
  /** OBSERVE seam: PERSIST the spawn's run dir here instead of the ephemeral tmpdir (which is deleted after
   *  the turn). The dir then holds the SAME `.pi/run.json` + per-node records a workflow node's run dir does,
   *  so the existing observe instruments (`piflowctl telemetry|status|trace <dir>`, `readRunModel`) read the
   *  judge/fixer spawn exactly like a node. Returned as `runDir` on the result. Omit ⇒ ephemeral (deleted). */
  outDir?: string;
}

export interface RunBaseAgentOpts extends BaseAgentInherited {
  /** The FULL, already-assembled prompt text — the caller resolves every token/embed itself; agent.ts does
   *  no token resolution of its own. */
  prompt: string;
  /** The exec cwd AND the sandbox `execCwd` (E10) — granted read and made the spawned process' cwd. */
  cwd: string;
  /** Extra read roots (beyond `cwd`) the agent may read — the node's `sandbox.read`. */
  readScope: string[];
  /** The write-authority globs/paths the agent may write — the node's `sandbox.write` (= `contract.owns`). */
  owns: string[];
  /** Tool selection. Omitted/`{}` ⇒ the SDK's default claude-code builtin set. */
  tools?: ToolSelection;
  /** A bare Agent-Skill id to stage for this turn — set on the spawned node so the runner's existing
   *  skill-staging path (`locateSkillStage` → `.pi/skills/<id>/` → `--skill`) fires. It ring-searches Ring 0
   *  `<cwd>/.agents/skills/<id>` then Ring 1 `<piflowHome>/skills/<id>`. Omitted ⇒ no `--skill`. A declared
   *  skill absent from every ring DEGRADES (advisory skill-missing; the node still runs) — never a hard fail. */
  skill?: string;
  /** SEED for `{{state.*}}` token resolution — forwarded to `runFromConfig` as `initialState` (runner.ts).
   *  NOT auto-inherited via `inheritedAgentOpts` (unlike tier/model/…): each caller computes this itself
   *  (typically `loadState(pinnedRunDir)`) from a run dir it alone knows about — there is no sensible outer
   *  default. Omit ⇒ this spawn's own (always-empty, ephemeral) `.pi/state.json` alone, i.e. today's
   *  behavior: any `{{state.*}}` occurrence in `prompt` throws `MissingChannelError`. */
  state?: RunState;
}

/** What a CHILD base agent's opts EMBED: the whole inherited base surface + the `runAgent` test seam
 *  (replace the real spawn in a test — never live-spawn there; the live demo proves real agent behavior). */
export interface BaseAgentChildOpts extends BaseAgentInherited {
  runAgent?: (opts: RunBaseAgentOpts) => Promise<RunBaseAgentResult>;
}

/** The one enumerated key set behind `inheritedAgentOpts` — typed `Record<keyof BaseAgentInherited, true>`
 *  so adding a field to the interface FAILS COMPILATION here until it is forwarded too (no silent loss). */
const INHERITED_KEYS: Record<keyof BaseAgentInherited, true> = {
  tier: true,
  model: true,
  timeoutMs: true,
  provider: true,
  buildCommand: true,
  execRunner: true,
  modelRouting: true,
  dryRun: true,
  outDir: true,
};

/** Project a child's opts DOWN to the base agent's inheritable surface — what every child spreads into its
 *  `runAgent(...)` call. Never spread `...opts` raw: a child's OWN fields (seams, dirs, caps) must not leak
 *  into the spawn opts. Undefined fields are omitted (exact-optional-safe). */
export function inheritedAgentOpts(opts: BaseAgentInherited): BaseAgentInherited {
  const out: Partial<Record<keyof BaseAgentInherited, unknown>> = {};
  for (const k of Object.keys(INHERITED_KEYS) as (keyof BaseAgentInherited)[]) {
    if (opts[k] !== undefined) out[k] = opts[k];
  }
  return out as BaseAgentInherited;
}

export interface RunBaseAgentResult {
  /** The one node's full status record — everything a claude-code node reports. ABSENT on a dry-run (nothing ran). */
  status?: NodeStatusRecord;
  /** The agent's parsed final text (via `parseClaudeResult`); `''` when unavailable. ABSENT on a dry-run. */
  text?: string;
  /** Present ONLY on a dry-run: the composed one-node spec that WOULD have been spawned — `prompt` is the full
   *  ingested context, `sandbox` the read jail + write authority, `tier`/`model`/`tools`/`skill` the config. */
  plan?: WorkflowSpec['nodes'][number];
  /** The spawn's PERSISTED run dir — present ONLY when the caller passed `outDir` (the observe seam). Point
   *  the existing instruments at it (`piflowctl telemetry|status|trace <runDir>`). ABSENT on the ephemeral
   *  default (already deleted) and on a dry-run (nothing ran). */
  runDir?: string;
}

/**
 * Spawn ONE claude-code agent turn and return its status + parsed text. THE spawn wrapper — every base
 * agent (judge, fixer) calls this; never hand-roll a `spawn('claude', …)` or call `runFromConfig` directly
 * for an agent turn outside this function.
 */
export async function runBaseAgent(opts: RunBaseAgentOpts): Promise<RunBaseAgentResult> {
  const spec: WorkflowSpec = {
    meta: { name: 'substrate-agent', description: 'ephemeral one-node substrate agent turn' },
    nodes: [
      {
        label: AGENT_NODE_LABEL,
        prompt: opts.prompt,
        executor: 'claude-code',
        // `model` always wins inside `resolveClaudeModel` regardless of `tier` also being set — no need to
        // conditionally null one out here; setting both lets the SAME precedence every claude-code node uses
        // do the deciding.
        tier: opts.tier ?? BASE_AGENT_DEFAULT_TIER,
        model: opts.model,
        // A bare skill id rides onto the node so the runner's skill-staging path stages it (`--skill`); a
        // miss is advisory, so `undefined` here is a no-op (no skill declared), like every non-skill node.
        skill: opts.skill,
        tools: opts.tools ?? {},
        io: { reads: [], produces: [], artifacts: [] },
        sandbox: {
          // DECLARE `local`: every base agent runs the claude-code driver, whose capability card lists
          // `sandbox.providers: ['local']` ONLY. Left undefined, `compile()` (dag.ts) stamps the run-level
          // `?? 'inmemory'` default, and the runner's `driverFits` precheck then warns `[driver-fit] … cannot
          // run on sandbox provider "inmemory"` (the runtime provider below is already local, so the spawn
          // itself still worked — but the declared kind must match what the driver can actually run on).
          provider: 'local',
          read: opts.readScope,
          write: opts.owns,
          execCwd: opts.cwd,
          timeoutMs: opts.timeoutMs,
        },
      },
    ],
  };

  // DRY-RUN: the spec IS the composition (prompt + tools + sandbox + skill + tier/model). Return it and STOP —
  // no tmpdir, no runFromConfig, no spawn. Every base agent inherits this preview through this ONE seam.
  if (opts.dryRun) return { plan: spec.nodes[0] };

  // Capture the ONE node's raw stdout by wrapping whichever execRunner would actually run — a pure
  // pass-through (same args in, same result out) that only stashes `result.stdout` into a closure var.
  let capturedStdout = '';
  const captureExecRunner: ExecRunner = async (sandbox, cmd, execOpts) => {
    const inner = opts.execRunner ?? defaultExecRunner;
    const r = await inner(sandbox, cmd, execOpts);
    capturedStdout = r.result.stdout;
    return r;
  };

  // The OBSERVE seam: a caller-provided `outDir` PERSISTS the spawn's run dir (readable by the existing
  // observe instruments like any node's run); the default stays an ephemeral tmpdir, removed after the turn.
  const ephemeral = !opts.outDir;
  const outDir = opts.outDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-substrate-agent-')));
  try {
    const result = await runFromConfig({
      workflowSpec: spec,
      run: 'substrate-agent',
      outDir,
      workspace: opts.cwd,
      execRunner: captureExecRunner,
      // DEFAULT to a read-scope-jailed local sandbox: the claude-code driver can't run on `inmemory`.
      provider: opts.provider ?? new LocalSandboxProvider({ enforceReadScope: true }),
      ...(opts.buildCommand ? { buildCommand: opts.buildCommand } : {}),
      ...(opts.modelRouting ? { modelRouting: opts.modelRouting } : {}),
      ...(opts.state ? { initialState: opts.state } : {}),
    });
    const status = result.status.nodes[AGENT_NODE_LABEL];
    const text = parseClaudeResult(capturedStdout).text ?? '';
    // `result.outDir` is the runner's own resolved run dir — returned (not our input) so the pointer is
    // exactly where the records landed.
    return { status, text, ...(ephemeral ? {} : { runDir: result.outDir }) };
  } finally {
    if (ephemeral) await fs.rm(outDir, { recursive: true, force: true });
  }
}
