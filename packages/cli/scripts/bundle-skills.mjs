#!/usr/bin/env node
// PREPACK build step — copy the workflow-authoring TRIO from the canonical repo-root `.claude/skills/` into
// this package's `skills/` so the npm tarball carries them. THE NO-DRIFT DESIGN: the canonical source is
// repo-root `.claude/skills/` (the ONE editable copy); `packages/cli/skills/` is a GENERATED ARTIFACT —
// gitignored, never hand-edited, regenerated here before every pack — exactly like a generated workflow.json.
// Run by npm/pnpm `prepack` (cwd = this package dir) before `npm pack` / publish.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)); // packages/cli/scripts
const pkgRoot = path.join(here, '..'); // packages/cli
const repoRoot = path.join(pkgRoot, '..', '..'); // repo root
const canonical = path.join(repoRoot, '.claude', 'skills');
const dest = path.join(pkgRoot, 'skills');

// The workflow-authoring trio travels to a consumer repo BY DEFAULT — EXCLUDES piflow-release (SDK
// publishing) and piflow-web-design (marketing-site only).
const TRIO = ['piflow-init', 'piflow-start', 'piflow-enhance'];
// Plus the opt-in ADD-ON skills so `skills install --with/--all` can reach them from the tarball. MIRROR
// SKILL_ADDONS in src/skills.ts (this plain .mjs can't import the TS catalog) — understand → okf-slices,
// memory → memory-slices.
const ADDON_SKILLS = ['okf-slices', 'memory-slices'];
const BUNDLED = [...TRIO, ...ADDON_SKILLS];

rmSync(dest, { recursive: true, force: true }); // regenerate from scratch — never accrete stale skills
mkdirSync(dest, { recursive: true });
for (const name of BUNDLED) {
  cpSync(path.join(canonical, name), path.join(dest, name), { recursive: true });
}
process.stdout.write(`bundle-skills: staged ${BUNDLED.length} skill(s) into ${path.relative(repoRoot, dest)}\n`);
