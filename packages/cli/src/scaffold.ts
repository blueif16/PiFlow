// `piflowctl new` / `piflowctl add-node` — the template SCAFFOLDER. It EMITS the two CLI-owned, fully
// schema-valid authored files (`meta.json` + each `nodes/<id>/node.json`) from flags, so an agent never
// hand-writes JSON (no `{{RUN}}` escaping, no `additionalProperties:false` typo round-trips) and never
// EDITS a skeleton (which would cost a Read + an exact old-string echo). The DIVISION is the whole point:
//   • structured CONFIG (meta.json, node.json)  → emitted here from flags, overwritten freely (it is a
//     deterministic function of the flags — re-run it, don't edit it);
//   • PROSE (the node's prompt.md)              → the agent's job, written FRESH with the Write tool. The
//     scaffolder NEVER creates or touches a prompt.md, so an agent's authored prose is never clobbered.
//   • the generated workflow.json LOCK + stages → neither — `loadTemplate` (re)writes them itself.
//
// The oracle that the emitted JSON is engine-valid is `loadTemplate` (the §8 compile gate): run
// `piflowctl extract <dir>` after scaffolding and a non-zero exit means a real defect, not a glance at JSON.

import { promises as fs } from 'node:fs';
import path from 'node:path';
// The memory layer (piflow-memory-v1 §2) is a CORE feature; the scaffolder is its thin accessor — it seeds
// the two optimizer-facing legs (Leg A memory.md · Leg B code-map.md) create-if-absent, exactly as it seeds
// (never clobbers) a node's prompt.md. The build LOGIC lives in @piflow/core; the seeded files are product data.
import { seedSystemMemory, seedNodeMemory, seedNodeCodeMap } from '@piflow/core';
import { loadAgentPreset, mergePreset } from '@piflow/core';
import type { PresetMergeable } from '@piflow/core';
// The read-only Leg-A readers (`memory find|check`) live in their own file (mirroring understand.ts); the
// dispatcher below routes to them so scaffold.ts stays the scaffolding concern only. `memory compact` is the
// out-of-band cap/retire pass (its injectors shell git + the OKF gate) — its own file too, one concern each.
import { runMemoryFind, runMemoryCheck } from './memory.js';
import { runMemoryCompactCli } from './memory-compact.js';

/** A `--mcp name=url` server entry → the `node.json` `mcp.servers` value (http transport inferred). */
export type McpServers = Record<string, { transport: string; url: string }>;

/** Options for `scaffoldNew` (emit `meta.json` + the `nodes/` dir). All optional — defaults from the dir. */
export interface NewOpts {
  /** Workflow id (default: the dir basename, or its parent when the dir is named `template`). */
  id?: string;
  /** Human-readable name (default: the id). */
  name?: string;
  /** One-line description (default: ''). */
  description?: string;
  /** Optional decorative phase DISPLAY order (never drives the DAG — deps + owns do). */
  phases?: string[];
}

/** An integrity check on an artifact (`--check field-present:verify/r.json:warn:verdict`). The full
 *  `$defs/check` shape (node.schema.ts): a `kind`, an optional `path`, a `severity` (fail|warn — the
 *  verdict on failure), and a kind-specific `param` (dotted field, regex, or an object like {min,path}). */
export interface CheckOpt {
  kind: string;
  path?: string;
  severity?: 'fail' | 'warn';
  param?: unknown;
}

/** Options for `scaffoldAddNode` (emit one `nodes/<id>/node.json`). `id` is the only required field. */
export interface NodeOpts {
  id: string;
  /** Decorative phase label (default: the id). A run PROFILE elides by this tag. */
  phase?: string;
  /** Upstream node ids — THE edges (default: []). */
  deps?: string[];
  /** Required outputs, {{RUN}}-relative — the driver stat()s them (default: []). */
  artifacts?: string[];
  /** Write-authority globs (default: ['out/**']). Disjoint owns + same deps ⇒ a parallel lane. */
  owns?: string[];
  /** Exposed read dirs + the OS allow-list (default: ['{{RUN}}']). */
  readScope?: string[];
  /** tools.allow entries (fs/sh builtins, oc.*, mcp.*, submit_result). */
  tools?: string[];
  /** tools.deny entries. */
  deny?: string[];
  /** KIND-1 forced reads auto-injected into the prompt (must sit inside readScope). */
  inject?: string[];
  /** DERIVE HOOKS → emitted as the canonical `op[]`. `seed` PRE; the rest POST. See `references/hooks/`. */
  /** seed: stage a starting artifact before the model — `{ to, from }`. */
  seed?: { to: string; from: string }[];
  /** project: derive an output from frozen inputs — `{ to, from }` (`from` = one path or many). */
  project?: { to: string; from: string | string[] }[];
  /** merge `run`: a deterministic shell side-effect (asset gen etc.) — `{ cmd, args?, cwd? }`. */
  mergeRun?: { cmd: string; args?: string[]; cwd?: string }[];
  /** promote: lift a node output → a RunState `{{state.<to>}}` channel — `from` = `@return:<f>` | `<file>:<f>`. */
  promote?: { from: string; to: string; merge?: 'set' | 'append' | 'deepMerge' }[];
  /** registryProject: project a registry record's op-map over a frozen source — `{ source, mapRef, key }`. */
  registryProject?: { source: string; mapRef: string; key: string };
  /** EXECUTION GATE(s) → a POST `op.run` whose non-zero exit BLOCKS the node (test/build/lint). `{ cmd, args?, cwd? }`. */
  gateRun?: { cmd: string; args?: string[]; cwd?: string }[];
  /** (M4) Escalate to a stronger tier/model on failure → `op.action{kind:'escalate', via}` (→ io.escalate.tier). */
  escalate?: string;
  /** (M3) Bounded reroute back to an upstream node on failure → `op.action{kind:'rerouteTo', node, max}`. */
  reroute?: { node: string; max: number };
  /** Per-node external MCP servers (loader REJECTS a literal secret — use $VAR refs in values). */
  mcp?: McpServers;
  /** Which agent ENGINE runs this node: 'pi' (default fleet) or 'claude-code' (headless local Claude). */
  executor?: 'pi' | 'claude-code';
  /** Per-node routing (G1). */
  model?: string;
  provider?: string;
  tier?: string;
  /** Per-node hard wall-clock cap (ms). */
  timeoutMs?: number;
  /** Per-node retry budget (extra attempts on error/blocked). */
  retries?: number;
  /** optional (default when artifacts declared) | required (zero-artifact gate nodes). */
  returnMode?: 'optional' | 'required';
  /** JSON-Schema path validated off-disk after the node. */
  schema?: string;
  /** Optional SKILL.md pointer inlined into the realized prompt. */
  skill?: string;
  /** (G6) Adopt a base agent PRESET (`~/.piflow/agents/<id>.md`): folds its tools+skill+agentType LABEL
   *  into this node via the real `mergePreset` (preset base UNION the explicit `--tool`; `--deny` + the
   *  preset's deny both apply, deny wins; explicit `--skill` wins). NEVER touches prompt.md (the role-prompt
   *  stays the author's to prepend). An unknown id THROWS — the scaffolder never invents a preset. */
  agentType?: string;
  /** Prompt body file, node-folder-relative (default: 'prompt.md'). */
  promptFile?: string;
  /** Post-checks over produced artifacts (the `checks.post` lane). */
  checks?: CheckOpt[];
  /** Pre-checks over staged inputs (the `checks.pre` lane — runs BEFORE the model). */
  checksPre?: CheckOpt[];
  /** policy.fail action (default omitted ⇒ the engine default 'block'). */
  onFail?: 'block' | 'warn' | 'stop';
  /** policy.warn action (the consequence of a `warn`-severity verdict). */
  onWarn?: 'block' | 'warn' | 'stop';
  /** (G5 HITL) A human checkpoint on this node — pauses for a reply. NOT programmatic (the schema still
   *  requires a `prompt` block, and checkRefs still demands the prompt.md on disk). */
  checkpoint?: {
    kind: 'confirm' | 'input' | 'select';
    prompt: string;
    choices?: string[];
    default?: unknown;
    headless?: 'default' | 'abort';
    timeoutMs?: number;
  };
  /** A JUDGE gate — a different-tier model's verdict, materialized at load into a `<id>__judge` node. The
   *  `rubric` is INLINE prose (the CLI reads it from the sibling `judge.md`). `judgeTier` MUST differ from
   *  this node's `tier` (buildNode rejects a collision — no self-judging). */
  judge?: {
    judgeTier: string;
    rubric: string;
    threshold?: string;
    policy?: {
      onFail?: 'block' | 'warn' | 'stop' | 'retry' | 'escalate';
      retryMax?: number;
      retryScope?: 'feedback' | 'fix';
    };
  };
  /** (Phase 2) FUSION activation — siblings + judge expansion (run-path `expandFusion`). `mode` required. */
  fusion?: { mode: 'moa' | 'best-of-n'; n?: number; panel?: string[]; judge?: string; obligations?: boolean; verify?: boolean };
  /** (G9) SUBWORKFLOW — inline a sub-template as a sub-DAG in place of this node. `ref` = sub-template dir, parent-root-relative. */
  subworkflow?: { ref: string };
  /** Per-node jail-off → `contract.fullAccess` (run OUTSIDE the local fs jail; loosen-only, LOCAL-only). */
  fullAccess?: boolean;
  /** A write-first sentinel → `contract.fillSentinel` (still-present ⇒ the artifact is incomplete). */
  fillSentinel?: string;
  /** A no-pi node: runs its declarative ops, omits `prompt`/`tools`. */
  programmatic?: boolean;
}

/** Pretty-print a JSON object the way the template files are authored (2-space, trailing newline). */
const toJson = (o: unknown): string => JSON.stringify(o, null, 2) + '\n';

/** Parse a CLI scalar as JSON when it parses (an object/number/bool), else keep the raw string. Used for
 *  kind-specific check params ({min,path}) and a checkpoint `default` (any type). */
const jsonOrString = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

/** A `CheckOpt` → the `$defs/check` object: omit each optional field unless present (a minimal file). */
const emitCheck = (c: CheckOpt): Record<string, unknown> => ({
  kind: c.kind,
  ...(c.path ? { path: c.path } : {}),
  ...(c.severity ? { severity: c.severity } : {}),
  ...(c.param !== undefined ? { param: c.param } : {}),
});

/** The workflow id baked from the template dir: parent basename when the dir is `template/`, else its own. */
function deriveId(dir: string): string {
  const base = path.basename(path.resolve(dir));
  return base === 'template' ? path.basename(path.dirname(path.resolve(dir))) : base;
}

/** Build the `meta.json` object (pure). Mirrors `meta.schema.ts` — id/name/description required. */
export function buildMeta(dir: string, opts: NewOpts): Record<string, unknown> {
  const id = opts.id ?? deriveId(dir);
  const meta: Record<string, unknown> = {
    id,
    name: opts.name ?? id,
    description: opts.description ?? '',
  };
  if (opts.phases?.length) meta.phases = opts.phases;
  return meta;
}

/**
 * Build the `node.json` object (pure). Mirrors `node.schema.ts`: emits the required spine
 * (id/phase/deps/contract) always, defaults `owns`/`readScope` so a node is valid from id+artifacts
 * alone, and includes each optional block ONLY when its flag was given (so the file stays minimal).
 */
export function buildNode(opts: NodeOpts): Record<string, unknown> {
  // (G6) Resolve the agent-PRESET binding FIRST so the rest of the builder emits the FOLDED config. The
  // preset folds ONLY node.json-resident config (tools.allow/deny, prompt.skill, the agentType LABEL) via
  // the REAL `mergePreset` (drift-free) — it NEVER writes prompt.md (the role-prompt stays the author's to
  // prepend; `runAddNodeCli` prints the one-line note). An unknown id THROWS — never an invented preset.
  let tools = opts.tools;
  let deny = opts.deny;
  let skill = opts.skill;
  let agentType = opts.agentType;
  if (opts.agentType) {
    const preset = loadAgentPreset(opts.agentType);
    if (!preset) {
      throw new Error(
        `piflowctl: unknown agent preset "${opts.agentType}" (no ~/.piflow/agents/${opts.agentType}.md)`,
      );
    }
    // mergePreset operates on the MERGEABLE subset; pass the node's tools/skill so the union/deny-wins/
    // node-skill-wins rules run in ONE place (core). `prompt: ''` is a throwaway — we discard the merged
    // role+task prompt because prompt.md is never the scaffolder's to write.
    const mergeable: PresetMergeable = {
      prompt: '',
      ...(opts.skill !== undefined ? { skill: opts.skill } : {}),
      ...(opts.tools?.length || opts.deny?.length
        ? { tools: { ...(opts.tools?.length ? { allow: opts.tools } : {}), ...(opts.deny?.length ? { deny: opts.deny } : {}) } }
        : {}),
    };
    const merged = mergePreset(preset, mergeable);
    tools = merged.tools?.allow;
    deny = merged.tools?.deny;
    skill = merged.skill;
    agentType = merged.agentType;
  }
  const node: Record<string, unknown> = {
    id: opts.id,
    phase: opts.phase ?? opts.id,
    deps: opts.deps ?? [],
  };
  // PROSE pointer — omitted on a programmatic (no-pi) node, which the schema's allOf permits.
  if (!opts.programmatic) {
    node.prompt = { file: opts.promptFile ?? 'prompt.md', ...(skill ? { skill } : {}) };
  }
  // (G6) The agent-PRESET branding LABEL — emitted only when bound. The runner treats it as opaque; observe
  // → the GUI keys the preset icon off it. Round-trips through loadTemplate (node.schema.ts + loader.ts).
  if (agentType) node.agentType = agentType;
  // Engine selector — emitted only when set (absent ⇒ the loader defaults to 'pi', byte-identical).
  if (opts.executor) node.executor = opts.executor;
  if (tools?.length || deny?.length) {
    node.tools = {
      ...(tools?.length ? { allow: tools } : {}),
      ...(deny?.length ? { deny } : {}),
    };
  }
  if (opts.mcp && Object.keys(opts.mcp).length) node.mcp = { servers: opts.mcp };
  if (opts.timeoutMs) node.timeoutMs = opts.timeoutMs;
  if (opts.retries) node.retries = opts.retries;
  if (opts.model) node.model = opts.model;
  if (opts.provider) node.provider = opts.provider;
  if (opts.tier) node.tier = opts.tier;
  node.contract = {
    artifacts: opts.artifacts ?? [],
    owns: opts.owns ?? ['out/**'],
    readScope: opts.readScope ?? ['{{RUN}}'],
    // contract-resident extras (the fs-scope + completeness axes). fullAccess is emitted ONLY when true
    // (false/absent are byte-identical downstream); fillSentinel is a string (the schema also allows null).
    ...(opts.fullAccess ? { fullAccess: true } : {}),
    ...(opts.fillSentinel !== undefined ? { fillSentinel: opts.fillSentinel } : {}),
    ...(opts.schema ? { schema: opts.schema } : {}),
    ...(opts.returnMode ? { returnMode: opts.returnMode } : {}),
  };
  // (G13) The canonical `op[]` envelope. It carries the DERIVE hooks (seed/project/registryProject/merge/
  // promote), EXECUTION GATES (op.run), and CONTROL ACTIONS (escalate/reroute) — ONE ordered list. Authoring
  // `op[]` short-circuits the loader's alias-lowering (`lower.ts` — `if (def.op) return def.op`), so a node
  // WITH any op MUST ALSO carry its `inject` here (folded as PRE read-ops) or it would be dropped; `checks`/
  // `policy` stay below (the loader reads them independently via collectChecks/toPolicy). The derives RUN
  // because `op[]` is the SOLE derive rep (legacy `node.ops` retired in U6); the runner reads each family off
  // `op[]` (`derivesFromOp`/`runOpsFromOp`/`lowerActions`). Canonical order: pre reads · seed · project ·
  // registryProject · merge · promote (post derives) · execution gates (post) · control actions (on-failure).
  const ops: Record<string, unknown>[] = [];
  for (const s of opts.seed ?? []) {
    ops.push({ when: 'pre', writes: [s.to], transform: { kind: 'seed', from: s.from } });
  }
  for (const p of opts.project ?? []) {
    const reads = Array.isArray(p.from) ? p.from : [p.from];
    ops.push({ when: 'post', writes: [p.to], reads, transform: { kind: 'project', from: p.from } });
  }
  if (opts.registryProject) {
    const { source, mapRef, key } = opts.registryProject;
    ops.push({ when: 'post', transform: { kind: 'projectRegistry', source, mapRef, key } });
  }
  if (opts.mergeRun?.length) {
    const mergeOps = opts.mergeRun.map((r) => ({
      run: { cmd: r.cmd, ...(r.args?.length ? { args: r.args } : {}), ...(r.cwd ? { cwd: r.cwd } : {}) },
    }));
    ops.push({ when: 'post', transform: { kind: 'merge', ops: mergeOps } });
  }
  for (const p of opts.promote ?? []) {
    ops.push({ when: 'post', transform: { kind: 'promote', from: p.from, to: p.to, ...(p.merge ? { reducer: p.merge } : {}) } });
  }
  // EXECUTION GATE — a POST `op.run`; a non-zero exit BLOCKS the node (`onFailure:'block'`; node-lifecycle
  // partitions blocking op-failures). Distinct from `--merge-run` (a `transform.merge` data-derive, no verdict).
  for (const g of opts.gateRun ?? []) {
    ops.push({
      when: 'post',
      run: { cmd: g.cmd, ...(g.args?.length ? { args: g.args } : {}), ...(g.cwd ? { cwd: g.cwd } : {}) },
      onFailure: 'block',
    });
  }
  // CONTROL ACTIONS (on failure) — escalate `via` lowers to io.escalate.tier (M4); reroute `node` lowers to
  // io.reroute.onFail (M3 bounded self-fix; `node` must be a strict ancestor — expandReroute is the oracle).
  if (opts.escalate) ops.push({ when: 'on-failure', action: { kind: 'escalate', via: opts.escalate } });
  if (opts.reroute) {
    ops.push({ when: 'on-failure', action: { kind: 'rerouteTo', node: opts.reroute.node, max: opts.reroute.max } });
  }
  if (ops.length) {
    node.op = [...(opts.inject ?? []).map((p) => ({ when: 'pre', reads: [p] })), ...ops];
  } else if (opts.inject?.length) {
    node.inject = opts.inject; // no op[] entries ⇒ inject stays the legacy alias (the loader lowers it).
  }
  // DETECTION (§4) — the full `$defs/check` shape in BOTH lanes (pre over staged inputs, post over produced
  // artifacts). `collectChecks` (render.ts) folds kind/path/param/severity onto the runtime `io.checks`, so a
  // dropped severity/param silently weakens the gate — emit every present field. ⊥ policy (below).
  if (opts.checks?.length || opts.checksPre?.length) {
    node.checks = {
      ...(opts.checksPre?.length ? { pre: opts.checksPre.map(emitCheck) } : {}),
      ...(opts.checks?.length ? { post: opts.checks.map(emitCheck) } : {}),
    };
  }
  // CONSEQUENCE (§4) — verdict→action. Each lane (warn|fail) omitted ⇒ the engine default (fail→block).
  if (opts.onFail || opts.onWarn) {
    node.policy = {
      ...(opts.onFail ? { fail: opts.onFail } : {}),
      ...(opts.onWarn ? { warn: opts.onWarn } : {}),
    };
  }
  // (G5 HITL) The human checkpoint block (loader.ts:174 carries it verbatim). NOT a programmatic node —
  // it keeps its `prompt` block above (the runtime no-pi lane never reads it, but checkRefs demands it).
  if (opts.checkpoint) {
    const cp = opts.checkpoint;
    node.checkpoint = {
      kind: cp.kind,
      prompt: cp.prompt,
      ...(cp.choices?.length ? { choices: cp.choices } : {}),
      ...(cp.default !== undefined ? { default: cp.default } : {}),
      ...(cp.headless ? { headless: cp.headless } : {}),
      ...(cp.timeoutMs !== undefined ? { timeoutMs: cp.timeoutMs } : {}),
    };
  }
  // The JUDGE gate (loader materializes it into a real `<id>__judge` node, materialize.ts). `kind` is
  // IMPLIED by the field name — never emitted (additionalProperties:false would reject it). The producer
  // tier MUST differ from judgeTier (no self-judging — a model false-accepts its own work, TeamBench); the
  // SDK throws a JudgeConfigError at load, but fail in the CLI first for a clearer message + no half-write.
  if (opts.judge) {
    const j = opts.judge;
    if (opts.tier !== undefined && opts.tier === j.judgeTier) {
      throw new Error(
        `piflowctl: --judge tier "${j.judgeTier}" must differ from the node's --tier "${opts.tier}" ` +
          `(no self-judging — a model can't reliably judge its own output)`,
      );
    }
    node.judgeGate = {
      judgeTier: j.judgeTier,
      rubric: j.rubric,
      ...(j.threshold ? { threshold: j.threshold } : {}),
      ...(j.policy && Object.keys(j.policy).length ? { policy: j.policy } : {}),
    };
  }
  // (Phase 2) FUSION — top-level activation (loader carries verbatim; run-path expandFusion makes the node a
  // judge + N sibling producers). `mode` is the one required key — validate the enum here for a clear error.
  if (opts.fusion) {
    const f = opts.fusion;
    if (f.mode !== 'moa' && f.mode !== 'best-of-n') {
      throw new Error(`piflowctl: --fusion mode must be moa|best-of-n (got "${f.mode}")`);
    }
    node.fusion = {
      mode: f.mode,
      ...(f.n !== undefined ? { n: f.n } : {}),
      ...(f.panel?.length ? { panel: f.panel } : {}),
      ...(f.judge ? { judge: f.judge } : {}),
      ...(f.obligations ? { obligations: true } : {}),
      ...(f.verify === false ? { verify: false } : {}),
    };
  }
  // (G9) SUBWORKFLOW — top-level; run-path expandSubworkflow inlines the referenced sub-template's nodes in
  // place of this node. loadTemplate accepts any non-empty ref (it does NOT resolve the dir) — expandSubworkflow
  // is the resolution oracle.
  if (opts.subworkflow) node.subworkflow = { ref: opts.subworkflow.ref };
  if (opts.programmatic) node.programmatic = true;
  return node;
}

/**
 * Emit `meta.json` + create the `nodes/` dir, and SEED the template's SYSTEM memory (`memory.md`, Leg A
 * reconcile summary) create-if-absent. Overwrites meta (CLI-owned, deterministic) but NEVER clobbers a
 * curated `memory.md` (it accumulates the optimizer's reconcile state). Returns the paths touched.
 */
export async function scaffoldNew(
  dir: string,
  opts: NewOpts,
): Promise<{ meta: string; memory: { path: string; created: boolean } }> {
  await fs.mkdir(path.join(dir, 'nodes'), { recursive: true });
  const meta = buildMeta(dir, opts);
  const metaPath = path.join(dir, 'meta.json');
  await fs.writeFile(metaPath, toJson(meta));
  const memory = await seedSystemMemory(dir, meta.id as string);
  return { meta: metaPath, memory };
}

/**
 * Emit one `nodes/<id>/node.json`. Overwrites the node config (CLI-owned, deterministic from flags) but
 * NEVER creates or touches the sibling `prompt.md` — that prose is the agent's, written fresh with Write.
 */
export async function scaffoldAddNode(
  dir: string,
  opts: NodeOpts,
): Promise<{
  nodeJson: string;
  promptFile: string;
  promptExists: boolean;
  memory: { path: string; created: boolean };
  codeMap: { path: string; created: boolean };
}> {
  const ndir = path.join(dir, 'nodes', opts.id);
  await fs.mkdir(ndir, { recursive: true });
  const nodeJson = path.join(ndir, 'node.json');
  await fs.writeFile(nodeJson, toJson(buildNode(opts)));
  const promptFile = path.join(ndir, opts.promptFile ?? 'prompt.md');
  const promptExists = await fs
    .access(promptFile)
    .then(() => true)
    .catch(() => false);
  // Seed the node's TWO memory legs create-if-absent — like prompt.md, the optimizer curates these and a
  // re-emit must never clobber them. Leg A (memory.md): the node's standing behavior + failure lessons;
  // Leg B (code-map.md): the Tier-0 OKF slice of the product code in its scope.
  const memory = await seedNodeMemory(ndir, opts.id);
  const codeMap = await seedNodeCodeMap(ndir, opts.id);
  return { nodeJson, promptFile, promptExists, memory, codeMap };
}

/**
 * BACKFILL the memory layer over an ALREADY-authored template (one written before the layer existed, or
 * `templates/quality/verify`): seed the template's system `memory.md` + every existing node's `memory.md`
 * + `code-map.md`, all create-if-absent. The `piflowctl memory scaffold` command's engine. Returns what it
 * touched so the CLI can report seeded-vs-kept.
 */
export async function scaffoldMemory(dir: string): Promise<{
  system: { path: string; created: boolean };
  nodes: { id: string; memory: { path: string; created: boolean }; codeMap: { path: string; created: boolean } }[];
}> {
  // the workflow id titles the system memory; prefer meta.json's id, fall back to the dir-derived id.
  let wfId = deriveId(dir);
  try {
    const meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8')) as { id?: string };
    if (meta.id) wfId = meta.id;
  } catch {
    /* no/invalid meta.json — fall back to the derived id */
  }
  const system = await seedSystemMemory(dir, wfId);
  const nodesDir = path.join(dir, 'nodes');
  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = await fs.readdir(nodesDir, { withFileTypes: true });
  } catch {
    /* no nodes/ dir yet — only the system memory is seeded */
  }
  const nodes = [];
  for (const e of entries.filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const ndir = path.join(nodesDir, e.name);
    let id = e.name; // prefer the authored node.json id; fall back to the folder name.
    try {
      const nj = JSON.parse(await fs.readFile(path.join(ndir, 'node.json'), 'utf8')) as { id?: string };
      if (nj.id) id = nj.id;
    } catch {
      /* missing/invalid node.json — use the folder name */
    }
    nodes.push({ id, memory: await seedNodeMemory(ndir, id), codeMap: await seedNodeCodeMap(ndir, id) });
  }
  return { system, nodes };
}

// ── arg parsing ────────────────────────────────────────────────────────────────────────────────────

interface Parsed {
  positional: string[];
  flags: Record<string, string[]>; // every value-flag is REPEATABLE (collected into a list)
  bools: Set<string>;
}

/** A tiny GNU-ish parser: `--flag value` (repeatable → list), `--bool` (in `boolFlags`), else positional. */
function parseArgs(argv: string[], boolFlags: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string[]> = {};
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (boolFlags.includes(key)) {
        bools.add(key);
        continue;
      }
      const val = argv[++i];
      if (val === undefined) throw new Error(`piflowctl: flag --${key} needs a value`);
      (flags[key] ??= []).push(val);
    } else {
      positional.push(a);
    }
  }
  return { positional, flags, bools };
}

/** Parse `--mcp name=url` entries into the `mcp.servers` map (http transport inferred from the URL). */
function parseMcp(entries: string[] | undefined): McpServers | undefined {
  if (!entries?.length) return undefined;
  const servers: McpServers = {};
  for (const e of entries) {
    const eq = e.indexOf('=');
    if (eq < 1) throw new Error(`piflowctl: --mcp expects name=url (got "${e}")`);
    servers[e.slice(0, eq)] = { transport: 'http', url: e.slice(eq + 1) };
  }
  return servers;
}

/** Parse `--check kind[:path[:severity[:param]]]` into a check (used for both the post and pre lanes).
 *  Positional, colon-delimited: the terse `kind` / `kind:path` forms stay back-compatible. `severity` ∈
 *  fail|warn (empty segment ⇒ default fail). `param` is EVERYTHING after the 3rd colon (so a regex/dotted
 *  field keeps its own colons), JSON-parsed when it parses (count-floor's `{min,path}`, a number) else the
 *  raw string (a `field-present` dotted field, a regex). The loader is the oracle for an out-of-set kind. */
function parseCheck(entry: string): CheckOpt {
  const parts = entry.split(':');
  const out: CheckOpt = { kind: parts[0] };
  if (parts[1]) out.path = parts[1];
  if (parts[2]) {
    if (parts[2] !== 'fail' && parts[2] !== 'warn') {
      throw new Error(`piflowctl: --check severity must be fail|warn (got "${parts[2]}")`);
    }
    out.severity = parts[2];
  }
  const paramStr = parts.slice(3).join(':');
  if (paramStr) out.param = jsonOrString(paramStr);
  return out;
}

/** Parse `--judge <judgeTier>[:threshold]` + read the sibling `judge.md` rubric (the prose the agent Writes;
 *  the CLI inlines it, never authors it). Throws a clear error if the rubric file is absent/empty. The
 *  `judgeTier !== node tier` invariant is enforced in `buildNode` (it has the node's `--tier`). */
async function parseJudge(
  dir: string,
  id: string,
  flagValue: string,
  policyFlags: { onFail?: string; retryMax?: string; retryScope?: string },
): Promise<NonNullable<NodeOpts['judge']>> {
  const colon = flagValue.indexOf(':');
  const judgeTier = colon < 0 ? flagValue : flagValue.slice(0, colon);
  const threshold = colon < 0 ? undefined : flagValue.slice(colon + 1);
  if (!judgeTier) throw new Error(`piflowctl: --judge expects <judgeTier>[:threshold] (got "${flagValue}")`);
  const rubricPath = path.join(dir, 'nodes', id, 'judge.md');
  let rubric: string;
  try {
    rubric = (await fs.readFile(rubricPath, 'utf8')).trim();
  } catch {
    throw new Error(
      `piflowctl: --judge needs the rubric prose in ${rubricPath} — Write it first (the CLI inlines it, never authors it)`,
    );
  }
  if (!rubric) throw new Error(`piflowctl: ${rubricPath} is empty — write the judge rubric prose first`);
  const policy: NonNullable<NonNullable<NodeOpts['judge']>['policy']> = {};
  if (policyFlags.onFail) policy.onFail = policyFlags.onFail as NonNullable<typeof policy.onFail>;
  if (policyFlags.retryMax !== undefined) policy.retryMax = Number(policyFlags.retryMax);
  if (policyFlags.retryScope) policy.retryScope = policyFlags.retryScope as NonNullable<typeof policy.retryScope>;
  return {
    judgeTier,
    rubric,
    ...(threshold ? { threshold } : {}),
    ...(Object.keys(policy).length ? { policy } : {}),
  };
}

/** Parse `--checkpoint <kind>:<prompt>` (+ the sidecar `--checkpoint-*` flags) into the G5 block. `kind` is
 *  the token before the FIRST colon (so a prompt keeps its own colons). */
function parseCheckpoint(
  flagValue: string,
  sidecars: { choices?: string[]; default?: string; headless?: string; timeoutMs?: string },
): NonNullable<NodeOpts['checkpoint']> {
  const colon = flagValue.indexOf(':');
  if (colon < 1) throw new Error(`piflowctl: --checkpoint expects kind:prompt (got "${flagValue}")`);
  const kind = flagValue.slice(0, colon);
  if (kind !== 'confirm' && kind !== 'input' && kind !== 'select') {
    throw new Error(`piflowctl: --checkpoint kind must be confirm|input|select (got "${kind}")`);
  }
  return {
    kind,
    prompt: flagValue.slice(colon + 1),
    ...(sidecars.choices?.length ? { choices: sidecars.choices } : {}),
    ...(sidecars.default !== undefined ? { default: jsonOrString(sidecars.default) } : {}),
    ...(sidecars.headless ? { headless: sidecars.headless as 'default' | 'abort' } : {}),
    ...(sidecars.timeoutMs !== undefined ? { timeoutMs: Number(sidecars.timeoutMs) } : {}),
  };
}

// ── derive-hook flag parsers (each emits one canonical `op[]` entry via buildNode) ──────────────────
// Value grammars per design §3 (docs/design/scaffold-hooks/00-design.md). Every flag is a value-flag, so
// `parseArgs` collects it into the repeatable list already; these only shape one entry's string.

/** Parse `--seed to=from` → a PRE seed (stage an input before the model). Dest LHS, source RHS (first `=`). */
function parseSeed(entry: string): NonNullable<NodeOpts['seed']>[number] {
  const eq = entry.indexOf('=');
  if (eq < 1) throw new Error(`piflowctl: --seed expects to=from (got "${entry}")`);
  return { to: entry.slice(0, eq), from: entry.slice(eq + 1) };
}

/** Parse `--promote from=to[:reducer]` → a POST promote (lift an output into a `{{state.<to>}}` channel).
 *  `from` (`@return:<field>` | `<file>:<field>`) is the LHS of the FIRST `=` — so its own `:` is preserved;
 *  the RHS is `to` with an optional `:set|append|deepMerge` reducer suffix (the design's `--promote-merge`,
 *  folded inline so promote stays one flag). The loader is the oracle for an out-of-set reducer. */
function parsePromote(entry: string): NonNullable<NodeOpts['promote']>[number] {
  const eq = entry.indexOf('=');
  if (eq < 1) throw new Error(`piflowctl: --promote expects from=to[:reducer] (got "${entry}")`);
  const from = entry.slice(0, eq);
  const rhs = entry.slice(eq + 1);
  const colon = rhs.indexOf(':');
  if (colon < 0) return { from, to: rhs };
  return { from, to: rhs.slice(0, colon), merge: rhs.slice(colon + 1) as 'set' | 'append' | 'deepMerge' };
}

/** Parse `--project to=from[,from2,…]` → a POST project (derive an output from frozen inputs). `from` is one
 *  path (string) or a comma-listed set (array — the `derivedHook` string|array form). */
function parseProject(entry: string): NonNullable<NodeOpts['project']>[number] {
  const eq = entry.indexOf('=');
  if (eq < 1) throw new Error(`piflowctl: --project expects to=from[,from2] (got "${entry}")`);
  const to = entry.slice(0, eq);
  const parts = entry.slice(eq + 1).split(',').filter((p) => p.length > 0);
  if (!parts.length) throw new Error(`piflowctl: --project needs at least one from (got "${entry}")`);
  return { to, from: parts.length === 1 ? parts[0] : parts };
}

/** Parse `--merge-run cmd[:arg,arg,…][@cwd]` → a POST `run` op (a deterministic shell side-effect). `cmd` is
 *  the token before the FIRST `:` (so a `lesson:scaffold` arg keeps its colon); comma-listed args follow; a
 *  trailing `@cwd` sets the working dir. Rich merge bodies (fold/concat/reconcile) are hand-authored. */
function parseMergeRun(entry: string): NonNullable<NodeOpts['mergeRun']>[number] {
  let body = entry;
  let cwd: string | undefined;
  const at = body.lastIndexOf('@');
  if (at > 0) {
    cwd = body.slice(at + 1);
    body = body.slice(0, at);
  }
  const colon = body.indexOf(':');
  if (colon < 0) {
    if (!body) throw new Error(`piflowctl: --merge-run expects cmd[:args][@cwd] (got "${entry}")`);
    return { cmd: body, ...(cwd ? { cwd } : {}) };
  }
  const cmd = body.slice(0, colon);
  const args = body.slice(colon + 1).split(',').filter((a) => a.length > 0);
  return { cmd, ...(args.length ? { args } : {}), ...(cwd ? { cwd } : {}) };
}

/** Parse `--reroute node[:max]` → a bounded reroute back to an upstream node (default max 1). `node` is the
 *  LHS of the FIRST `:`; the optional RHS is the attempt budget. The target must be a strict ancestor —
 *  `expandReroute` is the run-path oracle (loadTemplate alone accepts any id). */
function parseReroute(entry: string): NonNullable<NodeOpts['reroute']> {
  const colon = entry.indexOf(':');
  if (colon < 0) return { node: entry, max: 1 };
  const node = entry.slice(0, colon);
  const max = Number(entry.slice(colon + 1));
  if (!node || !Number.isFinite(max)) throw new Error(`piflowctl: --reroute expects node[:max] (got "${entry}")`);
  return { node, max };
}

/** Parse `--registry-project source=…,mapRef=…,key=…` → a POST registryProject (all three required). */
function parseRegistryProject(entry: string): NonNullable<NodeOpts['registryProject']> {
  const fields: Record<string, string> = {};
  for (const pair of entry.split(',')) {
    const eq = pair.indexOf('=');
    if (eq < 1) throw new Error(`piflowctl: --registry-project expects k=v pairs (got "${pair}")`);
    fields[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  const { source, mapRef, key } = fields;
  if (!source || !mapRef || !key) {
    throw new Error(`piflowctl: --registry-project needs source=,mapRef=,key= (got "${entry}")`);
  }
  return { source, mapRef, key };
}

const NEW_USAGE =
  'piflowctl new <templateDir> [--id <id>] [--name <n>] [--description <d>] [--phase <p>]...';
const ADD_USAGE =
  'piflowctl add-node <templateDir> --id <id> [--phase <p>] [--dep <id>]... [--artifact <p>]... ' +
  '[--owns <glob>]... [--read <p>]... [--tool <t>]... [--deny <t>]... [--inject <p>]... ' +
  '[--seed <to=from>]... [--promote <from=to[:reducer]>]... [--project <to=from[,from2]>]... ' +
  '[--merge-run <cmd[:args][@cwd]>]... [--registry-project <source=,mapRef=,key=>] ' +
  '[--gate-run <cmd[:args][@cwd]>]... [--escalate <tier|model>] [--reroute <node[:max]>] ' +
  '[--mcp <name=url>]... [--check <kind[:path[:severity[:param]]]>]... [--check-pre <kind[:path[:severity[:param]]]>]... ' +
  '[--agent-type <id>] [--executor pi|claude-code] [--model <m>] [--provider <g>] [--tier <t>] ' +
  '[--timeout <ms>] [--retries <n>] [--return-mode optional|required] [--artifact-schema <p>] [--skill <p>] ' +
  '[--prompt-file <f>] [--on-fail block|warn|stop] [--on-warn block|warn|stop] ' +
  '[--judge <judgeTier[:threshold]>] [--judge-on-fail block|warn|stop|retry|escalate] [--judge-retry-max <n>] [--judge-retry-scope feedback|fix] ' +
  '[--checkpoint <confirm|input|select:prompt>] [--checkpoint-choice <v>]... [--checkpoint-default <v>] [--checkpoint-headless default|abort] [--checkpoint-timeout <ms>] ' +
  '[--fusion <moa|best-of-n>] [--fusion-n <n>] [--fusion-panel <model|tier>]... [--fusion-judge <model|tier>] [--fusion-obligations] [--fusion-no-verify] ' +
  '[--subworkflow <ref>] [--full-access] [--fill-sentinel <s>] [--programmatic]';

/** `piflowctl new <templateDir> [flags]` — emit meta.json + the nodes/ dir. */
export async function runNewCli(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv, []);
  const dir = positional[0];
  if (!dir) {
    process.stderr.write(`piflowctl new: a template directory is required\n  ${NEW_USAGE}\n`);
    process.exitCode = 1;
    return;
  }
  const { meta } = await scaffoldNew(dir, {
    id: flags.id?.[0],
    name: flags.name?.[0],
    description: flags.description?.[0],
    phases: flags.phase,
  });
  process.stdout.write(
    `wrote ${meta}\nnext: piflowctl add-node ${dir} --id <id> … (one per node), then Write each nodes/<id>/prompt.md\n`,
  );
}

/** `piflowctl add-node <templateDir> --id <id> [flags]` — emit one node.json (prose is the agent's). */
export async function runAddNodeCli(argv: string[]): Promise<void> {
  const { positional, flags, bools } = parseArgs(argv, [
    'programmatic',
    'full-access',
    'fusion-obligations',
    'fusion-no-verify',
  ]);
  const dir = positional[0];
  const id = flags.id?.[0];
  if (!dir || !id) {
    process.stderr.write(`piflowctl add-node: <templateDir> and --id are required\n  ${ADD_USAGE}\n`);
    process.exitCode = 1;
    return;
  }
  const num = (v: string | undefined): number | undefined => (v === undefined ? undefined : Number(v));
  // --judge reads the sibling judge.md (async I/O — kept out of the pure buildNode); --checkpoint folds its
  // sidecar flags. Both throw on a malformed value BEFORE scaffoldAddNode writes, so no half-authored node.
  const judge = flags.judge?.[0]
    ? await parseJudge(dir, id, flags.judge[0], {
        onFail: flags['judge-on-fail']?.[0],
        retryMax: flags['judge-retry-max']?.[0],
        retryScope: flags['judge-retry-scope']?.[0],
      })
    : undefined;
  const checkpoint = flags.checkpoint?.[0]
    ? parseCheckpoint(flags.checkpoint[0], {
        choices: flags['checkpoint-choice'],
        default: flags['checkpoint-default']?.[0],
        headless: flags['checkpoint-headless']?.[0],
        timeoutMs: flags['checkpoint-timeout']?.[0],
      })
    : undefined;
  const { nodeJson, promptFile, promptExists } = await scaffoldAddNode(dir, {
    id,
    phase: flags.phase?.[0],
    deps: flags.dep ?? [],
    artifacts: flags.artifact ?? [],
    owns: flags.owns,
    readScope: flags.read,
    tools: flags.tool,
    deny: flags.deny,
    inject: flags.inject,
    seed: (flags.seed ?? []).map(parseSeed),
    promote: (flags.promote ?? []).map(parsePromote),
    project: (flags.project ?? []).map(parseProject),
    mergeRun: (flags['merge-run'] ?? []).map(parseMergeRun),
    registryProject: flags['registry-project']?.[0]
      ? parseRegistryProject(flags['registry-project'][0])
      : undefined,
    gateRun: (flags['gate-run'] ?? []).map(parseMergeRun), // same cmd[:args][@cwd] grammar; emitted as a gate
    escalate: flags.escalate?.[0],
    reroute: flags.reroute?.[0] ? parseReroute(flags.reroute[0]) : undefined,
    mcp: parseMcp(flags.mcp),
    executor: flags.executor?.[0] as NodeOpts['executor'],
    model: flags.model?.[0],
    provider: flags.provider?.[0],
    tier: flags.tier?.[0],
    timeoutMs: num(flags.timeout?.[0]),
    retries: num(flags.retries?.[0]),
    returnMode: flags['return-mode']?.[0] as NodeOpts['returnMode'],
    schema: flags['artifact-schema']?.[0], // per-ARTIFACT output validation → contract.schema (NOT the return handshake)
    skill: flags.skill?.[0],
    agentType: flags['agent-type']?.[0],
    promptFile: flags['prompt-file']?.[0],
    checks: (flags.check ?? []).map(parseCheck),
    checksPre: (flags['check-pre'] ?? []).map(parseCheck),
    onFail: flags['on-fail']?.[0] as NodeOpts['onFail'],
    onWarn: flags['on-warn']?.[0] as NodeOpts['onWarn'],
    checkpoint,
    judge,
    fusion: flags.fusion?.[0]
      ? {
          mode: flags.fusion[0] as 'moa' | 'best-of-n',
          n: num(flags['fusion-n']?.[0]),
          panel: flags['fusion-panel'],
          judge: flags['fusion-judge']?.[0],
          obligations: bools.has('fusion-obligations') ? true : undefined,
          verify: bools.has('fusion-no-verify') ? false : undefined,
        }
      : undefined,
    subworkflow: flags.subworkflow?.[0] ? { ref: flags.subworkflow[0] } : undefined,
    fullAccess: bools.has('full-access') ? true : undefined,
    fillSentinel: flags['fill-sentinel']?.[0],
    programmatic: bools.has('programmatic'),
  });
  const next = bools.has('programmatic')
    ? 'programmatic node — no prompt needed'
    : promptExists
      ? `prompt exists: ${promptFile} (left untouched)`
      : `next: Write ${promptFile} (the node's prose — never scaffolded)`;
  // (G6) The preset folds CONFIG only; its role-PROMPT stays the author's to prepend (prose ≠ scaffolder's
  // job). Print the one-line reminder so the agent prepends the role before the node's task in prompt.md.
  const at = flags['agent-type']?.[0];
  const presetNote = at
    ? `\nagent-type ${at}: prepend its role-prompt (~/.piflow/agents/${at}.md) to this node's prompt.md.`
    : '';
  process.stdout.write(`wrote ${nodeJson}\n${next}${presetNote}\n`);
}

const MEMORY_USAGE =
  'piflowctl memory <scaffold|find|check|compact> <templateDir>  (find/check read-only; compact is the out-of-band cap/retire pass)';

/**
 * `piflowctl memory <scaffold|find|check|compact> …` — the Leg-A per-node MEMORY verb. `scaffold` backfills the
 * layer; `find`/`check` are the read-only readers (in ./memory.ts); `compact` is the out-of-band cap/retire
 * pass (in ./memory-compact.ts) that RETIRES lowest-value/graduated/code-shifted lessons (dry-run unless
 * `--apply`). Dispatches by the first token; `deps` threads the injectable OKF gate/cwd through so tests never
 * shell (`runGate` also drives the compact code-shifted injector).
 */
export async function runMemoryCli(
  argv: string[],
  deps: {
    cwd?: string;
    runGate?: (mode: 'check' | 'write', topicsDir: string, keys: string[]) => number;
  } = {},
): Promise<void> {
  const [action, ...rest] = argv;
  switch (action) {
    case 'find':
      return runMemoryFind(rest, deps);
    case 'check':
      return runMemoryCheck(rest, deps);
    case 'scaffold':
      return runMemoryScaffold(rest);
    case 'compact':
      return runMemoryCompactCli(rest, { runGate: deps.runGate });
    default:
      process.stderr.write(`piflowctl memory: unknown action '${action ?? ''}'\n  ${MEMORY_USAGE}\n`);
      process.exitCode = 1;
      return;
  }
}

/**
 * `piflowctl memory scaffold <templateDir>` — backfill the memory layer over an existing template (system
 * `memory.md` + every node's `memory.md` + `code-map.md`), create-if-absent. Reports seeded-vs-kept per file.
 */
async function runMemoryScaffold(rest: string[]): Promise<void> {
  const dir = rest[0];
  if (!dir) {
    process.stderr.write(
      `piflowctl memory scaffold: a template directory is required\n  piflowctl memory scaffold <templateDir>\n`,
    );
    process.exitCode = 1;
    return;
  }
  const { system, nodes } = await scaffoldMemory(dir);
  const tag = (r: { created: boolean }): string => (r.created ? 'seeded' : 'kept  ');
  const lines = [`${tag(system)} ${system.path}`];
  for (const n of nodes) {
    lines.push(`${tag(n.memory)} ${n.memory.path}`, `${tag(n.codeMap)} ${n.codeMap.path}`);
  }
  process.stdout.write(lines.join('\n') + '\n');
}
