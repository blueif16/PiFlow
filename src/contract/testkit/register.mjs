/**
 * register.mjs — the SINGLE `--import` entry for ALL kit drive tests.
 *
 *   # canonical (durable — relative path, no node_modules symlink needed), run cwd = templates/core:
 *   node --import ../core-contract/src/testkit/register.mjs <path/to/X.drive.test.ts>
 *
 * Registers the unified resolve hook (./resolve-hook.mjs) in the loader thread, so BOTH
 * `@contract/*` AND `phaser`→stub resolve and extensionless `.ts` relative imports retry —
 * the one entry runs system AND behavior drive tests. Replaces the two per-module register
 * shims (systems/__tests__/contract-alias-hook-register.mjs +
 * behaviors/__tests__/behavior-test-register.mjs).
 */
import { register } from 'node:module';
register('./resolve-hook.mjs', import.meta.url);
