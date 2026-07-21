// The DAG compiler — the heart of "agent fills a flat bag → SDK derives the graph".
//
// `compile(WorkflowSpec)` assigns ids, defaults mechanical fields, INFERS edges from each node's
// declared io.reads ⋈ io.produces (the dbt/Bazel/Dagster data-flow model), groups nodes into
// topological stages (parallel lanes within a stage), and validates graph soundness. Ported from
// the data-flow join in `viz-model.mjs` + the forward-only DAG build in `tui/dag.mjs`.

import type { NodeSpec, NodeIntent, SandboxSpec, WorkflowSpec, Workflow, Edge, Stage } from './types.js';

/** Thrown by `compile` when the workflow is not buildable. Carries every violation. */
export class WorkflowError extends Error {
  constructor(public readonly errors: string[]) {
    super(`workflow is not buildable:\n  - ${errors.join('\n  - ')}`);
    this.name = 'WorkflowError';
  }
}

/** Slug a label into a stable node id (matches the engine's `slug(label, i)`). */
export function slugify(label: string, i: number): string {
  const s = (label || `node-${i}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || `node-${i}`;
}

/** Fill an authored NodeIntent into a dense NodeSpec (mechanical defaults). */
function materialize(intent: NodeIntent, id: string): NodeSpec {
  const sb = intent.sandbox ?? {};
  const sandbox: SandboxSpec = {
    provider: sb.provider ?? 'inmemory',
    workspace: sb.workspace ?? '.',
    read: sb.read ?? [],
    write: sb.write ?? [],
    output: sb.output ?? `out/${id}`,
    image: sb.image,
    env: sb.env,
    timeoutMs: sb.timeoutMs,
    // (E10) exec-scope — carried verbatim onto the dense NodeSpec (the fs-scope axis, beside read/write).
    // A node whose BUILD runs from a project root outside the run dir declares `execCwd` (+ `execReads` for
    // sibling kits it imports); the runner threads both into scope.create. Omitted ⇒ undefined ⇒ cwd = the
    // run dir (byte-identical to before). WITHOUT this carry they survive load but are dropped at compile,
    // so the seatbelt profile never grants the getcwd literal / sibling read → the build EPERMs on uv_cwd.
    ...(sb.execCwd ? { execCwd: sb.execCwd } : {}),
    ...(sb.execReads ? { execReads: sb.execReads } : {}),
    // Per-node JAIL-OFF posture — carried verbatim (only `true` is meaningful). Omitted ⇒ undefined ⇒ jailed.
    ...(sb.fullAccess ? { fullAccess: true } : {}),
  };
  return {
    id,
    label: intent.label,
    phase: intent.phase,
    prompt: intent.prompt,
    skill: intent.skill,
    agentType: intent.agentType,
    // G1 routing — carried verbatim; the runner resolves the effective model/provider (model-routing.ts).
    model: intent.model,
    provider: intent.provider,
    tier: intent.tier,
    // Per-node reasoning cap — carried verbatim onto the dense NodeSpec so command.ts emits `pi --thinking`.
    // WITHOUT this carry it survives load (intent) but is DROPPED at compile (the over-think guard never fires).
    thinking: intent.thinking,
    // Per-node executor selection — carried verbatim so dispatchCommand/effectiveModel/the readScope union
    // (all keyed on NodeSpec.executor) actually fire. Absent ⇒ the `pi` lane (byte-identical default).
    executor: intent.executor,
    sandbox,
    tools: intent.tools,
    hooks: intent.hooks,
    io: intent.io,
    // (M5 · G13 / op⊖ops U6) Carry the lowered op[] envelope verbatim onto the dense NodeSpec — the SOLE
    // derive rep (the legacy `ops`/`NodeOps` carry was retired in U6; the runner reads via `derivesFromOp`).
    op: intent.op,
    checkpoint: intent.checkpoint,
    // (P3 — INLINE HITL) Carry the inline (post-model) human gate verbatim → `node.gate`. Distinct from
    // `checkpoint` (the standalone no-pi node) so the runner's checkpoint dispatch never short-circuits it.
    gate: intent.gate,
    rerouteGate: intent.rerouteGate,
    // (PROGRAMMATIC NODE) Carry the no-pi marker verbatim — the runner dispatches a `programmatic` node to
    // `runProgrammatic` (declarative ops only, no `buildCommand`/exec). Additive: undefined ⇒ the pi lane.
    programmatic: intent.programmatic,
    // (feat/claude-mcp-wiring) Carry the per-node MCP config onto the dense NodeSpec — but ONLY for the
    // claude-code executor, which is its SOLE consumer there (node-lifecycle.ts stages `mcp.servers` as
    // Claude's own native `--mcp-config`). Every OTHER consumer (`assembleRunTools`, the pi-bridge union)
    // still reads `mcp` off the pre-compile `NodeIntent`, unaffected. A pi node authoring `mcp` (the bridge
    // form, e.g. `{ ref }`) must stay BYTE-IDENTICAL on the compiled spec — carrying it unconditionally
    // broke a golden compile snapshot (template-min's w2b-assets, a pi node with `mcp.ref`). Absent/non-
    // claude ⇒ undefined (byte-identical — WITHOUT this carry a claude-code node's declared servers survive
    // load but are dropped here, the `executor`/`execCwd` past-bug pattern this mirrors).
    ...(intent.executor === 'claude-code' && intent.mcp ? { mcp: intent.mcp } : {}),
  };
}

/** Infer data-flow edges from declared reads/produces (+ explicit dependsOn). Reports violations. */
export function inferEdges(nodes: Record<string, NodeSpec>): { edges: Edge[]; errors: string[] } {
  const errors: string[] = [];
  const producer = new Map<string, string>(); // produced file -> producing node id
  for (const n of Object.values(nodes)) {
    for (const f of n.io.produces) {
      const prev = producer.get(f);
      if (prev && prev !== n.id) errors.push(`duplicate producer for "${f}": ${prev} and ${n.id}`);
      else producer.set(f, n.id);
    }
  }
  const edges = new Map<string, Edge>();
  const add = (from: string, to: string, file?: string): void => {
    if (from === to) return;
    const key = `${from}\0${to}`;
    const e = edges.get(key) ?? { from, to, files: [] };
    if (file && !e.files.includes(file)) e.files.push(file);
    edges.set(key, e);
  };
  for (const n of Object.values(nodes)) {
    const ext = new Set(n.io.externalInputs ?? []);
    for (const f of n.io.reads) {
      const p = producer.get(f);
      if (p) add(p, n.id, f);
      else if (!ext.has(f)) {
        errors.push(`missing producer: "${n.id}" reads "${f}" (no producer; add it to externalInputs if it is a raw input)`);
      }
    }
    for (const dep of n.io.dependsOn ?? []) {
      if (!nodes[dep]) errors.push(`dependsOn references unknown node: "${n.id}" -> "${dep}"`);
      else add(dep, n.id);
    }
  }
  return { edges: [...edges.values()], errors };
}

/** Group nodes into topological stages (longest-path level = stage; >1 node per level ⇒ parallel). */
export function stagesOf(nodes: Record<string, NodeSpec>, edges: Edge[]): { stages: Stage[]; errors: string[] } {
  const ids = Object.keys(nodes);
  const adj = new Map<string, string[]>(ids.map((id) => [id, []]));
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const e of edges) {
    adj.get(e.from)?.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const level = new Map<string, number>();
  let frontier = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  let lvl = 0;
  let processed = 0;
  while (frontier.length) {
    for (const id of frontier) { level.set(id, lvl); processed++; }
    const next: string[] = [];
    for (const id of frontier) {
      for (const m of adj.get(id) ?? []) {
        indeg.set(m, (indeg.get(m) ?? 0) - 1);
        if ((indeg.get(m) ?? 0) === 0) next.push(m);
      }
    }
    frontier = next;
    lvl++;
  }
  const errors: string[] = [];
  if (processed < ids.length) {
    errors.push(`cycle detected among: ${ids.filter((id) => !level.has(id)).join(', ')}`);
  }
  const byLevel = new Map<number, string[]>();
  for (const id of ids) {
    const l = level.get(id);
    if (l === undefined) continue;
    const arr = byLevel.get(l) ?? [];
    arr.push(id);
    byLevel.set(l, arr);
  }
  const stages: Stage[] = [...byLevel.keys()]
    .sort((a, b) => a - b)
    .map((l, i) => {
      const nodeIds = byLevel.get(l) ?? [];
      return { index: i + 1, phase: null, parallel: nodeIds.length > 1, nodeIds };
    });
  return { stages, errors };
}

/** Validate a set of compiled nodes (edge soundness + acyclicity). Returns every violation. */
export function validate(nodes: Record<string, NodeSpec>): string[] {
  const { edges, errors } = inferEdges(nodes);
  const { errors: stageErrors } = stagesOf(nodes, edges);
  return [...errors, ...stageErrors];
}

/**
 * (AgentDriver registry — P3) The FAIL-CLOSED compile-time executor gate: every node's `executor` (when set)
 * must be a REGISTERED driver id, or the compile fails with a legible `WorkflowError` that names the offending
 * executor AND lists the known ids. `knownExecutors` is threaded from the run's `DriverTable.ids()` (the SAME
 * table the runtime `drivers.get` resolves against, so the compile check and the runtime backstop can never
 * disagree). `undefined` SKIPS the check (existing compile() callers that hold no table stay byte-identical —
 * the runtime `drivers.get` remains the authoritative gate). An authored-pi node (executor absent) is never
 * checked. Accumulates into the same `errors[]` the WorkflowError already carries.
 */
function executorErrors(nodes: Record<string, NodeSpec>, knownExecutors: string[] | undefined): string[] {
  if (!knownExecutors) return [];
  const errors: string[] = [];
  for (const nd of Object.values(nodes)) {
    const ex = nd.executor;
    if (ex !== undefined && !knownExecutors.includes(ex)) {
      errors.push(`node ${nd.id}: unknown executor "${ex}" — known executors: ${knownExecutors.join(', ')}`);
    }
  }
  return errors;
}

/** Compile without throwing — returns `{ workflow }` on success or `{ errors }` (for a repair loop). */
export function tryCompile(spec: WorkflowSpec, knownExecutors?: string[]): { workflow?: Workflow; errors: string[] } {
  const nodes: Record<string, NodeSpec> = {};
  const used = new Set<string>();
  spec.nodes.forEach((intent, i) => {
    let id = slugify(intent.label, i);
    const base = id;
    let n = 1;
    while (used.has(id)) { n++; id = `${base}-${n}`; }
    used.add(id);
    nodes[id] = materialize(intent, id);
  });
  const { edges, errors: edgeErrors } = inferEdges(nodes);
  const { stages, errors: stageErrors } = stagesOf(nodes, edges);
  // (P3) The executor gate runs alongside the edge/stage validation — a bad executor is as fatal as a bad edge.
  const errors = [...edgeErrors, ...stageErrors, ...executorErrors(nodes, knownExecutors)];
  if (errors.length) return { errors };
  return { workflow: { meta: spec.meta, nodes, stages, edges }, errors: [] };
}

/** Compile a flat WorkflowSpec into an executable Workflow. Throws WorkflowError if not buildable. */
export function compile(spec: WorkflowSpec, knownExecutors?: string[]): Workflow {
  const { workflow, errors } = tryCompile(spec, knownExecutors);
  if (!workflow) throw new WorkflowError(errors);
  return workflow;
}
