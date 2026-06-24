import Phaser from 'phaser';
import { BaseBehavior } from './IBehavior';
import gameConfig from '../gameConfig.json';

/**
 * CAPABILITY — self-describing registry sidecar (capability-registry-harness).
 * Globbed by registry/build-registry.mjs; bound by the blueprint via `id`.
 * EDIT THIS, not capabilities.json.
 */
export const CAPABILITY = {
  kind: 'behavior',
  id: 'ContactRespawn',
  intent:
    'On player contact, soft-reset the player to spawn (failModel respawn/lives); status stays playing.',
  roles: ['enemy'],
  params: ['penaltySeconds', 'effectEvent'],
  tuning: [],
} as const;

export interface ContactRespawnConfig {
  /** Seconds subtracted from the time clock on a hit (failModel:'time' only; default 0). */
  penaltySeconds?: number;
  /** Event fired via scene.fireEffect on a contact (default 'player.respawn'). */
  effectEvent?: string;
}

/**
 * ContactRespawn — a moving-enemy contact-fail behavior (KEEP — engine; the design
 * binds it by id on a patrol/chase enemy). On a player<->owner(enemy) overlap it
 * calls scene.respawnAtSpawn() — the immutable NON-TERMINAL respawn seam that
 * relocates the player to spawn and RETURNS CONTROL (status stays 'playing', NOT a
 * game-over). It re-implements NOTHING: the respawn is the SDK seam; the contact is
 * the same forgiving display-center read the SDK pickups use.
 *
 * FAIL-MODEL-AWARE (the no-double-damage rule): it acts ONLY under failModel
 * 'respawn' or 'lives'. Under 'health' it is INERT — the SDK's setupContactDamage
 * (player.takeDamage on enemy.damage) owns the contact path there, so a moving
 * enemy never both damages AND respawns. A respawn/lives moving enemy carries no
 * `damage`, so the SDK's contact-damage overlap is benign (takeDamage(0)) and THIS
 * behavior owns the consequence. Generic — no game/theme is encoded.
 *
 * One contact costs ONE respawn: a re-arm flag clears only after the player leaves
 * the overlap region, so standing in the enemy doesn't respawn every frame.
 */
export class ContactRespawn extends BaseBehavior {
  private readonly penaltySeconds: number;
  private readonly effectEvent: string;
  private armed = true;

  /** Forgiving display-center half-extent (matches the SDK pickup body feel). */
  private static readonly TOUCH = 40;

  constructor(config: ContactRespawnConfig = {}) {
    super();
    this.penaltySeconds = config.penaltySeconds ?? 0;
    this.effectEvent = config.effectEvent ?? 'player.respawn';
  }

  /** True iff the active fail model is respawn/lives (else this behavior is inert). */
  private static respawnFamily(): boolean {
    const fm = (gameConfig as any)?.failModel;
    return fm === 'respawn' || fm === 'lives';
  }

  update(): void {
    if (!ContactRespawn.respawnFamily()) return; // inert under health/time/none
    const owner = this.getOwner<Phaser.Physics.Arcade.Sprite & { isDead?: boolean }>();
    const scene = owner.scene as any;
    const player = scene?.player;
    if (!player?.body || owner.isDead || player.isDead) return;
    if (scene.gameCompleted) return;

    const touching = this.overlap(player, owner);
    if (touching && this.armed) {
      this.armed = false;
      scene.respawnAtSpawn?.(this.penaltySeconds);
      scene.fireEffect?.(this.effectEvent, player.x, player.y);
    } else if (!touching) {
      this.armed = true;
    }
  }

  /** Forgiving display-center AABB overlap (survives body.reset; no physics wait). */
  private overlap(a: any, b: any): boolean {
    const T = ContactRespawn.TOUCH;
    const aw = Math.max((a.displayWidth ?? 32) / 2, T);
    const ah = Math.max((a.displayHeight ?? 32) / 2, T);
    const bw = Math.max((b.displayWidth ?? 32) / 2, T);
    const bh = Math.max((b.displayHeight ?? 32) / 2, T);
    return Math.abs(a.x - b.x) < aw + bw && Math.abs(a.y - b.y) < ah + bh;
  }
}
