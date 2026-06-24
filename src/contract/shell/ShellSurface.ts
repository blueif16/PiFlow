/**
 * ============================================================================
 * shell/ShellSurface.ts — the title/landing SURFACE (KEEP — engine, shared)
 * ============================================================================
 * The composed DOM landing screen that REPLACES the old "white text on a black
 * canvas" title. Renderer-agnostic (pure DOM/CSS over the `#game-container` that
 * also holds the <canvas>), shared by BOTH engines — the 2D `TitleScreen` Phaser
 * scene and the 3D bootstrap both mount it. Driven entirely by the frozen
 * `gameConfig.shell` the SHELL node authored (intro · sceneFlow · modes).
 *
 * It composes the pre-built `shell-kit` primitives into:
 *   backdrop (the game's own key art, graded + an always-on gradient mesh)
 *   · a marquee (title · tagline · tag chips · objective ribbon)
 *   · an action stack (Play · How to play · modes)
 *   · a scrollable "how to play" sheet (the explorable region)
 *
 * ── THE START CONTRACT (load-bearing — do NOT narrow) ──────────────────────
 * The verify harness boots EVERY game by focusing the canvas and firing
 * ENTER / SPACE / a canvas click, then waits for `__GAME__.ready`
 * (`packages/verify/src/harness.ts`). So:
 *   • the overlay ROOT + backdrop + marquee are `pointer-events:none` — the
 *     harness's UNGUARDED `page.click('canvas')` must hit the canvas THROUGH the
 *     overlay, or boot fails. Only the (lower) buttons are `pointer-events:auto`.
 *   • start is driven by WINDOW listeners (keydown Enter/Space + pointerdown) so
 *     it fires regardless of which element is on top — the keyboard press bubbles
 *     to window even with every button covering the canvas.
 * `onStart` runs ONCE; the surface then tears itself + its listeners down.
 */

import {
  el,
  shellButton,
  shellTag,
  shellKbd,
  prettyKey,
  injectShellStyles,
} from './shell-kit';

/** One control row — the {input, action} the GDD declared (tolerates a bare string). */
export interface ShellControl {
  input?: string;
  action?: string;
}

/** The title/how-to-play surface content (mirrors `gameConfig.shell.intro`). */
export interface ShellIntro {
  title?: string;
  goalLine?: string;
  howToPlay?: Array<ShellControl | string>;
  tone?: string;
  /** Optional richer fields a later SHELL-node pass may author (degrade if absent). */
  synopsis?: string;
  kicker?: string;
  tags?: Array<string | { label: string; icon?: string }>;
}

export interface ShellMode {
  id?: string;
  label?: string;
}

export interface ShellSurfaceConfig {
  intro?: ShellIntro;
  modes?: ShellMode[];
  /** Explicit backdrop URL; else conventional asset paths are tried, then the mesh. */
  backdropSrc?: string;
  /** Extra backdrop candidates (first that loads wins). */
  backdropCandidates?: string[];
  startLabel?: string;
}

const DEFAULT_BACKDROPS = [
  'assets/backgrounds/background.png',
  'assets/backgrounds/bg.png',
  'assets/background.png',
];

export class ShellSurface {
  private overlay: HTMLDivElement | null = null;
  private sheet: HTMLDivElement | null = null;
  private started = false;
  private sheetOpen = false;
  private onStart: (() => void) | null = null;
  private keyHandler?: (e: KeyboardEvent) => void;
  private pointerHandler?: (e: Event) => void;

  /**
   * Mount the surface over `container` (the `#game-container` holding the canvas)
   * and call `onStart` ONCE on the first Enter / Space / backdrop tap. Returns
   * nothing — keep the instance to `teardown()` early if needed.
   */
  mount(container: HTMLElement, cfg: ShellSurfaceConfig, onStart: () => void): void {
    if (typeof document === 'undefined') {
      onStart();
      return;
    }
    injectShellStyles();
    this.onStart = onStart;

    const intro = cfg.intro ?? {};
    const overlay = el('div', 'gomni-shell');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', `${intro.title ?? 'Game'} — start screen`);

    // Per-game hue, seeded from the title → every game gets its own colour for free.
    const hue = hashHue(intro.title ?? 'game');
    overlay.style.setProperty('--accent', `hsl(${hue} 88% 62%)`);
    overlay.style.setProperty('--accent-2', `hsl(${(hue + 152) % 360} 92% 58%)`);

    overlay.appendChild(this.buildBackdrop(cfg));
    overlay.appendChild(this.buildStage(intro, cfg));

    // The container must be a positioning context so inset:0 covers the canvas.
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }
    container.appendChild(overlay);
    this.overlay = overlay;

    this.wireStart();
  }

  // ── backdrop ──────────────────────────────────────────────────────────────
  private buildBackdrop(cfg: ShellSurfaceConfig): HTMLDivElement {
    const bg = el('div', 'gomni-shell__bg');
    bg.appendChild(el('div', 'gomni-shell__bg-mesh'));

    const img = el('div', 'gomni-shell__bg-img');
    bg.appendChild(img);
    // Try candidates in order; first that loads becomes the hero backdrop. If
    // none load (zero-art / headless block), the gradient mesh stays — always legible.
    const candidates = [
      ...(cfg.backdropSrc ? [cfg.backdropSrc] : []),
      ...(cfg.backdropCandidates ?? []),
      ...DEFAULT_BACKDROPS,
    ];
    this.loadFirst(candidates, (src) => {
      img.style.backgroundImage = `url("${src}")`;
      img.classList.add('is-loaded');
    });

    bg.appendChild(el('div', 'gomni-shell__bg-scrim'));
    bg.appendChild(el('div', 'gomni-shell__bg-grain'));
    bg.appendChild(el('div', 'gomni-shell__bg-vignette'));
    return bg;
  }

  /** Resolve the first URL that loads as an image (graceful: never throws). */
  private loadFirst(urls: string[], onHit: (src: string) => void): void {
    const tryAt = (i: number): void => {
      if (i >= urls.length) return;
      const probe = new Image();
      probe.onload = () => onHit(urls[i]);
      probe.onerror = () => tryAt(i + 1);
      probe.src = urls[i];
    };
    tryAt(0);
  }

  // ── the marquee + actions column ────────────────────────────────────────────
  private buildStage(intro: ShellIntro, cfg: ShellSurfaceConfig): HTMLDivElement {
    const stage = el('div', 'gomni-shell__stage');
    const top = el('div', 'gomni-shell__top');

    // kicker: an authored kicker, else a decorative gradient rule (no false claim).
    if (intro.kicker) {
      top.appendChild(el('span', 'gomni-shell-eyebrow', intro.kicker));
    } else {
      const rule = el('div');
      rule.style.cssText =
        'width:46px;height:2px;border-radius:2px;background:linear-gradient(90deg,transparent,var(--accent-2),transparent);opacity:.8';
      top.appendChild(rule);
    }

    top.appendChild(el('h1', 'gomni-shell__title', intro.title ?? 'GAME'));

    const tagline = intro.synopsis ?? intro.tone;
    if (tagline) top.appendChild(el('p', 'gomni-shell__tagline', tagline));

    const tags = this.deriveTags(intro);
    if (tags.length > 0) {
      const row = el('div', 'gomni-shell__tags');
      tags.forEach((t) => row.appendChild(shellTag(t.label, t.icon)));
      top.appendChild(row);
    }

    if (intro.goalLine) {
      const goal = el('div', 'gomni-shell__goal');
      goal.appendChild(el('span', 'gomni-shell__goal-flag', '🏁'));
      const text = el('span');
      text.innerHTML = `<b>Goal</b> — ${escapeHtml(intro.goalLine)}`;
      goal.appendChild(text);
      top.appendChild(goal);
    }

    stage.appendChild(top);
    stage.appendChild(this.buildActions(intro, cfg));
    stage.appendChild(el('span', 'gomni-shell__hint', 'Press Enter or tap to play'));
    return stage;
  }

  private buildActions(intro: ShellIntro, cfg: ShellSurfaceConfig): HTMLDivElement {
    const actions = el('div', 'gomni-shell__actions');

    actions.appendChild(
      shellButton({
        label: cfg.startLabel ?? 'Play',
        variant: 'primary',
        hint: 'Enter / Space',
        onClick: () => this.start(),
      }),
    );

    const hasControls = (intro.howToPlay ?? []).length > 0;
    if (hasControls) {
      actions.appendChild(
        shellButton({
          label: 'How to play',
          variant: 'ghost',
          onClick: () => this.openSheet(),
        }),
      );
    }

    // Named modes beyond the default single "play" become their own pills.
    const modes = (cfg.modes ?? []).filter((m) => m.label && m.id !== 'play');
    if (modes.length > 0) {
      const row = el('div', 'gomni-shell__modes');
      modes.forEach((m) =>
        row.appendChild(
          shellButton({ label: m.label ?? 'Mode', variant: 'mode', onClick: () => this.start() }),
        ),
      );
      actions.appendChild(row);
    }
    return actions;
  }

  // ── the scrollable how-to-play sheet ────────────────────────────────────────
  private openSheet(): void {
    if (this.sheetOpen || !this.overlay) return;
    const intro = this.currentIntro;
    const sheet = el('div', 'gomni-shell__sheet');
    const card = el('div', 'gomni-shell__sheet-card');
    card.appendChild(el('div', 'gomni-shell__sheet-grab'));
    card.appendChild(el('h3', undefined, 'How to play'));

    const rows = el('div', 'gomni-shell__rows');
    normalizeControls(intro.howToPlay).forEach((c) => {
      const row = el('div', 'gomni-shell__row');
      const keys = el('div', 'gomni-shell__row-keys');
      (c.input ?? '').split(/\s*[/+]\s*/).filter(Boolean).forEach((k) => keys.appendChild(shellKbd(k)));
      if (keys.childElementCount === 0) keys.appendChild(shellKbd(c.input ?? '?'));
      row.appendChild(keys);
      row.appendChild(el('div', 'gomni-shell__row-action', c.action ?? ''));
      rows.appendChild(row);
    });
    card.appendChild(rows);

    if (intro.goalLine) {
      const note = el('p', 'gomni-shell__sheet-note', `Goal — ${intro.goalLine}`);
      card.appendChild(note);
    }

    const close = el('div', 'gomni-shell__sheet-close');
    close.appendChild(
      shellButton({ label: 'Got it', variant: 'ghost', onClick: () => this.closeSheet() }),
    );
    card.appendChild(close);

    sheet.appendChild(card);
    // Tapping the scrim (not the card) closes the sheet.
    sheet.addEventListener('pointerdown', (e) => {
      if (e.target === sheet) this.closeSheet();
    });
    this.overlay.appendChild(sheet);
    this.sheet = sheet;
    this.sheetOpen = true;
    // next frame → trigger the slide-up transition
    requestAnimationFrame(() => sheet.classList.add('is-open'));
  }

  private closeSheet(): void {
    if (!this.sheet) return;
    const sheet = this.sheet;
    this.sheet = null;
    this.sheetOpen = false;
    sheet.classList.remove('is-open');
    window.setTimeout(() => sheet.remove(), 260);
  }

  private get currentIntro(): ShellIntro {
    return this._intro;
  }
  private _intro: ShellIntro = {};

  // ── start contract + teardown ───────────────────────────────────────────────
  private wireStart(): void {
    // Enter/Space → start (NOT while the how-to-play sheet is open — let the human
    // read/scroll). Escape closes the sheet. The harness never opens the sheet, so
    // its Enter/Space always reaches start.
    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.sheetOpen) {
        this.closeSheet();
        return;
      }
      if (this.sheetOpen) return;
      if (e.key === 'Enter' || e.key === ' ' || e.code === 'Space') this.start();
    };
    // A pointerdown on the BACKDROP (not a button, not the sheet) → start. This is
    // also the path the harness's canvas click takes (it bubbles to window since
    // the overlay is pointer-events:none).
    this.pointerHandler = (e: Event) => {
      if (this.sheetOpen) return;
      const t = e.target as Element | null;
      if (t && t.closest('.gomni-shell-btn, .gomni-shell__sheet')) return;
      this.start();
    };
    window.addEventListener('keydown', this.keyHandler);
    window.addEventListener('pointerdown', this.pointerHandler);
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    const cb = this.onStart;
    this.teardown();
    cb?.();
  }

  teardown(): void {
    if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler);
    if (this.pointerHandler) window.removeEventListener('pointerdown', this.pointerHandler);
    this.keyHandler = undefined;
    this.pointerHandler = undefined;
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
    this.sheet = null;
    this.sheetOpen = false;
  }

  // round-1 derivation: honest tags from the declared controls (the SHELL node may
  // author richer `intro.tags` later — those win).
  private deriveTags(intro: ShellIntro): Array<{ label: string; icon?: string }> {
    this._intro = intro;
    if (intro.tags && intro.tags.length > 0) {
      return intro.tags.map((t) => (typeof t === 'string' ? { label: t } : t)).slice(0, 4);
    }
    const inputs = normalizeControls(intro.howToPlay)
      .map((c) => c.input ?? '')
      .join(' ');
    const tags: Array<{ label: string; icon?: string }> = [];
    if (/Arrow/.test(inputs)) tags.push({ label: 'Arrow keys', icon: '⇄' });
    if (/Key[WASD]/.test(inputs)) tags.push({ label: 'WASD', icon: '⌨' });
    if (/Space/.test(inputs)) tags.push({ label: 'Space', icon: '␣' });
    const pointer = normalizeControls(intro.howToPlay).some((c) =>
      /click|tap|mouse|pointer|drag/i.test(c.input ?? `${c.action ?? ''}`),
    );
    if (pointer) tags.push({ label: 'Touch / click', icon: '☞' });
    return tags.slice(0, 3);
  }
}

// ── pure helpers ──────────────────────────────────────────────────────────────

/** Normalise the mixed control list to {input, action} rows. */
function normalizeControls(raw?: Array<ShellControl | string>): ShellControl[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c) => (typeof c === 'string' ? { input: c, action: '' } : c))
    .filter((c) => (c.input ?? '').length > 0 || (c.action ?? '').length > 0);
}

/** Deterministic hue [0,360) from a string — gives each game its own accent. */
function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 360;
  // bias away from murky yellow-greens that read poorly as an accent on dark
  return (h + 200) % 360;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// re-export the prettyKey for consumers that want the glyph mapping directly
export { prettyKey };
