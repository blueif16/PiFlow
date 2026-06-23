// pi-runner SDK bridge — Claude-Workflow `.js` → @piflow/core `WorkflowSpec`, WITH hooks.
//
// Reimplements the workflow-intake port (parse-claude-workflow.mjs) IN our module so we can ADD the hook
// step the port omits (decision 2 of design/sdk-convergence-phase2.md). The mapping (extractWorkflow →
// NodeIntent[]) is byte-for-byte the port's: realized prompt with DRIVER-* lines STRIPPED into `prompt`;
// parseMarkers → io.artifacts/schema/checks/policy/returnMode/fillSentinel, tools.allow/deny,
// sandbox.read/write; io.dependsOn = the previous stage's node ids. The ADDITION: per node,
// hooks = nodeHooks(RAW prompt) so the SDK keeps game-omni's deterministic DRIVER-SEED/PROJECT/MERGE/
// SEED-CONTRACT ops, bound to pi-runner/hooks/.
//
// The workflow file is READ-ONLY input (extractWorkflow records its body in-memory; no model calls, no
// writes). buildWorkflowSpec does NOT run the oracle compile — the caller compiles (the bridge test does,
// mirroring the port's self-check).

import path from "node:path";
import { parseMarkers, slugify } from "@piflow/core";
import { extractWorkflow } from "../extract.mjs";
import { nodeHooks } from "./hook-bindings.mjs";

// Strip the machine markers from the prose (the hooks re-emit them; keeping them in the prompt would
// duplicate them in the spawned pi prompt). Only DRIVER-* lines go; the human/LLM-facing prose stays.
// Byte-identical to parse-claude-workflow.mjs stripMarkers.
function stripMarkers(prompt) {
  return prompt
    .split("\n")
    .filter((line) => !/^\s*DRIVER-[A-Z0-9-]+\s*:/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// buildWorkflowSpec(workflowPath, args, opts?) → WorkflowSpec.
//   args : workflow args passed through to the recording (e.g. { prompt, projectDir, mode }).
//   opts : { hookCtx?, resolveProjectBase? } — forwarded to nodeHooks so the produced Hook.run binds to
//          the right run context (ROOT/HERE) + the per-fire PROJECT_BASE. When omitted, the hooks resolve
//          projectBase from each fire's HookContext.workspace (the SDK runner supplies it).
export async function buildWorkflowSpec(workflowPath, args = {}, opts = {}) {
  const wfPath = path.resolve(workflowPath);
  const { stages, meta } = await extractWorkflow(wfPath, args);
  if (!stages.length) {
    throw new Error(`buildWorkflowSpec: extraction recorded ZERO agent() calls from ${wfPath} — is this a Claude Code Workflow .js?`);
  }

  // Flatten in execution order; remember each node's stage index to chain dependsOn to the prior stage
  // (preserves the EXACT recorded DAG — the mechanical port).
  const flat = [];
  stages.forEach((stage, sIdx) => stage.nodes.forEach((rec) => flat.push({ rec, sIdx })));
  const labelOf = flat.map(({ rec }, i) => rec.label || `node-${i}`);
  // Predict the id `compile` assigns each node so dependsOn can reference it. MUST mirror tryCompile:
  // slugify(label, flatIndex), then dedup collisions with a -2/-3… suffix.
  const used = new Set();
  const idOf = labelOf.map((label, i) => {
    let id = slugify(label, i);
    const base = id;
    let n = 1;
    while (used.has(id)) { n++; id = `${base}-${n}`; }
    used.add(id);
    return id;
  });
  const idsByStage = new Map();
  flat.forEach(({ sIdx }, i) => {
    if (!idsByStage.has(sIdx)) idsByStage.set(sIdx, []);
    idsByStage.get(sIdx).push(idOf[i]);
  });

  const nodes = flat.map(({ rec, sIdx }, i) => {
    const m = parseMarkers(rec.prompt);
    const artifacts = (m.artifacts ?? []).map((p) => {
      const s = (m.schema ?? []).find((x) => x.path === p);
      return s ? { path: p, schema: s.schema } : { path: p };
    });
    const io = {
      reads: [], // the mechanical port carries the DAG via dependsOn; data-flow reads are a refinement
      produces: [],
      artifacts,
      ...(sIdx > 0 ? { dependsOn: idsByStage.get(sIdx - 1) } : {}),
      ...(m.checks ? { checks: m.checks } : {}),
      ...(m.policy ? { policy: m.policy } : {}),
      ...(m.returnMode ? { returnMode: m.returnMode } : {}),
      ...(m.fillSentinel ? { fillSentinel: m.fillSentinel } : {}),
    };
    // The ADDITION over the port: re-attach the deterministic hooks parsed from the RAW (un-stripped)
    // prompt, bound to pi-runner/hooks/.
    const { pre, post } = nodeHooks(rec.prompt, opts.hookCtx ?? {}, opts.resolveProjectBase);
    const node = {
      label: rec.label || `node-${i}`,
      prompt: stripMarkers(rec.prompt),
      tools: {
        ...(m.tools ? { allow: m.tools } : {}),
        ...(m.excludeTools ? { deny: m.excludeTools } : {}),
      },
      io,
    };
    if (rec.agentType) node.agentType = rec.agentType;
    if (m.owns || m.readScope) {
      node.sandbox = { ...(m.readScope ? { read: m.readScope } : {}), ...(m.owns ? { write: m.owns } : {}) };
    }
    if (pre.length || post.length) {
      node.hooks = { ...(pre.length ? { pre } : {}), ...(post.length ? { post } : {}) };
    }
    return node;
  });

  return {
    meta: { name: meta?.name || path.basename(wfPath, ".js"), description: meta?.description || "" },
    nodes,
  };
}
