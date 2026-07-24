// transcript.ts — the TRANSCRIPT PORT: the ONE executor-neutral vocabulary every inspection verb speaks.
//
// THE DEFECT THIS CLOSES. `trace`, `logs --summary` and the telemetry turn table used to read
// `.pi/nodes/<id>/events.jsonl` DIRECTLY and decode it with pi's event vocabulary hardwired
// (`tool_execution_start`/`turn_start`/`message_update`, lowercase pi tool names). A `claude-code` node's
// archive speaks a DIFFERENT vocabulary (`assistant`/`user` lines with NESTED `tool_use`/`tool_result`
// content blocks, capitalised tool names), so those verbs decoded NOTHING and reported ZEROS — `readFiles=0`,
// `0w/0r/0t`, "17 advertised, 17 BLIND SPOT" — numbers that READ LIKE FINDINGS but were really "I cannot see
// this executor". A silent zero is worse than no answer: it launders blindness as evidence.
//
// THE SHAPE. Ports-and-adapters. This module declares the port; the METHOD NAMES ARE THE VOCABULARY
// (`ops()` · `turns()` · `capabilities()` · `origin()`). One adapter per executor decodes THAT executor's OWN
// native record NATIVELY — there is deliberately NO normalizer step (nothing transcodes Claude's records into
// pi's schema and re-feeds pi's parser; each adapter produces the shared vocabulary directly from its own
// bytes). Adapters are registered by EXECUTOR ID on the ALREADY-SHIPPED `DriverTable`
// (`runner/drivers/table.ts`, keyed by exactly that id) via `AgentDriver.transcript` — a SECOND registry
// keyed by the same id would be the duplicate-noun collision the driver-registry design explicitly warns
// against (agent-driver-registry.md §2.2 naming note). A third executor therefore lights up every verb by
// registering a driver with a `transcript` — no verb, no projection, and no renderer changes.
//
// HONEST BLINDNESS IS THE POINT. Every adapter DECLARES what it can answer (`capabilities()`) and WHY it
// cannot answer the rest (`limitation()`). A verb reads the declaration and prints `SKIP: <reason>` where the
// source genuinely carries no signal — it NEVER prints a zero it cannot stand behind. (Real case: Claude
// Code persists `thinking` content blocks with the text REDACTED to `""` plus a signature, so per-turn
// thinking VOLUME is unrecoverable. `turnThinking:false` + a reason is the truth; `thinkChars: 0` is a lie.)
//
// NAMING. Record FIELDS take the OTel GenAI semantic-convention name wherever one exists — `gen_ai.tool.name`
// → `toolName`, `gen_ai.tool.call.id` → `toolCallId`, `gen_ai.tool.call.arguments` → `argsPreview`,
// `gen_ai.tool.call.result` → `resultText`, `code.file.path` → `path` — continuing the convention
// contextComposition.ts already adopted. OTel GenAI has NO term for a model TURN, for read COVERAGE, or for
// the advertised-vs-read BLIND SPOT, so those keep this codebase's own established words rather than inventing
// a third dialect.

/** Bounded plaintext cap for a captured tool result (mirrors distill.ts `PREVIEW_CAP`). */
export const TRANSCRIPT_TEXT_CAP = 8000;
/** Bounded cap for a per-tool-call args preview (mirrors turnDissection's original 80-char slice). */
export const ARGS_PREVIEW_CAP = 80;

/**
 * The executor-neutral OP KINDS every adapter maps its own tool names onto. `other` is the honest bucket for
 * a tool that fits none of them (a Claude `Task`/`TodoWrite`, a pi `submit_result`) — it is COUNTED as a tool
 * call but contributes no read/write signal, so a projection never has to guess.
 */
export type TranscriptOpKind = 'read' | 'grep' | 'edit' | 'write' | 'list' | 'bash' | 'other';

/** The op kinds that DELIVER file content to the model (the coverage/blind-spot input set). */
export const READ_KINDS: ReadonlySet<TranscriptOpKind> = new Set<TranscriptOpKind>(['read', 'grep']);
/** The op kinds that MUTATE a file (the `logs --summary` write tally — the never-write detector). */
export const WRITE_KINDS: ReadonlySet<TranscriptOpKind> = new Set<TranscriptOpKind>(['edit', 'write']);

/** One tool call the agent made, in stream order — the shared vocabulary a verb renders. */
export interface TranscriptOp {
  /** chronological index across the node run (0-based, over tool ops only). */
  seq: number;
  /** ms since the node's first observed event; null when the source carries no clock. */
  tMs: number | null;
  /** the executor-neutral kind this adapter mapped the call onto. */
  kind: TranscriptOpKind;
  /** `gen_ai.tool.name` — the executor's OWN tool name, verbatim (`read` on pi, `Read` on claude-code). */
  toolName: string;
  /** `gen_ai.tool.call.id` — null when the source carries none. */
  toolCallId: string | null;
  /** `code.file.path` — absolute when the source gives one; `''` when the op names no file (e.g. bash). */
  path: string;
  /** line window the call asked for; null = whole-file/no-args. `limit:null` = offset-only continuation. */
  range: { offset: number; limit: number | null } | null;
  /** did the call succeed? (a result marked as an error ⇒ false). */
  ok: boolean;
  /**
   * `gen_ai.tool.call.result` — the joined plaintext the call returned, capped at `TRANSCRIPT_TEXT_CAP`.
   * Undefined when the source did not carry a decodable result. NOTE: this is the DELIVERED payload, not a
   * log preview — see `logPreviewCapped` for the archive's own cosmetic truncation.
   */
  resultText?: string;
  /**
   * The ARCHIVE truncated its stored copy of the result (`events.jsonl` MAX_RESULT). A LOGGING artifact —
   * the model received the full content — so it must NEVER be mapped to partial coverage.
   */
  logPreviewCapped: boolean;
}

/** One model turn — the reasoning-effort row the telemetry turn table renders. */
export interface TranscriptTurn {
  /** 0-based, in stream order. */
  index: number;
  /** ms from the node's first observed event to this turn's start. */
  startMs: number;
  /** this turn's own span (to the next turn's start, or to the last event of the final turn). */
  durMs: number;
  /** summed thinking characters. Meaningful ONLY when `capabilities().turnThinking` is true. */
  thinkChars: number;
  /** summed assistant-text characters. */
  textChars: number;
  /**
   * The turn's own thinking text, retained WHOLE (not capped) — the derivation-marker scan and the
   * mega-think quote both need it complete, and the source file is already fully in memory either way, so
   * the marginal cost is the same order. Empty when the source redacts thinking (`turnThinking:false`).
   */
  thinkText: string;
  /** The turn's own assistant text, retained whole (the `logs --summary` last-say source). */
  text: string;
  /** the tool calls this turn dispatched, in order. */
  toolCalls: { name: string; argsPreview: string }[];
}

/**
 * What an adapter can HONESTLY answer for THIS node's bytes. A `false` is a declaration of blindness, and a
 * verb must render it as `SKIP: <reason>` — never as a zero. Capabilities are per-SOURCE, not per-executor:
 * the same adapter may declare `turnThinking:true` off a complete native transcript and `false` after falling
 * back to a slimmed archive that dropped the thinking blocks.
 */
export interface TranscriptCapabilities {
  /** can it enumerate tool calls at all? (false ⇒ `trace`/`logs --summary` are blind for this node) */
  ops: boolean;
  /** do read ops carry their line window? (false ⇒ coverage math is not attempted) */
  opRanges: boolean;
  /** do ops carry their returned payload? (false ⇒ returnedBytes/preview are omitted, not zeroed) */
  opResults: boolean;
  /** can it segment model turns? (false ⇒ the turn table SKIPs) */
  turns: boolean;
  /** do turns carry thinking VOLUME? (false ⇒ think-chars SKIP rather than render 0) */
  turnThinking: boolean;
  /** do turns carry a real wall-clock span? */
  turnDurations: boolean;
}

/** Every capability key — the iteration order a conformance suite and a renderer share. */
export const CAPABILITY_KEYS: readonly (keyof TranscriptCapabilities)[] = [
  'ops', 'opRanges', 'opResults', 'turns', 'turnThinking', 'turnDurations',
];

/** Where an adapter actually got its bytes — rendered so a report never has to guess its own provenance. */
export interface TranscriptOrigin {
  /** `archive` = the piflow-captured `.pi/nodes/<id>/events.jsonl`; `native-session` = the executor's own
   *  session/transcript file; `none` = nothing readable was found. */
  kind: 'archive' | 'native-session' | 'none';
  /** absolute path of the file read, or null for `none`. */
  path: string | null;
}

/**
 * The PORT. One implementation per executor, decoding that executor's OWN record natively. All four methods
 * are pure over bytes the adapter read at construction — call them any number of times.
 */
export interface TranscriptSource {
  /** the executor id this adapter speaks for (== the `DriverTable` key). */
  readonly executorId: string;
  /** which file the answers below came from. */
  origin(): TranscriptOrigin;
  /** what this adapter can honestly answer for THIS node's bytes. */
  capabilities(): TranscriptCapabilities;
  /** why a capability is false — the verb's `SKIP: <reason>` text. `null` when the capability is true. */
  limitation(cap: keyof TranscriptCapabilities): string | null;
  /** every tool call the agent made, in stream order. Empty when `capabilities().ops` is false. */
  ops(): TranscriptOp[];
  /** every model turn, in stream order. Empty when `capabilities().turns` is false. */
  turns(): TranscriptTurn[];
}

/** The per-node handle an adapter needs to locate its bytes (the subset of a run.json node record). */
export interface TranscriptRef {
  /** the executor's own session id (pi: the node id; claude-code: the minted uuid). */
  sessionId?: string;
  /** an explicit session dir, when the run recorded one. */
  sessionDir?: string;
}

/** The factory an `AgentDriver` exposes — bound to one node of one run. */
export type TranscriptReader = (runDir: string, nodeId: string, ref?: TranscriptRef) => TranscriptSource;

/** The minimum an adapter host must expose — structurally satisfied by `AgentDriver`, declared here so the
 *  port never imports the driver module (which imports this one). */
export interface TranscriptProvider {
  readonly id: string;
  transcript?: TranscriptReader;
}

/**
 * Resolve ONE node's transcript source through its driver — the SINGLE seam every inspection verb goes
 * through, so routing lives in exactly one place and no verb ever branches on an executor id. A driver that
 * declares no reader yields the honest `nullTranscriptSource` (every verb prints `SKIP`), never a silent zero.
 */
export function transcriptFor(
  driver: TranscriptProvider,
  runDir: string,
  nodeId: string,
  ref?: TranscriptRef,
): TranscriptSource {
  if (!driver.transcript) {
    return nullTranscriptSource(
      driver.id,
      `executor '${driver.id}' declares no transcript reader — register one on its driver (AgentDriver.transcript) to make this node inspectable`,
    );
  }
  try {
    return driver.transcript(runDir, nodeId, ref);
  } catch (e) {
    // A reader that throws is BLIND, not empty — say so rather than degrade to zeros.
    return nullTranscriptSource(driver.id, `transcript reader for '${driver.id}' failed: ${(e as Error).message}`);
  }
}

// ── shared helpers every adapter reuses (so the vocabulary is produced ONE way) ────────────────────────

/** Bounded, guarded args preview — `gen_ai.tool.call.arguments`, capped. */
export function argsPreview(args: unknown): string {
  let s = '';
  try { s = JSON.stringify(args ?? {}); } catch { s = ''; }
  return s.length > ARGS_PREVIEW_CAP ? s.slice(0, ARGS_PREVIEW_CAP) : s;
}

/** Cap a captured payload at `TRANSCRIPT_TEXT_CAP` (undefined stays undefined). */
export function capText(s: string | undefined): string | undefined {
  if (s == null || s === '') return undefined;
  return s.length > TRANSCRIPT_TEXT_CAP ? s.slice(0, TRANSCRIPT_TEXT_CAP) : s;
}

/** Build a range from an offset/limit pair. Recorded whenever EITHER is present — an offset-only read is the
 *  canonical pagination CONTINUATION and must not collapse to null (that mis-counts it as a second whole read).
 *  Offset defaults to 1 (both pi's `read` and Claude's `Read` treat offset as a 1-indexed line). */
export function rangeOf(offset: unknown, limit: unknown): TranscriptOp['range'] {
  const o = typeof offset === 'number' ? offset : null;
  const l = typeof limit === 'number' ? limit : null;
  return o != null || l != null ? { offset: o ?? 1, limit: l } : null;
}

/** Every capability true — the declaration of an adapter whose source carries the full signal. */
export const ALL_CAPABILITIES: TranscriptCapabilities = {
  ops: true, opRanges: true, opResults: true, turns: true, turnThinking: true, turnDurations: true,
};

/**
 * The honest EMPTY source — what a node gets when its driver declares no `transcript` reader, or when the
 * adapter found no readable bytes. It declares EVERY capability false with a stated reason, so each verb
 * prints `SKIP: <reason>` instead of a zero. This is the whole anti-silent-zero contract in one object: an
 * executor that has not been taught to read its own record is VISIBLY unread, never falsely empty.
 */
export function nullTranscriptSource(executorId: string, reason: string): TranscriptSource {
  return {
    executorId,
    origin: () => ({ kind: 'none', path: null }),
    capabilities: () => ({
      ops: false, opRanges: false, opResults: false, turns: false, turnThinking: false, turnDurations: false,
    }),
    limitation: () => reason,
    ops: () => [],
    turns: () => [],
  };
}
