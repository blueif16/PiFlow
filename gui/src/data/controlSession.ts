// controlSession.ts — the GUI's CONTROL-SESSION client. Sibling to runStream.ts (the one-way DAG telemetry
// client), kept SEPARATE on purpose: telemetry stays a pure one-way DAG feed, this is the ONE two-way
// channel (talk to an interactive `pi` about a run). It opens its OWN EventSource to the control bridge
// (gui/vite.config.ts `/__piflow/control/<run>/stream`), which relays the frames pi emits over `--mode rpc`
// stdout — the agent event firehose + id-correlated command responses. It folds those frames into a chat
// view-model and exposes send()/abort()/start() to drive the up-channel (POST /message + /start).
//
// FRAME SET is OPEN (evidence): we fold the known streaming spine and pass unknown event types through as a
// generic log row — a new pi event shows up without a client change. Captured-real frame types we fold:
// response:<cmd> (here `{type:"response",command,...}`), agent_start/end, turn_start/end,
// message_start/update/end (message_end carries message.usage), tool_execution_start/end, plus the bridge's
// own meta/stderr/session_closed/stream-error wrappers.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

/** A folded chat message (assembled from message_start → message_update → message_end). We fold on the
 *  ASSEMBLED `message` snapshot pi sends on each frame (stable), not the fine-grained delta. */
export interface ControlMessage {
  id: string;                 // stable key: message.id ?? a synthesized index key
  role: string;               // "user" | "assistant" | "toolResult" | …
  text: string;               // concatenated text content
  streaming: boolean;         // true between message_start and message_end
  usage?: { input?: number; output?: number; totalTokens?: number; cost?: number };
}

/** A folded tool card — tool_execution_start/end collapse into ONE entry keyed by the stable toolCallId. */
export interface ControlToolExecution {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  phase: "running" | "done";
}

/** The §1c-style snapshot pi answers `get_state`/`get_session_stats` with — the bits the dock surfaces. */
export interface ControlContextUsage { tokens: number | null; contextWindow: number; percent: number | null }

export interface ControlSessionState {
  status: "idle" | "connecting" | "live" | "closed" | "error";
  messages: ControlMessage[];
  toolExecutions: Map<string, ControlToolExecution>;
  /** true while the agent is mid-turn (between agent_start and agent_end) — drives steer-vs-prompt. */
  streaming: boolean;
  model?: string | null;
  thinkingLevel?: string | null;
  contextUsage?: ControlContextUsage | null;
  /** generic passthrough log of unrecognized frame types (forward-compatible). */
  notices: string[];
  error?: string;
}

const INITIAL: ControlSessionState = {
  status: "idle",
  messages: [],
  toolExecutions: new Map(),
  streaming: false,
  notices: [],
};
const NOTICE_CAP = 40;

/** Shared control state (a sibling to RunStreamContext) — a provider can own ONE control subscription and
 *  hand it to the Companion, mirroring how CanvasInner owns the telemetry stream. */
export interface ControlSessionApi extends ControlSessionState {
  /** Send a chat message. Auto-steers if the agent is mid-turn, else a fresh prompt. */
  send: (text: string) => Promise<void>;
  /** Abort the current turn (the agent op only — pi stays up). */
  abort: () => Promise<void>;
  /** Explicitly (re)start the control pi (POST /start). The stream also auto-starts on connect. */
  start: () => Promise<void>;
}

const NOOP_API: ControlSessionApi = {
  ...INITIAL,
  send: async () => {},
  abort: async () => {},
  start: async () => {},
};
export const ControlStreamContext = createContext<ControlSessionApi>(NOOP_API);
export const useControlStreamContext = (): ControlSessionApi => useContext(ControlStreamContext);

// ---- the fold: one frame → next state. Pure, so it's trivially reasoned about/testable. -----------------

let synthSeq = 0; // for messages pi sends without an id (fall back to a stable synthesized key)

function textOf(message: { content?: unknown } | undefined): string {
  if (!message || !Array.isArray(message.content)) return "";
  return (message.content as Array<{ type?: string; text?: string }>)
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("");
}

function foldMessage(prev: ControlMessage[], message: Record<string, unknown> | undefined, streaming: boolean): ControlMessage[] {
  if (!message) return prev;
  const id = typeof message.id === "string" ? message.id : `m${(message.timestamp as number) ?? ++synthSeq}`;
  const folded: ControlMessage = {
    id,
    role: typeof message.role === "string" ? message.role : "assistant",
    text: textOf(message as { content?: unknown }),
    streaming,
    usage: (message.usage as ControlMessage["usage"]) ?? undefined,
  };
  const i = prev.findIndex((m) => m.id === id);
  if (i < 0) return [...prev, folded];
  const next = prev.slice();
  next[i] = { ...next[i], ...folded };
  return next;
}

export function reduceControl(prev: ControlSessionState, frame: Record<string, unknown>): ControlSessionState {
  const type = typeof frame.type === "string" ? frame.type : "";
  switch (type) {
    case "meta":
      return { ...prev, status: prev.status === "closed" ? "closed" : "live" };
    case "agent_start":
      return { ...prev, streaming: true };
    case "agent_end":
      return { ...prev, streaming: false };
    case "message_start":
      return { ...prev, messages: foldMessage(prev.messages, frame.message as Record<string, unknown>, true) };
    case "message_update":
      return { ...prev, messages: foldMessage(prev.messages, frame.message as Record<string, unknown>, true) };
    case "message_end":
      return { ...prev, messages: foldMessage(prev.messages, frame.message as Record<string, unknown>, false) };
    case "tool_execution_start": {
      const id = String(frame.toolCallId ?? "");
      if (!id) return prev;
      const m = new Map(prev.toolExecutions);
      m.set(id, { toolCallId: id, toolName: String(frame.toolName ?? "tool"), args: frame.args, phase: "running" });
      return { ...prev, toolExecutions: m };
    }
    case "tool_execution_update": {
      const id = String(frame.toolCallId ?? "");
      const cur = prev.toolExecutions.get(id);
      if (!cur) return prev;
      const m = new Map(prev.toolExecutions);
      m.set(id, { ...cur, args: frame.args ?? cur.args });
      return { ...prev, toolExecutions: m };
    }
    case "tool_execution_end": {
      const id = String(frame.toolCallId ?? "");
      const cur = prev.toolExecutions.get(id) ?? { toolCallId: id, toolName: String(frame.toolName ?? "tool"), phase: "done" as const };
      const m = new Map(prev.toolExecutions);
      m.set(id, { ...cur, result: frame.result, isError: !!frame.isError, phase: "done" });
      return { ...prev, toolExecutions: m };
    }
    case "model_select":
      return { ...prev, model: ((frame.model as { id?: string })?.id) ?? prev.model };
    case "thinking_level_select":
      return { ...prev, thinkingLevel: (frame.level as string) ?? prev.thinkingLevel };
    case "response": {
      // id-correlated ack to a command we sent. Snapshot replies (get_state/get_session_stats/get_messages)
      // carry the §1c state we surface; other acks are silent.
      const data = (frame.data ?? {}) as Record<string, unknown>;
      const cmd = frame.command;
      if (cmd === "get_state") {
        return {
          ...prev,
          model: ((data.model as { id?: string })?.id) ?? prev.model,
          thinkingLevel: (data.thinkingLevel as string) ?? prev.thinkingLevel,
          streaming: typeof data.isStreaming === "boolean" ? (data.isStreaming as boolean) : prev.streaming,
        };
      }
      if (cmd === "get_session_stats" && data.contextUsage) {
        return { ...prev, contextUsage: data.contextUsage as ControlContextUsage };
      }
      if (cmd === "get_messages" && Array.isArray(data.messages)) {
        // re-base the message list from the snapshot (a late joiner / reconnect catches up).
        let messages = prev.messages;
        for (const msg of data.messages as Array<Record<string, unknown>>) messages = foldMessage(messages, msg, false);
        return { ...prev, messages };
      }
      return prev;
    }
    case "session_closed":
      return { ...prev, status: "closed", streaming: false };
    case "stderr":
      return { ...prev, notices: [...prev.notices, `pi: ${String(frame.text ?? "")}`].slice(-NOTICE_CAP) };
    case "stream-error":
      return { ...prev, status: "error", error: String(frame.error ?? "stream error") };
    default:
      // forward-compatible: an unknown event type still surfaces as a notice (no client change needed).
      return type ? { ...prev, notices: [...prev.notices, type].slice(-NOTICE_CAP) } : prev;
  }
}

// ---- the hook: EventSource + fold + reconnect-with-backoff + the up-channel POSTs --------------------------

const MAX_BACKOFF_MS = 15_000;

/**
 * Subscribe to a run's control session. Opens an EventSource to the control bridge, folds frames into the
 * chat view-model, and exposes send/abort/start. Re-subscribes when `run` changes; closes on unmount and on
 * a terminal `session_closed`. A transient drop reconnects with exponential backoff; on each (re)open the
 * bridge re-sends the snapshot first (the host re-triggers get_state/get_messages/get_session_stats on
 * subscribe), so a reconnect re-bases.
 */
export function useControlSession(run: string | null | undefined): ControlSessionApi {
  const [state, setState] = useState<ControlSessionState>(INITIAL);
  const esRef = useRef<EventSource | null>(null);
  const backoffRef = useRef(500);
  const retryRef = useRef<number | null>(null);
  const stoppedRef = useRef(false);

  useEffect(() => {
    if (!run) { setState(INITIAL); return; }
    setState({ ...INITIAL, status: "connecting" });
    stoppedRef.current = false;
    backoffRef.current = 500;

    const connect = () => {
      if (stoppedRef.current) return;
      const es = new EventSource(`/__piflow/control/${encodeURIComponent(run)}/stream`);
      esRef.current = es;
      es.onopen = () => { backoffRef.current = 500; };
      es.onmessage = (e: MessageEvent) => {
        let frame: Record<string, unknown>;
        try { frame = JSON.parse(e.data) as Record<string, unknown>; } catch { return; }
        setState((prev) => reduceControl(prev, frame));
        if (frame.type === "session_closed") { stoppedRef.current = true; es.close(); }
      };
      es.onerror = () => {
        es.close();
        if (stoppedRef.current) return;
        // EventSource also auto-retries, but we own backoff to avoid a hot reconnect loop on a dead bridge.
        const wait = backoffRef.current;
        backoffRef.current = Math.min(wait * 2, MAX_BACKOFF_MS);
        setState((prev) => (prev.status === "closed" ? prev : { ...prev, status: "connecting" }));
        retryRef.current = window.setTimeout(connect, wait);
      };
    };
    connect();

    return () => {
      stoppedRef.current = true;
      if (retryRef.current) window.clearTimeout(retryRef.current);
      esRef.current?.close();
      esRef.current = null;
    };
  }, [run]);

  const post = useCallback(async (body: Record<string, unknown>) => {
    if (!run) return;
    await fetch(`/__piflow/control/${encodeURIComponent(run)}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }, [run]);

  const send = useCallback(async (text: string) => {
    // steer if a turn is active, else a fresh prompt (the bridge maps deliverAs → prompt|steer|follow_up).
    await post({ v: 1, text, deliverAs: state.streaming ? "steer" : undefined });
  }, [post, state.streaming]);

  const abort = useCallback(async () => { await post({ v: 1, type: "abort" }); }, [post]);

  const start = useCallback(async () => {
    if (!run) return;
    await fetch(`/__piflow/control/${encodeURIComponent(run)}/start`, { method: "POST" });
  }, [run]);

  return { ...state, send, abort, start };
}
