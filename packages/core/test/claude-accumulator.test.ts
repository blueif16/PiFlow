// claude-accumulator.test.ts — P5 of the AgentDriver registry (docs/design/agent-driver-registry.md §4/§4.1/§6 P5).
//
// FAILING tests (written BEFORE the real bodies exist) for the driver-selected observe fold that makes a
// Claude node stop rendering blank while pi stays byte-identical. Four behaviors, one per test class:
//   1. claudeCodeDriver.eventAccumulator() DECODES a real claude stream-json capture into a tool SEQUENCE +
//      toolBreakdown + maxToolRepeat that MATCH a hand-count; every span durMs===0 (the §4.1 count-only ceiling).
//   2. pi's accumulator path is UNCHANGED (guard) — a driver-selected pi node folds identically to today.
//   3. SSE=BATCH parity: feeding the SAME fixture line-by-line (tail/stream style) yields a snapshot() that
//      DEEP-EQUALS the finalize()-built (batch) rich for the same fixture (settled node).
//   4. `executor` is folded onto the assembled wire node (was absent) from the stamped rec.driverId.
//
// THE FIXTURE (packages/core/test/fixtures/claude-stream-json-tools.ndjson) is a REAL-shaped claude
// `--output-format stream-json --verbose` NDJSON capture — same block grammar as the shipped
// claude-stream-json-sample.ndjson (assistant `message.content[].tool_use` paired with the following
// user `message.content[].tool_result`), extended to FOUR tool calls with a REPEATED Grep so
// maxToolRepeat>1. The accumulator reads only the fields the post-slim events.jsonl preserves (`type`,
// tool_use `id`/`name`/`input`, tool_result `tool_use_id`/`is_error`), so this raw capture and the slimmed
// projection decode identically.
//
// Run: npx vitest run packages/core/test/claude-accumulator.test.ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeCodeDriver } from '../src/runner/drivers/claude-code.js';
import { piDriver } from '../src/runner/drivers/pi.js';
import { builtinDrivers } from '../src/runner/drivers/table.js';
import { createNodeAccumulator, type NodeAccumulator } from '../src/observe/distill.js';
import { assembleNode, nodeTokenSpine, type AssembleNodeCtx, type NodeIoLedger } from '../src/observe/runView.js';
import { loadModelCatalog } from '../src/observe/models.js';
import type { PiEvent } from '../src/runner/events.js';
import type { NodeUsage } from '../src/runner/status.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const catalog = loadModelCatalog();

/** The REAL claude stream-json capture, parsed one already-parsed object per NDJSON line — EXACTLY what
 *  both replayEvents (batch) and tailEvents (live) hand each accumulator. */
function fixtureLines(name: string): PiEvent[] {
  const text = fs.readFileSync(path.join(here, 'fixtures', name), 'utf8');
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as PiEvent);
}
const CLAUDE_TOOLS = 'claude-stream-json-tools.ndjson';
const CLAUDE_TOOL_ERROR = 'claude-stream-json-tool-error.ndjson';
const CLAUDE_USAGE = 'claude-stream-json-usage.ndjson';

// ── HAND-COUNT ORACLE (independently justified from the fixture, NOT copied from any output) ──────────────
// The fixture pairs one assistant `tool_use` with the next user `tool_result`, in this order:
//   line 3  assistant tool_use  Read  {file_path:"/tmp/cc-run/in.txt"}         → call #1
//   line 5  assistant tool_use  Grep  {pattern:"TODO",path:"/tmp/cc-run/in.txt"} → call #2
//   line 7  assistant tool_use  Grep  {pattern:"TODO",path:"/tmp/cc-run/in.txt"} → call #3  (IDENTICAL input to #2)
//   line 10 assistant tool_use  Write {file_path:"/tmp/cc-run/out.txt",content:"TODO fix"} → call #4
// So, by hand:
//   • ordered SEQUENCE of tool names       = ['Read','Grep','Grep','Write']
//   • toolBreakdown (name→count)           = { Read:1, Grep:2, Write:1 }
//   • toolCalls (total)                    = 4
//   • maxToolRepeat (SAME name+args)       = 2   (Grep run twice with the identical {pattern,path})
//   • repeatedTool                         = 'Grep'
//   • every tool_result closes its span with durMs 0 (claude stream has NO per-tool end timestamp — §4.1 count-only)
const EXPECTED_SEQUENCE = ['Read', 'Grep', 'Grep', 'Write'];
const EXPECTED_BREAKDOWN = { Read: 1, Grep: 2, Write: 1 };
const EXPECTED_TOOL_CALLS = 4;
const EXPECTED_MAX_REPEAT = 2;
const EXPECTED_REPEATED = 'Grep';

/** Push every fixture line through a fresh accumulator; return its finalize() rich. */
function foldAll(acc: NodeAccumulator, events: PiEvent[]) {
  for (const e of events) acc.push(e);
  return acc.finalize().rich;
}

describe('claudeCodeDriver.eventAccumulator() — decodes claude stream-json tool blocks (P5, behavior 1)', () => {
  it('folds the fixture into the hand-counted SEQUENCE + toolBreakdown + maxToolRepeat, all spans durMs 0', () => {
    const acc = claudeCodeDriver.eventAccumulator();
    // Today eventAccumulator() returns undefined (P5 deferred) ⇒ this assertion is the RED anchor.
    expect(acc).toBeDefined();
    const rich = foldAll(acc!, fixtureLines(CLAUDE_TOOLS));

    // ordered SEQUENCE — the timeline names in call order (the tool list a blank Claude node was missing).
    expect(rich.timeline.map((s) => s.name)).toEqual(EXPECTED_SEQUENCE);
    // per-tool counts + total.
    expect(rich.toolBreakdown).toEqual(EXPECTED_BREAKDOWN);
    expect(rich.toolCalls).toBe(EXPECTED_TOOL_CALLS);
    // loop signal — the identical-args Grep repeat.
    expect(rich.maxToolRepeat).toBe(EXPECTED_MAX_REPEAT);
    expect(rich.repeatedTool).toBe(EXPECTED_REPEATED);
    // count-only ceiling: claude carries NO per-tool end timestamp, so EVERY span is durMs 0 (never a faked duration).
    expect(rich.timeline).toHaveLength(EXPECTED_TOOL_CALLS);
    for (const span of rich.timeline) expect(span.durMs).toBe(0);
  });

  // ── HAND-COUNT ORACLE for the tool_result CLOSE path (independently justified from
  // claude-stream-json-tool-error.ndjson, NOT copied from any output) ────────────────────────────
  // The fixture pairs two assistant tool_use blocks with two user tool_result blocks, in order:
  //   line 2 assistant tool_use  Read  {file_path:"/tmp/cc-run-err/missing.txt"} → call #1
  //   line 3 user     tool_result is_error:true  (tool_use_id toolu_read_err)    → closes #1 as FAILED
  //   line 4 assistant tool_use  Bash  {command:"echo hi"}                      → call #2
  //   line 5 user     tool_result (no is_error key)  (tool_use_id toolu_bash_ok) → closes #2 as OK
  // So, by hand: timeline[0] is the Read span with ok:false; timeline[1] is the Bash span with ok:true.
  it('closes a tool_result with is_error:true as ok:false and a clean tool_result as ok:true, matched by tool order', () => {
    const acc = claudeCodeDriver.eventAccumulator();
    expect(acc).toBeDefined();
    const rich = foldAll(acc!, fixtureLines(CLAUDE_TOOL_ERROR));

    expect(rich.timeline).toHaveLength(2);
    // the specific errored span (Read, closed by the is_error:true tool_result).
    expect(rich.timeline[0].name).toBe('Read');
    expect(rich.timeline[0].ok).toBe(false);
    // the specific successful span (Bash, closed by the tool_result with no is_error key).
    expect(rich.timeline[1].name).toBe('Bash');
    expect(rich.timeline[1].ok).toBe(true);
  });

  // ADDITIVE per-tool error tally (mirrors distill.ts's toolErrorCounts) — same fixture, same is_error read:
  // Read's one call was rejected, Bash's was not, so toolBreakdown stays {Read:1,Bash:1} (attempts, unchanged)
  // while toolErrorCounts distinguishes them ({Read:1}, Bash absent ⇒ 0 errors).
  it('tallies toolErrorCounts per tool from the same is_error read the timeline ok flag uses', () => {
    const acc = claudeCodeDriver.eventAccumulator();
    expect(acc).toBeDefined();
    const rich = foldAll(acc!, fixtureLines(CLAUDE_TOOL_ERROR));

    expect(rich.toolBreakdown).toEqual({ Read: 1, Bash: 1 }); // attempts: unchanged
    expect(rich.toolErrorCounts).toEqual({ Read: 1 }); // only Read's attempt was rejected
  });

  it('is selected from the driver table by executor id — get("claude-code").eventAccumulator() decodes, get("pi") does NOT', () => {
    const drivers = builtinDrivers();
    // the claude driver yields a real, tool-decoding accumulator…
    const cAcc = drivers.get('claude-code').eventAccumulator?.();
    expect(cAcc).toBeDefined();
    const cRich = foldAll(cAcc!, fixtureLines(CLAUDE_TOOLS));
    expect(cRich.toolBreakdown).toEqual(EXPECTED_BREAKDOWN);

    // …while the pi accumulator switches on pi vocab (tool_execution_*), so the SAME claude lines decode NO
    // tools through it — proving the two accumulators are genuinely different reducers (not one shared path).
    const pAcc = drivers.get('pi').eventAccumulator?.();
    expect(pAcc).toBeDefined();
    const pRich = foldAll(pAcc!, fixtureLines(CLAUDE_TOOLS));
    expect(pRich.toolCalls).toBe(0);
    expect(pRich.toolBreakdown).toEqual({});
  });
});

describe('pi accumulator path is UNCHANGED — byte-identical guard (P5, behavior 2)', () => {
  // GUARD (may be green — pi is not touched by P5): piDriver.eventAccumulator() must remain the SAME factory
  // as the hardcoded createNodeAccumulator today folds, so a pi node stays byte-identical. Feeding the SAME
  // pi-vocab stream through both yields deep-equal rich. If P5 ever repoints pi at a different reducer, this RED-flags.
  const PI_EVENTS: PiEvent[] = [
    { type: 'message_start', message: { role: 'assistant', model: 'MiniMax-M3', provider: 'mmgw', api: 'anthropic-messages' } },
    { type: 'tool_execution_start', toolName: 'read', toolCallId: 'a', args: { path: '/p/a' }, _t: 0 },
    { type: 'tool_execution_end', toolCallId: 'a', _t: 5 },
    { type: 'tool_execution_start', toolName: 'bash', toolCallId: 'b', args: { command: 'ls' }, _t: 10 },
    { type: 'tool_execution_end', toolCallId: 'b', _t: 25 },
    { type: 'message_end', message: { role: 'assistant', usage: { input: 30, output: 6, totalTokens: 120 }, stopReason: 'end_turn' } },
  ];

  it('piDriver.eventAccumulator() folds a pi stream IDENTICALLY to the hardcoded createNodeAccumulator', () => {
    const viaDriver = piDriver.eventAccumulator?.();
    expect(viaDriver).toBeDefined();
    const driverRich = foldAll(viaDriver!, PI_EVENTS);

    const hardcodedRich = foldAll(createNodeAccumulator(), PI_EVENTS);
    // deep-equal — the driver-selected pi fold is the SAME reducer (real durMs preserved: bash span = 15ms).
    expect(driverRich).toEqual(hardcodedRich);
    expect(driverRich.timeline.find((s) => s.name === 'bash')?.durMs).toBe(15); // pi keeps REAL durations
    expect(driverRich.toolBreakdown).toEqual({ read: 1, bash: 1 });
  });
});

describe('SSE=BATCH parity — the claude accumulator snapshot() deep-equals finalize().rich (P5, behavior 3)', () => {
  // The live tail feeds acc.snapshot(rec) (non-destructive); buildRunView feeds acc.finalize(rec) (destructive).
  // On a SETTLED node (every tool_result seen) the two MUST deep-equal — else the live graph and the loaded
  // view disagree for a Claude node (the shadow-diff break). snapshot on one acc, finalize on a fresh IDENTICAL one.
  it('a settled Claude node: snapshot() deep-equals finalize().rich for the identical fixture line sequence', () => {
    const rec = { startedAt: 's', endedAt: 'e', durationMs: 42 };
    const events = fixtureLines(CLAUDE_TOOLS);

    const snapAcc = claudeCodeDriver.eventAccumulator();
    expect(snapAcc).toBeDefined();
    for (const e of events) snapAcc!.push(e);
    const snap = snapAcc!.snapshot(rec);

    const finAcc = claudeCodeDriver.eventAccumulator();
    for (const e of events) finAcc!.push(e);
    const fin = finAcc!.finalize(rec).rich;

    expect(snap).toEqual(fin);
    // and it is the REAL populated shape (not a coincidental empty deep-equal).
    expect(snap.timeline.map((s) => s.name)).toEqual(EXPECTED_SEQUENCE);
    expect(snap.maxToolRepeat).toBe(EXPECTED_MAX_REPEAT);
  });

  it('incremental (line-by-line) folding equals whole-batch folding — the tail can never diverge from replay', () => {
    const events = fixtureLines(CLAUDE_TOOLS);

    // BATCH: push all, then finalize.
    const batchAcc = claudeCodeDriver.eventAccumulator();
    expect(batchAcc).toBeDefined();
    const batch = foldAll(batchAcc!, events);

    // STREAM: push one line at a time (as tailEvents hands them), then finalize. The reducer is order-driven,
    // so the terminal rich must be identical to the batch fold.
    const streamAcc = claudeCodeDriver.eventAccumulator();
    for (const e of events) streamAcc!.push(e);
    const stream = streamAcc!.finalize().rich;

    expect(stream).toEqual(batch);
  });
});

describe('executor is folded onto the assembled wire node (P5, behavior 4)', () => {
  // assembleNode is the ONE shared assembler for BOTH buildRunView (batch) and watchRun (live). P5 folds the
  // stamped rec.driverId onto node.executor (beside the already-flowing agentType). Today it is ABSENT.
  const ctx: AssembleNodeCtx = {
    toAbs: (p) => (p.startsWith('/') ? p : `/run/${p}`),
    underRun: (abs) => abs.startsWith('/run/'),
    displayPath: (abs) => String(abs).replace(/^.*\//, ''),
    catalog,
    expected: {},
    samples: {},
    ckJournal: {},
    readMarkerSync: () => null,
  };
  const io: NodeIoLedger = { phase: 'author', reads: [], writes: [] };
  const blankRich = () => createNodeAccumulator().finalize().rich;

  it('a claude-code node folds executor="claude-code" from rec.driverId', () => {
    const rec = {
      id: 'cx', label: 'Claude Node', status: 'ok' as const, driverId: 'claude-code',
      usage: { inputTokens: 18, outputTokens: 337, contextWindow: 200000, numTurns: 2 } as NodeUsage,
      artifacts: [], issues: [],
    };
    const node = assembleNode(rec, blankRich(), io, ctx);
    expect(node.executor).toBe('claude-code');
  });

  it('a pi node folds executor="pi" (additive; pi wire node stays byte-identical otherwise)', () => {
    const rec = { id: 'p0', label: 'Pi Node', status: 'ok' as const, driverId: 'pi', artifacts: [], issues: [] };
    const node = assembleNode(rec, blankRich(), io, ctx);
    expect(node.executor).toBe('pi');
  });
});

// ── Defect E2 — the Claude accumulator accumulates tokens/model/modelCalls from the stream-json it
// already parses, so a LEGACY run (no rec.usage) stops rendering model:null + all-zero tokens. ────────
//
// THE FIXTURE (claude-stream-json-usage.ndjson) is copied VERBATIM from a real legacy run's events.jsonl
// (game-omni p09's `guidance` node, whose run.json carries driverId:null and no rec.usage for every node —
// the exact defect repro). It has a load-bearing real-world wrinkle the synthetic tools fixture doesn't:
// ONE logical model turn is reported across MULTIPLE "assistant" lines sharing the SAME top-level
// `request_id`, each repeating the IDENTICAL usage (the CLI echoes the in-flight message's usage once per
// streamed content chunk). Summing every line naively TRIPLES the real totals. The real data also shows
// usage growing monotonically ACROSS request_ids (turn 2's cache_read = turn 1's cache_creation), which is
// the independent evidence that request_id (falling back to message.id, matching the OTHER shipped fixture's
// shape) is the correct per-turn dedup key — not an assumption, a fact read off the two fixtures' own numbers.
//
// HAND-COMPUTED ORACLE (from the copied lines, NOT copied from any code output):
//   turn A (request_id req_...HGm2XZ...): input=2 output=2 cacheWrite=12175 cacheRead=0     (3 dupe lines → 1)
//   turn B (request_id req_...HH2G4T...): input=2 output=2 cacheWrite=35776 cacheRead=12175 (3 dupe lines → 1)
//   turn C (request_id req_...HJfkqG...): input=2 output=3 cacheWrite=2592  cacheRead=47951 (2 dupe lines → 1)
//   totals: input=6 output=7 cacheWrite=50543 cacheRead=60126 modelCalls=3 model='claude-sonnet-5'
// A naive (non-deduped) sum would instead yield input=16 output=18 cacheWrite=149037 cacheRead=132427
// modelCalls=8 — clearly distinguishable, so this test has real teeth against a dedup regression.
describe('claudeCodeDriver.eventAccumulator() — accumulates tokens/model/modelCalls (Defect E2)', () => {
  it('folds the REAL legacy fixture into the deduped-by-turn oracle totals', () => {
    const acc = claudeCodeDriver.eventAccumulator();
    expect(acc).toBeDefined();
    const rich = foldAll(acc!, fixtureLines(CLAUDE_USAGE));

    expect(rich.model).toBe('claude-sonnet-5');
    expect(rich.modelCalls).toBe(3); // 3 distinct turns, NOT 8 assistant lines
    expect(rich.tokens.input).toBe(6);
    expect(rich.tokens.output).toBe(7);
    expect(rich.tokens.cacheWrite).toBe(50543);
    expect(rich.tokens.cacheRead).toBe(60126);
    expect(rich.tokens.billable).toBe(6 + 7);
    // no principled price source in core (P5.x scope) — cost stays 0, never a hardcoded price table.
    expect(rich.tokens.cost).toBe(0);
    // the count-only tool signal is untouched by this fixture (no tool_use blocks in it).
    expect(rich.toolCalls).toBe(0);
  });

  it('does NOT collapse two DIFFERENT turns (different request_id) into one', () => {
    const acc = claudeCodeDriver.eventAccumulator()!;
    const events: PiEvent[] = [
      { type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5 } }, request_id: 'req_A' } as unknown as PiEvent,
      { type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5 } }, request_id: 'req_A' } as unknown as PiEvent, // dupe chunk of turn A — collapses
      { type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', usage: { input_tokens: 20, output_tokens: 8 } }, request_id: 'req_B' } as unknown as PiEvent, // a genuinely NEW turn
    ];
    const rich = foldAll(acc, events);
    expect(rich.modelCalls).toBe(2); // A (deduped) + B, not 3
    expect(rich.tokens.input).toBe(10 + 20);
    expect(rich.tokens.output).toBe(5 + 8);
  });

  it('falls back to message.id as the turn key when request_id is absent (the shipped tools-fixture shape)', () => {
    const acc = claudeCodeDriver.eventAccumulator()!;
    const events: PiEvent[] = [
      { type: 'assistant', message: { role: 'assistant', model: 'claude-haiku-4-5-20251001', id: 'msg_A', usage: { input_tokens: 10, output_tokens: 4 } } } as unknown as PiEvent,
      { type: 'assistant', message: { role: 'assistant', model: 'claude-haiku-4-5-20251001', id: 'msg_A', usage: { input_tokens: 10, output_tokens: 4 } } } as unknown as PiEvent, // dupe chunk, same id
      { type: 'assistant', message: { role: 'assistant', model: 'claude-haiku-4-5-20251001', id: 'msg_B', usage: { input_tokens: 12, output_tokens: 6 } } } as unknown as PiEvent,
    ];
    const rich = foldAll(acc, events);
    expect(rich.modelCalls).toBe(2); // msg_A (deduped) + msg_B
    expect(rich.tokens.input).toBe(10 + 12);
    expect(rich.tokens.output).toBe(4 + 6);
  });

  it('treats each line as its OWN turn when NEITHER request_id NOR message.id is present (no false collapse)', () => {
    const acc = claudeCodeDriver.eventAccumulator()!;
    const events: PiEvent[] = [
      { type: 'assistant', message: { role: 'assistant', model: 'm', usage: { input_tokens: 5, output_tokens: 1 } } } as unknown as PiEvent,
      { type: 'assistant', message: { role: 'assistant', model: 'm', usage: { input_tokens: 5, output_tokens: 1 } } } as unknown as PiEvent,
    ];
    const rich = foldAll(acc, events);
    expect(rich.modelCalls).toBe(2); // no correlator ⇒ never dedup away a real turn
    expect(rich.tokens.input).toBe(10);
    expect(rich.tokens.output).toBe(2);
  });

  it('the LIVE metrics() (mid-run, no finalize) also reports the accumulated tokens/model — not just finalize()', () => {
    const acc = claudeCodeDriver.eventAccumulator()!;
    for (const e of fixtureLines(CLAUDE_USAGE)) acc.push(e);
    const live = acc.metrics();
    expect(live.model).toBe('claude-sonnet-5');
    expect(live.tokens.input).toBe(6);
    expect(live.tokens.output).toBe(7);
  });
});

// ── nodeTokenSpine's rec.usage-vs-event-replay fallback (runView.ts) already reads `rich.tokens`/`rich.model`
// verbatim when `usage` is undefined — so once the accumulator (above) carries real numbers, the spine picks
// them up with NO nodeTokenSpine code change. This test pins that wiring so a future edit to the ternary
// can't silently drop the fallback.
describe('nodeTokenSpine — the Claude accumulator fallback flows through with NO usage present (Defect E2 wiring)', () => {
  it('sources tokens/model from the Claude accumulator rich node when rec.usage is undefined (legacy run)', () => {
    const acc = claudeCodeDriver.eventAccumulator()!;
    const rich = foldAll(acc, fixtureLines(CLAUDE_USAGE));
    const spine = nodeTokenSpine(undefined, rich, catalog, null);

    expect(spine.model).toBe('claude-sonnet-5'); // NOT null — the legacy defect symptom
    expect(spine.tokens.input).toBe(6);
    expect(spine.tokens.output).toBe(7);
    expect(spine.tokens.billable).toBe(6 + 7); // NOT all-zero — the legacy defect symptom
  });
});
