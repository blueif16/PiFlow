/**
 * ============================================================================
 * shell/mountShellSurface.ts — the SINGLE title-surface mount seam (KEEP — engine)
 * ============================================================================
 * Mounts the DOM `ShellSurface` over the canvas host and calls `onStart` once the
 * player presses start. The sibling of `mountGuidance` / `mountSound`: ONE call
 * wires the whole landing layer for a main.ts / title scene, 2D or 3D.
 *
 * `shellConfigFromGameConfig` projects the frozen `gameConfig.shell` (the section
 * the SHELL node authored) into the surface config, tolerating the older flat
 * seeds (`gameConfig.objective` / `gameConfig.controlsHelp`) so a sparsely-seeded
 * build still renders a complete surface.
 */

import { ShellSurface, type ShellSurfaceConfig, type ShellIntro, type ShellMode } from './ShellSurface';

/**
 * Mount + own the title surface. Returns the live instance so the caller can
 * `teardown()` early (e.g. a scene shutdown before the player pressed start).
 */
export function mountShellSurface(
  host: HTMLElement,
  cfg: ShellSurfaceConfig,
  onStart: () => void,
): ShellSurface {
  const surface = new ShellSurface();
  surface.mount(host, cfg, onStart);
  return surface;
}

/** Project `gameConfig.shell` (+ flat-seed fallbacks) into a ShellSurfaceConfig. */
export function shellConfigFromGameConfig(
  gameConfig: Record<string, unknown>,
  fallbackTitle?: string,
): ShellSurfaceConfig {
  const shell = (gameConfig.shell ?? {}) as Record<string, unknown>;
  const rawIntro = (shell.intro ?? {}) as Record<string, unknown>;

  const intro: ShellIntro = {
    title: asString(rawIntro.title) ?? fallbackTitle,
    goalLine: asString(rawIntro.goalLine) ?? asString(gameConfig.objective),
    howToPlay: asControlList(rawIntro.howToPlay) ?? asControlList(gameConfig.controlsHelp) ?? [],
    tone: asString(rawIntro.tone),
    synopsis: asString(rawIntro.synopsis),
    kicker: asString(rawIntro.kicker),
    tags: asTagList(rawIntro.tags),
  };

  return {
    intro,
    modes: asModeList(shell.modes),
  };
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asControlList(
  v: unknown,
): Array<{ input?: string; action?: string } | string> | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter(
    (x): x is { input?: string; action?: string } | string =>
      typeof x === 'string' || (typeof x === 'object' && x !== null),
  );
}

function asTagList(v: unknown): Array<string | { label: string; icon?: string }> | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter(
    (x): x is string | { label: string; icon?: string } =>
      typeof x === 'string' || (typeof x === 'object' && x !== null && 'label' in (x as object)),
  );
}

function asModeList(v: unknown): ShellMode[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    .map((x) => ({ id: asString(x.id), label: asString(x.label) }));
}
