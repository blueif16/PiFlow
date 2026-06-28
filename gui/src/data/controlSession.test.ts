// reduceControl — the pure frame→state fold behind the Companion. The contract that matters for the
// redesign: durable signal (final messages, settled tools) accumulates; the agent-event FIREHOSE's
// lifecycle chatter (turn_start/turn_end/unknown types) must NOT pile up — that pile was the visible
// "junk that never clears" the chat panel showed. A test here fails if an unknown frame ever re-grows a log.
import { describe, it, expect } from "vitest";
import { reduceControl, type ControlSessionState } from "./controlSession";

const base = (): ControlSessionState => ({
  status: "idle",
  messages: [],
  toolExecutions: new Map(),
  streaming: false,
  sessions: [],
  activeSessionId: null,
  notices: [],
});

const msg = (id: string, text: string) => ({ id, role: "assistant", content: [{ type: "text", text }] });

describe("reduceControl — durable signal", () => {
  it("folds a message lifecycle into ONE settled message", () => {
    let s = base();
    s = reduceControl(s, { type: "message_start", message: msg("a", "Hel") });
    s = reduceControl(s, { type: "message_update", message: msg("a", "Hello") });
    s = reduceControl(s, { type: "message_end", message: msg("a", "Hello, world") });
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].text).toBe("Hello, world");
    expect(s.messages[0].streaming).toBe(false);
  });

  it("collapses tool_execution start→end into ONE entry keyed by toolCallId", () => {
    let s = base();
    s = reduceControl(s, { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { cmd: "ls" } });
    expect(s.toolExecutions.get("t1")?.phase).toBe("running");
    s = reduceControl(s, { type: "tool_execution_end", toolCallId: "t1", result: "ok", isError: false });
    expect(s.toolExecutions.size).toBe(1);
    expect(s.toolExecutions.get("t1")?.phase).toBe("done");
  });

  it("clears the folded view on session_rebase (switch/new)", () => {
    let s = base();
    s = reduceControl(s, { type: "message_start", message: msg("a", "hi") });
    s = reduceControl(s, { type: "tool_execution_start", toolCallId: "t1", toolName: "bash" });
    s = reduceControl(s, { type: "session_rebase" });
    expect(s.messages).toHaveLength(0);
    expect(s.toolExecutions.size).toBe(0);
  });
});

describe("reduceControl — the firehose must NOT accumulate", () => {
  it("drops unknown lifecycle frame types instead of piling them into a visible log", () => {
    let s = base();
    // the captured-real lifecycle firehose the bridge passes through (no explicit reducer case):
    for (const type of ["turn_start", "turn_end", "before_agent_start", "context", "turn_start", "turn_end"]) {
      s = reduceControl(s, { type });
    }
    // every one of those was, in the old reducer, appended as a notice row that never cleared.
    expect(s.notices).toHaveLength(0);
  });

  it("an unknown frame leaves durable messages untouched (no spurious rows)", () => {
    let s = base();
    s = reduceControl(s, { type: "message_end", message: msg("a", "answer") });
    s = reduceControl(s, { type: "turn_end" });
    s = reduceControl(s, { type: "some_future_event", payload: 42 });
    expect(s.messages).toHaveLength(1);
    expect(s.notices).toHaveLength(0);
  });
});
