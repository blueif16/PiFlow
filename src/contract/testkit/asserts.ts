/**
 * asserts.ts — the throw-on-fail assert helpers for component DRIVE tests.
 *
 * EXTRACTED from the `check(label, cond, detail)` helper copied verbatim into every
 * exemplar (CrumblingPlatform.drive.test.ts:41, OneWayPlatform:43, ComboChain:34) — SAME
 * semantics: a pass logs `  PASS  <label>  (<detail>)` and bumps the shared counter; a fail
 * logs `  FAIL  ...` and THROWS, so the run dies non-zero at the first broken assertion.
 *
 * The counter is module-level (one tally per test process), matching the exemplars'
 * `let passed = 0;` — call `assertionsPassed()` for the final `ALL N ASSERTIONS PASSED`
 * line.
 */

import type { EventBus } from '../component-surface';

let passed = 0;

/** How many assertions have passed in this process (the exemplars' `passed` tally). */
export function assertionsPassed(): number {
  return passed;
}

/** Reset the tally (for a test that wants a fresh count; rarely needed). */
export function resetAssertions(): void {
  passed = 0;
}

/** Throw-on-fail check — identical semantics to the exemplars' inlined `check`. */
export function check(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${label}${detail ? `  (${detail})` : ''}`);
  } else {
    console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ''}`);
    throw new Error(`assertion failed: ${label}`);
  }
}

/** Read a dot-path off an object (`'player.isGrounded'`). Returns undefined if absent. */
function readPath(root: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[key];
  }, root);
}

/**
 * Assert the recording bus logged at least one `type` event since `since` (default: whole
 * buffer), optionally matching a payload shape (each key in `payloadShape` must deep-equal
 * the logged payload's value). Mirrors the exemplars' `bus.recent(cur).filter(...)` +
 * payload-field checks. Returns the matched entries.
 */
export function assertEmitted(
  bus: EventBus,
  type: string,
  payloadShape?: Record<string, unknown>,
  since?: number,
): Array<{ type: string; payload?: unknown }> {
  const matches = bus.recent(since).filter((e) => e.type === type);
  check(`event '${type}' emitted on the bus`, matches.length >= 1, `count=${matches.length}`);
  if (payloadShape) {
    const pl = (matches[0]?.payload ?? {}) as Record<string, unknown>;
    for (const [k, want] of Object.entries(payloadShape)) {
      const got = pl[k];
      const ok = JSON.stringify(got) === JSON.stringify(want);
      check(`event '${type}' payload.${k} === ${JSON.stringify(want)}`, ok, JSON.stringify(pl));
    }
  }
  return matches;
}

/** Assert NO `type` event was logged since `since` (the counterfactual negative). */
export function assertNotEmitted(bus: EventBus, type: string, since?: number): void {
  const matches = bus.recent(since).filter((e) => e.type === type);
  check(
    `no '${type}' event logged`,
    matches.length === 0,
    JSON.stringify(bus.recent(since).map((e) => e.type)),
  );
}

/**
 * Assert an observable (a `snapshot()` dot-path, or any object dot-path) transitioned to
 * the expected value. `transition` is either a concrete expected value (deep-equal) or a
 * predicate over the read value (e.g. `(v) => (v as number) > 0`).
 */
export function assertObservable(
  scene: { snapshot(): Record<string, unknown> } | Record<string, unknown>,
  path: string,
  transition: unknown | ((value: unknown) => boolean),
  detail = '',
): void {
  const root = typeof (scene as { snapshot?: unknown }).snapshot === 'function'
    ? (scene as { snapshot(): Record<string, unknown> }).snapshot()
    : scene;
  const got = readPath(root, path);
  const ok = typeof transition === 'function'
    ? (transition as (v: unknown) => boolean)(got)
    : JSON.stringify(got) === JSON.stringify(transition);
  const want = typeof transition === 'function' ? '<predicate>' : JSON.stringify(transition);
  check(`observable '${path}' → ${want}`, ok, detail || `got=${JSON.stringify(got)}`);
}
