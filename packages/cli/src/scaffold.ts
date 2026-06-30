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
import { loadAgentPreset, mergePreset } from '@piflow/core';
import type { PresetMergeable } from '@piflow/core';

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

/** A post-check on a produced artifact (`--check non-empty:findings/findings.md`). */
export interface CheckOpt {
  kind: string;
  path?: string;
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
  /** Post-checks over produced artifacts. */
  checks?: CheckOpt[];
  /** policy.fail action (default omitted ⇒ the engine default 'block'). */
  onFail?: 'block' | 'warn' | 'stop';
  /** A no-pi node: runs its declarative ops, omits `prompt`/`tools`. */
  programmatic?: boolean;
}

/** Pretty-print a JSON object the way the template files are authored (2-space, trailing newline). */
const toJson = (o: unknown): string => JSON.stringify(o, null, 2) + '\n';

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
    ...(opts.schema ? { schema: opts.schema } : {}),
    ...(opts.returnMode ? { returnMode: opts.returnMode } : {}),
  };
  // (G13) The canonical `op[]` envelope for the DERIVE hooks. Authoring `op[]` short-circuits the loader's
  // alias-lowering (`lower.ts:48` — `if (def.op) return def.op`), so a node WITH derive hooks must ALSO carry
  // its `inject` here (folded as PRE read-ops) or it would be dropped; `checks`/`policy` stay below (the
  // loader reads them independently). The derives RUN because `op[]` is the SOLE derive rep (the legacy
  // `node.ops` + its back-fill were retired in U6) and the runner reads each family off `op[]` via
  // `derivesFromOp`. Order is canonical pre→post: inject reads · seed · project · registryProject · merge · promote.
  const derive: Record<string, unknown>[] = [];
  for (const s of opts.seed ?? []) {
    derive.push({ when: 'pre', writes: [s.to], transform: { kind: 'seed', from: s.from } });
  }
  for (const p of opts.project ?? []) {
    const reads = Array.isArray(p.from) ? p.from : [p.from];
    derive.push({ when: 'post', writes: [p.to], reads, transform: { kind: 'project', from: p.from } });
  }
  if (opts.registryProject) {
    const { source, mapRef, key } = opts.registryProject;
    derive.push({ when: 'post', transform: { kind: 'projectRegistry', source, mapRef, key } });
  }
  if (opts.mergeRun?.length) {
    const ops = opts.mergeRun.map((r) => ({
      run: { cmd: r.cmd, ...(r.args?.length ? { args: r.args } : {}), ...(r.cwd ? { cwd: r.cwd } : {}) },
    }));
    derive.push({ when: 'post', transform: { kind: 'merge', ops } });
  }
  for (const p of opts.promote ?? []) {
    derive.push({ when: 'post', transform: { kind: 'promote', from: p.from, to: p.to, ...(p.merge ? { reducer: p.merge } : {}) } });
  }
  if (derive.length) {
    node.op = [...(opts.inject ?? []).map((p) => ({ when: 'pre', reads: [p] })), ...derive];
  } else if (opts.inject?.length) {
    node.inject = opts.inject; // no derive hooks ⇒ inject stays the legacy alias (the loader lowers it).
  }
  if (opts.checks?.length) {
    node.checks = { post: opts.checks.map((c) => ({ kind: c.kind, ...(c.path ? { path: c.path } : {}) })) };
  }
  if (opts.onFail) node.policy = { fail: opts.onFail };
  if (opts.programmatic) node.programmatic = true;
  return node;
}

/** Emit `meta.json` + create the `nodes/` dir. Returns the path written. Overwrites meta (CLI-owned). */
export async function scaffoldNew(dir: string, opts: NewOpts): Promise<{ meta: string }> {
  await fs.mkdir(path.join(dir, 'nodes'), { recursive: true });
  const metaPath = path.join(dir, 'meta.json');
  await fs.writeFile(metaPath, toJson(buildMeta(dir, opts)));
  return { meta: metaPath };
}

/**
 * Emit one `nodes/<id>/node.json`. Overwrites the node config (CLI-owned, deterministic from flags) but
 * NEVER creates or touches the sibling `prompt.md` — that prose is the agent's, written fresh with Write.
 */
export async function scaffoldAddNode(
  dir: string,
  opts: NodeOpts,
): Promise<{ nodeJson: string; promptFile: string; promptExists: boolean }> {
  const ndir = path.join(dir, 'nodes', opts.id);
  await fs.mkdir(ndir, { recursive: true });
  const nodeJson = path.join(ndir, 'node.json');
  await fs.writeFile(nodeJson, toJson(buildNode(opts)));
  const promptFile = path.join(ndir, opts.promptFile ?? 'prompt.md');
  const promptExists = await fs
    .access(promptFile)
    .then(() => true)
    .catch(() => false);
  return { nodeJson, promptFile, promptExists };
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

/** Parse `--check kind[:path]` into a post-check. */
function parseCheck(entry: string): CheckOpt {
  const colon = entry.indexOf(':');
  return colon < 0 ? { kind: entry } : { kind: entry.slice(0, colon), path: entry.slice(colon + 1) };
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
  '[--mcp <name=url>]... [--check <kind[:path]>]... [--agent-type <id>] [--executor pi|claude-code] [--model <m>] [--provider <g>] [--tier <t>] ' +
  '[--timeout <ms>] [--retries <n>] [--return-mode optional|required] [--schema <p>] [--skill <p>] ' +
  '[--prompt-file <f>] [--on-fail block|warn|stop] [--programmatic]';

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
  const { positional, flags, bools } = parseArgs(argv, ['programmatic']);
  const dir = positional[0];
  const id = flags.id?.[0];
  if (!dir || !id) {
    process.stderr.write(`piflowctl add-node: <templateDir> and --id are required\n  ${ADD_USAGE}\n`);
    process.exitCode = 1;
    return;
  }
  const num = (v: string | undefined): number | undefined => (v === undefined ? undefined : Number(v));
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
    mcp: parseMcp(flags.mcp),
    executor: flags.executor?.[0] as NodeOpts['executor'],
    model: flags.model?.[0],
    provider: flags.provider?.[0],
    tier: flags.tier?.[0],
    timeoutMs: num(flags.timeout?.[0]),
    retries: num(flags.retries?.[0]),
    returnMode: flags['return-mode']?.[0] as NodeOpts['returnMode'],
    schema: flags.schema?.[0],
    skill: flags.skill?.[0],
    agentType: flags['agent-type']?.[0],
    promptFile: flags['prompt-file']?.[0],
    checks: (flags.check ?? []).map(parseCheck),
    onFail: flags['on-fail']?.[0] as NodeOpts['onFail'],
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
