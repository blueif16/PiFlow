// pi-runner hook-op engine — DRIVER-PROJECT (the POST/DERIVE family: copy | assemble | merge | union).
//
// PHASE-1 PORT (sdk-convergence): driverProject + applyProjectionOp + runProjection, ported verbatim
// from run.mjs. State change: the run.mjs globals (RUN_CWD / ROOT) used for schema/map/source path
// resolution are passed in as `ctx = { runCwd, root, here }`; projectBase was ALREADY an explicit param
// in run.mjs (callers pass PROJECT_BASE || RUN_CWD). The projection OPS are generic JSON transforms
// declared as DATA in the registry genre record's `projections`.

import fs from "node:fs";
import path from "node:path";
import { ensureDir, projJson, drillPath, assetDefaultPath } from "./markers.mjs";
import { resolveSeedTokens } from "./seed.mjs";
import { loadSchemaValidatorFactory } from "./schema.mjs";

// DRIVER-PROJECT: <source> => genre:<token> @ <mapRef>. Returns null when no marker; else
// { source, mapRef, genreToken } (token resolved). ctx is needed only because the genreToken may carry
// a {jsonfile:field} seed token resolved vs ctx.runCwd.
export function driverProject(prompt, ctx) {
  const m = /(?:^|\n)[ \t]*DRIVER-PROJECT:[ \t]*(\S+)[ \t]*=>[ \t]*genre:(\S+)[ \t]*@[ \t]*(\S+)[ \t]*(?=\n|$)/.exec(prompt || "");
  if (!m) return null;
  return { source: m[1], genreToken: resolveSeedTokens(m[2], ctx), mapRef: m[3] };
}

// Apply ONE generic projection op against the source JSON (`spec`). Returns { to, op, wrote, skipped? }.
// Op kinds: copy | assemble | merge | union (full semantics documented in run.mjs).
export async function applyProjectionOp(name, opSpec, spec, projectBase, ctx) {
  const toRel = opSpec.to;
  const toAbs = path.isAbsolute(toRel) ? toRel : path.join(projectBase, toRel);
  ensureDir(path.dirname(toAbs));

  if (typeof opSpec.copy === "string") {
    const subtree = drillPath(spec, opSpec.copy);
    if (subtree === undefined) return { to: toRel, op: "copy", wrote: false, skipped: `source path "${opSpec.copy}" not found` };
    fs.writeFileSync(toAbs, projJson(subtree));
    return { to: toRel, op: "copy", wrote: true };
  }

  if (opSpec.assemble && typeof opSpec.assemble === "object") {
    const { spread, fields = {} } = opSpec.assemble;
    // POST-hook authority semantics: START from the model's on-disk file (preserving its woven @entity:
    // fields), then overwrite ONLY the deterministic fields. If the file is absent, start from the spread
    // skeleton alone.
    let onDisk = {};
    try { onDisk = JSON.parse(fs.readFileSync(toAbs, "utf8")); } catch {}
    if (!onDisk || typeof onDisk !== "object" || Array.isArray(onDisk)) onDisk = {};
    const base = spread ? drillPath(spec, spread) : undefined;
    const det = {};                                                          // the deterministic fields the driver owns
    const entityKeys = new Set();                                            // the @entity: keys the model owns
    const dropKeys = new Set();                                              // deterministic keys whose source is ABSENT → delete the seed
    for (const [outKey, fieldSpec] of Object.entries(fields)) {
      if (typeof fieldSpec === "string" && fieldSpec.startsWith("@entity:")) { entityKeys.add(outKey); continue; }
      if (typeof fieldSpec === "string") {                                    // "<dotted.path>" → verbatim pull
        const v = drillPath(spec, fieldSpec);
        if (v !== undefined) det[outKey] = v; else dropKeys.add(outKey);      // absent source ⇒ the blueprint provides no value: DROP
      } else if (fieldSpec && typeof fieldSpec === "object" && "value" in fieldSpec) {
        det[outKey] = fieldSpec.value;                                        // {value:v} → a constant literal
      } else if (fieldSpec && typeof fieldSpec === "object" && "from" in fieldSpec) {
        const v = drillPath(spec, fieldSpec.from);                            // {from:"<path>", default:v} → pull w/ fallback
        if (v !== undefined) det[outKey] = v;
        else if ("default" in fieldSpec) det[outKey] = fieldSpec.default;
        else dropKeys.add(outKey);                                            // absent source, no default ⇒ DROP (no seed leak)
      }
    }
    // The deterministic geometry the spread contributes = its keys MINUS the model-owned @entity: keys.
    const spreadDet = {};
    if (base && typeof base === "object" && !Array.isArray(base)) for (const k of Object.keys(base)) if (!entityKeys.has(k)) spreadDet[k] = base[k];
    const out = { ...onDisk, ...spreadDet, ...det };
    // DETERMINISTIC ABSENCE: a deterministic (non-@entity:) field the map declares but whose blueprint SOURCE is
    // absent (no value, no default) is NOT a model weave — the blueprint genuinely provides no value, so the key
    // must NOT exist. DELETE it from the on-disk seed so the output key set is a pure function of the blueprint
    // (a no-op/lazy model can no longer leak a template placeholder, e.g. a paddle_ball brickGrid never specified).
    // @entity: keys are untouched (model-owned).
    for (const k of dropKeys) delete out[k];
    fs.writeFileSync(toAbs, projJson(out));
    return { to: toRel, op: "assemble", wrote: true, ...(entityKeys.size ? { modelOwns: [...entityKeys] } : {}) };
  }

  if (opSpec.merge && typeof opSpec.merge === "object") {
    const { wrapInto, from, literals = {} } = opSpec.merge;
    // Start from the SEEDED target already on disk (the template-default file DRIVER-SEED staged); fall
    // back to an empty object only if absent.
    let target = {};
    try { target = JSON.parse(fs.readFileSync(toAbs, "utf8")); } catch {}
    const group = (target[wrapInto] && typeof target[wrapInto] === "object") ? target[wrapInto] : (target[wrapInto] = {});
    const src = (spec[from] && typeof spec[from] === "object") ? spec[from] : {};
    // Overwrite the .value of each src key that ALREADY has a home in the template group.
    for (const k of Object.keys(src)) {
      if (group[k] && typeof group[k] === "object" && "value" in group[k]) group[k].value = src[k];
    }
    // Set each literal at the TOP level from a dotted spec path; absent → "". COALESCE form: an ARRAY of
    // dotted paths → first present wins, all absent → "".
    for (const [key, spec_path] of Object.entries(literals)) {
      const paths = Array.isArray(spec_path) ? spec_path : [spec_path];
      let v;
      for (const p of paths) { const got = drillPath(spec, p); if (got !== undefined) { v = got; break; } }
      target[key] = v === undefined ? "" : v;
    }
    fs.writeFileSync(toAbs, projJson(target));
    return { to: toRel, op: "merge", wrote: true };
  }

  if (Array.isArray(opSpec.union)) {
    const constRow = opSpec.row || {};
    const rows = [];
    const seen = new Set();
    for (const ref of opSpec.union) {
      const mEnt = /^(.+?)\[\]\.(.+)$/.exec(ref); // "entities[].assetSlot" → collect each entity's assetSlot
      if (mEnt) {
        const arr = drillPath(spec, mEnt[1]);
        if (Array.isArray(arr)) for (const ent of arr) {
          const slot = ent && ent[mEnt[2]];
          if (!slot || seen.has(slot)) continue;
          seen.add(slot);
          const type = ent.type || "sprite";
          rows.push({ slot, type, path: assetDefaultPath(slot, type), width: ent.width || 32, height: ent.height || 32, ...(ent.description ? { description: ent.description } : {}), ...constRow });
        }
      } else {
        const arr = drillPath(spec, ref);
        if (Array.isArray(arr)) for (const e of arr) {
          const slot = e && e.slot;
          if (!slot || seen.has(slot)) continue;
          seen.add(slot);
          const type = e.type || "sprite";
          const r = { slot, type, path: assetDefaultPath(slot, type), width: e.width || 32, height: e.height || 32 };
          if (typeof e.depth === "number") r.depth = e.depth; // 3D model slot: carry the Z extent for the runtime fit-to-box
          if (Array.isArray(e.frames)) r.frames = e.frames;
          if (Array.isArray(e.entityIds)) r.entityIds = e.entityIds;
          if (e.description) r.description = e.description;
          rows.push({ ...r, ...constRow });
        }
      }
    }
    const out = { archetype: drillPath(spec, "meta.archetype"), assetsDir: "public/assets", slots: rows };
    // Best-effort schema validation (degrades like the engine's own schema gate).
    if (opSpec.schema) {
      const factory = await loadSchemaValidatorFactory(ctx);
      if (factory) {
        const schemaAbs = path.isAbsolute(opSpec.schema)
          ? opSpec.schema
          : [path.join(ctx.runCwd, opSpec.schema), path.join(ctx.root, opSpec.schema)].find((c) => { try { return fs.statSync(c).size > 0; } catch { return false; } }) || path.join(ctx.runCwd, opSpec.schema);
        try {
          const validate = factory(JSON.parse(fs.readFileSync(schemaAbs, "utf8")));
          const r = validate(out);
          if (!r.ok) return { to: toRel, op: "union", wrote: false, skipped: `projected slots violate ${path.basename(opSpec.schema)}: ${(r.errors || []).slice(0, 4).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ")}` };
        } catch (e) { console.warn(`    ⚠ DRIVER-PROJECT union: schema "${opSpec.schema}" unreadable/uncompilable — writing without validation (${e.message})`); }
      } else {
        console.warn(`    ⚠ DRIVER-PROJECT union: no draft-2020-12 validator resolved — writing ${toRel} WITHOUT schema validation`);
      }
    }
    fs.writeFileSync(toAbs, projJson(out));
    return { to: toRel, op: "union", wrote: true, rows: rows.length };
  }

  return { to: toRel, op: "unknown", wrote: false, skipped: `no recognized op (copy|merge|union) for "${name}"` };
}

// Run a node's DRIVER-PROJECT map (POST-node). Resolves the genre record in the mapRef by exact id, else by
// the archetype PREFIX of genreToken, reads its `projections` object, and applies each op. Returns a summary;
// a null marker / unreadable map / missing record returns null|skip (graceful degrade — the engine law).
export async function runProjection(proj, projectBase, ctx) {
  if (!proj) return null;
  const mapAbs = path.isAbsolute(proj.mapRef)
    ? proj.mapRef
    : [path.join(ctx.runCwd, proj.mapRef), path.join(ctx.root, proj.mapRef)].find((c) => { try { return fs.statSync(c).size > 0; } catch { return false; } });
  if (!mapAbs) { console.warn(`    ⚠ DRIVER-PROJECT — mapRef "${proj.mapRef}" not found; skipping projection`); return { skipped: `mapRef not found: ${proj.mapRef}` }; }
  let map;
  try { map = JSON.parse(fs.readFileSync(mapAbs, "utf8")); }
  catch (e) { console.warn(`    ⚠ DRIVER-PROJECT — mapRef "${proj.mapRef}" unreadable (${e.message}); skipping`); return { skipped: `mapRef unreadable: ${e.message}` }; }
  // Prefer an exact id match, then fall back to the archetype PREFIX. Record ids are compound
  // "archetype:subgenre" but the genre token is the bare archetype (from classification.json), so a
  // single-genre archetype like paddle_ball needs the prefix fallback or its projection is skipped. Warn +
  // pick-first when a bare archetype maps to multiple subgenres (those need the genre id sourced explicitly).
  const genres = map.genres || [];
  let record = genres.find((g) => g.id === proj.genreToken);
  if (!record) {
    const byPrefix = genres.filter((g) => g.id.split(":")[0] === proj.genreToken);
    if (byPrefix.length > 1) console.warn(`    ⚠ DRIVER-PROJECT — genre token "${proj.genreToken}" is ambiguous: ${byPrefix.map((g) => g.id).join(", ")}; using "${byPrefix[0].id}" (source the genre id to disambiguate)`);
    record = byPrefix[0];
  }
  if (!record) { console.warn(`    ⚠ DRIVER-PROJECT — no genre record "${proj.genreToken}" in ${proj.mapRef}; skipping`); return { skipped: `no genre record: ${proj.genreToken}` }; }
  const projections = record.projections;
  if (!projections || typeof projections !== "object") return { genre: proj.genreToken, ops: [], note: "no projections declared for this genre (inert)" };
  // Read the source JSON ONCE (the frozen spec the projection derives from).
  const srcAbs = path.isAbsolute(proj.source) ? proj.source
    : [path.join(projectBase, proj.source), path.join(ctx.runCwd, proj.source), path.join(ctx.root, proj.source)].find((c) => { try { return fs.statSync(c).size > 0; } catch { return false; } });
  let spec;
  try { spec = JSON.parse(fs.readFileSync(srcAbs, "utf8")); }
  catch (e) { console.warn(`    ⚠ DRIVER-PROJECT — source "${proj.source}" unreadable (${e.message}); skipping`); return { skipped: `source unreadable: ${e.message}` }; }
  const ops = [];
  for (const [name, opSpec] of Object.entries(projections)) {
    try { ops.push(await applyProjectionOp(name, opSpec, spec, projectBase, ctx)); }
    catch (e) { ops.push({ to: opSpec && opSpec.to, op: name, wrote: false, skipped: `error: ${e.message}` }); console.warn(`    ⚠ DRIVER-PROJECT op "${name}" errored: ${e.message}`); }
  }
  return { genre: proj.genreToken, map: proj.mapRef, ops };
}
