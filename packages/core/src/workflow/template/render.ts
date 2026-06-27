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
import { lowerToOps } from './lower.js';

/** Strip a leading `{{RUN}}/` so an injected forced-read renders as a RUN-relative path in the fold. */
const runRel = (p: string): string => p.replace(/^\{\{RUN\}\}\//, '');

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
  // (M5 · G13) Lower the deprecated aliases into the canonical op[] so the realized prompt carries a
  // DRIVER-OP marker (the codec round-trips it) AND #10: each pre-op's `reads` (the injected forced-reads)
  // FOLD into the realized prompt — a NEW behavior (the loader's reads:[] hardcode never folded them).
  const op = lowerToOps(def);
  const node = {
    id: def.id,
    label: def.id,
    prompt: prose,
    // A PROGRAMMATIC node has no `prompt` block on disk (it spawns no `pi`); tolerate its absence.
    skill: def.prompt?.skill,
    sandbox: { provider: 'inmemory', workspace: '.', read: c.readScope, write: c.owns, output: `out/${def.id}` },
    tools: { allow: def.tools?.allow, deny: def.tools?.deny },
    io: {
      reads: [],
      produces: c.artifacts,
      artifacts: c.artifacts.map((p) => (c.schema ? { path: p, schema: c.schema } : { path: p })),
      checks: collectChecks(def),
      policy: toPolicy(def.policy),
      returnMode: c.returnMode as ReturnMode | undefined,
      // The authored structured-return JSON-Schema (node.json top-level `return`) → DRIVER-RETURN-SCHEMA
      // in the realized prompt, so the executor sees the required result shape (the codec emits it when set).
      returnSchema: def.return as Record<string, unknown> | undefined,
      fillSentinel: c.fillSentinel ?? undefined,
    },
    ...(op ? { op } : {}),
  } as unknown as NodeSpec;
  const tail = emitMarkers(markersFromNode(node));
  // #10 — fold the PRE ops' reads (the injected forced-reads) into a human-readable line so the model knows
  // which inputs to load. The base64 DRIVER-OP marker round-trips them; this line makes them legible in-prompt.
  const preReads = [...new Set((op ?? []).filter((o) => o.when === 'pre').flatMap((o) => (o.reads ?? []).map(runRel)))];
  const injectLine = preReads.length ? `DRIVER-INJECT: ${preReads.join(' ')}` : '';
  const fullTail = [tail, injectLine].filter(Boolean).join('\n');
  const body = prose.trimEnd();
  return fullTail ? `${body}\n\n${fullTail}` : body;
}
