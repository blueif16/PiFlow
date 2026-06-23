// pi-runner hook-op engine — DRIVER-MERGE (the FILESYSTEM-merge family: concat | reconcile | fold | run).
//
// PHASE-1 PORT (sdk-convergence): driverMerge + mergeResolveAbs + applyMergeOp + runMerge, ported
// verbatim from run.mjs. State change: the run.mjs globals (RUN_CWD / ROOT) used for path/schema/command
// resolution + the {root} token are passed in as `ctx = { runCwd, root, here }`; projectBase was ALREADY
// an explicit param. The SPEC is DATA declared in the workflow contract() (a `merge:{ ops:[...] }` field),
// rendered as ONE base64 DRIVER-MERGE marker.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, projJson, drillPath } from "./markers.mjs";
import { loadSchemaValidatorFactory } from "./schema.mjs";

// base64 line (the contract() encodes the ops object so headings/globs with spaces ride one marker line).
export function driverMerge(prompt) {
  const m = /(?:^|\n)[ \t]*DRIVER-MERGE:[ \t]*([A-Za-z0-9+/=]+)[ \t]*(?=\n|$)/.exec(prompt || "");
  if (!m) return null;
  try { return JSON.parse(Buffer.from(m[1], "base64").toString("utf8")); }
  catch (e) { console.warn(`    ⚠ DRIVER-MERGE — marker payload unreadable (${e.message}); skipping`); return null; }
}

export function mergeResolveAbs(rel, projectBase, ctx) {
  if (path.isAbsolute(rel)) return rel;
  return [path.join(projectBase, rel), path.join(ctx.runCwd, rel), path.join(ctx.root, rel)].find((c) => { try { return fs.statSync(c).size >= 0; } catch { return false; } }) || path.join(projectBase, rel);
}

export async function applyMergeOp(opSpec, projectBase, ctx) {
  // ---- concat: glob → to, each under a heading, stable lexical-by-path, idempotent overwrite ----
  if (opSpec.concat && typeof opSpec.concat === "object") {
    const { glob, to, heading = "## {name}" } = opSpec.concat;
    const toAbs = path.isAbsolute(to) ? to : path.join(projectBase, to);
    const dir = path.dirname(glob);
    const pat = path.basename(glob);
    const reSrc = "^" + pat.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$";
    const re = new RegExp(reSrc);
    const dirAbs = path.isAbsolute(dir) ? dir : path.join(projectBase, dir);
    let names = [];
    try { names = fs.readdirSync(dirAbs); } catch {}
    // STABLE lexical-by-path order; EXCLUDE the destination itself.
    const toBase = path.basename(toAbs);
    const matched = names.filter((n) => re.test(n) && n !== toBase).sort();
    if (!matched.length) return { op: "concat", to, wrote: false, skipped: `no files match ${glob}`, merged: 0 };
    const parts = [];
    for (const n of matched) {
      const relPath = path.join(dir, n).replace(/^\.\//, "");
      let body = "";
      try { body = fs.readFileSync(path.join(dirAbs, n), "utf8"); } catch { continue; }
      const head = heading.replaceAll("{name}", n).replaceAll("{path}", relPath);
      parts.push(`${head}\n\n${body.replace(/\s+$/, "")}`);
    }
    ensureDir(path.dirname(toAbs));
    fs.writeFileSync(toAbs, parts.join("\n\n") + "\n");
    return { op: "concat", to, wrote: true, merged: matched.length };
  }

  // ---- reconcile: from.<keys> → to.slots[].<fields> on matching key; keys/order untouched ----
  if (opSpec.reconcile && typeof opSpec.reconcile === "object") {
    const { from, to, key = "slot", fields = [], arrayAt = "slots", fromAt = "slots", schema } = opSpec.reconcile;
    const toAbs = path.isAbsolute(to) ? to : path.join(projectBase, to);
    let toJson;
    try { toJson = JSON.parse(fs.readFileSync(toAbs, "utf8")); }
    catch (e) { return { op: "reconcile", to, wrote: false, skipped: `target unreadable: ${e.message}` }; }
    const fromAbs = mergeResolveAbs(from, projectBase, ctx);
    let fromMap = null;
    try { fromMap = drillPath(JSON.parse(fs.readFileSync(fromAbs, "utf8")), fromAt); }
    catch (e) { /* graceful: a missing/absent source ⇒ no reconcile, target left as-is */
      return { op: "reconcile", to, wrote: false, skipped: `source unreadable: ${e.message} (target left unchanged)` }; }
    if (!fromMap || typeof fromMap !== "object") return { op: "reconcile", to, wrote: false, skipped: `source "${from}" has no .${fromAt} object` };
    const rows = drillPath(toJson, arrayAt);
    if (!Array.isArray(rows)) return { op: "reconcile", to, wrote: false, skipped: `target has no .${arrayAt} array` };
    let reconciled = 0;
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const id = row[key];
      const src = id != null ? fromMap[id] : undefined;
      if (!src || typeof src !== "object") continue; // a row with no source entry keeps its existing fields
      let touched = false;
      for (const f of fields) {
        const name = typeof f === "string" ? f : f.name;
        if (!name) continue;
        if (typeof f === "object" && f.when) {
          // conditional copy: only when the SOURCE's gating field equals the expected value
          if (src[f.when.field] !== f.when.equals) continue;
        }
        if (name in src) { row[name] = src[name]; touched = true; }
      }
      if (touched) reconciled++;
    }
    // optional best-effort schema re-validate (degrade like the projection schema gate)
    if (schema) {
      const factory = await loadSchemaValidatorFactory(ctx);
      if (factory) {
        const schemaAbs = path.isAbsolute(schema) ? schema
          : [path.join(ctx.runCwd, schema), path.join(ctx.root, schema)].find((c) => { try { return fs.statSync(c).size > 0; } catch { return false; } }) || path.join(ctx.runCwd, schema);
        try {
          const validate = factory(JSON.parse(fs.readFileSync(schemaAbs, "utf8")));
          const r = validate(toJson);
          if (!r.ok) return { op: "reconcile", to, wrote: false, skipped: `reconciled ${to} violates ${path.basename(schema)}: ${(r.errors || []).slice(0, 4).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ")}` };
        } catch (e) { console.warn(`    ⚠ DRIVER-MERGE reconcile: schema "${schema}" unreadable/uncompilable — writing without validation (${e.message})`); }
      } else {
        console.warn(`    ⚠ DRIVER-MERGE reconcile: no draft-2020-12 validator resolved — writing ${to} WITHOUT schema validation`);
      }
    }
    fs.writeFileSync(toAbs, projJson(toJson));
    return { op: "reconcile", to, wrote: true, reconciled };
  }

  // ---- fold: a fragment JSON object → to.<into> (SET to[into] = the parsed fragment, then write). The
  // read-modify-write is FULLY SYNCHRONOUS (no await), so two parallel chrome lanes folding DISTINCT keys
  // never lose an update. Graceful: a missing/unreadable fragment skips the fold. ----
  if (opSpec.fold && typeof opSpec.fold === "object") {
    const { from, to, into } = opSpec.fold;
    if (!from || !to || !into) return { op: "fold", to, wrote: false, skipped: "fold needs { from, to, into }" };
    const toAbs = path.isAbsolute(to) ? to : path.join(projectBase, to);
    let toJson;
    try { toJson = JSON.parse(fs.readFileSync(toAbs, "utf8")); }
    catch (e) { return { op: "fold", to, wrote: false, skipped: `target unreadable: ${e.message}` }; }
    const fromAbs = mergeResolveAbs(from, projectBase, ctx);
    let frag;
    try { frag = JSON.parse(fs.readFileSync(fromAbs, "utf8")); }
    catch (e) { /* graceful: an absent/unreadable fragment ⇒ no fold, target left unchanged */
      return { op: "fold", to, wrote: false, skipped: `fragment "${from}" unreadable: ${e.message} (target left unchanged)` }; }
    toJson[into] = frag;
    fs.writeFileSync(toAbs, projJson(toJson));
    return { op: "fold", to, wrote: true, into };
  }

  // ---- run: execute a declared command — a deterministic GENERATION/derive step. Tokens {project}/{root}
  // in cmd/args[]/cwd are substituted with the resolved projectBase / ctx.root (absolute). cwd defaults to
  // ctx.root. A non-zero exit returns { failed:true, exit }. ----
  if (opSpec.run && typeof opSpec.run === "object") {
    const { cmd, args = [], cwd, note } = opSpec.run;
    if (!cmd) return { op: "run", wrote: false, skipped: "run needs { cmd }" };
    const sub = (s) => typeof s === "string" ? s.replace(/\{project\}/g, projectBase).replace(/\{root\}/g, ctx.root) : s;
    // A BARE command (no path separator) — `node` (run with the driver's OWN interpreter, robust to a
    // PATH/nvm mismatch in the spawned env), `python3`, etc. — resolves via process/PATH, NOT joined to
    // ctx.root (joining produced <root>/node → ENOENT, which silently no-op'd the event-wiring gate ops).
    // Only a path CONTAINING a separator is a repo-relative file and keeps the ctx.root join.
    const subCmd = sub(cmd);
    const cmdAbs = path.isAbsolute(subCmd) ? subCmd
      : subCmd === "node" ? process.execPath
      : !/[\\/]/.test(subCmd) ? subCmd
      : path.join(ctx.root, subCmd);
    const argv = (Array.isArray(args) ? args : []).map(sub);
    const runCwd = cwd ? (path.isAbsolute(sub(cwd)) ? sub(cwd) : path.join(ctx.root, sub(cwd))) : ctx.root;
    const res = spawnSync(cmdAbs, argv, { cwd: runCwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    const out = (res.stdout || "").toString().trim().split("\n").slice(-3).join(" | ");
    const err = (res.stderr || "").toString().trim().split("\n").slice(-3).join(" | ");
    if (res.error) { console.warn(`    ⚠ DRIVER-MERGE run: spawn error (${res.error.message})`); return { op: "run", wrote: false, failed: true, skipped: `spawn error: ${res.error.message}`, cmd: path.relative(ctx.root, cmdAbs) }; }
    if (res.status !== 0) { console.warn(`    ⚠ DRIVER-MERGE run: ${path.basename(cmdAbs)} exited ${res.status} — ${err || out}`); return { op: "run", wrote: false, failed: true, exit: res.status, stderr: err.slice(0, 400), cmd: path.relative(ctx.root, cmdAbs) }; }
    return { op: "run", wrote: true, exit: 0, cmd: path.relative(ctx.root, cmdAbs), stdout: out.slice(0, 200), note: note || undefined };
  }

  return { op: "unknown", wrote: false, skipped: "no recognized op (concat|reconcile|fold|run)" };
}

// Run a node's DRIVER-MERGE ops (POST-node). Each op degrades gracefully. Returns { ops:[...] }; a null
// marker returns null.
export async function runMerge(spec, projectBase, ctx) {
  if (!spec || !Array.isArray(spec.ops)) return null;
  const ops = [];
  for (const opSpec of spec.ops) {
    try { ops.push(await applyMergeOp(opSpec, projectBase, ctx)); }
    catch (e) { ops.push({ op: Object.keys(opSpec || {})[0] || "?", wrote: false, skipped: `error: ${e.message}` }); console.warn(`    ⚠ DRIVER-MERGE op errored: ${e.message}`); }
  }
  return { ops };
}
