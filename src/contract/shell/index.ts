/**
 * ============================================================================
 * shell/index.ts — the shared shell unit's public API (convenience re-export)
 * ============================================================================
 * The renderer-agnostic title/landing SURFACE, shared by BOTH engines (imported
 * as `@contract/shell/*`) — the sibling of `@contract/guidance/*` and
 * `@contract/sound/*`. Consumers MAY import a specific path; this barrel pulls
 * the public surface in one import.
 *
 * Surface:
 *   - mountShellSurface        — the single DOM mount seam (gameConfig.shell → landing).
 *   - shellConfigFromGameConfig — project gameConfig.shell into the surface config.
 *   - ShellSurface             — the composed landing component the seam mounts.
 *   - the pre-built kit (shellButton/shellTag/shellKbd/…) for bespoke composition.
 */

export { mountShellSurface, shellConfigFromGameConfig } from './mountShellSurface';
export { ShellSurface } from './ShellSurface';
export type { ShellSurfaceConfig, ShellIntro, ShellControl, ShellMode } from './ShellSurface';
export {
  shellButton,
  shellTag,
  shellKbd,
  shellEyebrow,
  prettyKey,
  injectShellStyles,
  el,
} from './shell-kit';
export type { ButtonVariant, ShellButtonSpec } from './shell-kit';
