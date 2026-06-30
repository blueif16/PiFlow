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
import { gatesFromOp } from '../../runner/op-dispatch.js';
import { loadAgentPreset, defaultAgentsDir } from '../agent-preset.js';

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
  // (A-fix) A node authored DIRECTLY in `op[]` expresses a post-check as a `{when:'post', gate}` op, but the
  // runner's gate reader fires only PRE gates — so those post-gates were a DEAD rep. Fold them into `io.checks`
  // (THE post-check engine, the deliberate two-layer design) so they are enforced. Read from the AUTHORED
  // `def.op`: a hooks-authored node has none (its `checks` alias is flattened above + lowered separately), so
  // this adds nothing for it — no double-count. Pre gates are excluded (they run via the pre-gate reader).
  all.push(...gatesFromOp(def.op).post);
  return all.length ? all : undefined;
}

/** Map the authored policy object → the runtime `Policy` (already the runtime enum — structural pass-through). */
export function toPolicy(p: TemplateNode['policy']): Policy | undefined {
  if (!p || !Object.keys(p).length) return undefined;
  return p as Policy;
}

/** Options for the realized-prompt renderer (the role-preset catalog seam — injectable for tests). */
export interface RenderOpts {
  /** Catalog dir for `agentType` preset resolution. Default `~/.piflow/agents/` (the SDK-boundary home). */
  agentsDir?: string;
}

/**
 * Thrown when a node names an `agentType` preset that cannot be resolved at render. A node declaring a
 * preset it can't load is a TEMPLATE buildability failure (the loader's fail-closed convention) — we
 * fail LOUDLY rather than silently emit a node that looks bound but inherits no role.
 */
export class MissingPresetError extends Error {
  constructor(public readonly agentType: string, public readonly nodeId: string) {
    super(
      `node "${nodeId}" declares agentType "${agentType}" but no preset "${agentType}.md" could be ` +
        `loaded from the agents catalog — the role-prompt cannot be inherited. ` +
        `Add the preset to ~/.piflow/agents/ (or remove the agentType binding).`,
    );
    this.name = 'MissingPresetError';
  }
}

/**
 * Resolve a node's RAW prose into the role-inherited prose used by BOTH render sites (loader · init-RUN),
 * so the role is applied IDENTICALLY and cannot drift. When `def.agentType` is set, prepend the named
 * preset's role-prompt body (the SAME `role + "\n\n" + task` order as the author-time `mergePreset`):
 * the preset is the SINGLE source — editing it updates every inheriting node, never copied into prompt.md.
 *
 * PURE w.r.t. its inputs except the one unavoidable disk read of the preset catalog (mirrors how
 * `loadAgentPreset` is the read-only adapter over `~/.piflow/agents/`). A node with NO `agentType`
 * (every bespoke/programmatic node) returns its prose UNCHANGED — byte-identical to before. A missing
 * preset THROWS (`MissingPresetError`) — fail-closed, never a silently un-bound node.
 */
export function withRolePrompt(def: TemplateNode, prose: string, opts: RenderOpts = {}): string {
  if (!def.agentType) return prose; // bespoke/programmatic node: no inheritance, unchanged.
  const preset = loadAgentPreset(def.agentType, opts.agentsDir ?? defaultAgentsDir());
  if (!preset) throw new MissingPresetError(def.agentType, def.id);
  // ROLE first, TASK after — the exact additive composition `mergePreset` uses (agent-preset.ts:81).
  // An empty task (no prose) ⇒ role alone, so the node is never left blank when bound.
  return prose ? `${preset.prompt}\n\n${prose}` : preset.prompt;
}

/**
 * Render a node's realized prompt: the (role-inherited) prose body + the DRIVER-* marker tail (§6 step 2).
 * Uses the EXISTING `markersFromNode` codec AS-IS over a materialized NodeSpec (artifacts/owns/readScope/
 * schema/checks/policy/return). Tokens in the markers are carried through verbatim (the caller resolves them).
 *
 * When `def.agentType` is set, the node INHERITS its preset's role-prompt at the head of the body (resolved
 * BY REFERENCE via `withRolePrompt`, single-sourced from the preset). Both call sites (loader render-at-load
 * + init-RUN render-at-instantiation) start from the RAW prose and route through here, so the role is applied
 * exactly ONCE per final prompt and the two sites cannot drift.
 */
export function renderRealizedPrompt(def: TemplateNode, prose: string, opts: RenderOpts = {}): string {
  // Inherit the preset's role-prompt FIRST (no-op when the node has no agentType), then render the tail.
  prose = withRolePrompt(def, prose, opts);
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
