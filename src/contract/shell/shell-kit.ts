/**
 * ============================================================================
 * shell/shell-kit.ts — the pre-composed SHELL CHROME kit (KEEP — engine, shared)
 * ============================================================================
 * The reusable DOM primitives the title/landing SURFACE composes from — buttons,
 * tag chips, keycaps, the section heading — plus the ONE injected stylesheet that
 * styles ALL of them. Renderer-agnostic (pure DOM/CSS), shared by BOTH engines
 * (imported as `@contract/shell/*`), the sibling of `@contract/guidance/*` and
 * `@contract/sound/*`.
 *
 * WHY a kit (not ad-hoc `add.text`): the surface is no longer "white text on a
 * black canvas" — it is a composed landing screen (backdrop · marquee · tags ·
 * buttons · a scrollable how-to-play sheet). A small vocabulary of pre-composed,
 * prop-driven primitives is what lets a single shared component render VARIETY
 * across every archetype while staying legible. Every class is namespaced
 * `gomni-shell-*` so it never collides with a game's own DOM/CSS.
 *
 * The styles are injected ONCE as a `<style id="gomni-shell-styles">` element
 * (NOT a CSS import) so the unit is self-contained and never depends on the
 * bundler resolving `.css` — the same robustness discipline as the rest of the
 * contract. A network font is requested for polish but EVERY rule has a
 * system-font fallback, so the surface is fully legible offline / headless.
 */

/** Create an element, optionally with a class and text. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export type ButtonVariant = 'primary' | 'ghost' | 'mode';

export interface ShellButtonSpec {
  label: string;
  variant?: ButtonVariant;
  /** Small uppercase hint under/!beside the label (e.g. "ENTER"). */
  hint?: string;
  onClick: () => void;
}

/**
 * A pre-composed, tactile button. `primary` is the filled call-to-action (Play);
 * `ghost` is the outlined secondary (How to Play); `mode` is a compact pill.
 * Always `type=button` (never submits) and `pointer-events:auto` so it is the
 * one interactive layer over the canvas.
 */
export function shellButton(spec: ShellButtonSpec): HTMLButtonElement {
  const variant = spec.variant ?? 'primary';
  const btn = el('button', `gomni-shell-btn gomni-shell-btn--${variant}`);
  btn.type = 'button';

  const label = el('span', 'gomni-shell-btn__label', spec.label);
  btn.appendChild(label);
  if (spec.hint) btn.appendChild(el('span', 'gomni-shell-btn__hint', spec.hint));

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    spec.onClick();
  });
  return btn;
}

/** A tag/badge chip — a compact, glanceable affordance (a control, a mode, a trait). */
export function shellTag(label: string, icon?: string): HTMLSpanElement {
  const tag = el('span', 'gomni-shell-tag');
  if (icon) tag.appendChild(el('span', 'gomni-shell-tag__icon', icon));
  tag.appendChild(el('span', 'gomni-shell-tag__text', label));
  return tag;
}

/** A keycap — renders an input token (e.g. "ArrowLeft" → "←", "Space") as a key. */
export function shellKbd(input: string): HTMLSpanElement {
  return el('kbd', 'gomni-shell-kbd', prettyKey(input));
}

/** A small uppercased section heading used inside the surface and the sheet. */
export function shellEyebrow(text: string): HTMLSpanElement {
  return el('span', 'gomni-shell-eyebrow', text);
}

/**
 * Map a raw control token to a glyph/short label a player reads at a glance.
 * Tolerant: passes anything it doesn't recognise straight through (trimmed).
 */
export function prettyKey(input: string): string {
  const k = (input ?? '').trim();
  const map: Record<string, string> = {
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓',
    Space: 'Space',
    ' ': 'Space',
    Enter: 'Enter',
    Escape: 'Esc',
    ShiftLeft: 'Shift',
    ShiftRight: 'Shift',
    Shift: 'Shift',
  };
  if (map[k]) return map[k];
  // KeyA → A, KeyD → D, Digit1 → 1
  const key = /^Key([A-Z])$/.exec(k);
  if (key) return key[1];
  const digit = /^Digit([0-9])$/.exec(k);
  if (digit) return digit[1];
  return k;
}

/** Inject the shell stylesheet ONCE (id-guarded). Safe to call repeatedly. */
export function injectShellStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById('gomni-shell-styles')) return;
  const style = document.createElement('style');
  style.id = 'gomni-shell-styles';
  style.textContent = SHELL_CSS;
  document.head.appendChild(style);
}

/**
 * The whole shell stylesheet. Namespaced `gomni-shell-*`. Colours are driven by
 * CSS custom properties set on `.gomni-shell` (the root) — `--accent`/`--accent-2`
 * are seeded per-game from the title so every game gets its own hue for free,
 * over a consistent premium-dark base. Distinctive display + body fonts are
 * requested from a CDN for polish; the `font-family` stacks fall back to crisp
 * system fonts so nothing depends on the network for legibility.
 */
export const SHELL_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700&family=Sora:wght@300;400;500;600&display=swap');

.gomni-shell, .gomni-shell * { box-sizing: border-box; margin: 0; }

.gomni-shell {
  --ink: #0b0d17;
  --paper: #f3f1ea;
  --accent: hsl(265 90% 62%);
  --accent-2: hsl(195 95% 58%);
  --display: 'Chakra Petch', 'Bahnschrift', 'DIN Alternate', system-ui, sans-serif;
  --body: 'Sora', system-ui, -apple-system, 'Segoe UI', sans-serif;
  position: absolute; inset: 0; z-index: 30;
  display: flex; align-items: stretch; justify-content: center;
  font-family: var(--body);
  color: var(--paper);
  pointer-events: none;            /* the backdrop NEVER traps input (harness canvas-click passes through) */
  -webkit-font-smoothing: antialiased;
  user-select: none;
  overflow: hidden;
}

/* ── backdrop: the game's own key art, graded for legibility, + an atmospheric
   gradient mesh that always renders (zero-art safe) + grain + vignette ── */
.gomni-shell__bg { position: absolute; inset: 0; overflow: hidden; }
.gomni-shell__bg-mesh {
  position: absolute; inset: -20%;
  background:
    radial-gradient(40% 50% at 22% 18%, color-mix(in srgb, var(--accent) 55%, transparent), transparent 70%),
    radial-gradient(45% 55% at 82% 28%, color-mix(in srgb, var(--accent-2) 45%, transparent), transparent 72%),
    radial-gradient(60% 60% at 50% 110%, color-mix(in srgb, var(--accent) 35%, transparent), transparent 70%),
    linear-gradient(160deg, #11132a 0%, #0b0d17 55%, #06070f 100%);
  filter: saturate(1.05);
  animation: gomni-shell-drift 22s ease-in-out infinite alternate;
}
.gomni-shell__bg-img {
  position: absolute; inset: 0;
  background-size: cover; background-position: center;
  opacity: 0; transition: opacity .6s ease;
  filter: saturate(1.06) contrast(1.02);
}
.gomni-shell__bg-img.is-loaded { opacity: .9; }
.gomni-shell__bg-scrim {
  position: absolute; inset: 0;
  background:
    linear-gradient(180deg, rgba(6,7,15,.35) 0%, rgba(6,7,15,.15) 32%, rgba(6,7,15,.62) 78%, rgba(6,7,15,.92) 100%);
}
.gomni-shell__bg-grain {
  position: absolute; inset: 0; opacity: .06; mix-blend-mode: overlay;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
}
.gomni-shell__bg-vignette {
  position: absolute; inset: 0;
  box-shadow: inset 0 0 180px 40px rgba(0,0,0,.55);
}

/* ── the marquee column (portrait-locked, matches the game frame) ── */
.gomni-shell__stage {
  position: relative; z-index: 2;
  width: 100%; max-width: 440px;
  padding: clamp(20px, 6vh, 48px) 24px calc(env(safe-area-inset-bottom, 0px) + 28px);
  display: flex; flex-direction: column;
  align-items: center; justify-content: flex-end;
  gap: 14px; text-align: center;
}

.gomni-shell__top { flex: 1 1 auto; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; width: 100%; }

.gomni-shell-eyebrow {
  font-family: var(--display); font-weight: 600;
  font-size: 12px; letter-spacing: .42em; text-transform: uppercase;
  color: color-mix(in srgb, var(--accent-2) 70%, #fff);
  padding-left: .42em;
}

.gomni-shell__title {
  font-family: var(--display); font-weight: 700;
  font-size: clamp(38px, 13vw, 62px); line-height: .94;
  letter-spacing: -.01em; text-transform: uppercase;
  background: linear-gradient(180deg, #fff 0%, #e6e2f5 55%, color-mix(in srgb, var(--accent) 40%, #fff) 100%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
  text-shadow: 0 1px 0 rgba(255,255,255,.05);
  filter: drop-shadow(0 8px 26px color-mix(in srgb, var(--accent) 45%, transparent));
  max-width: 12ch;
}

.gomni-shell__tagline {
  font-family: var(--body); font-weight: 300; font-style: italic;
  font-size: 15px; line-height: 1.4; max-width: 30ch;
  color: rgba(243,241,234,.82);
}

.gomni-shell__tags { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; max-width: 34ch; }
.gomni-shell-tag {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 11px; border-radius: 999px;
  font-size: 11.5px; font-weight: 500; letter-spacing: .04em;
  color: rgba(243,241,234,.92);
  background: rgba(255,255,255,.07);
  border: 1px solid rgba(255,255,255,.14);
  backdrop-filter: blur(6px);
}
.gomni-shell-tag__icon { font-size: 12px; opacity: .9; }

/* ── the objective ribbon ── */
.gomni-shell__goal {
  display: flex; align-items: center; gap: 9px;
  max-width: 32ch; padding: 9px 15px; border-radius: 14px;
  background: rgba(11,13,23,.5); border: 1px solid rgba(255,255,255,.1);
  backdrop-filter: blur(8px);
  font-size: 13.5px; line-height: 1.35; color: rgba(243,241,234,.96);
}
.gomni-shell__goal-flag { font-size: 15px; }
.gomni-shell__goal b { color: var(--accent-2); font-weight: 600; }

/* ── the action stack (the ONLY interactive layer) ── */
.gomni-shell__actions {
  display: flex; flex-direction: column; align-items: center; gap: 11px;
  width: 100%; pointer-events: none;       /* wrapper inert; each button re-enables */
}
.gomni-shell__modes { display: flex; gap: 9px; flex-wrap: wrap; justify-content: center; }

.gomni-shell-btn {
  pointer-events: auto;                     /* the interactive layer */
  position: relative; cursor: pointer;
  display: inline-flex; flex-direction: column; align-items: center; gap: 1px;
  font-family: var(--display); border: none; border-radius: 16px;
  transition: transform .12s ease, box-shadow .2s ease, background .2s ease;
  -webkit-tap-highlight-color: transparent;
}
.gomni-shell-btn:active { transform: translateY(2px) scale(.99); }
.gomni-shell-btn__label { font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
.gomni-shell-btn__hint { font-family: var(--body); font-weight: 500; font-size: 9.5px; letter-spacing: .22em; opacity: .7; text-transform: uppercase; }

.gomni-shell-btn--primary {
  width: 100%; max-width: 320px; padding: 15px 22px;
  color: #0b0d17;
  background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 78%, #fff) 0%, var(--accent) 100%);
  box-shadow: 0 10px 30px -6px color-mix(in srgb, var(--accent) 60%, transparent), inset 0 1px 0 rgba(255,255,255,.5);
}
.gomni-shell-btn--primary .gomni-shell-btn__label { font-size: 19px; }
.gomni-shell-btn--primary:hover { transform: translateY(-2px); box-shadow: 0 16px 40px -6px color-mix(in srgb, var(--accent) 70%, transparent), inset 0 1px 0 rgba(255,255,255,.55); }

.gomni-shell-btn--ghost {
  padding: 11px 20px; color: rgba(243,241,234,.92);
  background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.2);
  backdrop-filter: blur(6px);
}
.gomni-shell-btn--ghost .gomni-shell-btn__label { font-size: 13px; }
.gomni-shell-btn--ghost:hover { background: rgba(255,255,255,.12); transform: translateY(-1px); }

.gomni-shell-btn--mode {
  padding: 8px 15px; color: rgba(243,241,234,.85);
  background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.14);
}
.gomni-shell-btn--mode .gomni-shell-btn__label { font-size: 12px; }
.gomni-shell-btn--mode:hover { background: rgba(255,255,255,.1); }

.gomni-shell__hint {
  font-family: var(--body); font-size: 11px; letter-spacing: .18em; text-transform: uppercase;
  color: rgba(243,241,234,.5); margin-top: 2px;
  animation: gomni-shell-pulse 2.6s ease-in-out infinite;
}

/* ── the scrollable "How to play" sheet (the explorable region) ── */
.gomni-shell__sheet {
  position: absolute; inset: 0; z-index: 40; pointer-events: auto;
  display: flex; flex-direction: column; justify-content: flex-end;
  background: rgba(4,5,11,.55); backdrop-filter: blur(3px);
  opacity: 0; transition: opacity .25s ease;
}
.gomni-shell__sheet.is-open { opacity: 1; }
.gomni-shell__sheet-card {
  width: 100%; max-width: 440px; margin: 0 auto;
  max-height: 82%; overflow-y: auto; -webkit-overflow-scrolling: touch;
  padding: 24px 24px calc(env(safe-area-inset-bottom, 0px) + 24px);
  background: linear-gradient(180deg, #15172e 0%, #0b0d17 100%);
  border-top-left-radius: 24px; border-top-right-radius: 24px;
  border-top: 1px solid rgba(255,255,255,.12);
  box-shadow: 0 -24px 60px rgba(0,0,0,.5);
  transform: translateY(18px); transition: transform .28s cubic-bezier(.2,.8,.2,1);
}
.gomni-shell__sheet.is-open .gomni-shell__sheet-card { transform: translateY(0); }
.gomni-shell__sheet-grab { width: 40px; height: 4px; border-radius: 999px; background: rgba(255,255,255,.2); margin: 0 auto 16px; }
.gomni-shell__sheet h3 { font-family: var(--display); font-size: 13px; letter-spacing: .2em; text-transform: uppercase; color: var(--accent-2); margin-bottom: 12px; }
.gomni-shell__rows { display: flex; flex-direction: column; gap: 8px; margin-bottom: 18px; }
.gomni-shell__row { display: flex; align-items: center; gap: 12px; padding: 9px 12px; border-radius: 12px; background: rgba(255,255,255,.04); }
.gomni-shell__row-keys { display: flex; gap: 5px; flex: 0 0 auto; }
.gomni-shell-kbd {
  font-family: var(--display); font-size: 12px; font-weight: 600; min-width: 26px; text-align: center;
  padding: 5px 8px; border-radius: 7px; color: #f3f1ea;
  background: linear-gradient(180deg, #2a2d4a, #1a1c30);
  border: 1px solid rgba(255,255,255,.14); box-shadow: 0 2px 0 rgba(0,0,0,.4);
}
.gomni-shell__row-action { font-size: 13px; color: rgba(243,241,234,.88); text-align: left; line-height: 1.3; }
.gomni-shell__sheet-note { font-size: 12.5px; font-style: italic; line-height: 1.5; color: rgba(243,241,234,.6); }
.gomni-shell__sheet-close { margin-top: 18px; }

/* ── staggered entrance ── */
.gomni-shell__stage > *, .gomni-shell__top > * { animation: gomni-shell-rise .6s cubic-bezier(.2,.8,.2,1) both; }
.gomni-shell__top > *:nth-child(1) { animation-delay: .05s; }
.gomni-shell__top > *:nth-child(2) { animation-delay: .12s; }
.gomni-shell__top > *:nth-child(3) { animation-delay: .19s; }
.gomni-shell__top > *:nth-child(4) { animation-delay: .26s; }
.gomni-shell__actions { animation-delay: .34s; }
.gomni-shell__hint { animation-delay: .42s; }

@keyframes gomni-shell-rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
@keyframes gomni-shell-pulse { 0%,100% { opacity: .35; } 50% { opacity: .75; } }
@keyframes gomni-shell-drift { from { transform: translate(-2%, -1%) scale(1.02); } to { transform: translate(2%, 1%) scale(1.06); } }

@media (prefers-reduced-motion: reduce) {
  .gomni-shell *, .gomni-shell *::before, .gomni-shell *::after { animation: none !important; transition: none !important; }
}
`;
