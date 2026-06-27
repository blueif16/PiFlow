// `loadTemplate(dir) → WorkflowSpec` — the compile gate (template-format.md §8), the workflow's `tsc`.
// The SINGLE fail-closed gate: a malformed template fails in ms at author time, not after a 20-min pi
// run. It (1) reads meta.json + scans nodes/*/ for each {node.json, prompt.md}; (2) chains each node's
// `deps` into the DAG (stages = topological levels; parallel lanes = same-level write-disjoint owns);
// (3) renders each node's DRIVER-* marker tail (§6) via the existing codec; (4) (re)writes the generated
// workflow.json lock; (5) returns the in-memory WorkflowSpec the existing compile/runWorkflow consume.
//
// The §8 static checks are FAIL-CLOSED: any violation throws a `TemplateError` carrying EVERY violation
// (detection = checks.ts; the throw is the consequence). The render uses `markersFromNode` AS-IS (T3
// owns extending the codec); only the BASE contract (artifacts/owns/readScope/schema/tools/checks/
// policy/return) is rendered — seed/promote/inject delivery is the runtime's job (T4/T5), flagged below.

import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import type { WorkflowSpec, NodeIntent, NodeOps, ReturnMode, Reducer } from '../../types.js';
import { defaultSchemaValidator, type SchemaValidator } from '../../runner/schema.js';
import { nodeSchema, metaSchema } from './schema/index.js';
import type { LoadedNode, TemplateNode, TemplateMeta } from './types.js';
import { renderRealizedPrompt, collectChecks, toPolicy } from './render.js';
import { lowerToOps, lowerActions } from './lower.js';
import {
  checkSchemas,
  checkDeps,
  checkCycles,
  checkParallelOwns,
  checkChannels,
  checkProducers,
  checkRefs,
  checkMcpSecrets,
} from './checks.js';
import { buildWorkflowJson, writeWorkflowJson } from './workflow-json.js';

/** Thrown when the template does not compile. Carries EVERY §8 violation (like `WorkflowError`). */
export class TemplateError extends Error {
  constructor(public readonly errors: string[]) {
    super(`template is not buildable:\n  - ${errors.join('\n  - ')}`);
    this.name = 'TemplateError';
  }
}

/** Options for `loadTemplate`. The schema validator is injectable (test seam); default = the one ajv. */
export interface LoadTemplateOpts {
  /** Override the schema validator (default: `defaultSchemaValidator()` — the package's single ajv). */
  validate?: SchemaValidator | null;
}

const readJson = async (p: string): Promise<unknown> => JSON.parse(await fs.readFile(p, 'utf8'));

/** Read a file as utf8, or '' if absent (an empty prose body is valid). */
async function readText(p: string): Promise<string> {
  try {
    return (await fs.readFile(p, 'utf8')) as string;
  } catch {
    return '';
  }
}

/** Scan the `<dir>/nodes/<id>/` folders → the loaded node bundles, id-sorted for a deterministic spec order. */
async function scanNodes(dir: string): Promise<{ loaded: LoadedNode[]; raw: { id: string; raw: unknown }[] }> {
  const nodesDir = path.join(dir, 'nodes');
  let entries: Dirent[];
  try {
    entries = await fs.readdir(nodesDir, { withFileTypes: true });
  } catch {
    throw new TemplateError([`no nodes/ directory under template "${dir}"`]);
  }
  const loaded: LoadedNode[] = [];
  const raw: { id: string; raw: unknown }[] = [];
  for (const e of entries.filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const ndir = path.join(nodesDir, e.name);
    const njson = path.join(ndir, 'node.json');
    let def: unknown;
    try {
      def = await readJson(njson);
    } catch {
      throw new TemplateError([`node "${e.name}": node.json is missing or not valid JSON (${njson})`]);
    }
    const id = (def as { id?: string }).id ?? e.name;
    raw.push({ id, raw: def });
    const tnode = def as TemplateNode;
    const prose = await readText(path.join(ndir, tnode.prompt?.file ?? 'prompt.md'));
    loaded.push({ def: tnode, dir: ndir, prose });
  }
  if (!loaded.length) throw new TemplateError([`template "${dir}" has no nodes`]);
  return { loaded, raw };
}

/**
 * Carry the authored `node.json.hooks` block onto the runtime `NodeOps` (the declarative DATA the run
 * loop executes: seed PRE · project/merge/promote POST). The `node.json` `hooks` shape IS `NodeOps`
 * (seed/project `{to,from}` · promote `{from,to,merge}` · merge the `{ops:[...]}` MergeSpec), so this is
 * a near-pass-through; only `promote.merge` is narrowed from the authored `string` to the `Reducer` union
 * (the schema gate already constrains it). Returns undefined when no hooks block is authored (so a node
 * with no ops stays op-free — additive).
 */
function toNodeOps(h: LoadedNode['def']['hooks']): NodeOps | undefined {
  if (!h) return undefined;
  const ops: NodeOps = {};
  if (h.seed) ops.seed = h.seed;
  if (h.project) ops.project = h.project;
  if (h.merge) ops.merge = h.merge;
  if (h.promote) ops.promote = h.promote.map((p) => ({ from: p.from, to: p.to, merge: p.merge as Reducer }));
  if (h.registryProject) ops.registryProject = h.registryProject;
  return ops;
}

/** Dedup a string list, preserving first-seen order. */
const unique = (xs: string[]): string[] => [...new Set(xs)];

/** Strip a leading `{{RUN}}/` so an injected forced-read becomes a RUN-relative `io.reads` path (edges). */
const runRel = (p: string): string => p.replace(/^\{\{RUN\}\}\//, '');

/** Map an authored TemplateNode → the runtime NodeIntent the existing DAG compiler consumes. */
function toNodeIntent(n: LoadedNode): NodeIntent {
  const c = n.def.contract;
  const ops = toNodeOps(n.def.hooks);
  // (M5 · G13) LOWER the deprecated aliases (inject/hooks/checks/policy) into the canonical op[] envelope.
  // AT THE LOADER ONLY — the dense NodeSpec gains exactly this one field; the runtime ops/checks/policy
  // carried below stay byte-identical so the runner's existing dispatch is unchanged (additive).
  const op = lowerToOps(n.def);
  // (M5 · G13) The CONTROL action ops lower to the canonical M3/M4 primitives (reroute/retry/escalate).
  const actions = lowerActions(op);
  // (M5 · #10/#16) The node's declared reads = injected forced-reads ∪ every op's `reads` (RUN-relative).
  // Replaces the `reads:[]` hardcode: an injected read now FOLDS into the prompt (the realized-prompt
  // renderer below) AND draws a DAG edge from its producer.
  const opReads = (op ?? []).flatMap((o) => (o.reads ?? []).map(runRel));
  const opWrites = (op ?? []).flatMap((o) => (o.writes ?? []).map(runRel));
  const intent: NodeIntent = {
    // label = the template id so `slugify(label)` round-trips to the SAME id (the DAG compiler derives
    // ids from labels, not from an authored id — keeping `compile`'s graph aligned with the template).
    label: n.def.id,
    // carry the node's `phase` through to the spec so a PROFILE predicate can select by it (generic metadata).
    phase: n.def.phase,
    // A PROGRAMMATIC node spawns no `pi`, so it has no realized prompt and no skill (its `prompt` block is
    // absent on disk). Every other node renders its prompt + carries its skill exactly as before.
    ...(n.def.programmatic ? {} : { prompt: renderRealizedPrompt(n.def, n.prose), skill: n.def.prompt?.skill }),
    tools: { allow: n.def.tools?.allow, deny: n.def.tools?.deny },
    io: {
      // (M5 · #10/#16) The node's declared reads = the lowered ops' reads (incl. {{RUN}}-relative injected
      // forced-reads) — raw inputs the template checks already proved are produced upstream or canonical.
      // Replaces the long-stale `reads:[]` hardcode (deps still carry routing explicitly).
      reads: unique(opReads),
      // produces = the required artifacts ∪ every op's declared writes (#16).
      produces: unique([...c.artifacts, ...opWrites]),
      externalInputs: [],
      dependsOn: n.def.deps.slice(),
      artifacts: c.artifacts.map((p) => (c.schema ? { path: p, schema: c.schema } : { path: p })),
      checks: collectChecks(n.def),
      policy: toPolicy(n.def.policy),
      returnMode: c.returnMode as ReturnMode | undefined,
      // Carry the AUTHORED structured-return JSON-Schema (node.json top-level `return`, §3) onto the
      // runtime NodeIO — parallel to how the artifact `schema` is carried above. Until now this was read
      // by the loader but never set, so `returnMode` was live while the return SCHEMA stayed dormant; the
      // runner now enforces a `required` node's result against it (the codec already renders DRIVER-RETURN-SCHEMA).
      returnSchema: n.def.return as Record<string, unknown> | undefined,
      fillSentinel: c.fillSentinel ?? undefined,
      // per-node retry budget → runner re-runs a fresh attempt on error/blocked (else one attempt).
      ...(n.def.retries ? { retries: n.def.retries } : {}),
      // (M5 · G13) The action:retry/escalate sugar lowered to the canonical M4 NodeIO fields.
      ...(actions.retry ? { retry: actions.retry } : {}),
      ...(actions.escalate ? { escalate: actions.escalate } : {}),
    },
    sandbox: {
      read: c.readScope.slice(),
      write: c.owns.slice(),
      // per-node hard wall-clock cap (ms) → runner reads node.sandbox.timeoutMs (else the run-level default).
      ...(n.def.timeoutMs ? { timeoutMs: n.def.timeoutMs } : {}),
    },
  };
  // Additive: only attach `ops` when the node authored a hooks block (a node with none stays op-free).
  if (ops) intent.ops = ops;
  // (M5 · G13) Carry the lowered op[] envelope onto the intent → the dense NodeSpec (the one new field).
  // Additive: a node declaring none of the lowerable surfaces stays op-free.
  if (op) intent.op = op;
  // (G6) Carry the agent-PRESET label verbatim (the preset was already expanded into tools/prompt at init);
  // it rides to observe so the GUI renders the icon. Additive — a node with none stays label-free.
  if (n.def.agentType) intent.agentType = n.def.agentType;
  // (G1) Carry the per-node routing fields verbatim; the runner resolves the effective model (model-routing.ts).
  if (n.def.model) intent.model = n.def.model;
  if (n.def.provider) intent.provider = n.def.provider;
  if (n.def.tier) intent.tier = n.def.tier;
  // (G5) Carry a HUMAN CHECKPOINT block verbatim onto the spec (the runtime CheckpointSpec) when authored —
  // additive, the same way `ops` is carried. A node with no checkpoint behaves exactly as before.
  if (n.def.checkpoint) intent.checkpoint = n.def.checkpoint;
  // (PROGRAMMATIC NODE) Carry the no-pi marker verbatim onto the intent → the dense NodeSpec (the runner
  // dispatches it to the declarative-ops lane). Additive: a node with none spawns `pi` exactly as before.
  if (n.def.programmatic) intent.programmatic = true;
  // (Phase 2) Carry a FUSION activation block verbatim onto the intent when authored — `expandFusion`
  // consumes it before compile (the activated node becomes a judge + N siblings). Additive: no block ⇒ no change.
  if (n.def.fusion) intent.fusion = n.def.fusion;
  // (G11) Carry the per-node external MCP gateway config verbatim onto the intent when authored —
  // `assembleRunTools` reads `mcp.servers` off the spec to build the run's merged `mcpConfig`, and the
  // runner stages it into a bridge-tool node's `_pi/mcp.json`. Authoring layer only (never the dense
  // NodeSpec — the `fusion?`/`checkpoint?` precedent). Additive: no block ⇒ no change (#3 was dead until now).
  if (n.def.mcp) intent.mcp = n.def.mcp;
  // (M5 · G13) The action:rerouteTo sugar lowered to the canonical M3 NodeIntent.reroute — consumed by
  // `expandReroute` BEFORE compile (the `fusion?` precedent: never reaches the dense NodeSpec). Additive.
  if (actions.reroute) intent.reroute = actions.reroute;
  // (G9) Carry a SUBWORKFLOW activation block verbatim onto the intent when authored — `expandSubworkflow`
  // consumes it before fusion + compile (the node is replaced by the referenced sub-template). Additive.
  if (n.def.subworkflow) intent.subworkflow = n.def.subworkflow;
  return intent;
}

/**
 * Load + compile a template directory into a `WorkflowSpec`, (re)writing the generated workflow.json.
 * Fail-closed: throws `TemplateError` with every §8 violation if the template is not buildable.
 */
export async function loadTemplate(dir: string, opts: LoadTemplateOpts = {}): Promise<WorkflowSpec> {
  const validate = opts.validate !== undefined ? opts.validate : await defaultSchemaValidator();
  if (!validate) {
    throw new TemplateError([
      'no draft-2020-12 validator resolved (install ajv) — the schema gate is mandatory for loadTemplate',
    ]);
  }

  // (1) read meta.json + scan nodes/*/
  let meta: unknown;
  try {
    meta = await readJson(path.join(dir, 'meta.json'));
  } catch {
    throw new TemplateError([`meta.json is missing or not valid JSON under template "${dir}"`]);
  }
  const { loaded, raw } = await scanNodes(dir);

  // §8 STATIC CHECKS — fail-closed, collect EVERY violation.
  const errors: string[] = [];
  const schemaErrors = checkSchemas(meta, raw, validate, metaSchema as object, nodeSchema as object);
  errors.push(...schemaErrors);
  // Structural graph checks need only `id`/`deps` (top-level) — run them even on a malformed shape.
  errors.push(...checkDeps(loaded));
  const cycleErrors = checkCycles(loaded);
  errors.push(...cycleErrors);
  // Contract-DEPENDENT referential checks (owns/readScope/inject/promote) assume a valid per-file shape
  // and an acyclic graph — skip them when schema is invalid (a malformed node.json would only produce
  // noisy secondary errors) or a cycle is present (topo levels are undefined).
  if (!schemaErrors.length && !cycleErrors.length) {
    errors.push(...checkParallelOwns(loaded));
    errors.push(...checkChannels(loaded));
    errors.push(...checkProducers(loaded));
  }
  // (#3) The literal-secret guard reads only `mcp.servers` (no graph dependency) — run it whenever the
  // per-file shape is valid, independent of the topology checks above.
  if (!schemaErrors.length) errors.push(...checkMcpSecrets(loaded));
  errors.push(...(await checkRefs(loaded)));

  if (errors.length) throw new TemplateError(errors);

  // (4) (re)write the generated workflow.json lock — always synced from the node set.
  await writeWorkflowJson(dir, buildWorkflowJson(meta as TemplateMeta, loaded));

  // (5) build + return the in-memory WorkflowSpec (deterministic node order = id-sorted from scan).
  const m = meta as TemplateMeta;
  const nodes = loaded.map(toNodeIntent);
  // (M5 · #10/#16) Now that `io.reads` folds the op/injected reads (no longer the `reads:[]` hardcode),
  // mark each read with NO producer in the spec as an externalInput — a RAW input, NOT a missing-producer
  // error (the template's `checkRefs` already proved each injected read is produced upstream or canonical).
  // A read another node PRODUCES stays an inferred edge (the data-flow join). This makes the new edges sound.
  const producers = new Set(nodes.flatMap((n) => n.io.produces ?? []));
  for (const n of nodes) {
    const raw = (n.io.reads ?? []).filter((r) => !producers.has(r));
    if (raw.length) n.io.externalInputs = unique([...(n.io.externalInputs ?? []), ...raw]);
  }
  const spec: WorkflowSpec = {
    meta: { name: m.name, description: m.description },
    nodes,
  };
  // Carry the product-declared run modes (DATA) onto the spec when authored — additive, the SDK only
  // applies the named profile's GENERIC predicate; the product owns the names/vocabulary in its meta.json.
  if (m.profiles) spec.profiles = m.profiles;
  if (m.defaultProfile !== undefined) spec.defaultProfile = m.defaultProfile;
  return spec;
}
