// ─────────────────────────────────────────────────────────────────────────────
// init-RUN (template-format.md §10) — instantiate a runnable THREAD from an authored template.
//
// The template's `nodes/<id>/` folder and the runtime `${RUN}/.pi/nodes/<id>/` folder are the SAME schema
// (D7), so a run is a near-literal COPY of the template. `instantiateRun` sorts each node's files into the
// FOUR §10 buckets — deterministic, individually-testable steps, never open-ended logic:
//
//   1. PURE COPY (byte-identical): `node.json` (the frozen contract source) + the PROSE body of `prompt.md`.
//   2. TOKEN-RESOLVE (intrinsic): `{{RUN}}`→runDir, `{{WORKSPACE}}`→workspace; `{{state.*}}` LEFT DEFERRED
//      (resolved by the driver at node launch from `${RUN}/.pi/state.json`). The ONLY thing that can't be a
//      blind copy — the run lives at a new physical path. We reuse the SINGLE token delimiter (`tokens.ts`).
//   3. MARKER TAIL: append `renderRealizedPrompt`'s DRIVER-* block (a pure function of `node.json`) to the
//      copied prose, THEN intrinsic-resolve the whole realized prompt — so `node.json` stays the ONE source
//      for the contract and the markers cannot drift.
//   4. RUN-ONLY STUBS shipped EMPTY: per-node `io.json` (`{}`) + `events.jsonl` (empty), and the run-level
//      `${RUN}/.pi/state.json` (`{}`) — so the run folder is COMPLETE + uniform from t=0; execution fills
//      them in place.
//
// PRODUCT-SEED scope note (failure-path, template-format.md §10 / D8 init-RUN): a fuller init-RUN also
// copies a product SEED/scaffold and binds `${WORKSPACE}`. The template-min fixture carries NO product seed,
// so this implementation is scoped to the `.pi/` node-folder materialization (the CORE of §10). Product-seed
// copying is a NOTED extension, not invented here.
// ─────────────────────────────────────────────────────────────────────────────

import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import type { TemplateNode } from './types.js';
import { renderRealizedPrompt } from './render.js';
import { reToken } from './tokens.js';
import {
  nodeDir,
  nodePromptFile,
  nodeIoFile,
  nodeEventsFile,
  stateFile,
  piDir,
} from '../../runner/layout.js';

/** Options for `instantiateRun`. */
export interface InstantiateRunOpts {
  /** `{{WORKSPACE}}` — the canonical, read-only, out-of-thread tree (skills · templates · registry). */
  workspace: string;
}

/** The per-node files materialized for one node (returned for tooling/inspection). */
export interface InstantiatedNode {
  id: string;
  dir: string;
}

/** The result of instantiating a run from a template. */
export interface InstantiateRunResult {
  /** The physical run root (= `{{RUN}}`). */
  runDir: string;
  /** Every node materialized into `${RUN}/.pi/nodes/<id>/`, in template (id-sorted) order. */
  nodes: InstantiatedNode[];
}

/**
 * Resolve the INTRINSIC tokens (`{{RUN}}`/`{{WORKSPACE}}`) of a realized prompt to their physical roots,
 * LEAVING `{{state.*}}` (and any other unknown token) verbatim for the driver to resolve at node launch.
 *
 * Deliberately NOT the U7 `resolveTokens` (which THROWS on an unresolved `{{state.*}}` — correct at launch,
 * wrong at instantiation where state is DEFERRED by design). Uses the SAME single delimiter (`tokens.ts`)
 * so `{{` / `}}` lives in exactly one place.
 */
function resolveIntrinsic(s: string, runDir: string, workspace: string): string {
  return s.replace(reToken('([A-Za-z0-9_.]+)'), (whole, inner: string) => {
    if (inner === 'RUN') return runDir;
    if (inner === 'WORKSPACE') return workspace;
    return whole; // {{state.*}} and any other token: left DEFERRED, verbatim.
  });
}

/** Read + parse a node.json (raw bytes kept separately for the byte-identical copy). */
async function readNode(ndir: string): Promise<{ raw: string; def: TemplateNode }> {
  const raw = await fs.readFile(path.join(ndir, 'node.json'), 'utf8');
  return { raw, def: JSON.parse(raw) as TemplateNode };
}

/** Read a node's prose body (the prompt template), or '' if absent (an empty body is valid). */
async function readProse(ndir: string, file: string): Promise<string> {
  try {
    return await fs.readFile(path.join(ndir, file), 'utf8');
  } catch {
    return '';
  }
}

/**
 * init-RUN: materialize a runnable thread from an authored template DIR into `runDir`, per §10's four
 * buckets. Deterministic; safe to re-run (overwrites the per-node files, re-stubs the run-only files).
 *
 * @param templateDir absolute path to the authored `template/` (the D8 source of truth)
 * @param runDir      the physical run root (= `{{RUN}}`); its `.pi/nodes/<id>/` is materialized
 * @param opts.workspace the physical `{{WORKSPACE}}` root
 */
export async function instantiateRun(
  templateDir: string,
  runDir: string,
  opts: InstantiateRunOpts,
): Promise<InstantiateRunResult> {
  const { workspace } = opts;
  const nodesDir = path.join(templateDir, 'nodes');
  const entries = (await fs.readdir(nodesDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name)); // deterministic, id-sorted (matches the loader scan)

  // BUCKET 4 (run-level) — the engine namespace + the EMPTY RunState stub, complete from t=0.
  // PRESERVE an existing state.json: a --from resume re-instantiates the run (runFromTemplate always
  // calls instantiateRun), so unconditionally re-stubbing would WIPE the channels prior nodes promoted
  // — then a reused upstream node never re-promotes and a downstream {{state.*}} consumer fails with
  // "unresolved state channel". Only seed the empty stub on a fresh run (no state.json yet).
  await fs.mkdir(piDir(runDir), { recursive: true });
  if (!existsSync(stateFile(runDir))) await fs.writeFile(stateFile(runDir), '{}');

  const nodes: InstantiatedNode[] = [];
  for (const e of entries) {
    const srcDir = path.join(nodesDir, e.name);
    const { raw, def } = await readNode(srcDir);
    const id = def.id ?? e.name;
    const dstDir = nodeDir(runDir, id);
    await fs.mkdir(dstDir, { recursive: true });

    // BUCKET 1 — copy node.json BYTE-IDENTICAL (the frozen contract source; NO token resolution here).
    await fs.writeFile(path.join(dstDir, 'node.json'), raw);

    // BUCKET 1+3 — copy the prose body, APPEND the markersFromNode tail; THEN
    // BUCKET 2 — intrinsic-resolve {{RUN}}/{{WORKSPACE}} over the whole realized prompt, {{state.*}} deferred.
    const prose = await readProse(srcDir, def.prompt?.file ?? 'prompt.md');
    const realized = renderRealizedPrompt(def, prose);
    await fs.writeFile(nodePromptFile(runDir, id), resolveIntrinsic(realized, runDir, workspace));

    // BUCKET 4 (per-node) — EMPTY run-only stubs (io.json `{}`, events.jsonl empty) ride along.
    await fs.writeFile(nodeIoFile(runDir, id), '{}');
    await fs.writeFile(nodeEventsFile(runDir, id), '');

    nodes.push({ id, dir: dstDir });
  }

  return { runDir, nodes };
}
