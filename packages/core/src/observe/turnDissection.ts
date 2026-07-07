// turnDissection.ts — per-MODEL-TURN "reasoning-effort" dissection for one node run: segment the raw
// event stream into per-turn records (thinking/text volume + the tool calls that turn made), plus the
// derived node-level signals a debugging agent wants first — the biggest turn, and any "mega-think" turn
// (a large thinking burst that took ZERO action). This is what turns "why was this node slow" from manual
// trace archaeology into one command: `piflowctl telemetry <run> <node>` renders `turns` as a timeline
// table and `megaThinkTurns` feeds the anomaly worklist.
//
// pi turn semantics (grounds segmentation, verified against a real 4200-event node run):
//   • `turn_start` brackets EVERY model turn — the thinking/text/tool-call-request that follows belongs to
//     the turn that opened them.
//   • `turn_end` is emitted only SOMETIMES (an internal pi checkpoint, not 1:1 with turn_start), so it is
//     NOT a reliable per-turn boundary — segmentation walks strictly turn_start → the NEXT turn_start (or
//     end-of-stream for the final turn).
//   • `message_update.assistantMessageEvent` sub-events (`thinking_delta`/`text_delta`, chars in `.delta`)
//     and the top-level `tool_execution_start` (the harness DISPATCHING a tool the turn's message
//     requested) both fall inside that [turn_start, next turn_start) window in file order.
//
// A PROJECTION over data that already exists uncapped in events.jsonl — computed ONCE here in
// @piflow/core/observe, never in a view (the design law: telemetry sits ON TOP of observe). Mirrors
// contextComposition.ts's shape: a single sequential, order-preserving pass over one node's events.jsonl.

import fssync from 'node:fs';

/** thinkChars ≥ this AND zero tool calls ⇒ a "mega-think" turn (pure deliberation, no action taken).
 *  Exported so a consumer can retune the bar for a smaller/larger model's typical thinking volume. */
export const MEGA_THINK_CHARS = 10_000;

/** Domain-agnostic "derivation" vocabulary — occurrences of these in a node's thinking text count toward
 *  `derivationMarkerCount`, a cheap signal for "the model is deriving a formula/algebraic result" rather
 *  than reading files or planning. Tunable — a consumer may swap in its own regex list (each is matched
 *  case-sensitively, globally, against the full thinking text of every turn). */
export const DERIVATION_MARKERS: RegExp[] = [/sqrt\(/, /discriminant/, /quadratic/];

/** One tool the turn's own message dispatched (via the harness's `tool_execution_start`). */
export interface TurnToolCall {
  name: string;
  /** JSON.stringify(args) sliced to ≤80 chars — enough to identify the call, never the full payload. */
  argsPreview: string;
}

/** One model turn's timeline row. */
export interface TurnRecord {
  turnIndex: number; // 0-based, in stream order
  startMs: number; // relative to the first event of the node run
  durMs: number; // this turn's own span: turn_start → the next turn_start (or end-of-stream)
  thinkChars: number; // summed thinking_delta length
  textChars: number; // summed text_delta length
  toolCalls: TurnToolCall[];
}

/** A turn that burned ≥ MEGA_THINK_CHARS of thinking with ZERO tool calls. */
export interface MegaThinkTurn {
  turnIndex: number;
  thinkChars: number;
  durMs: number;
  /** first ~200 chars of the turn's thinking — enough to see WHAT it was deliberating without a full replay. */
  quote: string;
}

/** The derived node-level rollup over `turns`. */
export interface TurnSummary {
  totalThinkChars: number;
  largestTurn: { turnIndex: number; thinkChars: number; durMs: number } | null;
  megaThinkTurns: MegaThinkTurn[];
  derivationMarkerCount: number;
}

export interface TurnDissection {
  turns: TurnRecord[];
  summary: TurnSummary;
}

const QUOTE_CHARS = 200;

interface RawEvent {
  type?: string;
  _t?: unknown;
  assistantMessageEvent?: { type?: string; delta?: unknown };
  toolName?: string;
  args?: unknown;
}

/** Bounded, guarded args preview — mirrors contextComposition's/distill's JSON.stringify-and-slice idiom. */
function argsPreview(args: unknown): string {
  let s = '';
  try { s = JSON.stringify(args ?? {}); } catch { s = ''; }
  return s.length > 80 ? s.slice(0, 80) : s;
}

/** Count ALL occurrences (not just presence) of each derivation marker in one chunk of thinking text. */
function countMarkers(text: string): number {
  let n = 0;
  for (const re of DERIVATION_MARKERS) {
    const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
    const matches = text.match(new RegExp(re.source, flags));
    if (matches) n += matches.length;
  }
  return n;
}

interface OpenTurn {
  turnIndex: number;
  startAbsT: number;
  lastT: number;
  thinkChars: number;
  textChars: number;
  toolCalls: TurnToolCall[];
  quote: string;
}

/**
 * Segment one node run's `events.jsonl` into per-turn records + the derived node-level rollup. Reads the
 * file directly (like contextComposition's `buildNodeContext`) — turn boundaries and thinking/text volume
 * are NOT tracked by the shared distill.ts accumulator (that reducer folds tokens/tools, not per-turn
 * reasoning), so this is its own single, sequential, order-preserving pass. Missing/unreadable/empty file
 * → an empty dissection (never throws — this is a projection add-on).
 */
export function buildNodeTurns(runDir: string, nodeId: string): TurnDissection {
  const evFile = `${runDir}/.pi/nodes/${nodeId}/events.jsonl`;
  let raw = '';
  try { raw = fssync.readFileSync(evFile, 'utf8'); } catch { raw = ''; }

  const turns: TurnRecord[] = [];
  let totalThinkChars = 0;
  let largestTurn: TurnSummary['largestTurn'] = null;
  const megaThinkTurns: MegaThinkTurn[] = [];
  let derivationMarkerCount = 0;

  let firstT: number | null = null;
  let cur: OpenTurn | null = null;

  // Close `cur` into a TurnRecord (if open) and fold it into the running node-level rollup. Called on every
  // NEW turn_start (closing the PREVIOUS turn) and once more at end-of-stream (closing the FINAL turn).
  const closeCurrent = () => {
    if (!cur) return;
    const rec: TurnRecord = {
      turnIndex: cur.turnIndex,
      startMs: cur.startAbsT - (firstT ?? cur.startAbsT),
      durMs: Math.max(0, cur.lastT - cur.startAbsT),
      thinkChars: cur.thinkChars,
      textChars: cur.textChars,
      toolCalls: cur.toolCalls,
    };
    turns.push(rec);
    totalThinkChars += rec.thinkChars;
    if (!largestTurn || rec.thinkChars > largestTurn.thinkChars) {
      largestTurn = { turnIndex: rec.turnIndex, thinkChars: rec.thinkChars, durMs: rec.durMs };
    }
    // MUTATION-CRITICAL: the AND is the whole point of "mega-think" — a huge-but-productive turn (it acted
    // on its reasoning) is not the same anomaly as a huge turn that took no action at all.
    if (rec.thinkChars >= MEGA_THINK_CHARS && rec.toolCalls.length === 0) {
      megaThinkTurns.push({ turnIndex: rec.turnIndex, thinkChars: rec.thinkChars, durMs: rec.durMs, quote: cur.quote.slice(0, QUOTE_CHARS) });
    }
  };

  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let ev: RawEvent;
    try { ev = JSON.parse(s) as RawEvent; } catch { continue; } // a corrupted/truncated line — skip, never throw
    const t = typeof ev._t === 'number' ? ev._t : null;
    if (firstT == null && t != null) firstT = t;

    if (ev.type === 'turn_start') {
      // Extend the CLOSING turn's span up to this new turn_start's own timestamp before folding it — a
      // turn's durMs is the full wall-clock gap until the next turn begins (every ms of the run belongs to
      // exactly one turn), not just the span up to its last inner event (which would silently drop any
      // gap between the last delta and the next turn — e.g. tool-dispatch latency).
      if (cur && t != null) cur.lastT = t;
      closeCurrent();
      const startAbsT = t ?? (firstT ?? 0);
      cur = { turnIndex: turns.length, startAbsT, lastT: startAbsT, thinkChars: 0, textChars: 0, toolCalls: [], quote: '' };
      continue;
    }
    if (!cur) continue; // events before the first turn_start (session/agent_start) carry no turn context
    if (t != null) cur.lastT = t;

    if (ev.type === 'message_update') {
      const ame = ev.assistantMessageEvent;
      if (ame?.type === 'thinking_delta' && typeof ame.delta === 'string') {
        cur.thinkChars += ame.delta.length;
        if (cur.quote.length < QUOTE_CHARS) cur.quote += ame.delta;
        derivationMarkerCount += countMarkers(ame.delta);
      } else if (ame?.type === 'text_delta' && typeof ame.delta === 'string') {
        cur.textChars += ame.delta.length;
      }
    } else if (ev.type === 'tool_execution_start') {
      const name = typeof ev.toolName === 'string' ? ev.toolName : '';
      cur.toolCalls.push({ name, argsPreview: argsPreview(ev.args) });
    }
  }
  closeCurrent();

  return { turns, summary: { totalThinkChars, largestTurn, megaThinkTurns, derivationMarkerCount } };
}
