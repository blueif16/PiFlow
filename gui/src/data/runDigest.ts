// runDigest.ts — the GUI's contract for the run-LEVEL observation lens. Mirrors the shape
// `@piflow/core/observe` `projectRunDigest` emits (telemetry.ts), fetched from `/__piflow/run-digest/<run>`
// (which distills the run's real `.pi/` then projects it on demand). This is the agent-facing projection
// over the wide per-node run-view: verdicts + a cost spine + the ranked anomaly worklist + failure-onset
// localization. Every field is backed by a real value; there is no mock fallback.
import { apiFetch } from "./apiBase";

/** The tail-sampled anomaly kinds, in the order the worklist ranks them (failures first). */
export type AnomalyKind = "failed" | "truncated" | "context-pressure" | "tool-loop" | "slow" | "retries";

/** One reason a node is worth attention — the worklist item, with the value/bar it crossed. */
export interface Anomaly {
  kind: AnomalyKind;
  nodeId: string;
  /** one-line, human/agent-readable (e.g. "auth-verify truncated (stopReason=max_tokens)"). */
  detail: string;
  value?: number;
  threshold?: number;
}

/** Per-node decision-grade digest — the projection of a RunViewNode, view furniture stripped. */
export interface NodeDigest {
  id: string;
  label: string;
  phase: string | null;
  agentType?: string;
  /** the derived (verified-not-trusted) status: ok | reused | running | blocked | error | … */
  outcome: string;
  model: string | null;
  provider: string | null;
  durationMs: number | null;
  expectedMs: number | null;
  slowRatio: number | null;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  contextPeak: number;
  contextWindow: number | null;
  contextPct: number | null;
  modelCalls: number;
  toolCalls: number;
  topTools: Record<string, number>;
  maxToolRepeat: number;
  repeatedTool: string | null;
  retries: number;
  stopReason: string | null;
  truncated: boolean;
  missing: string[];
  issues: string[];
  anomalies: AnomalyKind[];
}

/** Failure-onset localization: the earliest decisive upstream node for a failure, via the file-flow DAG. */
export interface RootCause {
  /** the failed node. */
  failed: string;
  /** the earliest upstream node that is itself failed (= where the chain started); === `failed` if it
   *  originates here. */
  earliestUpstream: string;
  /** the file on the first hop out of `earliestUpstream` (the data link that propagated the failure). */
  viaPath: string;
  /** the node path earliestUpstream → … → failed. */
  chain: string[];
}

/** Run-level digest — the single read for "how did this run go + where to look". */
export interface RunDigest {
  run: string;
  source?: string;
  done: boolean;
  ok: boolean | null;
  durationMs: number | null;
  totals: {
    nodes: number;
    ok: number;
    failed: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    contextPeak: number;
    modelCalls: number;
    toolCalls: number;
  };
  nodes: NodeDigest[];
  /** the tail-sampled attention list across all nodes — the worklist, highest-signal first. */
  anomalies: Anomaly[];
  /** failure-onset localization for every failed node (empty when the run is clean). */
  rootCauses: RootCause[];
}

export async function loadRunDigest(run: string): Promise<RunDigest> {
  const res = await apiFetch(`/__piflow/run-digest/${encodeURIComponent(run)}`);
  if (!res.ok) throw new Error(`Failed to load run-digest for "${run}": ${res.status} ${res.statusText}`);
  return (await res.json()) as RunDigest;
}
