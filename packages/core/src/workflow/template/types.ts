// Internal types for the template loader (T2). These describe the AUTHORED on-disk node.json shape
// (template-format.md §3) as the loader sees it after JSON.parse — distinct from the runtime
// `NodeSpec`/`NodeIntent` (types.ts) the loader DERIVES from it. Kept loose where the schema gate (the
// T1 JSON Schemas) already pins the shape; the loader only reads the fields the §8 checks + render use.

/** A check entry as authored in node.json (§3 `checks.pre`/`checks.post`). */
export interface TemplateCheck {
  kind: string;
  path?: string;
  param?: unknown;
  severity?: 'fail' | 'warn';
}

/** The authored `node.json` (template-format.md §3) — what the loader parses off disk. */
export interface TemplateNode {
  id: string;
  phase: string;
  deps: string[];
  prompt: { file: string; skill?: string };
  tools?: { allow?: string[]; deny?: string[] };
  mcp?: { servers?: Record<string, unknown>; ref?: string };
  inject?: string[];
  contract: {
    artifacts: string[];
    owns: string[];
    readScope: string[];
    schema?: string;
    returnMode?: 'optional' | 'required';
    fillSentinel?: string | null;
  };
  checks?: { pre?: TemplateCheck[]; post?: TemplateCheck[] };
  policy?: Record<string, string>;
  hooks?: {
    seed?: { to: string; from: string }[];
    project?: { to: string; from: string | string[] }[];
    /** DRIVER-MERGE op set — the `applyMergeOp` discriminated grammar (`{ ops: [{fold|concat|reconcile|run}] }`). */
    merge?: { ops: Record<string, unknown>[] };
    promote?: { from: string; to: string; merge?: string }[];
    /** POST DERIVE — seed per-node contracts into `source.<into>` from the drift-gated `catalog` (runSeedContract). */
    seedContracts?: { source: string; catalog: string; into?: string };
    /** POST DERIVE — derive outputs from a frozen `source` via a genre record's `projections` map (runProjection). */
    projectGenre?: { source: string; mapRef: string; genre: string };
  };
  return?: object;
}

/** The authored `meta.json` (template-format.md §5). */
export interface TemplateMeta {
  id: string;
  name: string;
  description: string;
  phases?: string[];
}

/** A loaded node bundle: its parsed def + the absolute path to its folder (for ref/render resolution). */
export interface LoadedNode {
  /** The parsed node.json. */
  def: TemplateNode;
  /** Absolute path to this node's folder (`<template>/nodes/<id>/`). */
  dir: string;
  /** The prose body of prompt.md (pre-render). */
  prose: string;
}
