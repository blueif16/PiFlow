/**
 * bundle.mjs — assemble the merged game src and esbuild-bundle the boot entry.
 * ============================================================================
 *
 * Reproduces the W2 scaffold layout faithfully: copy templates/core/src, OVERLAY
 * the archetype module's src on top (the module wins on a name clash — exactly
 * how the scaffold overlays), drop boot-entry.ts into the merged tree, then
 * esbuild it to a single ESM bundle with `@contract` + `phaser` aliased. The
 * bundle is the REAL assembled engine; the harness imports it.
 *
 * Bundling once (vs a per-import loader) is what makes the per-test cost a fast
 * boot+step rather than a tsc/transform pass; the bundle is cached by content
 * hash of (module src + core src + testkit), so a re-run with no source change
 * skips esbuild entirely.
 */
import {
  cpSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  statSync,
  readdirSync,
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
// repo root = templates/core-contract/src/testkit → up 4
export const repoRoot = resolve(here, '..', '..', '..', '..');

// esbuild lives in templates/core/node_modules (the run cwd's package). Resolve
// it against core (this testkit is in the sibling core-contract tree). See
// dom-env.mjs for the same one-place-for-deps rationale.
const coreRequire = createRequire(
  pathToFileURL(resolve(repoRoot, 'templates/core/package.json')).href,
);
const { build } = await import(
  pathToFileURL(coreRequire.resolve('esbuild')).href
);
export const coreSrc = resolve(repoRoot, 'templates/core/src');
export const contractSrc = resolve(repoRoot, 'templates/core-contract/src');
export const phaserEntry = resolve(
  repoRoot,
  'templates/core/node_modules/phaser/dist/phaser.js',
);

/** The module src dir for an archetype id (default platformer). */
export function moduleSrc(archetype = 'platformer') {
  return resolve(repoRoot, 'templates/modules', archetype, 'src');
}

/** A content hash over a directory tree (paths + sizes + mtimes — cheap, stable). */
function hashTree(dir, acc) {
  for (const name of readdirSync(dir).sort()) {
    if (name === '__tests__' || name === 'node_modules') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) hashTree(p, acc);
    else acc.update(`${p}:${st.size}:${st.mtimeMs}\n`);
  }
}

/**
 * Build (or reuse) the headless bundle for an archetype.
 * @returns { bundlePath } absolute path to the ESM bundle.
 */
export async function buildHeadlessBundle(archetype = 'platformer') {
  const mod = moduleSrc(archetype);
  if (!existsSync(mod)) {
    throw new Error(
      `[testkit] module src not found for archetype "${archetype}": ${mod}`,
    );
  }
  const bootEntry = resolve(here, 'boot-entry.ts');

  // Cache key: hash of core src + module src + the testkit (boot-entry/dom-env).
  const h = createHash('sha1');
  hashTree(coreSrc, h);
  hashTree(mod, h);
  h.update(readFileSync(bootEntry));
  h.update(readFileSync(resolve(here, 'dom-env.mjs')));
  const key = h.digest('hex').slice(0, 16);

  const outDir = resolve(here, '.cache', archetype);
  const bundlePath = join(outDir, `boot.${key}.mjs`);
  if (existsSync(bundlePath)) return { bundlePath };

  // Assemble the merged src in a temp build dir (core, then module overlay).
  // Layout mirrors a scaffolded game: <gameRoot>/src/** + <gameRoot>/index.json,
  // so Preloader's `../../index.json` (from src/scenes/) resolves to a real file.
  const gameRoot = join(outDir, 'game');
  const mergeDir = join(gameRoot, 'src');
  rmSync(gameRoot, { recursive: true, force: true });
  mkdirSync(mergeDir, { recursive: true });
  cpSync(coreSrc, mergeDir, { recursive: true });
  cpSync(mod, mergeDir, { recursive: true }); // module wins on a clash
  // The empty-but-playable default manifest (no generated art — slots:[]). The
  // module's own index.json wins if it ships one (it usually doesn't).
  const moduleIndex = resolve(mod, '..', 'index.json');
  const coreIndex = resolve(coreSrc, '..', 'index.json');
  cpSync(existsSync(moduleIndex) ? moduleIndex : coreIndex, join(gameRoot, 'index.json'));
  // Drop the boot entry into the merged tree (so its ./scenes/… ./systems/…
  // ./hook relative imports resolve against the assembled src).
  cpSync(bootEntry, join(mergeDir, '__bootHeadless.ts'));

  // Clear any stale bundles for this archetype (keep only the fresh one).
  for (const f of existsSync(outDir) ? readdirSync(outDir) : []) {
    if (f.startsWith('boot.') && f.endsWith('.mjs')) {
      rmSync(join(outDir, f), { force: true });
    }
  }

  // Resolve node deps (phaser3-rex-plugins, …) from core's node_modules — the
  // merged-src tree has none of its own.
  const coreNodeModules = resolve(repoRoot, 'templates/core/node_modules');
  // boot-entry re-exports `./behaviors/BehaviorManager` so the harness can attach
  // a behavior the DataLevelScene way. Most overlays ship one; some (grid_logic)
  // are BehaviorManager-FREE (grid-native IGridBehavior, mounted via resolveBehavior).
  // Stub the import ONLY when the merged tree has no real file, so a manager-free
  // archetype still bundles + boots (it never touches the stub — it mounts via
  // resolveBehavior). A real file always resolves normally (return null).
  const optionalBehaviorManager = {
    name: 'optional-behavior-manager',
    setup(b) {
      b.onResolve({ filter: /behaviors\/BehaviorManager$/ }, (args) => {
        if (existsSync(resolve(args.resolveDir, `${args.path}.ts`))) return null;
        return { path: args.path, namespace: 'tk-bm-stub' };
      });
      b.onLoad({ filter: /.*/, namespace: 'tk-bm-stub' }, () => ({
        contents:
          'export class BehaviorManager { constructor(){} add(){} update(){} remove(){} }',
        loader: 'js',
      }));
    },
  };
  await build({
    entryPoints: [join(mergeDir, '__bootHeadless.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    outfile: bundlePath,
    loader: { '.json': 'json' },
    nodePaths: [coreNodeModules],
    alias: {
      phaser: phaserEntry,
      '@contract': contractSrc,
    },
    plugins: [optionalBehaviorManager],
    logLevel: 'error',
  });

  return { bundlePath };
}

// CLI: `node bundle.mjs [archetype]` → prints the bundle path (warms the cache).
if (import.meta.url === `file://${process.argv[1]}`) {
  const archetype = process.argv[2] || 'platformer';
  const { bundlePath } = await buildHeadlessBundle(archetype);
  // eslint-disable-next-line no-console
  console.log(bundlePath);
}
