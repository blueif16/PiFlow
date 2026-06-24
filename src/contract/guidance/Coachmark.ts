/**
 * ============================================================================
 * guidance/Coachmark.ts  —  the player-facing teaching CARD (DOM overlay, KEEP — engine UI)
 * ============================================================================
 * The render half of the in-game guidance layer: a polished DOM card shown over
 * the game canvas to teach a control or state the goal. DOM is the right choice
 * (it is renderer-agnostic — works the same over a 2D or a 3D canvas, with crisp
 * text the canvas can't draw cheaply), and `pointer-events:none` keeps it from
 * trapping the player or blocking the input the verify harness fires through to the
 * game.
 *
 * The CONTENT is DATA (passed in — theme/copy from the blueprint's coaching[] /
 * overlays[]); the layout, typography, key-cap rendering, and the reveal/fade
 * timing are GENERIC engine code with no game noun. One Coachmark renders one
 * entry; the `GuidanceDriver` owns when each is shown/hidden (via the TriggerEngine).
 *
 * Polish bar: a soft frosted card, a tinted heading, monospace key caps with a
 * subtle bevel, a 220ms ease reveal (translate + fade in) and a matching fade-out
 * dismiss. Placement is `center` (a modal intro), `top`, or `bottom` (a slim
 * banner that sits clear of the bottom HUD objective panel).
 */

import type { CoachingContent, CoachingStyle } from '@contract/teach-spec';

const REVEAL_MS = 220;

export class Coachmark {
  private el: HTMLDivElement | null = null;
  private host: HTMLElement | null = null;
  private dismissTimer: ReturnType<typeof setTimeout> | null = null;
  private removed = false;

  /** Build (but do not yet reveal) the card over `host`. */
  constructor(
    private readonly content: CoachingContent,
    private readonly style: CoachingStyle = {},
  ) {}

  /** Reveal the card over `host` with the entrance transition. */
  show(host: HTMLElement): void {
    this.host = host;
    const placement = this.style.placement ?? 'bottom';
    const tone = this.style.tone ?? 'tip';

    const card = document.createElement('div');
    card.className = 'coachmark';
    card.dataset.tone = tone;
    card.dataset.placement = placement;

    // ── geometry: a non-intrusive band, or a centered intro modal.
    //    pointer-events:none so it never traps the player / blocks the input the
    //    verify harness fires through to the game. ───────────────────────────────
    const pos =
      placement === 'center'
        ? 'top:50%;left:50%;transform:translate(-50%,calc(-50% + 8px))'
        : placement === 'top'
          ? 'top:14px;left:50%;transform:translate(-50%,-8px)'
          : 'bottom:64px;left:50%;transform:translate(-50%,8px)'; // clear of a bottom HUD objective panel

    const panel = tone === 'panel';
    card.style.cssText = [
      'position:absolute',
      pos,
      'pointer-events:none',
      'box-sizing:border-box',
      panel ? 'max-width:84%' : 'max-width:90%',
      panel ? 'padding:14px 16px 16px' : 'padding:9px 13px',
      'border-radius:14px',
      // a soft frosted, high-contrast card — readable over any scene
      'background:linear-gradient(180deg,rgba(18,22,38,0.82),rgba(12,15,28,0.88))',
      'border:1px solid rgba(255,255,255,0.14)',
      'box-shadow:0 8px 30px rgba(0,0,0,0.45),inset 0 1px 0 rgba(255,255,255,0.08)',
      'backdrop-filter:blur(7px)',
      '-webkit-backdrop-filter:blur(7px)',
      'color:#eef2ff',
      "font-family:system-ui,-apple-system,'Segoe UI',sans-serif",
      'text-align:center',
      'z-index:20',
      // entrance transition (set the start state; the rAF below relaxes it)
      'opacity:0',
      `transition:opacity ${REVEAL_MS}ms ease,transform ${REVEAL_MS}ms cubic-bezier(.2,.8,.2,1)`,
    ].join(';');

    if (this.content.title) {
      const h = document.createElement('div');
      h.className = 'coachmark-title';
      h.textContent = this.content.title;
      h.style.cssText = [
        panel ? 'font-size:15px' : 'font-size:12px',
        'font-weight:700',
        'letter-spacing:0.04em',
        'text-transform:uppercase',
        'color:#9fc6ff',
        panel ? 'margin-bottom:8px' : 'margin-bottom:4px',
      ].join(';');
      card.appendChild(h);
    }

    if (this.content.body) {
      const b = document.createElement('div');
      b.className = 'coachmark-body';
      b.textContent = this.content.body;
      b.style.cssText = [
        panel ? 'font-size:14px' : 'font-size:12.5px',
        'line-height:1.4',
        'opacity:0.95',
        this.content.controls?.length ? (panel ? 'margin-bottom:12px' : 'margin-bottom:7px') : '',
      ].join(';');
      card.appendChild(b);
    }

    if (this.content.controls?.length) {
      const grid = document.createElement('div');
      grid.className = 'coachmark-controls';
      grid.style.cssText = [
        'display:flex',
        'flex-wrap:wrap',
        'gap:7px 10px',
        'justify-content:center',
        'align-items:center',
      ].join(';');
      for (const row of this.content.controls) {
        const item = document.createElement('div');
        item.style.cssText = 'display:flex;align-items:center;gap:6px';
        const cap = document.createElement('kbd');
        cap.textContent = row.keys;
        cap.style.cssText = [
          'font-family:ui-monospace,SFMono-Regular,Menlo,monospace',
          'font-size:11.5px',
          'font-weight:600',
          'color:#dbe6ff',
          'padding:3px 7px',
          'min-width:18px',
          'border-radius:7px',
          'background:rgba(255,255,255,0.10)',
          'border:1px solid rgba(255,255,255,0.18)',
          'box-shadow:inset 0 -2px 0 rgba(0,0,0,0.35),0 1px 0 rgba(255,255,255,0.06)',
          'white-space:nowrap',
        ].join(';');
        const lab = document.createElement('span');
        lab.textContent = row.label;
        lab.style.cssText = 'font-size:12px;opacity:0.82';
        item.appendChild(cap);
        item.appendChild(lab);
        grid.appendChild(item);
      }
      card.appendChild(grid);
    }

    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.appendChild(card);
    this.el = card;

    // Relax to the resting transform/opacity on the next frame (triggers the ease).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!this.el) return;
        this.el.style.opacity = '1';
        this.el.style.transform =
          placement === 'center'
            ? 'translate(-50%,-50%)'
            : placement === 'top'
              ? 'translate(-50%,0)'
              : 'translate(-50%,0)';
      });
    });

    // Auto-dismiss after durationMs (a clean timed fade-out).
    const dur = this.style.durationMs ?? 0;
    if (dur > 0) this.dismissTimer = setTimeout(() => this.dismiss(), dur);
  }

  /** Fade the card out and remove it (idempotent). Honors the same ease as reveal. */
  dismiss(): void {
    if (this.removed) return;
    this.removed = true;
    if (this.dismissTimer) {
      clearTimeout(this.dismissTimer);
      this.dismissTimer = null;
    }
    const card = this.el;
    if (!card) return;
    const placement = this.style.placement ?? 'bottom';
    card.style.opacity = '0';
    card.style.transform =
      placement === 'center'
        ? 'translate(-50%,calc(-50% - 6px))'
        : placement === 'top'
          ? 'translate(-50%,-8px)'
          : 'translate(-50%,8px)';
    const el = card;
    setTimeout(() => el.remove(), REVEAL_MS + 30);
    this.el = null;
  }

  /** True once this coachmark has been dismissed/removed. */
  isDone(): boolean {
    return this.removed;
  }
}
