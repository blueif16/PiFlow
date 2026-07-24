// transcript-conformance.test.ts — the SHARED conformance suite EVERY executor's transcript adapter must
// pass (observe/transcript.ts). It is the gate that makes "a new executor cannot silently under-report" a
// TEST rather than a hope, and it is the regression pin for the defect the port closed: piflowctl's
// inspection verbs used to decode every node with pi's event vocabulary hardwired, so a `claude-code` node
// reported `readFiles=0` / `0w/0r/0t` / "every advertised file is a BLIND SPOT" — zeros that read like
// findings on a node that had really performed 7 reads, 3 writes, 1 edit and 5 bash calls.
//
// WHY IT FAILS WHEN THE CODE IS WRONG (the whole point — a suite that passes against a stub proves nothing):
//   • GROUND TRUTH IS HAND-COUNTED FROM REAL BYTES. Each fixture is a real captured record (the claude case
//     is the verified `.piflow/section-anim/runs/260722-09` transcript with payloads trimmed and roots
//     remapped; the pi case is the shipped gm10 archive slice), and the expectations below are the counts a
//     human read off those bytes. An adapter that returns 0 — the exact original bug — fails. So does one
//     that returns 15, or that buckets a `Write` as a read.
//   • DECLARED ⇒ DELIVERED. Every capability an adapter declares TRUE must be backed by evidence on a
//     fixture that exercises it, and every capability declared FALSE must carry a non-empty reason. An
//     adapter cannot pass by declaring everything false (no reason ⇒ fail) or by declaring everything true
//     (no evidence ⇒ fail).
//   • THE CROSS-EXECUTOR MUTATION GUARD. The claude fixture routed through the PI adapter must yield ZERO
//     ops, and through its OWN adapter exactly 16. That pair pins the defect itself: if someone re-hardwires
//     one reader for all executors, the second half of the pair fails.
//
// Run: npx vitest run packages/core/test/transcript-conformance.test.ts

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtinDrivers } from '../src/runner/drivers/table.js';
import {
  CAPABILITY_KEYS, nullTranscriptSource, transcriptFor,
  type TranscriptCapabilities, type TranscriptOpKind, type TranscriptRef, type TranscriptSource,
} from '../src/observe/transcript.js';
import { piTranscript } from '../src/observe/transcript-pi.js';
import { claudeTranscript } from '../src/observe/transcript-claude.js';
import { diagnoseRun } from '../src/runner/logs.js';

const FIX = path.join(__dirname, 'fixtures');
const CLAUDE_SESSION = '3ccf2351-1cfd-4e82-b1f2-9b5177970839';
const RANGED_SESSION = 'ranged-session-id';

const tmpdir = (tag: string) => fs.mkdtemp(path.join(os.tmpdir(), `transcript-${tag}-`));

/** Stage a file into a run dir, creating parents. */
async function put(file: string, bytes: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
}

/** Stage the pi archive fixture as `<run>/.pi/nodes/<id>/events.jsonl`. */
async function stagePiArchive(nodeId = 'gameplay'): Promise<string> {
  const run = await tmpdir('pi');
  const bytes = await fs.readFile(path.join(FIX, 'context-composition', 'events.jsonl'), 'utf8');
  await put(path.join(run, '.pi', 'nodes', nodeId, 'events.jsonl'), bytes);
  return run;
}

/** Stage a claude NATIVE transcript at the real jail path Claude writes:
 *  `<run>/.claude-config/<nodeId>/projects/<cwd-slug>/<sessionId>.jsonl`. */
async function stageClaudeNative(fixtureDir: string, sessionId: string, nodeId = 'section-animation'): Promise<string> {
  const run = await tmpdir('claude');
  const bytes = await fs.readFile(path.join(FIX, 'transcript', fixtureDir, `${sessionId}.jsonl`), 'utf8');
  // an opaque Claude-minted cwd slug — the adapter must LOCATE the file, never reconstruct this
  await put(path.join(run, '.claude-config', nodeId, 'projects', '-ws-run', `${sessionId}.jsonl`), bytes);
  return run;
}

// ── the per-executor cases: hand-counted ground truth over real fixture bytes ────────────────────────
interface ExecutorCase {
  driverId: string;
  label: string;
  nodeId: string;
  stage: () => Promise<string>;
  ref: TranscriptRef;
  originKind: 'archive' | 'native-session';
  opsTotal: number;
  byKind: Partial<Record<TranscriptOpKind, number>>;
  /** distinct paths whose content was DELIVERED to the model (successful read/grep ops). */
  distinctReadPaths: number;
  turnsAtLeast: number;
  /** capabilities this fixture EXERCISES — a declared-true one here MUST show evidence. */
  exercises: (keyof TranscriptCapabilities)[];
}

const CASES: ExecutorCase[] = [
  {
    driverId: 'pi',
    label: 'pi — the shipped gm10 archive slice',
    nodeId: 'gameplay',
    stage: () => stagePiArchive(),
    ref: {},
    originKind: 'archive',
    // hand-counted off test/fixtures/context-composition/events.jsonl
    opsTotal: 7,
    byKind: { read: 6, write: 1 },
    distinctReadPaths: 4, // 5 distinct read paths, one of which is an EPERM failure ⇒ delivered nothing
    turnsAtLeast: 1,
    exercises: ['ops', 'opRanges', 'opResults', 'turns'],
  },
  {
    driverId: 'claude-code',
    label: 'claude-code — the verified section-anim native transcript',
    nodeId: 'section-animation',
    stage: () => stageClaudeNative('claude-native', CLAUDE_SESSION),
    ref: { sessionId: CLAUDE_SESSION },
    originKind: 'native-session',
    // hand-counted off the real record: 7 Read · 5 Bash · 3 Write · 1 Edit
    opsTotal: 16,
    byKind: { read: 7, bash: 5, write: 3, edit: 1 },
    distinctReadPaths: 7,
    turnsAtLeast: 26, // one `assistant` record IS one turn
    exercises: ['ops', 'opResults', 'turns', 'turnDurations'],
  },
  {
    driverId: 'claude-code',
    label: 'claude-code — a ranged + failed read',
    nodeId: 'ranged',
    stage: () => stageClaudeNative('claude-native-ranged', RANGED_SESSION, 'ranged'),
    ref: { sessionId: RANGED_SESSION },
    originKind: 'native-session',
    opsTotal: 3,
    byKind: { read: 3 },
    distinctReadPaths: 1, // big.md delivered twice (paged); denied.md failed ⇒ delivered nothing
    turnsAtLeast: 4,
    exercises: ['ops', 'opRanges', 'opResults', 'turns', 'turnDurations'],
  },
];

/** The evidence that BACKS a declared-true capability. Returning false ⇒ the adapter over-declared. */
function hasEvidence(cap: keyof TranscriptCapabilities, s: TranscriptSource): boolean {
  const ops = s.ops();
  const turns = s.turns();
  switch (cap) {
    case 'ops': return ops.length > 0;
    case 'opRanges': return ops.some((o) => o.range != null);
    case 'opResults': return ops.some((o) => o.resultText != null && o.resultText.length > 0);
    case 'turns': return turns.length > 0;
    case 'turnThinking': return turns.some((t) => t.thinkChars > 0);
    case 'turnDurations': return turns.some((t) => t.durMs > 0);
  }
}

describe.each(CASES)('transcript conformance — $label', (c) => {
  const build = async (): Promise<TranscriptSource> => {
    const run = await c.stage();
    return builtinDrivers().transcriptFor(c.driverId, run, c.nodeId, c.ref);
  };

  it('reports the source it actually read (provenance is never guessed)', async () => {
    const s = await build();
    expect(s.executorId).toBe(c.driverId);
    expect(s.origin().kind).toBe(c.originKind);
    expect(s.origin().path).toBeTruthy();
  });

  it('enumerates EXACTLY the tool calls in the record — the under-report gate', async () => {
    const s = await build();
    const ops = s.ops();
    // The original defect returned 0 here. So would a decoder that silently drops a nested block.
    expect(ops.length).toBe(c.opsTotal);
    const byKind: Record<string, number> = {};
    for (const o of ops) byKind[o.kind] = (byKind[o.kind] ?? 0) + 1;
    expect(byKind).toEqual(c.byKind);
  });

  it('keeps ops in stream order with contiguous 0-based seq, and names each tool verbatim', async () => {
    const s = await build();
    const ops = s.ops();
    expect(ops.map((o) => o.seq)).toEqual(ops.map((_, i) => i));
    // tMs is monotonically non-decreasing when the source carries a clock
    const clocked = ops.map((o) => o.tMs).filter((t): t is number => t != null);
    expect([...clocked].sort((a, b) => a - b)).toEqual(clocked);
    // the executor's OWN tool name survives (never normalised away — that is what makes a report readable)
    for (const o of ops) expect(o.toolName).not.toBe('');
  });

  it('counts distinct DELIVERED read paths — a failed read delivered nothing and must not count', async () => {
    const s = await build();
    const delivered = new Set(s.ops().filter((o) => (o.kind === 'read' || o.kind === 'grep') && o.ok && o.path).map((o) => o.path));
    expect(delivered.size).toBe(c.distinctReadPaths);
  });

  it('segments at least the turns the record contains', async () => {
    const s = await build();
    expect(s.turns().length).toBeGreaterThanOrEqual(c.turnsAtLeast);
    expect(s.turns().map((t) => t.index)).toEqual(s.turns().map((_, i) => i));
  });

  it('DECLARED ⇒ DELIVERED: every capability declared true on a fixture that exercises it shows evidence', async () => {
    const s = await build();
    const caps = s.capabilities();
    for (const cap of c.exercises) {
      if (!caps[cap]) continue; // honestly declared false — checked by the reason test below
      expect(
        hasEvidence(cap, s),
        `adapter '${s.executorId}' declares capabilities.${cap}=true but produced no ${cap} evidence on a fixture that exercises it — an over-declared capability is a silent under-report`,
      ).toBe(true);
    }
  });

  it('DECLARED FALSE ⇒ A STATED REASON: a blind capability always carries its SKIP text', async () => {
    const s = await build();
    const caps = s.capabilities();
    for (const cap of CAPABILITY_KEYS) {
      if (caps[cap]) {
        expect(s.limitation(cap), `a TRUE capability must carry no limitation (${cap})`).toBeNull();
        continue;
      }
      const why = s.limitation(cap);
      expect(typeof why, `capabilities.${cap}=false must state WHY — a reasonless false is a silent blind spot`).toBe('string');
      expect((why ?? '').length).toBeGreaterThan(20);
    }
  });
});

describe('transcript conformance — the registry contract', () => {
  it('every builtin driver ships a transcript reader', () => {
    for (const d of builtinDrivers().list()) {
      expect(typeof d.transcript, `driver '${d.id}' has no transcript reader — every inspection verb would SKIP it`).toBe('function');
    }
  });

  it('a driver with NO reader yields an honest SKIP source — never a zero', () => {
    const s = transcriptFor({ id: 'future-executor' }, '/nowhere', 'n');
    const caps = s.capabilities();
    for (const cap of CAPABILITY_KEYS) {
      expect(caps[cap]).toBe(false);
      // assert the TYPE first so a reasonless (null) limitation fails with THAT message, not a chai type error
      expect(typeof s.limitation(cap), `capabilities.${cap}=false must state WHY`).toBe('string');
      expect(s.limitation(cap)).toContain('future-executor');
    }
    expect(s.ops()).toEqual([]);
    expect(s.turns()).toEqual([]);
    expect(s.origin().kind).toBe('none');
  });

  it('an UNKNOWN executor id SKIPs rather than throwing — routing must never be fatal to inspection', async () => {
    const run = await stagePiArchive('n');
    const s = builtinDrivers().transcriptFor('codex', run, 'n');
    expect(s.capabilities().ops).toBe(false);
    expect(s.limitation('ops')).toContain('codex');
    expect(s.ops()).toEqual([]);
  });

  it('a reader that THROWS degrades to a stated SKIP, not to silent zeros', () => {
    const s = transcriptFor(
      { id: 'broken', transcript: () => { throw new Error('boom'); } },
      '/nowhere', 'n',
    );
    expect(s.capabilities().ops).toBe(false);
    expect(s.limitation('ops')).toContain('boom');
  });

  it('nullTranscriptSource never claims a capability it cannot back', () => {
    const s = nullTranscriptSource('x', 'because');
    expect(CAPABILITY_KEYS.every((k) => s.capabilities()[k] === false)).toBe(true);
  });
});

describe('transcript conformance — the cross-executor mutation guard', () => {
  it('the claude record is INVISIBLE to the pi adapter and FULLY visible to its own — routing is what fixes it', async () => {
    const run = await stageClaudeNative('claude-native', CLAUDE_SESSION);
    // The DEFECT, reproduced: pi's decoder sees no `tool_execution_start` in Claude's nested blocks.
    // (The pre-port verbs ran exactly this path for every claude node and printed its zeros as findings.)
    expect(piTranscript(run, 'section-animation').ops()).toHaveLength(0);
    // The FIX: the claude adapter reads the same bytes natively and finds all 16 calls.
    expect(claudeTranscript(run, 'section-animation', { sessionId: CLAUDE_SESSION }).ops()).toHaveLength(16);
  });

  it('the pi record is invisible to the claude adapter — each adapter reads only its own schema', async () => {
    const run = await stagePiArchive('gameplay');
    // No claude jail dir ⇒ the claude adapter falls back to the archive, whose pi events carry no
    // assistant/user tool blocks ⇒ zero ops. It must NOT invent ops out of a foreign vocabulary.
    expect(claudeTranscript(run, 'gameplay').ops()).toHaveLength(0);
    expect(piTranscript(run, 'gameplay').ops()).toHaveLength(7);
  });
});

describe('transcript conformance — the claude ARCHIVE fallback declares what it lost', () => {
  /** Stage ONLY the slimmed archive (no jail dir) for a claude node — the fallback path. */
  async function stageArchiveOnly(): Promise<string> {
    const run = await tmpdir('claude-archive');
    const lines = [
      JSON.stringify({ type: 'assistant', _t: 10, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/ws/run/a.md' } }] } }),
      JSON.stringify({ type: 'user', _t: 20, message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] } }),
      JSON.stringify({ type: 'assistant', _t: 30, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Write', input: { file_path: '/ws/run/b.md' } }] } }),
    ];
    await put(path.join(run, '.pi', 'nodes', 'n', 'events.jsonl'), lines.join('\n') + '\n');
    return run;
  }

  it('still enumerates the ops the archive kept', async () => {
    const s = claudeTranscript(await stageArchiveOnly(), 'n');
    expect(s.origin().kind).toBe('archive');
    expect(s.ops().map((o) => o.kind)).toEqual(['read', 'write']);
  });

  it('DOWNGRADES opResults with a stated reason — the archive tears long tool_result lines, so a payload it did not keep is UNKNOWN, not empty', async () => {
    const s = claudeTranscript(await stageArchiveOnly(), 'n');
    expect(s.capabilities().opResults).toBe(false);
    expect(s.limitation('opResults')).toMatch(/archive/i);
  });

  it('declares turnThinking false on BOTH sources — claude persists thinking blocks with the text redacted', async () => {
    const archive = claudeTranscript(await stageArchiveOnly(), 'n');
    const native = claudeTranscript(await stageClaudeNative('claude-native', CLAUDE_SESSION), 'section-animation', { sessionId: CLAUDE_SESSION });
    for (const s of [archive, native]) {
      expect(s.capabilities().turnThinking).toBe(false);
      expect(s.limitation('turnThinking')).toMatch(/redact/i);
    }
    // and the redaction is REAL in the fixture — thinking blocks exist, their text does not
    expect(native.turns().reduce((n, t) => n + t.thinkChars, 0)).toBe(0);
  });
});

describe('transcript conformance — the verb-level consequence', () => {
  it('`logs --summary` reports a claude node\'s REAL tallies, never 0w/0r/0t', async () => {
    const run = await stageClaudeNative('claude-native', CLAUDE_SESSION);
    await put(path.join(run, '.pi', 'run.json'), JSON.stringify({
      run: 'r', done: true, ok: true,
      nodes: {
        'section-animation': {
          id: 'section-animation', status: 'ok', exitCode: 0, driverId: 'claude-code',
          sessionId: CLAUDE_SESSION, artifacts: [],
        },
      },
    }));
    const n = diagnoseRun(run).nodes[0];
    // the numbers the verb printed as zeros before the port
    expect(n.tools).toBe(16);
    expect(n.reads).toBe(7);
    expect(n.writes).toBe(4); // 3 Write + 1 Edit (a write tally counts both, as it always has)
    expect(n.blind).toBeUndefined();
  });

  it('an unreadable node is marked BLIND so its tally is never rendered as zeros', async () => {
    const run = await tmpdir('blind');
    await put(path.join(run, '.pi', 'run.json'), JSON.stringify({
      run: 'r', done: true, ok: false,
      nodes: { n: { id: 'n', status: 'blocked', exitCode: 0, driverId: 'codex', artifacts: [{ path: 'x.json', exists: false }] } },
    }));
    const n = diagnoseRun(run).nodes[0];
    expect(n.blind).toBeTruthy();
    // and it must NOT reach the never-write verdict — that is a claim about behaviour we cannot see
    expect(n.note).toMatch(/^SKIP: /);
    expect(n.note).not.toContain('never-write');
  });
});
