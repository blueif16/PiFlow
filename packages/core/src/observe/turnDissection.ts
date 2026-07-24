// turnDissection.ts — per-MODEL-TURN "reasoning-effort" dissection for one node run: the derived node-level
// signals a debugging agent wants first over the per-turn timeline — the biggest turn, and any "mega-think"
// turn (a large thinking burst that took ZERO action). This is what turns "why was this node slow" from
// manual trace archaeology into one command: `piflowctl telemetry <run> <node>` renders `turns` as a
// timeline table and `megaThinkTurns` feeds the anomaly worklist.
//
// EXECUTOR-BLIND BY CONSTRUCTION: the per-turn RECORDS come from the node's own executor adapter
// (`TranscriptSource.turns()` — observe/transcript.ts), which owns turn segmentation in that executor's OWN
// terms (pi brackets a turn with `turn_start`; claude-code has no such event — one `assistant` record IS one
// turn). This module only folds those records into the node-level rollup, so it works for every registered
// executor. The pre-port version scanned events.jsonl for pi's `turn_start`, which is why a claude-code node
// rendered no turn table at all.
//
// HONESTY NOTE: `totalThinkChars`/`megaThinkTurns` are only meaningful when the source declares
// `capabilities().turnThinking`. A renderer MUST check that declaration and print `SKIP: <reason>` when it is
// false — a `0` here means "the record does not carry thinking volume", never "the model did not think".

import type { TranscriptTurn } from './transcript.js';

/** thinkChars ≥ this AND zero tool calls ⇒ a "mega-think" turn (pure deliberation, no action taken).
 *  Exported so a consumer can retune the bar for a smaller/larger model's typical thinking volume. */
export const MEGA_THINK_CHARS = 10_000;

/** Domain-agnostic "derivation" vocabulary — occurrences of these in a node's thinking text count toward
 *  `derivationMarkerCount`, a cheap signal for "the model is deriving a formula/algebraic result" rather
 *  than reading files or planning. Tunable — a consumer may swap in its own regex list (each is matched
 *  case-sensitively, globally, against the thinking text of every turn). */
export const DERIVATION_MARKERS: RegExp[] = [/sqrt\(/, /discriminant/, /quadratic/];

/** One tool the turn's own message dispatched. */
export interface TurnToolCall {
  name: string;
  /** JSON.stringify(args) sliced to ≤80 chars — enough to identify the call, never the full payload. */
  argsPreview: string;
}

/** One model turn's timeline row. */
export interface TurnRecord {
  turnIndex: number; // 0-based, in stream order
  startMs: number; // relative to the first event of the node run
  durMs: number; // this turn's own span
  thinkChars: number; // summed thinking volume (meaningful only when the source declares turnThinking)
  textChars: number; // summed assistant-text volume
  toolCalls: TurnToolCall[];
}

/** A turn that burned ≥ MEGA_THINK_CHARS of thinking with ZERO tool calls. */
export interface MegaThinkTurn {
  turnIndex: number;
  thinkChars: number;
  durMs: number;
  /** first ~200 chars of the turn's THINKING — enough to see WHAT it was deliberating without a full replay. */
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

/** Count ALL occurrences (not just presence) of each derivation marker in one chunk of text. */
function countMarkers(text: string): number {
  let n = 0;
  for (const re of DERIVATION_MARKERS) {
    const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
    const matches = text.match(new RegExp(re.source, flags));
    if (matches) n += matches.length;
  }
  return n;
}

/**
 * Fold one node's transcript turns into the timeline rows + the node-level rollup. PURE over the records —
 * the adapter already did the executor-specific segmentation. An empty input yields an empty dissection
 * (never throws — this is a projection add-on).
 */
export function buildNodeTurns(sourceTurns: readonly TranscriptTurn[]): TurnDissection {
  const turns: TurnRecord[] = [];
  let totalThinkChars = 0;
  let largestTurn: TurnSummary['largestTurn'] = null;
  const megaThinkTurns: MegaThinkTurn[] = [];
  let derivationMarkerCount = 0;

  for (const t of sourceTurns) {
    const rec: TurnRecord = {
      turnIndex: t.index,
      startMs: t.startMs,
      durMs: t.durMs,
      thinkChars: t.thinkChars,
      textChars: t.textChars,
      toolCalls: t.toolCalls.map((c) => ({ name: c.name, argsPreview: c.argsPreview })),
    };
    turns.push(rec);
    totalThinkChars += rec.thinkChars;
    derivationMarkerCount += countMarkers(t.thinkText);
    if (!largestTurn || rec.thinkChars > largestTurn.thinkChars) {
      largestTurn = { turnIndex: rec.turnIndex, thinkChars: rec.thinkChars, durMs: rec.durMs };
    }
    // MUTATION-CRITICAL: the AND is the whole point of "mega-think" — a huge-but-productive turn (it acted
    // on its reasoning) is not the same anomaly as a huge turn that took no action at all.
    if (rec.thinkChars >= MEGA_THINK_CHARS && rec.toolCalls.length === 0) {
      megaThinkTurns.push({ turnIndex: rec.turnIndex, thinkChars: rec.thinkChars, durMs: rec.durMs, quote: t.thinkText.slice(0, QUOTE_CHARS) });
    }
  }

  return { turns, summary: { totalThinkChars, largestTurn, megaThinkTurns, derivationMarkerCount } };
}
