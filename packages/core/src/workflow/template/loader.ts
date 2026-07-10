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
import type { WorkflowSpec, NodeIntent, ReturnMode, ScriptToolDef } from '../../types.js';
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
  checkOpAliasConflict,
} from './checks.js';
import { buildWorkflowJson, writeWorkflowJson } from './workflow-json.js';
import { materializeJudgeNodes, JudgeConfigError } from '../judge/materialize.js';
import { fanoutGates, GateListError } from '../gate-list.js';
import { loadProfileOverlay, mergeProfileOverlay, ProfileOverlayError } from '../profile-overlay.js';
import { isScriptToolAddress, scriptToolName } from '../../tools/script-discover.js';

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
  /**
   * (gate-list-and-additive-profiles.md §b/§c) The ADDITIVE profile name → `<dir>/profiles/<name>.json`,
   * an overlay that APPENDS gates to the nodes it declares. Absent ⇒ a pure-template compile. A named
   * overlay whose file is missing is left to the legacy `meta.json` elidePhases path / an unknown-profile
   * error (resolved outside this loader); a malformed overlay file is a loud `TemplateError`.
   */
  profile?: string;
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

/** Dedup a string list, preserving first-seen order. */
const unique = (xs: string[]): string[] => [...new Set(xs)];

/** Strip a leading `{{RUN}}/` so an injected forced-read becomes a RUN-relative `io.reads` path (edges). */
const runRel = (p: string): string => p.replace(/^\{\{RUN\}\}\//, '');

/**
 * (script-tools) Fill the DEFAULT tool dir (`<templateDir>/tools/<name>/`) for every `tool:<name>` allow
 * entry that carries NO explicit `defs` override — the loader is the ONE place that knows the template
 * dir, so it bakes this default in at load time. An author-declared `defs` entry is carried through
 * VERBATIM (still token-bearing; token-resolved later, at node start). A node with no `tool:*` allow
 * entry gets no `defs` at all (byte-identical to before this feature).
 */
function fillScriptToolDefaults(
  tools: TemplateNode['tools'],
  templateDir: string,
): Record<string, ScriptToolDef> | undefined {
  const scriptAddrs = (tools?.allow ?? []).filter(isScriptToolAddress);
  if (!scriptAddrs.length) return tools?.defs;
  // An authored entry (string OR the `{ path, optional }` object form) is carried through VERBATIM;
  // only a `tool:<name>` with NO entry gets the template-root default (a plain string = REQUIRED).
  const defs: Record<string, ScriptToolDef> = { ...(tools?.defs ?? {}) };
  for (const addr of scriptAddrs) {
    if (!(addr in defs)) defs[addr] = path.join(templateDir, 'tools', scriptToolName(addr));
  }
  return defs;
}

/** Map an authored TemplateNode → the runtime NodeIntent the existing DAG compiler consumes. */
function toNodeIntent(n: LoadedNode, templateDir: string): NodeIntent {
  const c = n.def.contract;
  // (M5 · G13) LOWER the deprecated aliases (inject/hooks/checks/policy) into the canonical op[] envelope.
  // AT THE LOADER ONLY — the dense NodeSpec gains exactly this one field; the runtime checks/policy carried
  // below stay byte-identical so the runner's existing dispatch is unchanged (additive). `op[]` is now the
  // SOLE derive rep — the legacy `node.ops` (and its back-fill) was retired in U6.
  const baseOp = lowerToOps(n.def);
  // (gate-list-and-additive-profiles.md §a) FAN OUT the additive gate LIST onto the existing carriers BEFORE
  // action lowering, so a fanned execution op's retry/reroute lowers uniformly and its post `Check` joins
  // `io.checks`. A node with no `gates[]` yields `undefined` here → `op`/`checks` are byte-identical to today.
  const fan = n.def.gates?.length ? fanoutGates(n.def.gates, n.def.id) : undefined;
  const op = fan?.ops.length ? [...(baseOp ?? []), ...fan.ops] : baseOp;
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
    tools: {
      allow: n.def.tools?.allow,
      deny: n.def.tools?.deny,
      defs: fillScriptToolDefaults(n.def.tools, templateDir),
    },
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
      // (gate-list §a) The authored checks ∪ the execution gates' post predicates (the two-layer post engine).
      // Byte-identical to `collectChecks(n.def)` when the node authors no `gates[]`.
      checks: fan?.checks.length ? [...(collectChecks(n.def) ?? []), ...fan.checks] : collectChecks(n.def),
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
      // (E10) exec-scope → `sandbox.execCwd`/`sandbox.execReads`: a build that runs from a project root
      // OUTSIDE the run dir (execCwd) importing a sibling kit (execReads). Raw tokens survive here — the
      // {{WORKSPACE}} resolve happens at launch (node-lifecycle). OMITTED when absent so a normal node's
      // sandbox is byte-identical to today. Threaded like read/write (the fs-scope axis).
      ...(c.execCwd ? { execCwd: c.execCwd } : {}),
      ...(c.execReads ? { execReads: c.execReads.slice() } : {}),
      // per-node hard wall-clock cap (ms) → runner reads node.sandbox.timeoutMs (else the run-level default).
      ...(n.def.timeoutMs ? { timeoutMs: n.def.timeoutMs } : {}),
      // per-node JAIL-OFF (`contract.fullAccess`) → `sandbox.fullAccess`: a `true` runs this node outside the
      // local fs jail (scope.create passes enforceReadScope:false). Threaded like read/write (sits with the
      // fs-scope axis); OMITTED when absent so a normal node's sandbox is byte-identical to today.
      ...(c.fullAccess ? { fullAccess: true } : {}),
      // per-node OUTPUT-COLLECTION ROOT (`contract.output`) → `sandbox.output`. `materialize` (dag.ts:32)
      // defaults an unset value to `out/<id>`; an authored `"."` makes the isolated-kind `downloadDir` an
      // IDENTITY (no prefix strip) so a nested artifact lands where the contract stats it under BOTH in-place
      // and isolated kinds (the N-breach parity fix). OMITTED when absent ⇒ the `out/<id>` default (unchanged).
      ...(c.output ? { output: c.output } : {}),
    },
  };
  // (M5 · G13) Carry the lowered op[] envelope onto the intent → the dense NodeSpec. `op[]` is the SOLE
  // derive rep (the legacy `node.ops` + its back-fill were retired in U6): both `hooks`-authored and
  // directly-`op[]`-authored derives flow through this one field, which the runner reads via `derivesFromOp`.
  // Additive: a node declaring none of the lowerable surfaces stays op-free.
  if (op) intent.op = op;
  // (G6) Carry the agent-PRESET label verbatim (the preset was already expanded into tools/prompt at init);
  // it rides to observe so the GUI renders the icon. Additive — a node with none stays label-free.
  if (n.def.agentType) intent.agentType = n.def.agentType;
  // (claude-code executor) Carry the per-node ENGINE selector verbatim → the dense NodeSpec. The runner
  // routes on it at dispatch (claudeCommand vs defaultPiCommand), model res, and the credential seam.
  // Additive: absent ⇒ 'pi', byte-identical to today. The schema's enum already gated the value.
  if (n.def.executor) intent.executor = n.def.executor;
  // (G1) Carry the per-node routing fields verbatim; the runner resolves the effective model (model-routing.ts).
  if (n.def.model) intent.model = n.def.model;
  if (n.def.provider) intent.provider = n.def.provider;
  if (n.def.tier) intent.tier = n.def.tier;
  // Per-node reasoning cap → NodeSpec.thinking → `pi --thinking` (command.ts). Operator-free over-think guard.
  if (n.def.thinking) intent.thinking = n.def.thinking;
  // (G5 / gate-list §a / P3) Carry the HUMAN CHECKPOINT to ONE of TWO DISTINCT destinations:
  //   • a DIRECTLY-authored `checkpoint` (node.json, no prompt/model) → `intent.checkpoint` → the no-pi lane
  //     (a standalone human NODE that spawns no model), UNCHANGED.
  //   • a FANNED `hitl` gate → `intent.gate.checkpoint` (+ policy) → the INLINE lane: the producer runs its
  //     model, THEN pauses for the human (the node-lifecycle post-model seam). Kept OFF `node.checkpoint` so
  //     the runner's checkpoint dispatch (runner.ts) never short-circuits the producer before its model.
  // A node cannot be BOTH — a standalone checkpoint has no model, an inline gate needs one — so both at once
  // is a LOUD conflict (never a silent drop).
  if (fan?.checkpoint && n.def.checkpoint) {
    throw new GateListError(
      `node "${n.def.id}": a hitl gate conflicts with a directly-authored checkpoint — a node is EITHER a standalone checkpoint OR an inline-gated producer, never both`,
    );
  }
  if (n.def.checkpoint) intent.checkpoint = n.def.checkpoint;
  if (fan?.checkpoint) {
    intent.gate = { checkpoint: fan.checkpoint, ...(fan.hitlPolicy ? { policy: fan.hitlPolicy } : {}) };
  }
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
  // (expert-representations / gate-list §a) Carry the JUDGE GATE: a fanned `agentic` gate OR a directly-
  // authored `judgeGate`. `materializeJudgeNodes` consumes it at LOAD time (below), inserting a real
  // `<id>__judge` node + the producer-side reroute loop. A node has ONE judge slot — both at once is a LOUD
  // conflict. Additive: no gate ⇒ no change.
  if (fan?.judgeGate && n.def.judgeGate) {
    throw new GateListError(
      `node "${n.def.id}": an agentic gate conflicts with a directly-authored judgeGate — a node has ONE judge slot`,
    );
  }
  const judgeGate = fan?.judgeGate ?? n.def.judgeGate;
  if (judgeGate) intent.judgeGate = judgeGate;
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
  // (A2) The op[]/alias conflict guard reads only per-node shape (op vs inject/hooks) — likewise run it
  // whenever the per-file shape is valid: an authored op[] SILENTLY drops inject/hooks, so we reject it.
  if (!schemaErrors.length) errors.push(...checkOpAliasConflict(loaded));
  errors.push(...(await checkRefs(loaded)));

  if (errors.length) throw new TemplateError(errors);

  // (4) (re)write the generated workflow.json lock — synced from the PRISTINE node set. A profile overlay
  // is additive + run-scoped, so it must NOT churn the committed lock (merge happens AFTER this write).
  await writeWorkflowJson(dir, buildWorkflowJson(meta as TemplateMeta, loaded));

  // (5) build the in-memory WorkflowSpec (deterministic node order = id-sorted from scan).
  const m = meta as TemplateMeta;
  // (gate-list §c) The legacy meta.json `profiles` (elidePhases) model is DEPRECATED on the additive path —
  // warn LOUDLY, do NOT silently break: the legacy node-elision still functions (applyProfileByName) this
  // release. The migration is to additive overlays at template/profiles/<name>.json.
  if (m.profiles && Object.values(m.profiles).some((p) => p?.elidePhases?.length)) {
    console.warn(
      `[piflow] template "${m.id ?? m.name}": meta.json \`profiles.elidePhases\` is DEPRECATED — migrate to ` +
        `additive overlays at template/profiles/<name>.json (docs/design/gate-list-and-additive-profiles.md). ` +
        `Legacy node-elision still runs this release.`,
    );
  }
  let nodes: NodeIntent[];
  try {
    // (gate-list §b) Apply the ADDITIVE profile overlay (when named AND its file is present): APPEND its
    // per-node gates to the loaded defs BEFORE the fan-out, so a profile-added agentic gate materializes its
    // judge on the SAME path an authored one does. An unknown named node is a loud `ProfileOverlayError`; a
    // MISSING overlay file returns null (left to the caller's legacy-profile / unknown-profile resolution).
    if (opts.profile) {
      const overlay = await loadProfileOverlay(dir, opts.profile, validate);
      if (overlay) mergeProfileOverlay(loaded, overlay);
    }
    const authoredNodes = loaded.map((n) => toNodeIntent(n, dir));
    // (expert-representations · "Judge expansion") MATERIALIZE every `judgeGate` — authored OR fanned from an
    // agentic gate — into a real `<producer>__judge` pi node + the producer-side reroute loop + the
    // downstream-consumer rewiring. Runs BEFORE the externalInputs join below so the judge's reads/produces
    // participate in edge inference. A spec with no judge gate is returned referentially unchanged.
    nodes = materializeJudgeNodes({ meta: { name: m.name, description: m.description }, nodes: authoredNodes }).nodes;
  } catch (e) {
    // A gate-list conflict, an overlay error, or the judge same-tier invariant are all TEMPLATE buildability
    // failures — surface them through the SAME fail-closed `TemplateError` envelope the §8 checks use.
    if (e instanceof GateListError || e instanceof ProfileOverlayError || e instanceof JudgeConfigError) {
      throw new TemplateError([e.message]);
    }
    throw e;
  }
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
