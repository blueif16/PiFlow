// The §8 static-check suite — the fail-closed referential gate (template-format.md §8). PURE over the
// loaded node set + the schema validator: every function returns the list of VIOLATION strings (empty =
// clean). The loader collects them and, if any, throws a `TemplateError`. Detection lives here;
// throwing (the consequence) lives in the loader, so each check stays independently testable.
//
// These are exactly the cross-node/referential checks the T1 JSON Schema CANNOT see (it validates one
// file's shape, never the SET) — the "Deferred to T2" gate from the handoff. Schema validity itself is
// check (1); the rest are graph-level.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SchemaValidator } from '../../runner/schema.js';
import type { LoadedNode } from './types.js';
import { isRunRooted, runRelative, stateChannels } from './tokens.js';

/** (1) SCHEMA: every node.json + meta.json validates against the T1 schemas (the one ajv). */
export function checkSchemas(
  meta: unknown,
  nodes: { id: string; raw: unknown }[],
  validate: SchemaValidator,
  metaSchema: object,
  nodeSchema: object,
): string[] {
  const errs: string[] = [];
  const m = validate(metaSchema, meta);
  if (!m.ok) errs.push(`schema: meta.json invalid — ${m.errors.join('; ') || 'does not match metaSchema'}`);
  for (const n of nodes) {
    const r = validate(nodeSchema, n.raw);
    if (!r.ok) errs.push(`schema: node "${n.id}" invalid — ${r.errors.join('; ') || 'does not match nodeSchema'}`);
  }
  return errs;
}

/** (2) DANGLING DEP: every `dep` resolves to a discovered node. */
export function checkDeps(nodes: LoadedNode[]): string[] {
  const ids = new Set(nodes.map((n) => n.def.id));
  const errs: string[] = [];
  for (const n of nodes) {
    for (const d of n.def.deps) {
      if (!ids.has(d)) errs.push(`dangling dep: node "${n.def.id}" depends on "${d}", which is not a discovered node`);
    }
  }
  return errs;
}

/** (3) CYCLES: the deps graph is a DAG (no cycle). Reports the nodes left in the cycle. */
export function checkCycles(nodes: LoadedNode[]): string[] {
  const ids = nodes.map((n) => n.def.id);
  const idSet = new Set(ids);
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  const adj = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const n of nodes) {
    for (const d of n.def.deps) {
      if (!idSet.has(d)) continue; // dangling dep is check (2)'s job; don't double-count here
      adj.get(d)!.push(n.def.id);
      indeg.set(n.def.id, (indeg.get(n.def.id) ?? 0) + 1);
    }
  }
  let frontier = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  let processed = 0;
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      processed++;
      for (const m of adj.get(id) ?? []) {
        indeg.set(m, (indeg.get(m) ?? 0) - 1);
        if ((indeg.get(m) ?? 0) === 0) next.push(m);
      }
    }
    frontier = next;
  }
  if (processed < ids.length) {
    const stuck = ids.filter((id) => (indeg.get(id) ?? 0) > 0);
    return [`cycle detected in deps among: ${stuck.join(', ')}`];
  }
  return [];
}

/**
 * Topological LEVELS over the deps graph (assumes acyclic — call after checkCycles). Same algorithm the
 * runtime `stagesOf` uses, so the loader's stages and `compile`'s stages agree. Returns level→ids.
 */
export function topoLevels(nodes: LoadedNode[]): Map<number, string[]> {
  const ids = nodes.map((n) => n.def.id);
  const idSet = new Set(ids);
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  const adj = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const n of nodes) {
    for (const d of n.def.deps) {
      if (!idSet.has(d)) continue;
      adj.get(d)!.push(n.def.id);
      indeg.set(n.def.id, (indeg.get(n.def.id) ?? 0) + 1);
    }
  }
  const level = new Map<string, number>();
  let frontier = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  let lvl = 0;
  while (frontier.length) {
    for (const id of frontier) level.set(id, lvl);
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
  const byLevel = new Map<number, string[]>();
  for (const id of ids) {
    const l = level.get(id);
    if (l === undefined) continue;
    (byLevel.get(l) ?? byLevel.set(l, []).get(l)!).push(id);
  }
  return byLevel;
}

/** Two owns-globs collide if either is a prefix of the other once the trailing `/**` glob is stripped. */
function ownsOverlap(a: string, b: string): boolean {
  const norm = (g: string): string => g.replace(/\/?\*+$/, '').replace(/\/+$/, '');
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  return na.startsWith(nb + '/') || nb.startsWith(na + '/');
}

/** (4) PARALLEL LANES write-disjoint: same-topological-level nodes must not share owns authority. */
export function checkParallelOwns(nodes: LoadedNode[]): string[] {
  const byId = new Map(nodes.map((n) => [n.def.id, n]));
  const errs: string[] = [];
  for (const ids of topoLevels(nodes).values()) {
    if (ids.length < 2) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = byId.get(ids[i])!;
        const b = byId.get(ids[j])!;
        for (const oa of a.def.contract?.owns ?? []) {
          for (const ob of b.def.contract?.owns ?? []) {
            if (ownsOverlap(oa, ob)) {
              errs.push(
                `parallel lane owns overlap: "${a.def.id}" (owns "${oa}") and "${b.def.id}" (owns "${ob}") ` +
                  `are the same topological level but share write authority`,
              );
            }
          }
        }
      }
    }
  }
  return errs;
}

/** Transitive upstream node ids of `id` (its deps' closure). */
function upstreamOf(id: string, byId: Map<string, LoadedNode>): Set<string> {
  const seen = new Set<string>();
  const stack = [...(byId.get(id)?.def.deps ?? [])];
  while (stack.length) {
    const d = stack.pop()!;
    if (seen.has(d)) continue;
    seen.add(d);
    for (const dd of byId.get(d)?.def.deps ?? []) stack.push(dd);
  }
  return seen;
}

/**
 * (5) DANGLING CHANNEL: every `{{state.<channel>}}` a node CONSUMES (in readScope / seed.from / prompt
 * prose) must be `promote`d by some UPSTREAM node. State drives values; a consumed channel no upstream
 * produced is a hole (the run would resolve it to nothing).
 */
export function checkChannels(nodes: LoadedNode[]): string[] {
  const byId = new Map(nodes.map((n) => [n.def.id, n]));
  const errs: string[] = [];
  for (const n of nodes) {
    // Collect channels this node consumes across its token-bearing surfaces.
    const consumed = new Set<string>();
    for (const r of n.def.contract?.readScope ?? []) stateChannels(r).forEach((c) => consumed.add(c));
    for (const s of n.def.hooks?.seed ?? []) stateChannels(s.from).forEach((c) => consumed.add(c));
    for (const c of stateChannels(n.prose)) consumed.add(c);
    if (!consumed.size) continue;
    const upstream = upstreamOf(n.def.id, byId);
    // The channels any upstream node promotes.
    const available = new Set<string>();
    for (const up of upstream) {
      for (const p of byId.get(up)?.def.hooks?.promote ?? []) available.add(p.to);
    }
    for (const ch of consumed) {
      if (!available.has(ch)) {
        errs.push(
          `dangling channel: node "${n.def.id}" consumes {{state.${ch}}} but no upstream node promotes the "${ch}" channel`,
        );
      }
    }
  }
  return errs;
}

/**
 * (6) DANGLING PRODUCER/CONSUMER: a RUN-relative artifact a node READS (its `inject` set) that IS
 * produced SOMEWHERE in the graph must be produced by an UPSTREAM node — else it is an ordering bug (a
 * consumer can't see a non-ancestor's output). An artifact produced by NO node is a RAW INPUT (like
 * `externalInputs`), not a dangle — so a root's user-supplied `{{RUN}}/spec/request.json` is fine. This
 * mirrors `inferEdges`' "missing producer ⇒ allowed iff declared external" rule. Scoped to {{RUN}}-rooted
 * reads — {{WORKSPACE}} canonical reads (skills/registry/modules) are deferred tokens, never routed.
 */
export function checkProducers(nodes: LoadedNode[]): string[] {
  const byId = new Map(nodes.map((n) => [n.def.id, n]));
  // Every run-relative artifact ANY node produces → the set of producing node ids.
  const producersOf = new Map<string, Set<string>>();
  for (const n of nodes) {
    for (const a of n.def.contract?.artifacts ?? []) {
      const rel = runRelative(a);
      if (!rel) continue;
      (producersOf.get(rel) ?? producersOf.set(rel, new Set()).get(rel)!).add(n.def.id);
    }
  }
  const errs: string[] = [];
  for (const n of nodes) {
    const upstream = upstreamOf(n.def.id, byId);
    for (const injected of n.def.inject ?? []) {
      if (!isRunRooted(injected)) continue; // only {{RUN}}-relative reads are routed
      const rel = runRelative(injected);
      if (!rel) continue;
      const producers = producersOf.get(rel);
      if (!producers || !producers.size) continue; // produced by nobody ⇒ a raw input, not a dangle
      const upstreamProducer = [...producers].some((p) => upstream.has(p));
      if (!upstreamProducer) {
        errs.push(
          `dangling producer/consumer: node "${n.def.id}" reads "${rel}", produced by ` +
            `[${[...producers].join(', ')}] — none of which is upstream of "${n.def.id}"`,
        );
      }
    }
  }
  return errs;
}

/**
 * (7) DANGLING REF: every node-folder-relative path the node names must exist on disk — `prompt.file`
 * and any `scripts/` path it references. `{{WORKSPACE}}`-rooted refs (prompt.skill / mcp.ref) are
 * DEFERRED canonical reads resolved at run time per provider, so they are NOT existence-checked here
 * (no workspace root is bound at load time) — scoped to what travels WITH the node folder.
 */
export async function checkRefs(nodes: LoadedNode[]): Promise<string[]> {
  const errs: string[] = [];
  for (const n of nodes) {
    // A PROGRAMMATIC node spawns no `pi`, so it carries no `prompt` block (no prompt file to exist-check).
    const refs: string[] = n.def.prompt?.file ? [n.def.prompt.file] : [];
    // Any string field that points into the node's own scripts/ folder is a per-node ref that ships
    // with the copy (§2) and must exist. Conservatively scan hook/check paths under "scripts/".
    const scriptish: (string | undefined)[] = [];
    for (const c of [...(n.def.checks?.pre ?? []), ...(n.def.checks?.post ?? [])]) scriptish.push(c.path);
    for (const s of scriptish) if (s && s.startsWith('scripts/')) refs.push(s);
    for (const ref of refs) {
      const abs = path.join(n.dir, ref);
      try {
        await fs.stat(abs);
      } catch {
        errs.push(`dangling ref: node "${n.def.id}" references "${ref}", which does not exist at ${abs}`);
      }
    }
  }
  return errs;
}

// ── (#3) MCP literal-secret guard ───────────────────────────────────────────────────────────────────
// `node.json.mcp.servers` is committed to the repo, so a secret-bearing value MUST be a `$VAR`/`${VAR}`
// env REFERENCE (the runner forwards only that declared allowlist through SecretResolver — design §4),
// never a literal credential. A literal on disk is a leak; we reject it loudly at author time.
//
// #14 (DEFERRED, out of core): the runner stages this `$VAR`-bearing config VERBATIM + injects the resolved
// env vars; the actual `$VAR`→value EXPANSION is a one-line follow-on in `@piflow/tool-bridge` (a different
// package), not here. #14 stays DEFERRED — tracked there, never counted as closed by this milestone.

/** Keys whose VALUES are secret-bearing in MCP server config: the auth-header map + named-credential fields. */
const SECRET_KEYS = new Set([
  'headers',
  'authorization',
  'token',
  'apikey',
  'api_key',
  'password',
  'secret',
  'credential',
  'credentials',
  'bearer',
]);

/** The same `$VAR`/`${VAR}` vocabulary the runner resolves (runner.ts referencedEnvVars). */
const ENV_REF = /\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*/;

/** A string value is a LITERAL secret iff it is non-empty and contains NO `$VAR`/`${VAR}` reference. */
function isLiteralSecretValue(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0 && !ENV_REF.test(v);
}

/**
 * Walk a server-config sub-tree; once `underSecret` is true (we are inside a secret-bearing key's value),
 * every leaf string with no `$VAR` ref is a violation. Re-arms `underSecret` whenever a secret-named key
 * is entered. Returns the dotted paths of every literal-secret leaf found.
 */
function findLiteralSecrets(v: unknown, pathParts: string[], underSecret: boolean): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => findLiteralSecrets(x, [...pathParts, String(i)], underSecret));
  if (v && typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>).flatMap(([k, val]) =>
      findLiteralSecrets(val, [...pathParts, k], underSecret || SECRET_KEYS.has(k.toLowerCase())),
    );
  }
  return underSecret && isLiteralSecretValue(v) ? [pathParts.join('.')] : [];
}

/**
 * (8) MCP LITERAL-SECRET: every secret-bearing value in a node's `mcp.servers` must be a `$VAR`/`${VAR}`
 * env reference, never a literal. A literal credential committed to a header/token field is rejected
 * (it would leak the secret onto disk). Scans only the secret-bearing keys — a plain `url`/`transport`
 * is untouched. Per-server so the message names the offending server (and node) for a fast fix.
 */
export function checkMcpSecrets(nodes: LoadedNode[]): string[] {
  const errs: string[] = [];
  for (const n of nodes) {
    const servers = n.def.mcp?.servers;
    if (!servers || typeof servers !== 'object') continue;
    for (const [srv, cfg] of Object.entries(servers)) {
      for (const leaf of findLiteralSecrets(cfg, [], false)) {
        errs.push(
          `literal secret in mcp.servers: node "${n.def.id}" server "${srv}" carries a LITERAL value at ` +
            `"${leaf}" — secret-bearing fields must use a $VAR/\${VAR} env reference, never a committed literal`,
        );
      }
    }
  }
  return errs;
}
