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
  /** Per-node external MCP servers (loader REJECTS a literal secret — use $VAR refs in values). */
  mcp?: McpServers;
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
  const node: Record<string, unknown> = {
    id: opts.id,
    phase: opts.phase ?? opts.id,
    deps: opts.deps ?? [],
  };
  // PROSE pointer — omitted on a programmatic (no-pi) node, which the schema's allOf permits.
  if (!opts.programmatic) {
    node.prompt = { file: opts.promptFile ?? 'prompt.md', ...(opts.skill ? { skill: opts.skill } : {}) };
  }
  if (opts.tools?.length || opts.deny?.length) {
    node.tools = {
      ...(opts.tools?.length ? { allow: opts.tools } : {}),
      ...(opts.deny?.length ? { deny: opts.deny } : {}),
    };
  }
  if (opts.mcp && Object.keys(opts.mcp).length) node.mcp = { servers: opts.mcp };
  if (opts.timeoutMs) node.timeoutMs = opts.timeoutMs;
  if (opts.retries) node.retries = opts.retries;
  if (opts.model) node.model = opts.model;
  if (opts.provider) node.provider = opts.provider;
  if (opts.tier) node.tier = opts.tier;
  if (opts.inject?.length) node.inject = opts.inject;
  node.contract = {
    artifacts: opts.artifacts ?? [],
    owns: opts.owns ?? ['out/**'],
    readScope: opts.readScope ?? ['{{RUN}}'],
    ...(opts.schema ? { schema: opts.schema } : {}),
    ...(opts.returnMode ? { returnMode: opts.returnMode } : {}),
  };
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

const NEW_USAGE =
  'piflowctl new <templateDir> [--id <id>] [--name <n>] [--description <d>] [--phase <p>]...';
const ADD_USAGE =
  'piflowctl add-node <templateDir> --id <id> [--phase <p>] [--dep <id>]... [--artifact <p>]... ' +
  '[--owns <glob>]... [--read <p>]... [--tool <t>]... [--deny <t>]... [--inject <p>]... ' +
  '[--mcp <name=url>]... [--check <kind[:path]>]... [--model <m>] [--provider <g>] [--tier <t>] ' +
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
    mcp: parseMcp(flags.mcp),
    model: flags.model?.[0],
    provider: flags.provider?.[0],
    tier: flags.tier?.[0],
    timeoutMs: num(flags.timeout?.[0]),
    retries: num(flags.retries?.[0]),
    returnMode: flags['return-mode']?.[0] as NodeOpts['returnMode'],
    schema: flags.schema?.[0],
    skill: flags.skill?.[0],
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
  process.stdout.write(`wrote ${nodeJson}\n${next}\n`);
}
