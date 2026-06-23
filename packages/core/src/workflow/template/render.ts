// The ONE realized-prompt renderer (template-format.md §6 step 2 / §10 bucket 3) — shared by the loader
// (T2, render-at-load for the WorkflowSpec prompt) AND init-RUN (T5, render-at-instantiation, appending
// the freshly-rendered tail to the copied prose). Single-sourcing it keeps `node.json` the ONE source for
// the contract markers — they are never hand-authored and cannot drift between the two call sites.
//
// It builds a MINIMAL NodeSpec the codec reads (only the fields `markersFromNode` touches) and emits the
// DRIVER-* tail (artifacts · owns · readScope · schema · checks · policy · return · tools). The `{{RUN}}`/
// `{{WORKSPACE}}`/`{{state.*}}` tokens are carried THROUGH verbatim — the token resolution is the caller's
// concern (the loader leaves them for the runtime resolver; init-RUN resolves RUN/WORKSPACE intrinsically).

import type { NodeSpec, Check, ReturnMode, Policy } from '../../types.js';
import { markersFromNode, emitMarkers } from '../../contract.js';
import type { TemplateNode } from './types.js';

/** Flatten pre+post checks into the runtime `Check[]` (detection). Render order: pre then post. */
export function collectChecks(def: TemplateNode): Check[] | undefined {
  const all = [...(def.checks?.pre ?? []), ...(def.checks?.post ?? [])].map((c) => ({
    kind: c.kind,
    path: c.path,
    param: c.param,
    severity: c.severity,
  })) as Check[];
  return all.length ? all : undefined;
}

/** Map the authored policy object → the runtime `Policy` (already the runtime enum — structural pass-through). */
export function toPolicy(p: TemplateNode['policy']): Policy | undefined {
  if (!p || !Object.keys(p).length) return undefined;
  return p as Policy;
}

/**
 * Render a node's realized prompt: the prose body + the DRIVER-* marker tail (§6 step 2). Uses the
 * EXISTING `markersFromNode` codec AS-IS over a materialized NodeSpec (artifacts/owns/readScope/schema/
 * checks/policy/return). Tokens in the markers are carried through verbatim (the caller resolves them).
 */
export function renderRealizedPrompt(def: TemplateNode, prose: string): string {
  const c = def.contract;
  const node = {
    id: def.id,
    label: def.id,
    prompt: prose,
    skill: def.prompt.skill,
    sandbox: { provider: 'inmemory', workspace: '.', read: c.readScope, write: c.owns, output: `out/${def.id}` },
    tools: { allow: def.tools?.allow, deny: def.tools?.deny },
    io: {
      reads: [],
      produces: c.artifacts,
      artifacts: c.artifacts.map((p) => (c.schema ? { path: p, schema: c.schema } : { path: p })),
      checks: collectChecks(def),
      policy: toPolicy(def.policy),
      returnMode: c.returnMode as ReturnMode | undefined,
      fillSentinel: c.fillSentinel ?? undefined,
    },
  } as unknown as NodeSpec;
  const tail = emitMarkers(markersFromNode(node));
  const body = prose.trimEnd();
  return tail ? `${body}\n\n${tail}` : body;
}
