// `piflowctl skills install [targetDir] [--force]` — ship piflow's WORKFLOW-AUTHORING skills (the trio
// piflow-init / piflow-start / piflow-enhance) into ANY target repo's `.claude/skills/`, so a fresh Claude
// Code agent there is equipped to compose workflows against the SDK. The skills ARE the SDK's authoring
// brain; this is how they travel out of this repo.
//
// NO-DRIFT BUNDLING DESIGN (the load-bearing constraint — same discipline as the generated workflow.json):
//   • The CANONICAL skill source is repo-root `.claude/skills/` — the ONE editable copy.
//   • The PACKAGED copy under `packages/cli/skills/` is a GENERATED build artifact: a `prepack` script copies
//     `../../.claude/skills/piflow-{init,start,enhance}` there before `npm pack`, it's in the tarball `files`
//     AND in `.gitignore` (never a committed duplicate that could drift).
//   • `installSkills` is a PURE byte-faithful COPY (never a transform) → an installed SKILL.md is
//     byte-identical to its canonical source. That equality is what the anti-drift test pins.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PromptIO } from './init/types.js';
import { createPromptIO } from './init/prompt.js';

// The workflow-authoring TRIO — the ONLY skills that ship to a consumer repo BY DEFAULT. EXCLUDES
// `piflow-release` (publishing the SDK itself) and `piflow-web-design` (marketing-site only). The prepack
// script copies exactly these into the packaged dir; the dev fallback applies the same allowlist so dev ≡
// packaged. A bare install with no manifest installs EXACTLY the trio — nothing more.
export const TRIO = ['piflow-init', 'piflow-start', 'piflow-enhance'] as const;

/** Optional, OPT-IN skill add-ons: id → the skill dir(s) it installs + a one-line wizard description.
 *  MIRROR the skill-name list in scripts/bundle-skills.mjs (the same dual-copy discipline as TRIO). */
export const SKILL_ADDONS = {
  okf: {
    skills: ['okf-slices'],
    description: 'OKF code-understanding slices — find/maintain code slices (Leg B)',
  },
} as const satisfies Record<string, { skills: readonly string[]; description: string }>;
export type AddonId = keyof typeof SKILL_ADDONS;

/** Absolute path to a target repo's per-project skills manifest. */
function manifestPath(targetDir: string): string {
  return path.join(targetDir, '.piflow', 'skills.json');
}

/** Read `<targetDir>/.piflow/skills.json` → the opted-in add-on ids, filtered to VALID catalog ids (unknown
 *  entries dropped silently). `[]` when the file is absent or unparseable. */
export function readManifest(targetDir: string): AddonId[] {
  const file = manifestPath(targetDir);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { addons?: unknown };
    const addons = Array.isArray(parsed.addons) ? parsed.addons : [];
    return addons.filter((id): id is AddonId => typeof id === 'string' && id in SKILL_ADDONS);
  } catch {
    return []; // unparseable manifest → treat as no add-ons (never crash a plain install)
  }
}

/** Persist the opted-in add-on ids to `<targetDir>/.piflow/skills.json` (creating `.piflow/`). */
export function writeManifest(targetDir: string, addons: AddonId[]): void {
  const file = manifestPath(targetDir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ addons }, null, 2) + '\n');
}

/** Interactive add-on chooser — asks a yes/no for each catalog add-on and returns the accepted ids. Uses
 *  ONLY `confirm`, so no multiselect widget is needed. */
export async function chooseAddons(io: PromptIO): Promise<AddonId[]> {
  const chosen: AddonId[] = [];
  for (const [id, { description }] of Object.entries(SKILL_ADDONS) as [
    AddonId,
    (typeof SKILL_ADDONS)[AddonId],
  ][]) {
    if (await io.confirm(`Install add-on "${id}" — ${description}?`, false)) chosen.push(id);
  }
  return chosen;
}

/**
 * Copy each skill SUBDIR of `srcDir` into `<targetDir>/.claude/skills/<name>`, returning the names actually
 * installed. Pure over the filesystem (no path resolution, no argv) so the copy logic is unit-testable
 * independent of where the packaged skills live. Only immediate SUBDIRECTORIES of `srcDir` are skills (a
 * stray file at the src root is ignored); an optional `only` allowlist further restricts to those names.
 * An existing skill dir is SKIPPED unless `force` (then overwritten).
 */
export function installSkills(
  srcDir: string,
  targetDir: string,
  opts: { force: boolean; only?: readonly string[] },
): string[] {
  const skillsRoot = path.join(targetDir, '.claude', 'skills');
  mkdirSync(skillsRoot, { recursive: true });

  const allow = opts.only ? new Set(opts.only) : null;
  const names = readdirSync(srcDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => allow === null || allow.has(n))
    .sort();

  const installed: string[] = [];
  for (const name of names) {
    const dest = path.join(skillsRoot, name);
    if (existsSync(dest) && !opts.force) continue; // keep the user's copy unless --force
    // recursive byte-faithful copy of the whole skill subtree (SKILL.md + references/ + scripts/).
    cpSync(path.join(srcDir, name), dest, { recursive: true, force: true });
    installed.push(name);
  }
  return installed;
}

/**
 * Resolve the SOURCE skills dir for the CLI: the PACKAGED `<packageRoot>/skills` (shipped in the npm tarball,
 * relative to the compiled cli.js/skills.js), with a DEV FALLBACK to the repo-root `.claude/skills` when the
 * packaged dir is absent (a source checkout / the test runner). Both `dist/skills.js` and `src/skills.ts`
 * sit one level under the package root, so `..` = package root and `../../..` = repo root for either.
 */
function resolveSkillsSrc(): { dir: string; isDevFallback: boolean } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const packaged = path.join(here, '..', 'skills');
  if (existsSync(packaged)) return { dir: packaged, isDevFallback: false };
  return { dir: path.join(here, '..', '..', '..', '.claude', 'skills'), isDevFallback: true };
}

/**
 * `piflowctl skills install [targetDir] [--force] [--with <id>… | --all | --wizard]` — install the
 * workflow-authoring trio (always) plus any opted-in OKF-style ADD-ONS into a target repo.
 *
 * `deps.io` lets tests script the `--wizard` chooser; the live path defaults to the real readline PromptIO.
 */
export async function runSkillsCli(
  argv: string[],
  deps: { io?: PromptIO } = {},
): Promise<void> {
  const [action, ...rest] = argv;
  if (action !== 'install') {
    process.stderr.write(`piflowctl skills: unknown action '${action ?? ''}' (expected: install)\n`);
    process.exitCode = 1;
    return;
  }

  const force = rest.includes('--force');
  const useAll = rest.includes('--all');
  const useWizard = rest.includes('--wizard');
  // `--with <id>` is repeatable: collect the token following each occurrence.
  const withIds: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--with' && rest[i + 1] !== undefined) withIds.push(rest[i + 1]);
  }
  const targetDir = rest.find((a) => !a.startsWith('-')) ?? process.cwd();
  const validIds = Object.keys(SKILL_ADDONS) as AddonId[];

  // Resolve the add-on set + whether to PERSIST it to the manifest, in strict precedence:
  //   --all > --with > --wizard > existing manifest > none.
  let addons: AddonId[];
  let persist: boolean;
  if (useAll) {
    addons = validIds;
    persist = true;
  } else if (withIds.length > 0) {
    const unknown = withIds.filter((id) => !(id in SKILL_ADDONS));
    if (unknown.length > 0) {
      process.stderr.write(
        `piflowctl skills: unknown add-on(s) ${unknown.map((u) => `'${u}'`).join(', ')} — ` +
          `valid ids: ${validIds.join(', ')}\n`,
      );
      process.exitCode = 1;
      return; // bail BEFORE any copy — an unknown --with installs nothing
    }
    addons = withIds as AddonId[];
    persist = true;
  } else if (useWizard) {
    // The real PromptIO owns a readline interface that MUST be closed or the process hangs on open stdin
    // after the prompts (a scripted test io has no interface — close is a no-op).
    const { io, close } = deps.io ? { io: deps.io, close: () => {} } : createPromptIO();
    try {
      addons = await chooseAddons(io);
    } finally {
      close();
    }
    persist = true;
  } else {
    // No explicit choice → remember the last one from the per-project manifest (read-only, no rewrite).
    addons = readManifest(targetDir);
    persist = false;
  }

  // The packaged dir is already prepack-filtered to the trio + add-on skills; the dev fallback (full
  // repo-root .claude/skills) is filtered by the SAME resolved skill set so a source-checkout install
  // matches the published tarball exactly. ALWAYS pass `only` (both paths) so the packaged dir — which
  // now also carries add-on skills — never leaks a non-selected skill into a default install.
  const skillSet = [...new Set([...TRIO, ...addons.flatMap((id) => SKILL_ADDONS[id].skills)])];
  const { dir: srcDir } = resolveSkillsSrc();
  const installed = installSkills(srcDir, targetDir, { force, only: skillSet });
  const skillsRoot = path.join(targetDir, '.claude', 'skills');

  if (persist) writeManifest(targetDir, addons);

  if (installed.length === 0) {
    process.stdout.write(
      `piflowctl skills: nothing installed — all skills already present in ${skillsRoot} (re-run with --force to overwrite)\n`,
    );
  } else {
    process.stdout.write(
      `piflowctl skills: installed ${installed.length} skill(s) into ${skillsRoot}\n` +
        installed.map((n) => `  • ${n}`).join('\n') +
        '\n',
    );
  }
  if (addons.length > 0) {
    // NOTE: this ships the add-on SKILL(s) only — a pure .claude/skills byte-copy. Seeding the OKF
    // generator / `.agents/okf/` for a repo is a SEPARATE future step (not done here).
    process.stdout.write(
      `piflowctl skills: add-ons [${addons.join(', ')}]` +
        (persist ? ` recorded in ${manifestPath(targetDir)}` : ` from ${manifestPath(targetDir)}`) +
        '\n',
    );
  }
}
