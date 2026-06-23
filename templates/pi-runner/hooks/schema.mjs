// pi-runner hook-op engine — OPTIONAL draft-2020-12 JSON-Schema validator loader.
//
// PHASE-1 PORT (sdk-convergence): ported verbatim from run.mjs's loadSchemaValidatorFactory, with
// the run.mjs globals it scanned (HERE / RUN_CWD / ROOT) passed in as ctx. Used by the union/reconcile
// projection schema gates: best-effort, graceful-degrade — if no validator resolves it returns null and
// the gate WARNS + writes without validation (the engine law), so a missing optional dep never bricks a run.

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

let _schemaValidatorFactory; // undefined = not tried; null = unavailable; fn = the factory

// ctx = { here, runCwd, root } — the three node_modules-bearing roots run.mjs scanned (HERE, RUN_CWD, ROOT).
// Memoized like the original (resolved once per process). Returns a `compile(schemaObj) -> (data) =>
// {ok, errors}` factory or null.
export async function loadSchemaValidatorFactory(ctx) {
  if (_schemaValidatorFactory !== undefined) return _schemaValidatorFactory;
  const bases = [...new Set([ctx.here, ctx.runCwd, ctx.root])].map((d) => path.join(d, "__pi-runner-resolve-base.js"));
  const specs = ["ajv/dist/2020.js", "ajv/dist/2020", "ajv2020"]; // draft-2020-12 entry points
  for (const base of bases) {
    const req = createRequire(base);
    for (const spec of specs) {
      let resolved;
      try { resolved = req.resolve(spec); } catch { continue; }
      try {
        const m = await import(resolved);
        const Ajv2020 = m.Ajv2020 || m.default || m;
        if (typeof Ajv2020 !== "function") continue;
        let addFormats = null;
        try { addFormats = (await import(req.resolve("ajv-formats"))).default; } catch {}
        _schemaValidatorFactory = (schema, schemaDir) => {
          const ajv = new Ajv2020({ allErrors: true, strict: false });
          if (addFormats) try { addFormats(ajv); } catch {}
          // Multi-file $ref support: load every relative-file $ref (e.g. a per-archetype overlay $ref-ing the
          // shared blueprint.base.schema.json) and register it so a split schema set compiles. Each ref schema
          // is addSchema'd under its OWN $id — authored to equal the ajv-normalized ref string (a leading ../
          // collapses against the root base URI) — and we recurse for transitive refs. Generic: no project paths
          // baked in; a single self-contained schema (no external $ref, or no schemaDir) is byte-identical to before.
          if (schemaDir) {
            const seen = new Set();
            const addRefs = (sch, dir) => {
              const refs = [];
              JSON.stringify(sch, (k, v) => { if (k === "$ref" && typeof v === "string" && !v.startsWith("#")) refs.push(v); return v; });
              for (const ref of refs) {
                if (seen.has(ref)) continue;
                seen.add(ref);
                try {
                  const refAbs = path.resolve(dir, ref.split("#")[0]);
                  const refSchema = JSON.parse(fs.readFileSync(refAbs, "utf8"));
                  ajv.addSchema(refSchema);
                  addRefs(refSchema, path.dirname(refAbs));
                } catch { /* leave unresolved — ajv errors honestly at compile */ }
              }
            };
            try { addRefs(schema, schemaDir); } catch {}
          }
          const v = ajv.compile(schema);
          return (data) => ({ ok: !!v(data), errors: v.errors || [] });
        };
        return _schemaValidatorFactory;
      } catch { /* try the next spec/base */ }
    }
  }
  _schemaValidatorFactory = null;
  return null;
}

// Test-only: reset the memo so a parity test can exercise the loader from a clean state.
export function __resetSchemaValidatorMemo() { _schemaValidatorFactory = undefined; }
