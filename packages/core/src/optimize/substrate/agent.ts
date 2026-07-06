// optimize/substrate/agent.ts — the M4 ONE spawn wrapper (docs/specs/optimize-substrate-plan.md §M4). Every
// substrate agent turn (the judge here; the fixer in M6) goes through `runSubstrateAgent` — never a
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

import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { WorkflowSpec, ToolSelection, SandboxProvider } from '../../types.js';
import type { CommandBuilder } from '../../runner/command.js';
import type { ExecRunner } from '../../runner/exec-runner.js';
import { defaultExecRunner } from '../../runner/exec-runner.js';
import { runFromConfig } from '../../runner/entry.js';
import type { NodeStatusRecord } from '../../runner/status.js';
import type { ModelTiers } from '../../runner/model-routing.js';
import { parseClaudeResult } from '../../runner/claude-result.js';

/** The default substrate-agent tier — NEVER `'deep'` (memory: optimize-fixer-tier-finding — the deep tier
 *  over-deliberates and won't commit edits). Overridable per call, like every other tier reference. */
export const SUBSTRATE_AGENT_DEFAULT_TIER = 'balanced';

/** The single node id every ephemeral substrate-agent WorkflowSpec uses (internal bookkeeping only — never
 *  surfaced to the caller, who only ever sees the returned status/text). */
const AGENT_NODE_LABEL = 'agent';

export interface RunSubstrateAgentOpts {
  /** The FULL, already-assembled prompt text — the caller resolves every token/embed itself; agent.ts does
   *  no token resolution of its own. */
  prompt: string;
  /** The exec cwd AND the sandbox `execCwd` (E10) — granted read and made the spawned process' cwd. */
  cwd: string;
  /** Extra read roots (beyond `cwd`) the agent may read — the node's `sandbox.read`. */
  readScope: string[];
  /** The write-authority globs/paths the agent may write — the node's `sandbox.write` (= `contract.owns`). */
  owns: string[];
  /** SDK tier alias, resolved via `resolveClaudeModel`'s `claude` tier block. Default `'balanced'`. */
  tier?: string;
  /** An explicit model id/alias — WINS over `tier` (mirrors `resolveClaudeModel`'s own precedence). */
  model?: string;
  /** Tool selection. Omitted/`{}` ⇒ the SDK's default claude-code builtin set. */
  tools?: ToolSelection;
  /** Hard wall-clock cap for the agent's turn. Omitted ⇒ the runner's own default (no cap). */
  timeoutMs?: number;
  /** Test/offline seam — forwarded to `runFromConfig` verbatim. Omit ⇒ the real production default
   *  (`InMemorySandboxProvider`, the SAME default every bare `runFromConfig` caller gets). */
  provider?: SandboxProvider;
  /** Test/offline seam — forwarded to `runFromConfig` verbatim (fakes the spawned shell command; never
   *  a live `claude` spawn in a test). */
  buildCommand?: CommandBuilder;
  /** Test/offline seam — WRAPPED (never bypassed), so the stdout-capture keeps working under a fake exec. */
  execRunner?: ExecRunner;
  /** Test seam — injects the tier/model-index resolution `runFromConfig` would otherwise read off
   *  `~/.piflow/model-tiers.json` (the SAME `RunOptions.modelRouting` seam `runner.ts` exposes). */
  modelRouting?: { tiers: ModelTiers; modelsIndex: Map<string, string> };
}

export interface RunSubstrateAgentResult {
  /** The one node's full status record — usage/telemetry/checks/issues, everything a claude-code node reports. */
  status: NodeStatusRecord;
  /** The agent's parsed final text (Claude's `result` event `.result` field, via `parseClaudeResult`). `''`
   *  when unavailable (the node produced no result event — it errored before exec, or the stdout carried
   *  none). Never fabricated. */
  text: string;
}

/**
 * Spawn ONE claude-code agent turn and return its status + parsed text. THE spawn wrapper — every substrate
 * agent (judge, fixer) calls this; never hand-roll a `spawn('claude', …)` or call `runFromConfig` directly
 * for an agent turn outside this function.
 */
export async function runSubstrateAgent(opts: RunSubstrateAgentOpts): Promise<RunSubstrateAgentResult> {
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
        tier: opts.tier ?? SUBSTRATE_AGENT_DEFAULT_TIER,
        model: opts.model,
        tools: opts.tools ?? {},
        io: { reads: [], produces: [], artifacts: [] },
        sandbox: {
          read: opts.readScope,
          write: opts.owns,
          execCwd: opts.cwd,
          timeoutMs: opts.timeoutMs,
        },
      },
    ],
  };

  // Capture the ONE node's raw stdout by wrapping whichever execRunner would actually run — a pure
  // pass-through (same args in, same result out) that only stashes `result.stdout` into a closure var.
  let capturedStdout = '';
  const captureExecRunner: ExecRunner = async (sandbox, cmd, execOpts) => {
    const inner = opts.execRunner ?? defaultExecRunner;
    const r = await inner(sandbox, cmd, execOpts);
    capturedStdout = r.result.stdout;
    return r;
  };

  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-substrate-agent-'));
  try {
    const result = await runFromConfig({
      workflowSpec: spec,
      run: 'substrate-agent',
      outDir,
      workspace: opts.cwd,
      execRunner: captureExecRunner,
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(opts.buildCommand ? { buildCommand: opts.buildCommand } : {}),
      ...(opts.modelRouting ? { modelRouting: opts.modelRouting } : {}),
    });
    const status = result.status.nodes[AGENT_NODE_LABEL];
    const text = parseClaudeResult(capturedStdout).text ?? '';
    return { status, text };
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
}
