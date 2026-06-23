// The GENERATED workflow.json lock (template-format.md §5/§8 step 4). DERIVED from meta.json + every
// node.json: the resolved topology (stages from topological levels; per-node deps mirror). The compile
// step (re)writes it on every build so it is ALWAYS in sync with the node set — never hand-edited (a
// `piflow check` staleness gate would fail on drift). Mirrors package.json ⟷ package-lock.json.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { LoadedNode, TemplateMeta } from './types.js';
import { topoLevels } from './checks.js';

/** The generated lock shape (template-format.md §5; pinned by workflowSchema). */
export interface GeneratedWorkflowJson {
  id: string;
  meta: { name: string; description: string };
  stages: string[][];
  nodes: Record<string, { phase: string; deps: string[] }>;
}

/** Derive the stages array (topological levels, ids sorted within a level for determinism). */
export function deriveStages(nodes: LoadedNode[]): string[][] {
  const byLevel = topoLevels(nodes);
  return [...byLevel.keys()]
    .sort((a, b) => a - b)
    .map((l) => (byLevel.get(l) ?? []).slice().sort());
}

/** Build the generated workflow.json object from the loaded set (the single source = the node.jsons). */
export function buildWorkflowJson(meta: TemplateMeta, nodes: LoadedNode[]): GeneratedWorkflowJson {
  const out: GeneratedWorkflowJson = {
    id: meta.id,
    meta: { name: meta.name, description: meta.description },
    stages: deriveStages(nodes),
    nodes: {},
  };
  for (const n of nodes.slice().sort((a, b) => a.def.id.localeCompare(b.def.id))) {
    out.nodes[n.def.id] = { phase: n.def.phase, deps: n.def.deps };
  }
  return out;
}

/**
 * (Re)write workflow.json IFF it differs from the freshly-derived lock — so a stale committed lock is
 * regenerated in sync, and an already-synced one is left byte-identical (no needless churn / git noise).
 * Returns whether it was rewritten.
 */
export async function writeWorkflowJson(dir: string, generated: GeneratedWorkflowJson): Promise<boolean> {
  const file = path.join(dir, 'workflow.json');
  const next = JSON.stringify(generated, null, 2) + '\n';
  let prev: string | null = null;
  try {
    prev = await fs.readFile(file, 'utf8');
  } catch {
    prev = null;
  }
  if (prev === next) return false;
  await fs.writeFile(file, next);
  return true;
}
