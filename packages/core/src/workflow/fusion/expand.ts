// (Phase 2) expandFusion — the spec-level transform that realizes a `node.fusion` activation as the
// siblings+judge DAG expansion (spec §4). It runs BEFORE `compile` (the WorkflowSpec is still the
// `NodeIntent` bag), so it only GENERATES nodes — the existing compiler infers the edges from
// produces ⋈ reads and draws `deps → (siblings ‖) → judge → original successors`. NO new DAG code.
//
// For an activated node X:
//   • The JUDGE keeps X's id (label) → every original downstream edge (data-flow AND dependsOn:[X])
//     is preserved untouched; its prompt becomes the mode's Appendix-A judge; it reads the partials
//     (+ obligations) and keeps X's original produces/artifacts/integrity-contract.
//   • N SIBLINGS `X__pN` clone X's prompt/tools/read-scope/deps, each PRODUCE a distinct partial
//     `fusion/<id>/pN.json` (write-disjoint ⇒ one parallel lane). moa: sibling i = panel[i]'s model;
//     best-of-n: every sibling inherits X's resolved model (diversity from sampling).
//   • (optional) an OBLIGATIONS pre-node deriving the coverage checklist the JUDGE consumes.
//
// Precedence stays OUT of here: a panel/judge ref is CLASSIFIED as a known-active tier (→ `.tier`,
// the runner resolves it via model-routing.ts) else a `.model` — expandFusion never resolves a tier
// to a model. Loud failure: a moa node with no panel throws `FusionConfigError`.

import type { WorkflowSpec, NodeIntent, FusionSpec, NodeIO } from '../../types.js';
import { slugify } from '../../dag.js';
import { fillJudgePrompt, fillObligationsPrompt } from './prompts.js';
import { FUSION_PRESETS, FUSION_OBLIGATIONS, judgePresetId } from './presets.js';

/** Thrown when a fusion activation is unbuildable (e.g. moa with no panel). Loud, never a silent skip. */
export class FusionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FusionConfigError';
  }
}

/** The global fusion defaults (`~/.piflow/fusion.json`) each `node.fusion.<param>` falls back to. */
export interface FusionDefaults {
  mode?: 'moa' | 'best-of-n';
  n?: number;
  panel?: string[];
  judge?: string;
  obligations?: boolean;
  verify?: boolean;
}

/** Inputs to the transform: the global defaults + the (optional) tier map used ONLY to classify refs. */
export interface FusionExpandOpts {
  defaults?: FusionDefaults;
  tiers?: { active: boolean; tiers: Record<string, string> };
}

/** A model/provider/tier triple for a generated node — `.tier` when ref is a known active tier, else `.model`. */
type ModelFields = { model?: string; provider?: string; tier?: string };

/** Classify a panel/judge ref: a known ACTIVE tier alias → `.tier` (runner resolves); otherwise a `.model`. */
function classifyRef(ref: string, tiers: FusionExpandOpts['tiers'], provider?: string): ModelFields {
  if (tiers?.active && Object.prototype.hasOwnProperty.call(tiers.tiers, ref)) return { tier: ref, provider };
  return { model: ref, provider };
}

/** Carry the optional NodeIO fields that belong on a generated PRODUCER (siblings/obligations). */
function producerIo(x: NodeIntent, produces: string, deps: string[] | undefined): NodeIO {
  return {
    reads: x.io.reads ? [...x.io.reads] : [],
    produces: [produces],
    ...(x.io.externalInputs ? { externalInputs: [...x.io.externalInputs] } : {}),
    ...(deps && deps.length ? { dependsOn: [...deps] } : {}),
    artifacts: [{ path: produces }],
  };
}

/** Expand ONE fusion-activated node into `[obligations?, ...siblings, judge]`. */
function expandNode(x: NodeIntent, opts: FusionExpandOpts): NodeIntent[] {
  const f = x.fusion as FusionSpec;
  const d = opts.defaults ?? {};
  // Each generated PRODUCER (sibling / obligations) collects into its OWN unique TOP-LEVEL dir
  // (`fusion-<id>-p<i>/`, `fusion-<id>-obl/`). This is load-bearing: the runner collects every node's
  // output via a per-node `fs.cp(out/<id> → runRoot)` that runs IN PARALLEL for a parallel stage and
  // SWALLOWS errors — so if two siblings shared a collected dir (e.g. `fusion/<id>/p{i}.json`), their
  // concurrent copies would race on the common parent and one partial would be silently dropped (→ a
  // mysterious "blocked"). Disjoint top-level dirs match the only pattern the runner's collect supports
  // for a parallel lane (the way `w2a`/`w2b` write to distinct top-level dirs). The judge reads them back.
  const ns = slugify(x.label, 0);
  const partialPath = (i: number): string => `fusion-${ns}-p${i}/partial.json`;
  const obligationsPath = `fusion-${ns}-obl/obligations.json`;
  const obligations = f.obligations ?? d.obligations ?? false;
  const deps = x.io.dependsOn; // siblings + obligations inherit X's upstream deps

  // Resolve the sibling COUNT + per-sibling model fields per mode.
  let count: number;
  let siblingModel: (i: number) => ModelFields;
  if (f.mode === 'moa') {
    const panel = f.panel ?? d.panel;
    if (!panel || panel.length === 0) {
      throw new FusionConfigError(`moa fusion on "${x.label}" requires a non-empty "panel" (one model/tier per sibling)`);
    }
    count = panel.length;
    siblingModel = (i) => classifyRef(panel[i], opts.tiers, x.provider);
  } else {
    count = f.n ?? d.n ?? 3;
    if (count < 1) throw new FusionConfigError(`best-of-n fusion on "${x.label}" requires n >= 1 (got ${count})`);
    const inherited: ModelFields = { model: x.model, provider: x.provider, tier: x.tier };
    siblingModel = () => inherited;
  }

  // SIBLINGS — clone X's task; each owns + produces a distinct partial (write-disjoint ⇒ a parallel lane).
  const partials: string[] = [];
  const siblings: NodeIntent[] = [];
  for (let i = 1; i <= count; i++) {
    const partial = partialPath(i);
    partials.push(partial);
    siblings.push({
      label: `${x.label}__p${i}`,
      prompt: x.prompt, // clone X's ORIGINAL task verbatim (do NOT redesign agent-facing prose)
      ...(x.skill ? { skill: x.skill } : {}),
      tools: x.tools, // inherit X's concrete tool set (proven for this workflow's file I/O)
      ...(x.phase ? { phase: x.phase } : {}),
      ...siblingModel(i - 1),
      io: producerIo(x, partial, deps),
      sandbox: { ...(x.sandbox ?? {}), write: [partial] },
    });
  }

  // OBLIGATIONS pre-node (optional) — derives the coverage checklist the JUDGE reads.
  const out: NodeIntent[] = [];
  let oblPath: string | undefined;
  if (obligations) {
    oblPath = obligationsPath;
    out.push({
      label: `${x.label}__obl`,
      // The obligations role is a fusion PRESET AGENT → `agentType` brands it (observe → GUI icon).
      agentType: FUSION_OBLIGATIONS,
      prompt: fillObligationsPrompt(FUSION_PRESETS[FUSION_OBLIGATIONS].prompt, { task: x.prompt ?? '' }),
      tools: x.tools, // inherit X's concrete tool set (proven for this workflow's file I/O)
      ...(x.phase ? { phase: x.phase } : {}),
      model: x.model,
      provider: x.provider,
      tier: x.tier,
      io: producerIo(x, oblPath, deps),
      sandbox: { ...(x.sandbox ?? {}), write: [oblPath] },
    });
  }
  out.push(...siblings);

  // JUDGE = X retargeted: keep X's id/produces/contract; read the partials (+ obligations); new prompt.
  const judgeRef = f.judge ?? d.judge;
  const judgeModel: ModelFields = judgeRef
    ? classifyRef(judgeRef, opts.tiers, x.provider)
    : { model: x.model, provider: x.provider, tier: x.tier };
  const judgeReads = [...partials, ...(oblPath ? [oblPath] : [])];
  const judgePreset = judgePresetId(f.mode);
  const judgePrompt = fillJudgePrompt(FUSION_PRESETS[judgePreset].prompt, {
    task: x.prompt ?? '',
    partials,
    obligations: oblPath,
  });
  out.push({
    label: x.label, // KEEP the original id → all of X's downstream edges survive
    // The judge is a fusion PRESET AGENT → `agentType` brands it (and overrides X's own preset, since the
    // judge's role is synthesis, not X's task). A1/A2 are self-contained ⇒ NO skill carried.
    agentType: judgePreset,
    prompt: judgePrompt,
    tools: x.tools, // inherit X's concrete tool set (read partials + write the owned artifact)
    ...(x.phase ? { phase: x.phase } : {}),
    ...judgeModel,
    io: {
      // The judge orders AFTER the siblings via these partial reads; X's original upstream deps are
      // DROPPED (the siblings already carry them) so the judge has exactly one upstream layer.
      reads: judgeReads,
      produces: x.io.produces ? [...x.io.produces] : [],
      ...(x.io.externalInputs ? { externalInputs: [...x.io.externalInputs] } : {}),
      artifacts: x.io.artifacts ? x.io.artifacts.map((a) => ({ ...a })) : [],
      // Keep X's integrity contract — the judge now produces X's artifacts, so the checks/policy apply to it.
      ...(x.io.checks ? { checks: x.io.checks } : {}),
      ...(x.io.checksPrePost ? { checksPrePost: x.io.checksPrePost } : {}),
      ...(x.io.policy ? { policy: x.io.policy } : {}),
      ...(x.io.returnMode ? { returnMode: x.io.returnMode } : {}),
      ...(x.io.returnSchema ? { returnSchema: x.io.returnSchema } : {}),
      ...(x.io.fillSentinel ? { fillSentinel: x.io.fillSentinel } : {}),
      ...(x.io.retries ? { retries: x.io.retries } : {}),
    },
    // The judge is the canonical node: it reads the partials and writes X's owned outputs.
    sandbox: {
      ...(x.sandbox ?? {}),
      read: [...(x.sandbox?.read ?? []), ...judgeReads],
    },
    // Post-processing belongs to the result, which the judge produces — keep X's ops/hooks/checkpoint here.
    ...(x.ops ? { ops: x.ops } : {}),
    ...(x.hooks ? { hooks: x.hooks } : {}),
    ...(x.checkpoint ? { checkpoint: x.checkpoint } : {}),
  });
  return out;
}

/**
 * Expand every fusion-activated node in a WorkflowSpec into siblings + a judge (spec §4). A spec with no
 * `fusion` node is returned UNCHANGED (same object). Pure: no I/O, no model calls. Run BEFORE `compile`.
 */
export function expandFusion(spec: WorkflowSpec, opts: FusionExpandOpts = {}): WorkflowSpec {
  if (!spec.nodes.some((n) => n.fusion)) return spec;
  const nodes: NodeIntent[] = [];
  for (const node of spec.nodes) {
    if (!node.fusion) {
      nodes.push(node); // untouched (referential)
      continue;
    }
    nodes.push(...expandNode(node, opts));
  }
  return { ...spec, nodes };
}

/**
 * Set (or, with `null`, strip) a node's `fusion` activation by id — the AUTHOR-LEVEL toggle a surface
 * (e.g. the GUI's fusion mode) drives, so the siblings+judge expansion stays the SDK's `expandFusion`
 * (never a view-local DAG rewrite). Matches the activated node by its `label` (= the template node id).
 * PURE + immutable: returns a new spec; an unknown id is a no-op. The caller then runs `expandFusion` ⇒
 * `compile` exactly as the run-path does, so a preview is byte-for-byte what a live run would execute.
 */
export function withNodeFusion(spec: WorkflowSpec, nodeId: string, fusion: FusionSpec | null): WorkflowSpec {
  return {
    ...spec,
    nodes: spec.nodes.map((n) => {
      if (n.label !== nodeId) return n; // every other node is referenced untouched
      if (fusion === null) {
        const { fusion: _drop, ...rest } = n; // "off" — strip the activation
        return rest;
      }
      return { ...n, fusion };
    }),
  };
}
