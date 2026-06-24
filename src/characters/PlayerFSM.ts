import Phaser from 'phaser';
import FSM from 'phaser3-rex-plugins/plugins/fsm.js';

/**
 * PlayerAnimKeys — configurable animation key mapping (all optional).
 * Missing keys degrade gracefully (BasePlayer.playAnimation no-ops).
 */
export interface PlayerAnimKeys {
  idle?: string;
  walk?: string;
  jumpUp?: string;
  jumpDown?: string;
  punch?: string;
  kick?: string;
  shoot?: string;
  ultimate?: string;
  die?: string;
}

export const DEFAULT_PLAYER_ANIM_KEYS: Required<PlayerAnimKeys> = {
  idle: 'player_idle_anim',
  walk: 'player_walk_anim',
  jumpUp: 'player_jump_up_anim',
  jumpDown: 'player_jump_down_anim',
  punch: 'player_punch_anim',
  kick: 'player_kick_anim',
  shoot: 'player_shoot_anim',
  ultimate: 'player_ultimate_anim',
  die: 'player_die_anim',
};

/**
 * PlayerFSM — Player Finite State Machine (Platformer)  (KEEP — engine)
 *
 * Drives idle / moving / jumping / punching / kicking / shooting / ultimate /
 * hurting / dying. Reads input off the player's injected keys: BOTH WASD+Space
 * AND the arrow keys (cursors), so W5's 'ArrowLeft'/'ArrowUp'/'ArrowRight'
 * inputs and a human's WASD both work.
 *
 * Animation calls go through player.playAnimation(), which no-ops when the
 * animation is missing — so movement is fully functional with zero art.
 */
export class PlayerFSM extends FSM {
  scene: Phaser.Scene;
  player: any;
  animKeys: Required<PlayerAnimKeys>;

  constructor(scene: Phaser.Scene, player: any, animKeys?: PlayerAnimKeys) {
    super({
      extend: { eventEmitter: new Phaser.Events.EventEmitter() },
    });
    this.scene = scene;
    this.player = player;
    this.animKeys = { ...DEFAULT_PLAYER_ANIM_KEYS, ...animKeys };
    this.goto('idle');
  }

  // ── death ────────────────────────────────────────────────────────────────
  checkDeath(): boolean {
    if (this.player.health <= 0 && !this.player.isDead) {
      this.player.health = 0;
      this.player.isDead = true;
      this.goto('dying');
      return true;
    }
    return false;
  }

  // ── input helpers (WASD + Space OR arrow keys) ─────────────────────────────
  isMovingLeft(): boolean {
    return (
      (this.player.wasdKeys?.A?.isDown ?? false) ||
      (this.player.cursors?.left?.isDown ?? false)
    );
  }
  isMovingRight(): boolean {
    return (
      (this.player.wasdKeys?.D?.isDown ?? false) ||
      (this.player.cursors?.right?.isDown ?? false)
    );
  }
  isJumping(): boolean {
    return (
      (this.player.wasdKeys?.W?.isDown ?? false) ||
      (this.player.spaceKey?.isDown ?? false) ||
      (this.player.cursors?.up?.isDown ?? false)
    );
  }
  isMeleePressed(): boolean {
    return (
      this.player.shiftKey &&
      Phaser.Input.Keyboard.JustDown(this.player.shiftKey)
    );
  }
  isRangedPressed(): boolean {
    return this.player.eKey && Phaser.Input.Keyboard.JustDown(this.player.eKey);
  }
  isUltimatePressed(): boolean {
    return this.player.qKey && Phaser.Input.Keyboard.JustDown(this.player.qKey);
  }

  returnToBaseState(): void {
    if (!this.player.body.onFloor()) this.goto('jumping');
    else if (this.isMovingLeft() || this.isMovingRight()) this.goto('moving');
    else this.goto('idle');
  }

  // ── idle ────────────────────────────────────────────────────────────────
  enter_idle(): void {
    this.player.setVelocityX(0);
    this.player.playAnimation(this.animKeys.idle);
  }
  update_idle(): void {
    if (this.checkDeath()) return;
    if (this.isMovingLeft() || this.isMovingRight()) {
      this.goto('moving');
      return;
    }
    if (this.isJumping() && this.player.body.onFloor()) {
      this.goto('jumping');
      return;
    }
    if (this.isMeleePressed()) {
      this.startMelee();
      return;
    }
    if (this.isRangedPressed() && this.player.ranged) {
      this.goto('shooting');
      return;
    }
    if (this.isUltimatePressed() && this.player.canUseUltimate()) {
      this.goto('ultimate');
    }
  }

  // ── moving ──────────────────────────────────────────────────────────────
  enter_moving(): void {
    this.player.playAnimation(this.animKeys.walk);
  }
  update_moving(): void {
    if (this.checkDeath()) return;
    if (this.isMovingLeft()) {
      this.player.setVelocityX(-this.player.walkSpeed);
      this.player.facingDirection = 'left';
    } else if (this.isMovingRight()) {
      this.player.setVelocityX(this.player.walkSpeed);
      this.player.facingDirection = 'right';
    } else {
      this.goto('idle');
      return;
    }
    this.player.setFlipX(this.player.facingDirection === 'left');
    if (this.isJumping() && this.player.body.onFloor()) {
      this.goto('jumping');
      return;
    }
    if (this.isMeleePressed()) {
      this.startMelee();
      return;
    }
    if (this.isRangedPressed() && this.player.ranged) {
      this.goto('shooting');
      return;
    }
    if (this.isUltimatePressed() && this.player.canUseUltimate()) {
      this.goto('ultimate');
    }
  }

  // ── jumping ─────────────────────────────────────────────────────────────
  enter_jumping(): void {
    if (this.player.body.onFloor()) {
      this.player.body.setVelocityY(-this.player.jumpPower);
      this.player.jumpSound?.play();
    }
    this.player.playAnimation(this.animKeys.jumpUp);
  }
  update_jumping(): void {
    if (this.checkDeath()) return;
    if (this.isMovingLeft()) {
      this.player.setVelocityX(-this.player.walkSpeed * 0.8);
      this.player.facingDirection = 'left';
    } else if (this.isMovingRight()) {
      this.player.setVelocityX(this.player.walkSpeed * 0.8);
      this.player.facingDirection = 'right';
    } else {
      this.player.setVelocityX(0);
    }
    this.player.setFlipX(this.player.facingDirection === 'left');
    if (this.player.body.velocity.y > 0) {
      if (this.player.anims?.currentAnim?.key !== this.animKeys.jumpDown) {
        this.player.playAnimation(this.animKeys.jumpDown);
      }
    }
    if (this.player.body.onFloor()) {
      if (this.isMovingLeft() || this.isMovingRight()) this.goto('moving');
      else this.goto('idle');
      return;
    }
    if (this.isMeleePressed()) {
      this.startMelee();
      return;
    }
    if (this.isRangedPressed() && this.player.ranged) {
      this.goto('shooting');
    }
  }

  // ── melee (alternating punch/kick) ────────────────────────────────────────
  private startMelee(): void {
    this.player.meleeComboCount++;
    if (this.player.meleeComboCount % 2 === 1) this.goto('punching');
    else this.goto('kicking');
  }

  enter_punching(): void {
    this.enterMeleeState(this.animKeys.punch, 300);
  }
  update_punching(): void {
    if (this.checkDeath()) return;
    if (this.player.body.onFloor()) this.player.setVelocityX(0);
  }
  enter_kicking(): void {
    this.enterMeleeState(this.animKeys.kick, 350);
  }
  update_kicking(): void {
    if (this.checkDeath()) return;
    if (this.player.body.onFloor()) this.player.setVelocityX(0);
  }
  private enterMeleeState(animKey: string, fallbackMs: number): void {
    this.player.isAttacking = true;
    this.player.setVelocityX(0);
    this.player.playAnimation(animKey);
    this.player.attackSound?.play();
    this.player.currentMeleeTargets.clear();
    const exit = () => {
      if (!this.player.isAttacking) return;
      this.player.isAttacking = false;
      this.player.currentMeleeTargets.clear();
      this.returnToBaseState();
    };
    this.player.once(`animationcomplete-${animKey}`, exit);
    // Fallback timer drives the combo when there is no animation (no art).
    this.scene.time.delayedCall(fallbackMs, exit);
  }

  // ── shooting ────────────────────────────────────────────────────────────
  enter_shooting(): void {
    this.player.setVelocityX(0);
    this.player.playAnimation(this.animKeys.shoot);
    this.player.shoot();
    const exit = () => this.returnToBaseState();
    this.player.once(`animationcomplete-${this.animKeys.shoot}`, exit);
    this.scene.time.delayedCall(200, exit);
  }
  update_shooting(): void {
    if (this.checkDeath()) return;
    if (this.player.body.onFloor()) this.player.setVelocityX(0);
  }

  // ── ultimate ──────────────────────────────────────────────────────────────
  enter_ultimate(): void {
    if (!this.player.canUseUltimate()) return this.returnToBaseState();
    this.player.playAnimation(this.animKeys.ultimate);
    this.player.useUltimate();
  }
  update_ultimate(): void {
    if (this.checkDeath()) return;
    if (!this.player.isUsingUltimate) this.returnToBaseState();
  }

  // ── hurting ────────────────────────────────────────────────────────────────
  enter_hurting(): void {
    this.player.setVelocityX(0);
    this.player.hurtSound?.play();
    this.player.hurtingTimer = this.scene.time.delayedCall(
      this.player.hurtingDuration,
      () => {
        this.player.isHurting = false;
        this.returnToBaseState();
      },
    );
  }

  // ── dying ────────────────────────────────────────────────────────────────
  enter_dying(): void {
    this.player.hurtingTimer?.destroy();
    this.player.setVelocityX(0);
    this.player.playAnimation(this.animKeys.die);
    // Route death through the scene hook so the registry `status` flag is set
    // ('lost') at the real death point — never bypass it. Guard double-fire
    // (animationcomplete + the no-art fallback timer both call finish).
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      const s = this.scene as any;
      if (typeof s.onPlayerDeath === 'function') {
        s.onPlayerDeath();
      } else {
        this.scene.registry.set('status', 'lost');
        this.scene.scene.launch('GameOverUIScene', {
          currentLevelKey: this.scene.scene.key,
        });
      }
    };
    this.player.once(`animationcomplete-${this.animKeys.die}`, finish);
    // Fallback when there is no death animation (no art): fire after a beat.
    this.scene.time.delayedCall(400, finish);
  }
}
