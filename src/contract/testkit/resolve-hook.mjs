/**
 * resolve-hook.mjs — the ONE ESM resolve hook for ALL kit drive tests (system AND behavior).
 *
 * EXTRACTED + UNIFIED from the two per-module hooks (systems/__tests__/contract-alias-hook.mjs
 * + behaviors/__tests__/behavior-test-resolve-hook.mjs). It resolves, under bare `node`,
 * everything a drive test needs WITHOUT editing the unmodified component sources:
 *
 *   - `@contract/*`  → the REAL core-contract/src source (the same alias tsc uses). This hook
 *     lives in core-contract/src/testkit, so `@contract/foo` → `../foo.ts`. `@contract/testkit`
 *     and `@contract/testkit/*` resolve to THIS directory (so a test can import the kit by its
 *     public name under the same hook that runs it).
 *   - `phaser`       → the minimal real ./phaser-stub.mjs (faithful Phaser.Math.Distance +
 *     instanceof targets), so a behavior's `import Phaser from 'phaser'` LOADS with no
 *     `window is not defined`.
 *   - extensionless relative VALUE imports (e.g. `./IBehavior`) → retried with `.ts` so the
 *     UNMODIFIED component source resolves to its real `.ts` file. Resolution only.
 *
 * Everything else falls through to Node's default resolution.
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // …/core-contract/src/testkit
const CONTRACT_SRC = path.resolve(HERE, '..'); // …/core-contract/src
const PHASER_STUB = pathToFileURL(path.join(HERE, 'phaser-stub.mjs')).href;

/** Resolve a `@contract/<rest>` specifier to a real file under core-contract/src. Handles
 *  the testkit barrel (bare `@contract/testkit` → testkit/index.ts) and deep imports. */
function resolveContract(rest) {
  // Try, in order: <rest>.ts, <rest>/index.ts, <rest> (a dir → its index), <rest>.mjs.
  const base = path.join(CONTRACT_SRC, rest);
  const candidates = [`${base}.ts`, path.join(base, 'index.ts'), `${base}.mjs`, base];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) {
      return { url: pathToFileURL(c).href, shortCircuit: true };
    }
  }
  // Fall back to <rest>.ts even if missing — surfaces a clear MODULE_NOT_FOUND on the .ts.
  return { url: pathToFileURL(`${base}.ts`).href, shortCircuit: true };
}

export async function resolve(specifier, context, next) {
  if (specifier === 'phaser') {
    return { url: PHASER_STUB, shortCircuit: true };
  }
  if (specifier.startsWith('@contract/')) {
    return resolveContract(specifier.slice('@contract/'.length));
  }
  // Extensionless relative import of a real TS source → map to its `.ts` file.
  if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    !path.extname(specifier) &&
    context.parentURL
  ) {
    const abs = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
    if (fs.existsSync(`${abs}.ts`)) {
      return { url: pathToFileURL(`${abs}.ts`).href, shortCircuit: true };
    }
  }
  return next(specifier, context);
}
