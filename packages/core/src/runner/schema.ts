// The post-node SCHEMA gate — validate each declared artifact that carries a `schema` against its
// JSON-Schema (draft-2020-12). A present-but-INVALID artifact (wrong type / missing required key / an
// unfilled <FILL:> sentinel that breaks a type/enum) is a contract BREACH, programmatic and never an
// LLM judgment — exactly like a missing one. A faithful port of `run.mjs` schemaCheck.
//
// LEAN + GRACEFULLY DEGRADING: the validator is an injectable seam (RunOptions.validateSchema). The
// default best-effort-loads ajv-2020 and, if it does not resolve, the gate WARNS + SKIPS (non-blocking)
// — so @piflow/core carries no hard ajv dependency and a missing optional dep never bricks a run.

import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ArtifactReq } from '../types.js';

/**
 * Validate parsed `data` against a parsed JSON-Schema. Pure given the two objects PLUS the optional
 * `schemaDir` — the directory `schema` was read from, consulted ONLY to resolve a relative-FILE `$ref`
 * (a split base+overlay schema pair). Additive: an injected `RunOptions.validateSchema` that ignores the
 * third arg (today's every consumer) stays source-compatible; a single self-contained schema never looks
 * at it, so behavior is byte-identical when `schemaDir` is absent.
 */
export type SchemaValidator = (schema: object, data: unknown, schemaDir?: string) => { ok: boolean; errors: string[] };

/** The gate's outcome. `skipped` set (invalid empty) when off; `invalid` lists present-but-bad artifacts. */
export interface SchemaCheckResult {
  invalid: { path: string; errors: string[] }[];
  checked: number;
  skipped: string | null;
}

let _default: SchemaValidator | null | undefined; // undefined = not tried; null = unavailable; fn = loaded

/**
 * Best-effort draft-2020-12 validator from ajv (optional dep). Memoized. Returns null when ajv does
 * not resolve — the gate then skips with a warning (run.mjs's degrade-don't-brick contract).
 */
export async function defaultSchemaValidator(): Promise<SchemaValidator | null> {
  if (_default !== undefined) return _default;
  try {
    const mod = (await import('ajv/dist/2020.js')) as unknown as Record<string, unknown>;
    const Ajv2020 = (mod.Ajv2020 ?? mod.default ?? mod) as unknown as new (o: object) => {
      compile: (s: object) => ((d: unknown) => boolean) & { errors?: { instancePath?: string; message?: string }[] | null };
      addSchema: (s: object) => void;
    };
    if (typeof Ajv2020 !== 'function') {
      _default = null;
      return null;
    }
    let addFormats: ((a: unknown) => void) | null = null;
    try {
      addFormats = ((await import('ajv-formats')) as unknown as { default: (a: unknown) => void }).default;
    } catch {
      /* formats are optional */
    }
    _default = (schema, data, schemaDir) => {
      const ajv = new Ajv2020({ allErrors: true, strict: false });
      if (addFormats) try { addFormats(ajv); } catch { /* non-fatal */ }
      // Multi-file $ref support (a faithful port of the pi-runner hook engine's loadSchemaValidatorFactory):
      // load every relative-FILE $ref (e.g. a per-branch overlay schema $ref-ing a shared base) and
      // addSchema it, so a split schema set compiles instead of ajv.compile() throwing MissingRefError.
      // Each ref schema is addSchema'd under its own declared $id and we recurse for transitive refs.
      // Generic — no project paths baked in; a single self-contained schema (no external $ref, or no
      // schemaDir) never enters this block, so behavior there is byte-identical to before.
      if (schemaDir) {
        const seen = new Set<string>();
        const addRefs = (sch: unknown, dir: string): void => {
          const refs: string[] = [];
          JSON.stringify(sch, (k, v) => {
            if (k === '$ref' && typeof v === 'string' && !v.startsWith('#')) refs.push(v);
            return v;
          });
          for (const ref of refs) {
            if (seen.has(ref)) continue;
            seen.add(ref);
            try {
              const refAbs = path.resolve(dir, ref.split('#')[0]);
              const refSchema = JSON.parse(readFileSync(refAbs, 'utf8'));
              ajv.addSchema(refSchema);
              addRefs(refSchema, path.dirname(refAbs));
            } catch {
              /* leave unresolved — ajv errors honestly at compile */
            }
          }
        };
        try {
          addRefs(schema, schemaDir);
        } catch {
          /* non-fatal */
        }
      }
      const v = ajv.compile(schema);
      const ok = !!v(data);
      const errors = (v.errors ?? []).slice(0, 8).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim());
      return { ok, errors };
    };
    return _default;
  } catch {
    _default = null;
    return null;
  }
}

/** Read + JSON-parse a file; null on any failure (missing/unreadable/unparseable). */
async function readJson(p: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

/** First of `roots` under which `rel` exists; falls back to the first root. */
async function resolveUnder(rel: string, roots: string[]): Promise<string> {
  if (path.isAbsolute(rel)) return rel;
  for (const r of roots) {
    const c = path.join(r, rel);
    try {
      await fs.stat(c);
      return c;
    } catch {
      /* try next */
    }
  }
  return path.join(roots[0] ?? '.', rel);
}

/**
 * Validate every artifact that declares a `schema`. Artifact bytes resolve under `outDir` (where
 * collected outputs land); schema files resolve under `roots` ([outDir, repoRoot]). A MISSING artifact
 * is the existence gate's job (skipped here); an UNPARSEABLE artifact is invalid; an unreadable SCHEMA
 * is a config error → skip+warn (never a false breach).
 */
export async function validateArtifactSchemas(
  artifacts: ArtifactReq[],
  opts: { outDir: string; roots: string[]; validate: SchemaValidator | null },
): Promise<SchemaCheckResult> {
  const withSchema = artifacts.filter((a) => a.schema);
  if (!withSchema.length) return { invalid: [], checked: 0, skipped: null };
  if (!opts.validate) {
    return { invalid: [], checked: 0, skipped: 'no draft-2020-12 validator resolved (install ajv to enable the schema gate)' };
  }
  const invalid: { path: string; errors: string[] }[] = [];
  let checked = 0;
  let skipped: string | null = null;
  for (const a of withSchema) {
    const schemaAbs = await resolveUnder(a.schema as string, opts.roots);
    const schemaObj = await readJson(schemaAbs);
    if (schemaObj == null || typeof schemaObj !== 'object') {
      skipped = `schema unreadable/uncompilable (${path.basename(a.schema as string)})`;
      continue;
    }
    const dataPath = path.join(opts.outDir, a.path);
    let raw: string;
    try {
      raw = await fs.readFile(dataPath, 'utf8');
    } catch {
      continue; // a MISSING artifact is the existence gate's job, not the schema gate's
    }
    checked++;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      invalid.push({ path: a.path, errors: [`not valid JSON: ${(e as Error).message}`] });
      continue;
    }
    // The compile step inside `validate` can throw (an unresolved $ref, a strict-mode clash, …) — a SCHEMA
    // config problem, never a false artifact breach. Degrade exactly like an unreadable schema file above
    // (skip + warn, never crash the run — run.mjs schemaCheck's degrade-don't-brick contract).
    try {
      const r = opts.validate(schemaObj as object, data, path.dirname(schemaAbs));
      if (!r.ok) invalid.push({ path: a.path, errors: r.errors });
    } catch (e) {
      checked--; // this artifact's schema never actually compiled — it was not really "checked"
      skipped = `schema unreadable/uncompilable (${path.basename(a.schema as string)}): ${(e as Error).message}`;
    }
  }
  return { invalid, checked, skipped };
}
