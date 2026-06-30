// Internal types for the template loader (T2). These describe the AUTHORED on-disk node.json shape
// (template-format.md §3) as the loader sees it after JSON.parse — distinct from the runtime
// `NodeSpec`/`NodeIntent` (types.ts) the loader DERIVES from it. Kept loose where the schema gate (the
// T1 JSON Schemas) already pins the shape; the loader only reads the fields the §8 checks + render use.

/** A check entry as authored in node.json (§3 `checks.pre`/`checks.post`). */
export interface TemplateCheck {
  kind: string;
  path?: string;
  param?: unknown;
  severity?: 'fail' | 'warn';
}

/** The authored `node.json` (template-format.md §3) — what the loader parses off disk. */
export interface TemplateNode {
  id: string;
  phase: string;
  deps: string[];
  /**
   * The prompt body + optional skill. REQUIRED for a normal node; OMITTED on a `programmatic` node (it
   * spawns no `pi`, so it has no prompt). The schema enforces this conditionally (the `allOf` in node.schema.ts).
   */
  prompt?: { file: string; skill?: string };
  /**
   * (PROGRAMMATIC NODE) When `true`, this node runs its declarative `hooks`/`op` deterministically and
   * spawns NO `pi` → runtime `NodeSpec.programmatic`. It needs no `prompt` and no `tools`. Omitted ⇒ the
   * node spawns a `pi` agent exactly as before. Twin of the `checkpoint` no-pi marker.
   */
  programmatic?: true;
  /**
   * (G6) The agent-PRESET label this node adopted (e.g. "market-research"). `piflow-init` expands the
   * preset INTO the node's concrete `tools`/`prompt` at author time and keeps this as a branding LABEL —
   * the runner treats it as opaque; observe carries it so the GUI renders the preset's icon. Omitted ⇒ none.
   */
  agentType?: string;
  tools?: { allow?: string[]; deny?: string[] };
  mcp?: { servers?: Record<string, unknown>; ref?: string };
  inject?: string[];
  /** Per-node hard wall-clock cap (ms) → runtime `sandbox.timeoutMs`. Omitted ⇒ the run-level default. */
  timeoutMs?: number;
  /** Per-node retry budget — extra attempts after the first on error/blocked → runtime `io.retries`. Omitted ⇒ one attempt. */
  retries?: number;
  /** Per-node model id → `pi --model` (G1 routing). Omitted ⇒ tier, else the run-level model, else pi's default. */
  model?: string;
  /** Per-node provider/gateway → `pi --provider`. Omitted ⇒ auto-resolved from the model, else the run default. */
  provider?: string;
  /** Per-node tier alias → resolved to a model via `~/.piflow/model-tiers.json` (when active). Omitted ⇒ none. */
  tier?: string;
  contract: {
    artifacts: string[];
    owns: string[];
    readScope: string[];
    /**
     * Per-node JAIL-OFF posture → runtime `node.sandbox.fullAccess`. When true, this node's `pi` runs OUTSIDE
     * the local fs jail (full host read+write), nullifying `readScope`/`owns` for THIS node only. Loosen-only;
     * LOCAL-only (a no-op in a cloud VM). Sits with `readScope`/`owns` (the fs-scope axis). Omitted ⇒ jailed.
     */
    fullAccess?: boolean;
    schema?: string;
    returnMode?: 'optional' | 'required';
    fillSentinel?: string | null;
  };
  checks?: { pre?: TemplateCheck[]; post?: TemplateCheck[] };
  policy?: Record<string, string>;
  hooks?: {
    seed?: { to: string; from: string }[];
    project?: { to: string; from: string | string[] }[];
    /** DRIVER-MERGE op set — the `applyMergeOp` discriminated grammar (`{ ops: [{fold|concat|reconcile|run}] }`). */
    merge?: { ops: Record<string, unknown>[] };
    promote?: { from: string; to: string; merge?: string }[];
    /** POST DERIVE — derive outputs from a frozen `source` via a registry record's `projections` map, keyed by `key` (runProjection). */
    registryProject?: { source: string; mapRef: string; key: string };
  };
  return?: object;
  /**
   * (G13 — M5) The unified op envelope, authored DIRECTLY. When present, it is carried verbatim (the
   * deprecated `inject`/`hooks`/`checks`/`policy` aliases are NOT also lowered — direct authoring wins).
   * Each entry carries EXACTLY ONE body (transform|run|gate|action). Omitted ⇒ lower the aliases instead.
   */
  op?: import('../../types.js').OpSpec[];
  /** (G5 — HITL) A human checkpoint on this node → runtime `NodeSpec.checkpoint`. Spawns no `pi`. */
  checkpoint?: {
    kind: 'confirm' | 'input' | 'select';
    prompt: string;
    choices?: string[];
    default?: unknown;
    headless?: 'default' | 'abort';
    timeoutMs?: number;
  };
  /** (Phase 2) Fusion activation → intent `fusion`, consumed by `expandFusion` before compile (spec §4). */
  fusion?: {
    mode: 'moa' | 'best-of-n';
    n?: number;
    panel?: string[];
    judge?: string;
    obligations?: boolean;
    verify?: boolean;
  };
  /**
   * (expert-representations · "Judge expansion") A JUDGE GATE authored on this producer node → the loader
   * MATERIALIZES a real `<id>__judge` pi node into the spec at load time (`lowerGates` + `materializeJudgeNodes`)
   * and attaches the producer-side `rerouteTo` judge-fail loop. The `JudgeGate` shape MINUS its `kind`
   * discriminator (the field name implies it). `judgeTier` MUST differ from the producer's tier (no self-judging).
   */
  judgeGate?: {
    judgeTier: string;
    rubric: string;
    threshold?: string;
    policy?: { onFail?: 'block' | 'warn' | 'stop' | 'retry' | 'escalate'; retryMax?: number; retryScope?: 'feedback' | 'fix' };
  };
  /**
   * (G9) Subworkflow activation → intent `subworkflow`, consumed by `expandSubworkflow` before compile/
   * fusion: this node is REPLACED by the referenced sub-template's nodes (id-namespaced under it). A v1
   * subworkflow node is a pure reference holder — author its `contract` so the child terminal writes the
   * declared `artifacts` path (the parent's downstream reads it by the `{{RUN}}`-relative convention).
   */
  subworkflow?: {
    /** The sub-template to inline — a path resolved relative to the template root (e.g. "subflows/verify"). */
    ref: string;
    /** RESERVED (not yet wired): parent→child input path-mapping. See `SubworkflowSpec.inputs`. */
    inputs?: Record<string, string>;
    /** RESERVED (not yet wired): child→parent output path-mapping. See `SubworkflowSpec.outputs`. */
    outputs?: Record<string, string>;
  };
}

/** The authored `meta.json` (template-format.md §5). */
export interface TemplateMeta {
  id: string;
  name: string;
  description: string;
  phases?: string[];
  /** Named run profiles (product-declared run modes) — generic elision predicates, as DATA (§5). */
  profiles?: Record<string, { elidePhases?: string[] }>;
  /** The profile applied when a run names none. Absent ⇒ no elision (the full DAG). */
  defaultProfile?: string;
}

/** A loaded node bundle: its parsed def + the absolute path to its folder (for ref/render resolution). */
export interface LoadedNode {
  /** The parsed node.json. */
  def: TemplateNode;
  /** Absolute path to this node's folder (`<template>/nodes/<id>/`). */
  dir: string;
  /** The prose body of prompt.md (pre-render). */
  prose: string;
}
