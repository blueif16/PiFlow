// ── tui/test/thread-row.test.mjs ──────────────────────────────────────
// LOCKS the ThreadCol live-fleet signals the shared `summarizeRun` now fills (ThreadRow.runningTool,
// staleMs). These are ALREADY rendered correctly in components.mjs — this test pins that wiring so a
// regression reddens. Two signals, two distinct observability strategies:
//   • LIVE FOCUS — `${runningNode}:${runningTool}` is plain text, so it survives ANSI stripping; assert
//     the literal `classify:Read` appears (and that a null tool yields NO trailing `:`/`:null`). Reddens
//     if the `:${runningTool}` segment is dropped.
//   • STALE — a stalled running thread sets `pc = 'red'` (vs cyan for a fresh running thread). That signal
//     is COLOR-ONLY, so we force chalk to emit ANSI (vi.hoisted, before chalk's level is read) and assert
//     the stale row's RAW frame carries the red SGR code (31) that the fresh running row does NOT. Reddens
//     if the `stale`/`pc` branch is deleted (both rows would then be cyan).
// Two renders only (one stale row, one fresh row), each reused across its assertions — Ink's render() has
// a ~900ms fixed cost per call, so we keep the count minimal to stay light under the parallel test pool.
import { vi, describe, it, expect, beforeAll } from 'vitest';
// Force chalk/ink to emit color codes so the stale (red) vs fresh (cyan) distinction is observable in the
// captured frame. ink-testing-library is non-TTY → chalk level 0 → no codes by default; vi.hoisted runs
// BEFORE the static imports below evaluate chalk's level, so this takes effect. (Plain-text assertions are
// unaffected — they strip ANSI first.)
vi.hoisted(() => { process.env.FORCE_COLOR = '3'; });
import { render } from 'ink-testing-library';
import { ThreadCol } from '../components.mjs';

const plain = (s) => (s || '').replace(/\x1b\[[0-9;]*m/g, '');
const RED = '\x1b[31m'; // the SGR code chalk emits for color('red') — the stale path's only visible mark
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A minimal synthetic ThreadRow (summarizeRun shape) — all the live fields nullable, like a real read.
const mkThread = (over = {}) => ({
  statusPath: 'k', run: 'demo', state: 'running', nodesDone: 1, nodesTotal: 3,
  runningNode: null, runningTool: null, runningStalled: false, staleMs: null,
  stageIndex: null, stageTotal: null, phase: null, errorNode: null,
  ...over,
});

// Render ThreadCol (focus on the THREADS pane) and return both the raw frame (codes intact, for the color
// assertion) and the ANSI-stripped text (for the literal-text assertion).
const frameFor = async (threads) => {
  const { lastFrame, unmount } = render(ThreadCol(threads, 0, 1, 20, 0, 30));
  await sleep(20);
  const raw = lastFrame();
  unmount();
  return { raw, text: plain(raw) };
};

// Two rows, identical EXCEPT staleMs crossing the 90s bar → the only difference is `pc` (cyan vs red).
// Rendered ONCE in beforeAll and reused by every assertion below.
let fresh; // running, runningTool set, NOT stale
let stale; // running, runningTool set, stalled (staleMs > 90s)
let freshNoTool; // running, runningTool null
beforeAll(async () => {
  fresh = await frameFor([mkThread({ runningNode: 'classify', runningTool: 'Read', staleMs: 1000 })]);
  stale = await frameFor([mkThread({ runningNode: 'classify', runningTool: 'Read', staleMs: 120000 })]);
  freshNoTool = await frameFor([mkThread({ runningNode: 'classify', runningTool: null, staleMs: 1000 })]);
});

describe('ThreadCol renders the live fleet ThreadRow signals', () => {
  it('draws the running node + in-flight tool as `node:tool`', () => {
    // The live focus: `${runningNode}${runningTool ? ':'+runningTool : ''}`. Deleting the runningTool
    // segment leaves bare `classify`, so this exact substring reddens the test.
    expect(fresh.text).toContain('classify:Read');
  });

  it('omits the tool segment (no `:`) when runningTool is null — never renders null', () => {
    expect(freshNoTool.text).toContain('classify');
    expect(freshNoTool.text).not.toContain('classify:'); // null tool ⇒ no trailing `:`, no `:null`
    expect(freshNoTool.text).not.toMatch(/null|undefined/);
  });

  it('colors a STALLED running thread red, distinct from a fresh running thread (cyan)', () => {
    // Differential, not absolute: the fresh running row is cyan (no red SGR); the stale row carries red.
    // If the `stale`/`pc='red'` branch were deleted, both rows would be cyan and `stale.raw` would lose the
    // red code → this reddens. (Asserting the difference, not a fixed code position, keeps it robust.)
    expect(fresh.raw).not.toContain(RED);
    expect(stale.raw).toContain(RED);
  });
});
