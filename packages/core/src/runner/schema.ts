// The post-node SCHEMA gate — validate each declared artifact that carries a `schema` against its
// JSON-Schema (draft-2020-12). A present-but-INVALID artifact (wrong type / missing required key / an
// unfilled <FILL:> sentinel that breaks a type/enum) is a contract BREACH, programmatic and never an
// LLM judgment — exactly like a missing one. A faithful port of `run.mjs` schemaCheck.
//
// LEAN + GRACEFULLY DEGRADING: the validator is an injectable seam (RunOptions.validateSchema). The
// default best-effort-loads ajv-2020 and, if it does not resolve, the gate WARNS + SKIPS (non-blocking)
// — so @piflow/core carries no hard ajv dependency and a missing optional dep never bricks a run.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ArtifactReq } from '../types.js';

/** Validate parsed `data` against a parsed JSON-Schema. Pure given the two objects (the runner does fs). */
export type SchemaValidator = (schema: object, data: unknown) => { ok: boolean; errors: string[] };

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
    _default = (schema, data) => {
      const ajv = new Ajv2020({ allErrors: true, strict: false });
      if (addFormats) try { addFormats(ajv); } catch { /* non-fatal */ }
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
    const schemaObj = await readJson(await resolveUnder(a.schema as string, opts.roots));
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
    const r = opts.validate(schemaObj as object, data);
    if (!r.ok) invalid.push({ path: a.path, errors: r.errors });
  }
  return { invalid, checked, skipped };
}
