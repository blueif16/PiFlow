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
import {
  checkSchemas,
  checkDeps,
  checkCycles,
  checkParallelOwns,
  checkChannels,
  checkProducers,
  checkRefs,
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

/** Map an authored TemplateNode → the runtime NodeIntent the existing DAG compiler consumes. */
function toNodeIntent(n: LoadedNode): NodeIntent {
  const c = n.def.contract;
  const ops = toNodeOps(n.def.hooks);
  const intent: NodeIntent = {
    // label = the template id so `slugify(label)` round-trips to the SAME id (the DAG compiler derives
    // ids from labels, not from an authored id — keeping `compile`'s graph aligned with the template).
    label: n.def.id,
    // carry the node's `phase` through to the spec so a PROFILE predicate can select by it (generic metadata).
    phase: n.def.phase,
    prompt: renderRealizedPrompt(n.def, n.prose),
    skill: n.def.prompt.skill,
    tools: { allow: n.def.tools?.allow, deny: n.def.tools?.deny },
    io: {
      // {{RUN}}-relative injected reads become the node's declared reads (raw inputs — the template
      // checks already proved each is produced upstream or is canonical); deps carry routing explicitly.
      reads: [],
      produces: c.artifacts.slice(),
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
  // (G1) Carry the per-node routing fields verbatim; the runner resolves the effective model (model-routing.ts).
  if (n.def.model) intent.model = n.def.model;
  if (n.def.provider) intent.provider = n.def.provider;
  if (n.def.tier) intent.tier = n.def.tier;
  // (G5) Carry a HUMAN CHECKPOINT block verbatim onto the spec (the runtime CheckpointSpec) when authored —
  // additive, the same way `ops` is carried. A node with no checkpoint behaves exactly as before.
  if (n.def.checkpoint) intent.checkpoint = n.def.checkpoint;
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
  errors.push(...(await checkRefs(loaded)));

  if (errors.length) throw new TemplateError(errors);

  // (4) (re)write the generated workflow.json lock — always synced from the node set.
  await writeWorkflowJson(dir, buildWorkflowJson(meta as TemplateMeta, loaded));

  // (5) build + return the in-memory WorkflowSpec (deterministic node order = id-sorted from scan).
  const m = meta as TemplateMeta;
  const spec: WorkflowSpec = {
    meta: { name: m.name, description: m.description },
    nodes: loaded.map(toNodeIntent),
  };
  // Carry the product-declared run modes (DATA) onto the spec when authored — additive, the SDK only
  // applies the named profile's GENERIC predicate; the product owns the names/vocabulary in its meta.json.
  if (m.profiles) spec.profiles = m.profiles;
  if (m.defaultProfile !== undefined) spec.defaultProfile = m.defaultProfile;
  return spec;
}
