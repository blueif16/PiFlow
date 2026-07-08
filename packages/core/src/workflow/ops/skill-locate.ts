// SKILL locator — the IMPURE sibling of `skill.ts` (which stays pure). `resolveSkillStage` turns a ref
// into a workspace-rooted path with NO filesystem access — which meant a BARE skill id (e.g.
// "multi-source-research") resolved to `<workspace>/<id>`, never existed, and the runner SILENTLY
// skipped staging while the GUI display path (which searches wider roots) still showed the skill.
// This module closes that split: it CLASSIFIES a ref — PATH-LIKE (a separator, an absolute path, or a
// `{{token}}`) keeps `resolveSkillStage`'s exact semantics; a BARE ID searches the two PROJECT-LOCAL RINGS
// in order — Ring 0 `<workspace>/.agents/skills/<id>`, then Ring 1 `<workspace>/.claude/skills/<id>` (where
// `piflowctl skills install` lands them) — accepting only a dir that CONTAINS a `SKILL.md` (first hit wins).
// `skillSearchRoots` exports that ordering as the single source of truth so the server display handler can
// consume the SAME rings, and `listSkills` enumerates both rings for the catalog surface (.agents wins an id
// clash; the shadowed .claude bundle is still reported, flagged). NEVER the global `~/.piflow/skills` — skill
// resolution is ALWAYS project-local, so a run reproduces from the product alone with no machine-global state.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveSkillStage, type SkillStage } from './skill.js';
import { parseSkillManifest } from './skill-manifest.js';
import type { ResolveCtx } from '../resolver.js';

/** A BARE skill id: no path separator, not absolute, no `{{token}}` — the only shape that ring-searches. */
export function isBareSkillId(ref: string): boolean {
  return !path.isAbsolute(ref) && !ref.includes('/') && !ref.includes('\\') && !ref.includes('{{');
}

/**
 * The ordered ring roots a bare skill id searches, BOTH project-local: `<workspace>/.agents/skills` (Ring 0
 * — the project's own bundles), then `<workspace>/.claude/skills` (Ring 1 — where `piflowctl skills install`
 * lands the installed catalog). THE single source of truth for that ordering — the runner stages by it and
 * the server display path must search by it, so a skill a viewer can show is a skill the runtime actually
 * stages. NEVER the global `~/.piflow/skills`: resolution hangs entirely off the product-root workspace.
 */
export function skillSearchRoots(workspace: string): string[] {
  return [path.join(workspace, '.agents', 'skills'), path.join(workspace, '.claude', 'skills')];
}

/**
 * Where a declared skill ref landed: `found` carries the stage (source + staged dir name, the exact
 * shape the runner copies from); a miss carries the ref + EVERY searched candidate so the caller can
 * surface a LOUD, actionable signal (never the old silent skip). `undefined` ⇒ no skill declared.
 */
export type SkillLocateResult =
  | { found: true; stage: SkillStage }
  | { found: false; ref: string; searched: string[] }
  | undefined;

/**
 * Resolve a node's `skill` ref to a stageable source, IMPURE (stats the filesystem so a miss is known
 * here, not silently downstream). PATH-LIKE refs delegate to `resolveSkillStage` byte-identically (the
 * `{{WORKSPACE}}`/`{{RUN}}`/`{{state.*}}` + workspace-rooted semantics every existing template relies
 * on); BARE ids search the rings, accepting a dir only when its `SKILL.md` exists.
 */
export async function locateSkillStage(
  skillRef: string | undefined,
  ctx: ResolveCtx,
): Promise<SkillLocateResult> {
  if (!skillRef || !skillRef.trim()) return undefined;
  if (!isBareSkillId(skillRef)) {
    const stage = resolveSkillStage(skillRef, ctx) as SkillStage; // non-blank ref ⇒ always defined
    const ok = await fs.stat(stage.source).then(() => true, () => false);
    return ok ? { found: true, stage } : { found: false, ref: skillRef, searched: [stage.source] };
  }
  const searched = skillSearchRoots(ctx.workspace).map((root) => path.join(root, skillRef));
  for (const dir of searched) {
    const hit = await fs.stat(path.join(dir, 'SKILL.md')).then((s) => s.isFile(), () => false);
    if (hit) return { found: true, stage: { source: dir, name: skillRef } };
  }
  return { found: false, ref: skillRef, searched };
}

/** One enumerated skill bundle (a ring dir that contains a SKILL.md). */
export interface SkillListEntry {
  /** The RESOLVABLE id — the bundle DIR name, the exact token a node's bare `skill:` ref uses. */
  id: string;
  /** Absolute path to the bundle dir. */
  dir: string;
  /** Which project ring the bundle lives in: `.agents/skills` (`'workspace'`) or `.claude/skills`
   *  (`'installed'` — where `piflowctl skills install` lands them). */
  ring: 'workspace' | 'installed';
  /** The manifest's own name (SKILL.md frontmatter `name`, else the dir id). */
  name: string;
  /** The frontmatter `description` line (quote-stripped) — extracted the way the server display handler does. */
  description: string;
  /** Manifest FLOOR — parseSkillManifest `requires` (empty on a permissive/errored manifest). */
  requires: string[];
  /** Manifest CEILING — parseSkillManifest `allowed` (empty on a permissive/errored manifest). */
  allowed: string[];
  display?: { label?: string; icon?: string; color?: string };
  /** Set on an installed entry HIDDEN by a workspace bundle with the same id (workspace wins a clash). */
  shadowed?: boolean;
  /** A manifest parse error (e.g. requires ⊄ allowed) — the entry still lists; it never sinks the listing. */
  error?: string;
}

// The SAME frontmatter regex core parses SKILL.md with (skill-manifest.ts / the server display handler).
const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/;

/** Pull the frontmatter `description` line (parseSkillManifest does NOT parse it), stripping one quote layer. */
function extractDescription(raw: string): string {
  const fm = FRONTMATTER.exec(raw);
  const dm = fm && /^description:[ \t]*(.+)$/m.exec(fm[1]);
  if (!dm) return '';
  let d = dm[1].trim();
  if (d.length >= 2 && ((d[0] === '"' && d.endsWith('"')) || (d[0] === "'" && d.endsWith("'")))) d = d.slice(1, -1);
  return d;
}

/**
 * Enumerate the two PROJECT-LOCAL skill rings — Ring 0 `<workspace>/.agents/skills/*`, then Ring 1
 * `<workspace>/.claude/skills/*` — in the SAME order `locateSkillStage` searches, so the listing is exactly
 * the resolvable catalog. Both rings hang off the workspace, so with NO workspace there is nothing to
 * enumerate (never a global scan). Only a dir carrying a `SKILL.md` is a bundle; a missing ring is simply
 * empty; a malformed manifest yields an `error`-noted entry, never a throw.
 */
export async function listSkills(opts: { workspace?: string } = {}): Promise<SkillListEntry[]> {
  const rings: { root: string; ring: SkillListEntry['ring'] }[] = [];
  if (opts.workspace) {
    rings.push({ root: path.join(opts.workspace, '.agents', 'skills'), ring: 'workspace' });
    rings.push({ root: path.join(opts.workspace, '.claude', 'skills'), ring: 'installed' });
  }

  const out: SkillListEntry[] = [];
  const seen = new Set<string>();
  for (const { root, ring } of rings) {
    let ids: string[] = [];
    try {
      ids = (await fs.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    } catch {
      continue; // a missing ring is simply empty
    }
    for (const id of ids) {
      const dir = path.join(root, id);
      let raw: string;
      try {
        raw = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8');
      } catch {
        continue; // no SKILL.md ⇒ not a skill bundle
      }
      const entry: SkillListEntry = { id, dir, ring, name: id, description: extractDescription(raw), requires: [], allowed: [] };
      try {
        const m = parseSkillManifest(raw, id);
        entry.name = m.id;
        entry.requires = m.requires;
        entry.allowed = m.allowed;
        if (m.display) entry.display = m.display;
      } catch (e) {
        entry.error = (e as Error).message; // malformed manifest — listed with the note, never a sink
      }
      if (seen.has(id)) entry.shadowed = true; // an earlier (workspace) ring already claimed this id
      seen.add(id);
      out.push(entry);
    }
  }
  return out;
}
