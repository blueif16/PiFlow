// ─────────────────────────────────────────────────────────────────────────────
// DRIVER-PROJECT (the POST/DERIVE family) — generic JSON transforms that DERIVE a node's outputs from a
// FROZEN on-disk source. Ported from game-omni pi-runner/hooks/project.mjs; behavior-preserving. The
// destination resolves under the explicit `projectBase` (= the resolved `{{RUN}}`); the SOURCE spec is
// read by the caller (`runProjection`) under the same root.
//
// Every op is a GENERIC, data-driven JSON transform — `copy` (write a drilled subtree), `assemble`
// (spread + deterministic fields), `merge` (.value overwrite + literal coalesce), `union` (dedup-union
// of items into a manifest). NO domain knowledge lives in this code: the field names, defaults, path
// convention, and envelope are all supplied by the op-spec DATA the consumer authors. The `opSpec.schema`
// re-validation the original .mjs ran on the `union` output is DEFERRED to a separate core seam (same
// posture as `merge`) — `union` always writes its rows here; schema validation is not this executor's concern.
// ─────────────────────────────────────────────────────────────────────────────

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ensureDir, projJson, drillPath, absUnder, readJsonSafe } from './util.js';

/** The result of one projection op. `wrote` is the on-disk effect; `skipped` carries the graceful reason. */
export interface ProjectionResult {
  to: string;
  op: string;
  wrote: boolean;
  skipped?: string;
  modelOwns?: string[];
  /** `union` only: the number of deduped rows written. */
  rows?: number;
}

/** A field spec in an `assemble` op: a dotted-path string, an `@entity:` marker, `{value}`, or `{from,default}`. */
type FieldSpec = string | { value: unknown } | { from: string; default?: unknown };

/** The optional computed-path config for a `union` op: derive a per-row `path` from one field of the item. */
interface UnionPathSpec {
  /** The item field whose value selects the dir/ext (e.g. a type discriminator). */
  byField: string;
  /** value → directory segment. */
  dir?: Record<string, string>;
  /** value → file extension. */
  ext?: Record<string, string>;
  /** Fallback directory when the field's value is absent or unmapped. */
  defaultDir: string;
  /** Fallback extension when the field's value is absent or unmapped. */
  defaultExt: string;
}

/** The `union` op-spec: a generic dedup-union of items (drawn from `from` refs) into a manifest envelope. */
interface UnionSpec {
  /** The array refs to union. A `"arr[].f"` ref maps each element's `f` to the key; a plain `"arr"` ref keys each element by `key`. */
  from: string[];
  /** The dedup key field name (default 'slot'). */
  key?: string;
  /** Per-field fallback applied (falsy-coalesced) when an item's field is absent/empty. */
  defaults?: Record<string, unknown>;
  /** Optional computed `path` field; omit ⇒ no `path` field is added. */
  path?: UnionPathSpec;
  /** Field whitelist carried from each item (in this order). Inserted only when present. */
  carry?: string[];
  /** Constant fields merged into every row (last). */
  row?: Record<string, unknown>;
  /** Wrapper fields: a string value DRILLS the source; a `{value}` is a literal. */
  envelope?: Record<string, string | { value: unknown }>;
  /** Where the rows nest in the envelope (default 'items'). */
  itemsKey?: string;
}

/**
 * Apply ONE generic projection op against the source JSON (`spec`), writing under `projectBase`.
 * Op kinds: `copy` (write a drilled subtree) · `assemble` (spread + deterministic fields, @entity-aware,
 * deterministic-absence drop) · `merge` (.value overwrite of seeded group keys + top-level literal coalesce) ·
 * `union` (dedup-union of items into a manifest, all specifics — defaults/path/carry/envelope — in the DATA).
 */
export async function applyProjectionOp(
  name: string,
  opSpec: Record<string, unknown>,
  spec: unknown,
  projectBase: string,
): Promise<ProjectionResult> {
  const toRel = String(opSpec.to);
  const toAbs = absUnder(projectBase, toRel);
  await ensureDir(path.dirname(toAbs));

  // ---- copy: write the drilled subtree verbatim ----
  if (typeof opSpec.copy === 'string') {
    const subtree = drillPath(spec, opSpec.copy);
    if (subtree === undefined)
      return { to: toRel, op: 'copy', wrote: false, skipped: `source path "${opSpec.copy}" not found` };
    await fs.writeFile(toAbs, projJson(subtree));
    return { to: toRel, op: 'copy', wrote: true };
  }

  // ---- assemble: start from the destination's on-disk file (preserving @entity weaves), overwrite only
  // the deterministic fields; a deterministic field whose source is ABSENT is DROPPED (no seed leak) ----
  if (opSpec.assemble && typeof opSpec.assemble === 'object') {
    const { spread, fields = {} } = opSpec.assemble as { spread?: string; fields?: Record<string, FieldSpec> };
    let onDisk: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(await fs.readFile(toAbs, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) onDisk = parsed as Record<string, unknown>;
    } catch {
      /* absent ⇒ start from the spread skeleton alone */
    }
    const base = spread ? drillPath(spec, spread) : undefined;
    const det: Record<string, unknown> = {};
    const entityKeys = new Set<string>();
    const dropKeys = new Set<string>();
    for (const [outKey, fieldSpec] of Object.entries(fields)) {
      if (typeof fieldSpec === 'string' && fieldSpec.startsWith('@entity:')) {
        entityKeys.add(outKey);
        continue;
      }
      if (typeof fieldSpec === 'string') {
        const v = drillPath(spec, fieldSpec);
        if (v !== undefined) det[outKey] = v;
        else dropKeys.add(outKey);
      } else if (fieldSpec && typeof fieldSpec === 'object' && 'value' in fieldSpec) {
        det[outKey] = fieldSpec.value;
      } else if (fieldSpec && typeof fieldSpec === 'object' && 'from' in fieldSpec) {
        const v = drillPath(spec, fieldSpec.from);
        if (v !== undefined) det[outKey] = v;
        else if ('default' in fieldSpec) det[outKey] = fieldSpec.default;
        else dropKeys.add(outKey);
      }
    }
    const spreadDet: Record<string, unknown> = {};
    if (base && typeof base === 'object' && !Array.isArray(base))
      for (const k of Object.keys(base as Record<string, unknown>))
        if (!entityKeys.has(k)) spreadDet[k] = (base as Record<string, unknown>)[k];
    const out: Record<string, unknown> = { ...onDisk, ...spreadDet, ...det };
    for (const k of dropKeys) delete out[k];
    await fs.writeFile(toAbs, projJson(out));
    return {
      to: toRel,
      op: 'assemble',
      wrote: true,
      ...(entityKeys.size ? { modelOwns: [...entityKeys] } : {}),
    };
  }

  // ---- merge: overwrite .value of seeded group keys + set top-level literals (coalesce; absent→"") ----
  if (opSpec.merge && typeof opSpec.merge === 'object') {
    const { wrapInto, from, literals = {} } = opSpec.merge as {
      wrapInto: string;
      from: string;
      literals?: Record<string, string | string[]>;
    };
    let target: Record<string, unknown> = {};
    try {
      target = JSON.parse(await fs.readFile(toAbs, 'utf8'));
    } catch {
      /* absent ⇒ empty target */
    }
    const group =
      target[wrapInto] && typeof target[wrapInto] === 'object'
        ? (target[wrapInto] as Record<string, unknown>)
        : ((target[wrapInto] = {}) as Record<string, unknown>);
    const specObj = spec as Record<string, unknown>;
    const src = specObj[from] && typeof specObj[from] === 'object' ? (specObj[from] as Record<string, unknown>) : {};
    for (const k of Object.keys(src)) {
      const cell = group[k];
      if (cell && typeof cell === 'object' && 'value' in cell) (cell as Record<string, unknown>).value = src[k];
    }
    for (const [key, specPath] of Object.entries(literals)) {
      const paths = Array.isArray(specPath) ? specPath : [specPath];
      let v: unknown;
      for (const p of paths) {
        const got = drillPath(spec, p);
        if (got !== undefined) {
          v = got;
          break;
        }
      }
      target[key] = v === undefined ? '' : v;
    }
    await fs.writeFile(toAbs, projJson(target));
    return { to: toRel, op: 'merge', wrote: true };
  }

  // ---- union: a GENERIC dedup-union of items into a manifest. Every domain specific (the dedup key, the
  // per-field defaults, the computed-path convention, the carried-field whitelist, the constant row, the
  // wrapper envelope) is supplied by the op-spec DATA — this code carries no field names of its own.
  // A `"arr[].f"` ref maps each element's `f` to the key and carries the element's OTHER fields; a plain
  // `"arr"` ref treats each element as a row keyed by `key`. The FIRST occurrence of a key wins (dedup). ----
  if (opSpec.union && typeof opSpec.union === 'object' && !Array.isArray(opSpec.union)) {
    const u = opSpec.union as unknown as UnionSpec;
    if (!Array.isArray(u.from)) return { to: toRel, op: 'union', wrote: false, skipped: 'union.from must be an array of refs' };
    const keyField = u.key ?? 'slot';
    const carry = u.carry ?? [];
    const defaults = u.defaults ?? {};
    const constRow = (u.row && typeof u.row === 'object' ? u.row : {}) as Record<string, unknown>;
    const itemsKey = u.itemsKey ?? 'items';
    const rows: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    for (const ref of u.from) {
      const mMap = /^(.+?)\[\]\.(.+)$/.exec(ref); // "arr[].f" → key each element by its `f`
      const arrRef = mMap ? mMap[1] : ref;
      const arr = drillPath(spec, arrRef);
      if (!Array.isArray(arr)) continue;
      for (const el of arr as Record<string, unknown>[]) {
        const keyVal = mMap ? (el && (el[mMap[2]] as string)) : (el && (el[keyField] as string));
        if (!keyVal || seen.has(keyVal)) continue;
        seen.add(keyVal);
        const item = (el && typeof el === 'object' ? el : {}) as Record<string, unknown>;
        const r: Record<string, unknown> = { [keyField]: keyVal };
        // Walk the carry whitelist in order. A field with a `defaults` entry is always inserted
        // (falsy-coalesced to its default); a field with no default is inserted only when present.
        // The computed `path` is inserted right after its `path.byField` source field.
        for (const f of carry) {
          const has = Object.prototype.hasOwnProperty.call(defaults, f);
          if (has) r[f] = (item[f] as unknown) || defaults[f];
          else if (item[f] !== undefined) r[f] = item[f];
          if (u.path && f === u.path.byField) {
            const sel = (item[u.path.byField] as string) ?? '';
            const dir = (u.path.dir && u.path.dir[sel]) || u.path.defaultDir;
            const ext = (u.path.ext && u.path.ext[sel]) || u.path.defaultExt;
            r.path = `${dir}/${keyVal}.${ext}`;
          }
        }
        rows.push({ ...r, ...constRow });
      }
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(u.envelope ?? {}))
      out[k] = typeof v === 'string' ? drillPath(spec, v) : (v as { value: unknown }).value;
    out[itemsKey] = rows;
    await fs.writeFile(toAbs, projJson(out));
    return { to: toRel, op: 'union', wrote: true, rows: rows.length };
  }

  return {
    to: toRel,
    op: 'unknown',
    wrote: false,
    skipped: `no recognized op (copy|assemble|merge|union) for "${name}"`,
  };
}

/** A resolved DRIVER-PROJECT marker: the source spec, the record key, and the registry index to look it up in. */
export interface ProjectionMarker {
  source: string;
  key: string;
  mapRef: string;
}

/** The summary `runProjection` returns: either a graceful skip, or the resolved record key + the per-op results. */
export interface ProjectionSummary {
  skipped?: string;
  key?: string;
  map?: string;
  ops?: ProjectionResult[];
  note?: string;
}

/**
 * Run a node's DRIVER-PROJECT map: resolve the registry record in `mapRef` whose `id` matches `key`, read
 * its `projections`, read the source spec ONCE, and apply each op. Resolution: prefer an EXACT `id === key`,
 * else the FIRST record whose namespace prefix `id.split(':')[0]` equals `key` — i.e. a bare key `k` also
 * matches a namespaced record id `k:<suffix>`; multi-match picks the first. Every failure degrades to a
 * graceful skip — never throws.
 */
export async function runProjection(
  proj: ProjectionMarker | null,
  projectBase: string,
): Promise<ProjectionSummary | null> {
  if (!proj) return null;
  const mapAbs = absUnder(projectBase, proj.mapRef);
  type RegistryRecord = { id: string; projections?: Record<string, Record<string, unknown>> };
  const map = (await readJsonSafe(mapAbs)) as Record<string, unknown> | undefined;
  if (!map || typeof map !== 'object') return { skipped: `mapRef unreadable: ${proj.mapRef}` };
  // The registry index holds its records under the FIRST top-level property that is an array of
  // id-bearing objects — so core reads the record list WITHOUT knowing the consumer's array key name.
  const records =
    (Object.values(map).find(
      (v): v is RegistryRecord[] =>
        Array.isArray(v) && v.length > 0 && v.every((e) => e && typeof e === 'object' && typeof (e as RegistryRecord).id === 'string'),
    ) as RegistryRecord[] | undefined) ?? [];
  // Prefer an exact id match, then the namespace PREFIX (record ids may be compound "<key>:<suffix>" but
  // the lookup key is the bare prefix). Multi-match on the prefix → pick the first.
  let record = records.find((g) => g.id === proj.key);
  if (!record) {
    const byPrefix = records.filter((g) => g.id.split(':')[0] === proj.key);
    record = byPrefix[0];
  }
  if (!record) return { skipped: `no registry record: ${proj.key}` };
  const projections = record.projections;
  if (!projections || typeof projections !== 'object')
    return { key: proj.key, ops: [], note: 'no projections declared for this record (inert)' };
  // Read the source JSON ONCE (the frozen spec the projection derives from).
  const spec = await readJsonSafe(absUnder(projectBase, proj.source));
  if (spec === undefined) return { skipped: `source unreadable: ${proj.source}` };
  const ops: ProjectionResult[] = [];
  for (const [name, opSpec] of Object.entries(projections)) {
    try {
      ops.push(await applyProjectionOp(name, opSpec, spec, projectBase));
    } catch (e) {
      ops.push({ to: String((opSpec as Record<string, unknown>)?.to), op: name, wrote: false, skipped: `error: ${(e as Error).message}` });
    }
  }
  return { key: proj.key, map: proj.mapRef, ops };
}
