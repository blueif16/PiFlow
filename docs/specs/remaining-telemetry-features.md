# Remaining telemetry features — implementation spec (for subagents)

Self-contained contracts for the work left after the data-path consolidation. Each task names exact
files, the data fields (with their pi-event source), the styles (design tokens + class names), an
acceptance bar, and a scope fence. Grounding research: `docs/research/telemetry-observability-2026.md`
and `docs/research/pi-native-data-2026.md`. Architecture memo: `observe-single-data-path`.

## Ground rules (apply to every task)
- **Data logic lives in `@piflow/core/observe`, never in a view.** New per-node fields are computed in
  `packages/core/src/observe/distill.ts` (the reducer) + surfaced in `runView.ts`, then consumed by the
  GUI. The GUI never parses events itself.
- **After editing `packages/core/src/observe/*`, rebuild core**: `cd packages/core && npx tsc -b` (the GUI
  middleware dynamic-imports `packages/core/dist/observe/index.js`).
- **No mock data.** A field with no backing value renders empty/omitted — never a placeholder.
- **Verify, don't assert intent.** GUI work: `cd gui && npx tsc --noEmit -p tsconfig.json && npx vite build`.
  Core work: `cd packages/core && npx tsc -b` + the vitest test (Task 1).
- **Design tokens only** (no raw hex). Tones: `--ds-success` (green), `--ds-warning` (amber/orange),
  `--ds-error` (red), `--ds-accent` (blue), track `--ds-neutral-200`, text `--ds-text-secondary/tertiary`,
  mono `--ds-font-mono`, sizes `--ds-text-xs/sm`. Match the existing `.ds-*` class idiom.

## Field reference — what's available and where it comes from
Per-node, from the tee'd `events.jsonl` stream (already captured; `slimEvent` keeps these in `message`):

| datum | pi event source | field | status |
|---|---|---|---|
| model/provider/api | `message_start`/`message_end` (assistant) | `message.{model,provider,api}` | ✅ done |
| tokens in/out/cache/cost | `message_end` assistant | `message.usage.{input,output,cacheRead,cacheWrite,cost}` | ✅ done |
| contextPeak | `message_end` assistant | `max(message.usage.totalTokens)` | ✅ done |
| **stopReason / truncation** | `message_end` assistant | `message.stopReason` (`"max_tokens"` ⇒ truncated) | ⬜ Task 2 |
| **retries (429/overload)** | `auto_retry_start` / `auto_retry_end` | count of `auto_retry_start` | ⬜ Task 2 |
| **thinking chars** | `thinking_delta` | sum of `delta` string length | ⬜ Task 2 (optional) |
| contextWindow (capacity) | pi-native `~/.pi/agent/models.json` | `observe/models.ts` | ✅ done |

---

## Task 1 — Port the reducer test to core (do FIRST; it guards Task 2)
**Why:** the reducer moved to `@piflow/core/observe`; its only test is archived in
`gui/scripts/legacy/distill.test.mjs` and tests the dead copy. Port it to a real core test so Task 2's new
fields are guarded.

**Implement:** create `packages/core/test/distill.test.ts` (vitest — see sibling
`packages/core/test/observability.test.ts` for imports/style; root `vitest.config.ts` runs it).
- Import `createNodeAccumulator` from `../src/observe/distill.js` (or `@piflow/core/observe`).
- Port the synthetic-event cases from the legacy file. Each test pushes a hand-built `PiEvent[]` and
  asserts the `finalize()` output. The test must **FAIL if the reducer is wrong** (test-discipline): assert
  real values, e.g. push two assistant `message_end` with `usage.input=10/20` and assert
  `rich.tokens.input === 30`; push `message.usage.totalTokens = 100, 250` and assert
  `rich.tokens.contextPeak === 250` (MAX, not sum); push `tool_execution_start`×3 (read,read,bash) and
  assert `toolBreakdown == {read:2,bash:1}` and `toolCalls===3`; assert `model` is captured from the first
  assistant message; assert a `tool_execution_start` without a matching `_end` still yields one timeline
  span (the killed-mid-call close).
- Run: `cd /Users/tk/Desktop/piflow && npx vitest run packages/core/test/distill.test.ts`.

**Acceptance:** ≥6 assertions covering token SUM, contextPeak MAX, toolBreakdown, model capture, timeline
1:1 with calls, and the double-count guard (turn_end must NOT add usage — push a `turn_end` with usage and
assert totals are unchanged). All pass; deleting any reducer line makes ≥1 fail.

**Scope fence:** do not change `distill.ts` behavior in this task — only test it. If a port reveals a real
bug, note it; fix it in Task 2.

---

## Task 2 — New intakes in the reducer (retries · stopReason/truncation · thinking)
**File:** `packages/core/src/observe/distill.ts` (+ `runView.ts` to surface; + GUI type in Task 3).

**Implement in `createNodeAccumulator`:**
- Add counters: `let retries = 0; let stopReason: string | null = null; let thinkingChars = 0;`
- In `push(e)` switch:
  - `case 'auto_retry_start': retries += 1; break;` (rate-limit/overload retry — invisible to the model).
  - In `message_end` (assistant): `if (typeof msg.stopReason === 'string') stopReason = msg.stopReason;`
  - `case 'thinking_delta':` if `typeof e.delta === 'string'` → `thinkingChars += e.delta.length;` (the
    TUI already reads this event type — see `packages/tui/model.mjs`).
- Extend the `RichNode` interface + the `finalize()` `rich` object with:
  `retries`, `stopReason` (string|null), `truncated: stopReason === 'max_tokens' || stopReason === 'length'`,
  `thinkingChars`.

**Surface in `packages/core/src/observe/runView.ts`:** add to `RunViewNode` and the pushed node object:
`retries: number; stopReason: string | null; truncated: boolean; thinkingChars: number;` (read straight
from `rich`). Roll a run-level `retries` total into `tokenTotal` is NOT needed — per-node only.

**Acceptance:** add cases to `packages/core/test/distill.test.ts`: two `auto_retry_start` ⇒ `retries===2`;
`message_end` with `stopReason:'max_tokens'` ⇒ `truncated===true`; with `stopReason:'end_turn'` ⇒
`truncated===false`; two `thinking_delta` of `"ab"`,`"cde"` ⇒ `thinkingChars===5`. Rebuild core; the
`/__piflow/run-view/<run>` endpoint then returns the new fields (confirm via
`curl -s localhost:<port>/__piflow/run-view/e2e-m3 | node -e "..."`).

**Scope fence:** reducer + runView types only. No GUI rendering here (Task 3). Do not invent event types —
only `auto_retry_start`, `message.stopReason`, `thinking_delta` are confirmed in `pi-native-data-2026.md`.

---

## Task 3 — Status strip: truncation + retry badges (consumes Task 2)
**Files:** `gui/src/data/runView.ts` (add the 4 fields to the GUI `RunViewNode` type — mirror core),
`gui/src/components/NodeModeStrip.tsx` (the `status` branch), `gui/src/styles/modes.css`.

**Implement:** in the Status branch, after the two `MiniBar`s, render a badge row when either signal fires:
```tsx
{(rv?.truncated || (rv?.retries ?? 0) > 0) && (
  <div className="ds-nodemode__badges">
    {rv?.truncated && <span className="ds-nodebadge" data-tone="high" title="Output hit max_tokens — truncated">TRUNC</span>}
    {(rv?.retries ?? 0) > 0 && <span className="ds-nodebadge" data-tone="warn" title="Provider retries (429/overload)">↻ {rv.retries}</span>}
  </div>
)}
```
**Styles (`modes.css`):**
```css
.ds-nodemode__badges { display: flex; gap: var(--ds-space-1); }
.ds-nodebadge {
  font-family: var(--ds-font-mono); font-size: var(--ds-text-xs); line-height: 1.4;
  padding: 0 5px; border-radius: var(--ds-radius-sm); border: 1px solid var(--ds-border-hairline);
  background: var(--ds-bg-surface); letter-spacing: var(--ds-tracking-label);
}
.ds-nodebadge[data-tone="high"] { color: var(--ds-error-fg); border-color: var(--ds-error); }
.ds-nodebadge[data-tone="warn"] { color: var(--ds-warning-fg); border-color: var(--ds-warning); }
```
Also colorize the **TIME** MiniBar by slowdown: it already passes a `ContextTone` — keep
`ratio>1.5 → high`, `>1 → warn`, else `ok` (already implemented). No change needed there; just confirm.

**Acceptance:** with a run whose node has `truncated`/`retries>0`, the badge shows; a clean node shows no
badge row (no empty box). `tsc --noEmit` + `vite build` clean. Badges are `pointer-events:none` (inherit
from `.ds-nodemode`) and don't overflow the 220px node width — if both show, they wrap or fit.

**Scope fence:** Status strip only. Don't touch Model/Artifacts branches or the HUD.

---

## Task 4 — Tool-use STACKED BAR (not a pie) in the per-node HUD
**Why:** research verdict — with ~8 tool types, a pie fails for <10% slices; a horizontal stacked bar
encodes total + proportion and reads at small size. The HUD `tools` detail currently lists per-tool bars
(`.ds-bars`/`.ds-bar` in `hud.css`) — keep those for the expanded breakdown, and ADD a compact stacked bar
as the summary at the top of that region.

**Files:** new `gui/src/components/ToolStackBar.tsx`; used in `gui/src/components/NodeHud.tsx` `Detail`
(`region === 'tools'`); styles in `gui/src/styles/hud.css`.

**Implement `ToolStackBar`:** props `{ breakdown: Record<string, number> }`. Render one horizontal bar of
segments (width ∝ count) + a legend row. Color each segment by the existing `TOOL_TONE` map in
`NodeHud.tsx` (export it, or duplicate the mapping): `read/grep/submit_result→accent`, `edit/write→success`,
`bash→warn`, `ls/find→muted`. Segment colors:
```css
.ds-toolstack { display: flex; height: 8px; border-radius: var(--ds-radius-full); overflow: hidden; background: var(--ds-neutral-200); }
.ds-toolstack__seg[data-tone="accent"]  { background: var(--ds-accent); }
.ds-toolstack__seg[data-tone="success"] { background: var(--ds-success); }
.ds-toolstack__seg[data-tone="warn"]    { background: var(--ds-warning); }
.ds-toolstack__seg[data-tone="muted"]   { background: var(--ds-neutral-500); }
.ds-toolstack-legend { display: flex; flex-wrap: wrap; gap: var(--ds-space-2); margin-top: var(--ds-space-2); font-family: var(--ds-font-mono); font-size: var(--ds-text-xs); color: var(--ds-text-secondary); }
.ds-toolstack-legend__dot { width: 8px; height: 8px; border-radius: 2px; display: inline-block; margin-right: 4px; vertical-align: middle; }
```
Each legend item: `[dot] read 7`. Segment `title` = `"read · 7 (35%)"` for hover. Sort segments
descending by count.

**Acceptance:** in the HUD, hovering the **tools** region shows the stacked bar above the existing per-tool
bars; segment widths sum to 100%; colors match tool tone; an all-one-tool node shows a single full
segment. Keep the existing `.ds-bars` list below it (expanded detail). `tsc` + `build` clean.

**Scope fence:** HUD tools region only. Do NOT convert it to a pie/donut anywhere. Do NOT add a new
view-mode for tools in this task (that's optional Task 6).

---

## Task 5 — Cache hit/miss DONUT in the HUD model detail
**Why:** the ONE sanctioned donut (exactly 2 categories, single key % = cache-hit rate — the top cost
signal). Cache-hit rate = `cacheRead / (input + cacheRead)`.

**Files:** new `gui/src/components/CacheDonut.tsx`; used in `gui/src/components/NodeHud.tsx` `Detail`
(`region === 'model'`, alongside the token `KV` rows); styles in `gui/src/styles/hud.css`.

**Implement `CacheDonut`:** props `{ cacheRead: number; input: number }`. SVG donut, two arcs: cacheRead
(hit, `--ds-success`) vs input (miss/fresh, `--ds-neutral-400`); center label = `Math.round(hit*100)%`
with a `cache` caption under it. ~64px. If `input + cacheRead === 0`, render nothing.
```css
.ds-cachedonut { display: inline-flex; flex-direction: column; align-items: center; gap: 2px; font-family: var(--ds-font-mono); font-size: var(--ds-text-xs); color: var(--ds-text-tertiary); }
.ds-cachedonut__pct { font-size: var(--ds-text-base); font-weight: var(--ds-weight-semibold); color: var(--ds-text-primary); }
```
Warning color: if hit-rate < 0.3 make the `__pct` `--ds-error-fg`; < 0.6 `--ds-warning-fg`; else
`--ds-success-fg` (research thresholds).

**Acceptance:** HUD model detail shows the donut + `cache 62%`; thresholds recolor the % correctly; a node
with no cache data shows nothing (no zero-donut). `tsc` + `build` clean.

**Scope fence:** model detail region only. The donut is for cache hit/miss ONLY — do not reuse it for tools
or any >2-category data.

---

## Task 6 (OPTIONAL) — TUI parity
Make the TUI render the shared rich model so `tokens`/`contextPeak` aren't `null`. In
`packages/tui/model.mjs`, replace the lean `readRunModel`-only path with `buildRunView` from
`@piflow/core/observe` (same source the GUI uses), mapping its `RunViewNode` into the TUI row shape.
Keep the live `node-event` accumulator for the running-node tail. Acceptance: the TUI node rows show real
`ctx`/token numbers (it already references `n.tokens?.contextPeak`). Scope: TUI only; do not change core.

---

## Suggested order & independence
1 → 2 (sequential: 1 guards 2). 3 depends on 2. 4, 5, 6 are independent and can run in parallel once core
builds. Every task ends with the verify commands above and a focused commit.
