#!/usr/bin/env node
// PREPACK build step — copy the DEFAULT skill set from the canonical repo-root `.claude/skills/` into
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

// The DEFAULT skill set travels to a consumer repo BY DEFAULT — the authoring pair (init/start) +
// piflow-maintenance (the canonical node-config/run-condition standards reference — init's brother) +
// piflow-inspect (the instrument router) + the four optimize-loop agents piflow-triage (issue authoring),
// piflow-fixer (the fixer playbook; OWNS the portable method library under piflow-fixer/library/ — Leg C,
// travels with the fixer), piflow-gate (judges the candidate fix), and piflow-overlord (control plane). EXCLUDES
// piflow-release (SDK publishing), piflow-web-design (marketing-site only), and piflow-enhance (RETIRED). MIRROR
// DEFAULT_SKILLS in src/skills.ts (this plain .mjs can't import the TS catalog). A skill's whole subtree (incl.
// piflow-fixer/library) is copied recursively, so the library rides along automatically.
const DEFAULT_SKILLS = ['piflow-init', 'piflow-start', 'piflow-maintenance', 'piflow-inspect', 'piflow-triage', 'piflow-fixer', 'piflow-gate', 'piflow-overlord'];
// Plus the opt-in ADD-ON skills so `skills install --with/--all` can reach them from the tarball. MIRROR
// SKILL_ADDONS in src/skills.ts (this plain .mjs can't import the TS catalog) — understand → okf-slices,
// memory → memory-slices.
const ADDON_SKILLS = ['okf-slices', 'memory-slices'];
const BUNDLED = [...DEFAULT_SKILLS, ...ADDON_SKILLS];

rmSync(dest, { recursive: true, force: true }); // regenerate from scratch — never accrete stale skills
mkdirSync(dest, { recursive: true });
for (const name of BUNDLED) {
  cpSync(path.join(canonical, name), path.join(dest, name), { recursive: true });
}
process.stdout.write(`bundle-skills: staged ${BUNDLED.length} skill(s) into ${path.relative(repoRoot, dest)}\n`);
