// SKILL stage resolver — the PRE-stage family sibling of `seed.ts`. A node's `skill` (a {{WORKSPACE}}-rooted
// path to an Agent-Skill directory) is, like a seed, a forced read-only artifact the runner stages into the
// sandbox BEFORE the model runs — here into the pi-native `.pi/skills/<name>/` discovery dir, then named with
// `pi --skill` (docs/design/skills-integration.md, option C). This module is the PURE resolution half: it
// turns the `skill` ref into the absolute host source + the staged dir name. The host→sandbox staging itself
// is the runner's job (it reuses `stageHostPathIntoSandbox`, the same seam seeds use).
//
// REUSE: token resolution is the shared `resolveTokens` (the SAME one seeds/artifacts use), so a skill ref
// resolves `{{WORKSPACE}}`/`{{RUN}}`/`{{state.*}}` exactly as every other path does — no bespoke parser. The
// staged dir `name` is the source's basename; pi reads the skill's REAL name from its `SKILL.md` frontmatter,
// so the container dir name is just a stable, collision-free location (no frontmatter parsing needed here).

import path from 'node:path';
import { resolveTokens, type ResolveCtx } from '../resolver.js';

/** The resolved skill stage: where to copy FROM (host) and the dir NAME to stage it under (in `.pi/skills/`). */
export interface SkillStage {
  /** Absolute host path to the skill source (an Agent-Skill directory containing `SKILL.md`). */
  source: string;
  /** The staged dir name (= the source's basename). pi reads the real skill name from `SKILL.md`. */
  name: string;
}

/**
 * Resolve a node's `skill` ref into a {@link SkillStage}, or `undefined` when the node declares no skill (so
 * a skill-less node is fully additive). The ref's `{{WORKSPACE}}`/`{{RUN}}`/`{{state.*}}` tokens resolve via
 * the shared `resolveTokens`; a still-relative result is made absolute against the workspace root (where
 * skills canonically live — `ResolveCtx.workspace`). PURE: no filesystem access (the runner checks existence
 * + stages).
 */
export function resolveSkillStage(skillRef: string | undefined, ctx: ResolveCtx): SkillStage | undefined {
  if (!skillRef || !skillRef.trim()) return undefined;
  const resolved = resolveTokens(skillRef, ctx);
  const source = path.isAbsolute(resolved) ? resolved : path.resolve(ctx.workspace, resolved);
  return { source, name: path.basename(source) };
}
