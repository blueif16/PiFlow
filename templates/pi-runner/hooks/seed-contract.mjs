// pi-runner hook-op engine — DRIVER-SEED-CONTRACT (the per-node SEEDED-CONTRACT projection family).
//
// PHASE-1 PORT (sdk-convergence): driverSeedContract + drillArrayField + coreObservables + gatherEntityIds
// + resolveNodeContract + runSeedContract, ported verbatim from run.mjs. State change: only runSeedContract
// touched run.mjs globals (RUN_CWD / ROOT) for catalog/source path resolution → passed in as `ctx`;
// projectBase was ALREADY an explicit param. The bind-template interpreter (resolveNodeContract & helpers)
// is pure data-interpretation — every concrete value is drilled from `spec`; the catalog supplies the SHAPE.

import fs from "node:fs";
import path from "node:path";
import { projJson, drillPath, dedupSort } from "./markers.mjs";

// base64 line (the contract() encodes {source,catalog,into} so paths with any char ride one marker line).
export function driverSeedContract(prompt) {
  const m = /(?:^|\n)[ \t]*DRIVER-SEED-CONTRACT:[ \t]*([A-Za-z0-9+/=]+)[ \t]*(?=\n|$)/.exec(prompt || "");
  if (!m) return null;
  try { const o = JSON.parse(Buffer.from(m[1], "base64").toString("utf8")); return { into: "contracts", ...o }; }
  catch (e) { console.warn(`    ⚠ DRIVER-SEED-CONTRACT — marker payload unreadable (${e.message}); skipping`); return null; }
}

// "a[].b" → collect each element's drilled `b`; a plain dotted path with a non-array value → [value]; an
// array value → the array. GENERIC — no field name is hard-coded.
export function drillArrayField(obj, spec) {
  const m = /^(.+?)\[\]\.(.+)$/.exec(spec);
  if (m) {
    const arr = drillPath(obj, m[1]);
    if (!Array.isArray(arr)) return [];
    return arr.map((e) => (e == null ? undefined : drillPath(e, m[2]))).filter((v) => v != null);
  }
  const v = drillPath(obj, spec);
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

// The CORE OBSERVABLE set, computed ONCE per source from the catalog's `observables` palette (base + the
// meta-scalar-gated additions). The ONLY archetype knowledge is DATA in the catalog. Returns a deduped
// (insertion-order) array.
export function coreObservables(spec, palette) {
  if (!palette || typeof palette !== "object") return [];
  const out = [...(Array.isArray(palette.base) ? palette.base : [])];
  for (const [scalarPath, rule] of Object.entries(palette.whenScalar || {})) {
    const val = drillPath(spec, scalarPath);
    if (rule && Array.isArray(rule.unless)) { if (!rule.unless.includes(val)) for (const a of (rule.add || [])) out.push(a); }
    else if (rule && rule.map && typeof rule.map === "object") { const mapped = rule.map[val]; if (mapped != null) out.push(mapped); }
  }
  return [...new Set(out.map(String))];
}

// Gather the POSITIONED entity ids from a list of dotted paths (each a single object with `.id`, OR an
// array of {id}) — in path order, then array order.
export function gatherEntityIds(spec, paths) {
  const ids = [];
  for (const p of (paths || [])) {
    const v = drillPath(spec, p);
    if (v == null) continue;
    if (Array.isArray(v)) { for (const e of v) if (e && e.id != null) ids.push(String(e.id)); }
    else if (v.id != null) ids.push(String(v.id));
  }
  return ids;
}

// Resolve ONE node-TYPE's catalog entry against the frozen source → its contract object
// { owns, bind, demand, tone, ...scalars }. Pure data-interpretation; the catalog supplies only the SHAPE.
export function resolveNodeContract(spec, entry, palette) {
  const out = {};
  if (Array.isArray(entry.owns)) out.owns = entry.owns.slice();
  // ---- bind: ordered segments → one concatenated handle list ----
  const obs = coreObservables(spec, palette);
  const bind = [];
  for (const seg of (entry.bind && entry.bind.segments) || []) {
    if (seg.kind === "observables") {
      let xs = obs.slice();
      if (typeof seg.with === "string") xs.push(seg.with);
      else if (Array.isArray(seg.with)) xs.push(...seg.with);
      if (seg.sort === "dedup-sort") xs = dedupSort(xs);
      bind.push(...xs);
    } else if (seg.kind === "literals") {
      bind.push(...(seg.values || []));
    } else if (seg.kind === "events") {
      let xs = drillArrayField(spec, seg.from).map(String);
      if (seg.sort === "dedup-sort") xs = dedupSort(xs);
      bind.push(...xs);
    } else if (seg.kind === "anchors") {
      const ids = gatherEntityIds(spec, seg.entityIdsFrom);
      bind.push(...ids.map((i) => `near:${i}`), ...ids.map((i) => `${i}.position`));
    } else if (seg.kind === "tokens") {
      const xs = drillArrayField(spec, seg.from).map(String);
      bind.push(...xs.map((v) => `${seg.prefix}${v}`));
    } else if (seg.kind === "slots") {
      const xs = [];
      for (const f of (seg.from || [])) for (const v of drillArrayField(spec, f)) xs.push(String(v));
      bind.push(...[...new Set(xs)]);
    }
  }
  out.bind = bind;
  // ---- scalars: extra top-level fields copied/derived verbatim (nodeContract is additionalProperties:true) ----
  for (const [field, sc] of Object.entries(entry.scalars || {})) {
    if (sc && Array.isArray(sc.fromEntityIds)) out[field] = gatherEntityIds(spec, sc.fromEntityIds);
    else if (sc && typeof sc.from === "string") { const v = drillPath(spec, sc.from); out[field] = v == null ? (sc.default ?? "") : v; }
  }
  // ---- the templated demand + tone context (generic token grammar; values all drilled from spec) ----
  const scoringModel = drillPath(spec, "meta.scoringModel") ?? "none";
  const failModel = drillPath(spec, "meta.failModel") ?? "none";
  const ctx = {
    coreVerb: drillPath(spec, "meta.coreVerb") ?? "",
    goalId: (drillPath(spec, "layout.goal") || {}).id ?? "",
    firstMilestone: (() => { const ms = drillArrayField(spec, "milestones[].id"); return ms.length ? ms[0] : "M1"; })(),
    slotCount: (() => { let n = 0; for (const seg of (entry.bind && entry.bind.segments) || []) if (seg.kind === "slots") n = out.bind.length; return n; })(),
  };
  const renderDemand = (tmpl) => String(tmpl || "")
    .replace(/\{scoring\?([^:}]*):([^}]*)\}/g, (_, a, b) => (scoringModel !== "none" ? a : b))
    .replace(/\{failResource\}/g, () => (["none", "respawn"].includes(failModel) ? "" : ` + the ${failModel} resource`))
    .replace(/\{gameOver\?\}/g, () => (["none", "respawn"].includes(failModel) ? "out" : ""))
    .replace(/\{(coreVerb|goalId|firstMilestone|slotCount)\}/g, (_, k) => String(ctx[k] ?? ""));
  if (entry.demand && typeof entry.demand.template === "string") out.demand = renderDemand(entry.demand.template);
  // ---- tone: first-present coalesce over dotted paths, with a default ----
  if (entry.tone && Array.isArray(entry.tone.from)) {
    let tone;
    for (const p of entry.tone.from) { const v = drillPath(spec, p); if (v != null && v !== "") { tone = v; break; } }
    out.tone = tone == null ? (entry.tone.default ?? "") : tone;
  }
  return out;
}

// Run a node's DRIVER-SEED-CONTRACT (POST-node): read the drift-gated `catalog` (its `nodes` map of
// bind-templates + the `observables` palette), resolve each node-TYPE against the frozen `source` JSON, and
// write source.<into>.<node> = the resolved contract — then write the source back. Returns a summary; a null
// marker / unreadable catalog|source returns null|skip (graceful degrade — the engine law).
export async function runSeedContract(proj, projectBase, ctx) {
  if (!proj) return null;
  const catalogAbs = path.isAbsolute(proj.catalog)
    ? proj.catalog
    : [path.join(ctx.runCwd, proj.catalog), path.join(ctx.root, proj.catalog)].find((c) => { try { return fs.statSync(c).size > 0; } catch { return false; } });
  if (!catalogAbs) { console.warn(`    ⚠ DRIVER-SEED-CONTRACT — catalog "${proj.catalog}" not found; skipping`); return { skipped: `catalog not found: ${proj.catalog}` }; }
  let catalog;
  try { catalog = JSON.parse(fs.readFileSync(catalogAbs, "utf8")); }
  catch (e) { console.warn(`    ⚠ DRIVER-SEED-CONTRACT — catalog "${proj.catalog}" unreadable (${e.message}); skipping`); return { skipped: `catalog unreadable: ${e.message}` }; }
  if (!catalog || typeof catalog.nodes !== "object") return { skipped: "catalog has no `nodes` map (inert)" };
  const srcAbs = path.isAbsolute(proj.source) ? proj.source
    : [path.join(projectBase, proj.source), path.join(ctx.runCwd, proj.source), path.join(ctx.root, proj.source)].find((c) => { try { return fs.statSync(c).size > 0; } catch { return false; } });
  let spec;
  try { spec = JSON.parse(fs.readFileSync(srcAbs, "utf8")); }
  catch (e) { console.warn(`    ⚠ DRIVER-SEED-CONTRACT — source "${proj.source}" unreadable (${e.message}); skipping`); return { skipped: `source unreadable: ${e.message}` }; }
  const into = proj.into || "contracts";
  if (!spec[into] || typeof spec[into] !== "object" || Array.isArray(spec[into])) spec[into] = {};
  const done = [];
  for (const [node, entry] of Object.entries(catalog.nodes)) {
    if (node.startsWith("$")) continue; // skip $comment-style keys
    try { spec[into][node] = resolveNodeContract(spec, entry, catalog.observables); done.push(node); }
    catch (e) { console.warn(`    ⚠ DRIVER-SEED-CONTRACT — node "${node}" failed (${e.message}); skipping that node`); }
  }
  fs.writeFileSync(srcAbs, projJson(spec));
  return { source: proj.source, catalog: proj.catalog, into, nodes: done };
}
