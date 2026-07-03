// Skill-FLOOR wiring — the run-start pre-pass that makes the DORMANT `requires`-floor live (D6).
//
// A node's bound skill's `requires` list is a dependency FLOOR (docs/design/skills-integration.md D6):
// binding a skill MEANS the node must get those tools. Until now the floor was parsed only at author time
// (workflow/judge/materialize.ts) and never reached a real run — a node bound to a skill that requires
// `mcp.exa:web_search_exa` got the tool ONLY if the author ALSO hand-listed it in `tools.allow`.
//
// This closes the gap at the ONE seam that works: the runner entry, AFTER the expand passes and BEFORE
// `resolveRunTools`/`catalogForSpec` slice the spec by its selected `mcp.*` addresses (runner/entry.ts).
// The seam has the WORKSPACE root in hand (`locateSkillStage` needs it to ring-search a bare id) and keeps
// `loadTemplate` byte-identical for skill-less nodes (it never runs there). For each node that binds a skill
// which RESOLVES + carries a manifest, we union its `requires` into `tools.allow` (dedup; the node's explicit
// DENY wins, mirroring `mergePreset`). A required `mcp.*` absent from the catalog then fails FAST at the
// node's existing pre-spawn bind check (`verifyToolBinding` → `blocked`, or the registry's `unknown tool
// address` throw) — bare-name-aware, so the real `read`/`write` bare-name floors bind cleanly.
//
// ADDITIVE + fail-open on LOCATION: a node with no skill, a skill that does not resolve, or a skill with no
// manifest is left byte-identical (the runner's existing loud-miss at node launch still fires for a true
// miss). A ref we cannot resolve at run-start (e.g. a `{{state.*}}` path that needs runtime channels) is
// SKIPPED — never a run-start failure — leaving staging to node launch. The ONE hard failure is a PRESENT
// but MALFORMED manifest (`requires ⊄ allowed`): `parseSkillManifest` throws its clear message and we let it
// propagate (fail the run at start with the parser message, not a crash stack).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { WorkflowSpec } from '../types.js';
import type { ResolveCtx } from '../workflow/resolver.js';
import { locateSkillStage } from '../workflow/ops/skill-locate.js';
import { parseSkillManifest } from '../workflow/ops/skill-manifest.js';

/** The two logical roots the wire resolves a skill ref against, + the optional run args and a PIFLOW_HOME override (tests). */
export interface SkillFloorCtx {
  /** `{{RUN}}` — the per-thread run root (path-like skill refs resolve `{{RUN}}` against it). */
  run: string;
  /** `{{WORKSPACE}}` — the tree a BARE skill id ring-searches (`<workspace>/.agents/skills/<id>`). */
  workspace: string;
  /** The run-level `{{arg.*}}` values (forwarded so a path-like ref using `{{arg.*}}` resolves). */
  args?: Record<string, string>;
  /** PIFLOW_HOME override for the installed-skill ring (test seam); default = `process.env.PIFLOW_HOME ?? ~/.piflow`. */
  piflowHome?: string;
}

/**
 * MUTATE `spec` in place: for every node whose bound skill resolves to a manifest carrying a `requires`
 * floor, union that floor into the node's `tools.allow` (dedup; the node's explicit `deny` wins). Returns
 * nothing — the caller runs `resolveRunTools` on the mutated spec next, so the wired `mcp.*` floors are
 * sliced into the catalog + bind-checked.
 *
 * Throws ONLY on a malformed manifest (`requires ⊄ allowed`) — the parser's clear message (never a crash).
 */
export async function wireSkillFloors(spec: WorkflowSpec, ctx: SkillFloorCtx): Promise<void> {
  const resolveCtx: ResolveCtx = { run: ctx.run, workspace: ctx.workspace, args: ctx.args };
  for (const node of spec.nodes) {
    if (!node.skill || !node.skill.trim()) continue; // no skill ⇒ byte-identical.

    // LOCATE. A ref that cannot be resolved at run-start (e.g. a `{{state.*}}` path needing runtime
    // channels, or any fs error) is left to node launch — never a run-start failure.
    let located;
    try {
      located = await locateSkillStage(node.skill, resolveCtx, ctx.piflowHome);
    } catch {
      continue;
    }
    if (!located || !located.found) continue; // not found ⇒ no wire (the runner's loud-miss stands at launch).

    // READ the manifest. A skill dir with NO SKILL.md carries no floor ⇒ permissive (leave byte-identical).
    let raw: string;
    try {
      raw = await fs.readFile(path.join(located.stage.source, 'SKILL.md'), 'utf8');
    } catch {
      continue;
    }

    // PARSE — throws the clear `requires ⊄ allowed` message on a malformed manifest (propagate → fail at start).
    const manifest = parseSkillManifest(raw, located.stage.name);
    if (!manifest.requires.length) continue; // empty/absent floor ⇒ nothing to wire.

    // UNION the floor into allow; the node's explicit DENY wins (drop a denied floor id — mergePreset precedent).
    const tools = node.tools ?? {};
    const denySet = new Set(tools.deny ?? []);
    const floor = manifest.requires.filter((r) => !denySet.has(r));
    const nextAllow = [...new Set([...(tools.allow ?? []), ...floor])];
    node.tools = { ...tools, allow: nextAllow };
  }
}
