/**
 * ============================================================================
 * hud-spec.ts  —  the HudItem shape + deriveDefaultHud (DATA, no engine import)
 * ============================================================================
 * The engine-agnostic CONTRACT half of the HUD composer: the `HudItem` shape
 * (the blueprint→HUD projection W2 merges into `gameConfig.shell.hud`) and the
 * `deriveDefaultHud` logic that reproduces the historical HUD when no `hud` spec
 * is declared. Pure DATA — both engines (Phaser's `core/src/scenes/UIScene.ts`
 * today; a 3D DOM HUD later) RENDER this spec their own way, so the WHAT-to-track
 * decision lives here while the HOW-to-draw stays in each engine's UI impl.
 */

/** One declared HUD item (the blueprint→HUD contract, projected into gameConfig). */
export interface HudItem {
  observable: string;
  label?: string;
  container?: string;
  format?: string;
  priority?: number;
}

/**
 * Reproduce the historical HUD when no `hud` spec is declared:
 *   - a score chip (always — the prior code always drew 'Score: N'),
 *   - the resource widget the failModel drives ('health'→bar, 'lives'→counter,
 *     'time'→timer; 'respawn'/'none'→none — matching the prior switch),
 *   - the objective panel iff gameConfig.objective is non-empty.
 * Generic: derived from declared fields only, no game-specific strings.
 */
export function deriveDefaultHud(cfg: Record<string, unknown>): HudItem[] {
  const out: HudItem[] = [{ observable: 'score', label: 'Score', container: 'chip', format: 'int', priority: 10 }];

  const failModel = typeof cfg.failModel === 'string' ? cfg.failModel : 'health';
  if (failModel === 'health') {
    out.push({ observable: 'player.health', label: 'HP', container: 'bar', format: 'x/max', priority: 20 });
  } else if (failModel === 'lives') {
    out.push({ observable: 'lives', label: 'Lives', container: 'counter', format: 'int', priority: 20 });
  } else if (failModel === 'time') {
    out.push({ observable: 'timeRemaining', label: 'Time', container: 'timer', format: 'mm:ss', priority: 20 });
  }

  const objective = typeof cfg.objective === 'string' ? cfg.objective : '';
  if (objective.length > 0) out.push({ observable: 'objective', container: 'objective', priority: 100 });

  return out;
}
