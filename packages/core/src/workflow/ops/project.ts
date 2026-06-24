// ─────────────────────────────────────────────────────────────────────────────
// DRIVER-PROJECT (the POST/DERIVE family) — generic JSON transforms that DERIVE a node's outputs from a
// FROZEN on-disk source. Ported from game-omni pi-runner/hooks/project.mjs; behavior-preserving for the
// GENERIC ops (copy | assemble | merge). The state change: the run.mjs RUN_CWD/ROOT fallback chain is
// retired — the destination resolves under the explicit `projectBase` (= the resolved `{{RUN}}`), and the
// SOURCE spec is read by the caller (runProjection) under the same root.
//
// SCOPE NOTE (flagged): the `union` op (asset-slot manifest builder — assetDefaultPath, entities[].assetSlot
// dedup) is ported here too; it is the generic index.json transform consumed via a genre record's `projections`
// DATA. The `opSpec.schema` ajv re-validation that the game-omni .mjs ran on the union output is DEFERRED to a
// separate core seam (same posture as merge) — `union` always writes its rows here; schema validation is not
// the projection executor's concern.
// ─────────────────────────────────────────────────────────────────────────────

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ensureDir, projJson, drillPath, absUnder, readJsonSafe } from './util.js';

// ---- asset-slot path convention (local; NOT a util.ts concern — it is the union op's own data) ----
const ASSET_DIR_BY_TYPE: Record<string, string> = {
  sprite: 'sprites',
  animation: 'sprites',
  image: 'images',
  tileset: 'tiles',
  background: 'backgrounds',
  audio: 'audio',
  model: 'models',
};
const ASSET_EXT_BY_TYPE: Record<string, string> = { audio: 'mp3', model: 'glb' };
/** The conventional `<dir>/<slot>.<ext>` path the runtime Preloader reads for a slot of `type`. */
function assetDefaultPath(slot: string, type: string): string {
  const dir = ASSET_DIR_BY_TYPE[type] || 'sprites';
  const ext = ASSET_EXT_BY_TYPE[type] || 'png';
  return `${dir}/${slot}.${ext}`;
}

/** The result of one projection op. `wrote` is the on-disk effect; `skipped` carries the graceful reason. */
export interface ProjectionResult {
  to: string;
  op: string;
  wrote: boolean;
  skipped?: string;
  modelOwns?: string[];
  /** `union` only: the number of deduped slot rows written. */
  rows?: number;
}

/** A field spec in an `assemble` op: a dotted-path string, an `@entity:` marker, `{value}`, or `{from,default}`. */
type FieldSpec = string | { value: unknown } | { from: string; default?: unknown };

/**
 * Apply ONE generic projection op against the source JSON (`spec`), writing under `projectBase`.
 * Op kinds: `copy` (write a drilled subtree) · `assemble` (spread + deterministic fields, @entity-aware,
 * deterministic-absence drop) · `merge` (.value overwrite of seeded group keys + top-level literal coalesce).
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

  // ---- assemble: start from the model's on-disk file (preserving @entity weaves), overwrite only the
  // deterministic fields; a deterministic field whose source is ABSENT is DROPPED (no seed leak) ----
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

  // ---- union: build the asset-slot manifest (index.json) — dedup slots across the union refs, default
  // each row's path/width/height, carry optional depth/frames/entityIds/description, append the const row ----
  if (Array.isArray(opSpec.union)) {
    const constRow = (opSpec.row && typeof opSpec.row === 'object' ? opSpec.row : {}) as Record<string, unknown>;
    const rows: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    for (const ref of opSpec.union as string[]) {
      const mEnt = /^(.+?)\[\]\.(.+)$/.exec(ref); // "entities[].assetSlot" → collect each entity's assetSlot
      if (mEnt) {
        const arr = drillPath(spec, mEnt[1]);
        if (Array.isArray(arr))
          for (const ent of arr as Record<string, unknown>[]) {
            const slot = ent && (ent[mEnt[2]] as string);
            if (!slot || seen.has(slot)) continue;
            seen.add(slot);
            const type = (ent.type as string) || 'sprite';
            rows.push({
              slot,
              type,
              path: assetDefaultPath(slot, type),
              width: (ent.width as number) || 32,
              height: (ent.height as number) || 32,
              ...(ent.description ? { description: ent.description } : {}),
              ...constRow,
            });
          }
      } else {
        const arr = drillPath(spec, ref);
        if (Array.isArray(arr))
          for (const e of arr as Record<string, unknown>[]) {
            const slot = e && (e.slot as string);
            if (!slot || seen.has(slot)) continue;
            seen.add(slot);
            const type = (e.type as string) || 'sprite';
            const r: Record<string, unknown> = {
              slot,
              type,
              path: assetDefaultPath(slot, type),
              width: (e.width as number) || 32,
              height: (e.height as number) || 32,
            };
            if (typeof e.depth === 'number') r.depth = e.depth; // 3D model slot: carry the Z extent
            if (Array.isArray(e.frames)) r.frames = e.frames;
            if (Array.isArray(e.entityIds)) r.entityIds = e.entityIds;
            if (e.description) r.description = e.description;
            rows.push({ ...r, ...constRow });
          }
      }
    }
    const out = { archetype: drillPath(spec, 'meta.archetype'), assetsDir: 'public/assets', slots: rows };
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

/** A resolved DRIVER-PROJECT marker: the source spec, the genre token, and the genre map to look it up in. */
export interface ProjectionMarker {
  source: string;
  genreToken: string;
  mapRef: string;
}

/** The summary `runProjection` returns: either a graceful skip, or the resolved genre + the per-op results. */
export interface ProjectionSummary {
  skipped?: string;
  genre?: string;
  map?: string;
  ops?: ProjectionResult[];
  note?: string;
}

/**
 * Run a node's DRIVER-PROJECT map: resolve the genre record in `mapRef` (exact `id` match, else the FIRST whose
 * archetype prefix `id.split(':')[0]` equals the token — multi-match picks first), read its `projections`, read
 * the source spec ONCE, and apply each op. Every failure degrades to a graceful skip — never throws.
 */
export async function runProjection(
  proj: ProjectionMarker | null,
  projectBase: string,
): Promise<ProjectionSummary | null> {
  if (!proj) return null;
  const mapAbs = absUnder(projectBase, proj.mapRef);
  const map = (await readJsonSafe(mapAbs)) as { genres?: { id: string; projections?: Record<string, Record<string, unknown>> }[] } | undefined;
  if (!map) return { skipped: `mapRef unreadable: ${proj.mapRef}` };
  // Prefer an exact id match, then the archetype PREFIX (record ids are compound "archetype:subgenre" but
  // the token is the bare archetype). Multi-match on the prefix → pick the first.
  const genres = map.genres || [];
  let record = genres.find((g) => g.id === proj.genreToken);
  if (!record) {
    const byPrefix = genres.filter((g) => g.id.split(':')[0] === proj.genreToken);
    record = byPrefix[0];
  }
  if (!record) return { skipped: `no genre record: ${proj.genreToken}` };
  const projections = record.projections;
  if (!projections || typeof projections !== 'object')
    return { genre: proj.genreToken, ops: [], note: 'no projections declared for this genre (inert)' };
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
  return { genre: proj.genreToken, map: proj.mapRef, ops };
}
