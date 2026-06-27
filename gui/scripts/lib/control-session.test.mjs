// Test for the CONTROL-SESSION framing/serialization contract (gui/scripts/lib/control-session.mjs).
//
// This is the load-bearing proof for the rpc-stdio transport: pi's `--mode rpc` stdout is strict
// `\n`-JSONL, and a single JSON frame can be SPLIT across two stdout `data` events. If our parser doesn't
// carry the trailing partial line across chunks (the evidence's explicit rule — and why Node `readline`
// is banned), a split object silently corrupts the stream. These tests FAIL when that carry is broken, and
// the last test demonstrates that a naive per-chunk split (the wrong impl) WOULD fail — so this is not
// coverage theater.
//
// Pure functions only — no child spawn here (the live smoke test exercises the real `pi`).
import { describe, it, expect } from "vitest";
import { parseJsonlChunk, serializeCommand, parseSessionHeader } from "./control-session.mjs";

describe("parseJsonlChunk — strict \\n-JSONL with carry-partial-line", () => {
  it("reassembles a JSON object SPLIT across two chunks (the carry-partial contract)", () => {
    const frame = { v: 1, type: "message_update", message: { role: "assistant", text: "hello world" } };
    const whole = JSON.stringify(frame) + "\n";
    const cut = 20; // slice mid-object, mid-string
    const a = whole.slice(0, cut);
    const b = whole.slice(cut);

    // chunk 1: no complete line yet — everything is carried as `rest`.
    const r1 = parseJsonlChunk("", a);
    expect(r1.frames).toEqual([]);
    expect(r1.rest).toBe(a);

    // chunk 2: prepend the carry → the object now completes and parses intact.
    const r2 = parseJsonlChunk(r1.rest, b);
    expect(r2.frames).toEqual([frame]);
    expect(r2.rest).toBe("");
  });

  it("parses TWO frames delivered in ONE chunk", () => {
    const f1 = { type: "agent_start" };
    const f2 = { type: "turn_start" };
    const chunk = serializeCommand(f1) + serializeCommand(f2);
    const { frames, rest } = parseJsonlChunk("", chunk);
    expect(frames).toEqual([f1, f2]);
    expect(rest).toBe("");
  });

  it("emits complete frames and carries a trailing partial line for the next chunk", () => {
    const f1 = { id: "p1", type: "response", command: "prompt", success: true };
    const partial = '{"type":"message_';
    const { frames, rest } = parseJsonlChunk("", JSON.stringify(f1) + "\n" + partial);
    expect(frames).toEqual([f1]);
    expect(rest).toBe(partial); // the half-frame waits for more bytes
  });

  it("skips blank/keepalive lines and drops a single unparseable line without throwing", () => {
    const good = { type: "turn_end" };
    const chunk = "\n" + "not json{{{" + "\n" + JSON.stringify(good) + "\n";
    let frames;
    expect(() => { ({ frames } = parseJsonlChunk("", chunk)); }).not.toThrow();
    expect(frames).toEqual([good]); // the good frame survives the bad neighbor
  });

  it("tolerates CRLF line endings", () => {
    const f = { type: "agent_end" };
    const { frames } = parseJsonlChunk("", JSON.stringify(f) + "\r\n");
    expect(frames).toEqual([f]);
  });

  it("a NAIVE per-chunk split (no carry) would corrupt a split object — proving carry-partial is load-bearing", () => {
    // The WRONG implementation the test guards against: split each chunk independently and JSON.parse lines.
    const naive = (chunk) =>
      chunk.split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return "PARSE_ERROR"; } });
    const frame = { v: 1, type: "message_end", message: { text: "the quick brown fox" } };
    const whole = JSON.stringify(frame) + "\n";
    const a = whole.slice(0, 18);
    const b = whole.slice(18);

    // naive: each half fails to parse → corruption (this is exactly the bug carry-partial prevents).
    expect(naive(a)).toContain("PARSE_ERROR");
    expect(naive(b)).toContain("PARSE_ERROR");

    // ours: the same two chunks reassemble correctly.
    const r1 = parseJsonlChunk("", a);
    const r2 = parseJsonlChunk(r1.rest, b);
    expect(r2.frames).toEqual([frame]);
  });
});

describe("serializeCommand — one \\n-terminated line per command", () => {
  it("serializes a command to exactly ONE newline-terminated line", () => {
    const out = serializeCommand({ id: "1", type: "prompt", message: "hi" });
    expect(out.endsWith("\n")).toBe(true);
    expect(out.slice(0, -1).includes("\n")).toBe(false); // no embedded newline
    expect(out.split("\n").filter(Boolean)).toHaveLength(1);
    expect(JSON.parse(out)).toEqual({ id: "1", type: "prompt", message: "hi" });
  });

  it("escapes a newline INSIDE a string value (never emits a second line)", () => {
    const out = serializeCommand({ type: "prompt", message: "line1\nline2" });
    expect(out.split("\n").filter(Boolean)).toHaveLength(1); // the inner \n is JSON-escaped, not a frame break
    expect(JSON.parse(out).message).toBe("line1\nline2");
  });

  it("round-trips through parseJsonlChunk", () => {
    const cmd = { id: "x", type: "steer", message: "interrupt" };
    const { frames } = parseJsonlChunk("", serializeCommand(cmd));
    expect(frames).toEqual([cmd]);
  });
});

// The history-list parser pins the second load-bearing contract: turning one session `.jsonl`'s LEADING
// LINES into the {id,name,firstMessage} summary the GUI renders. The shapes here are the REAL pi 0.79.10
// session-file shapes (runtime-captured during this work: `{type:"session",version:3,id,timestamp,cwd}`
// header, optional `{type:"session_info",name}`, then `{type:"message",message:{role:"user",content}}`).
// Each test FAILS if the parse is wrong; the malformed/empty cases prove it never throws on the relay path.
describe("parseSessionHeader — header → conversation-list summary", () => {
  const header = (id = "019f0b0f-a344-705c-ad3d-4eb80c36d84c") =>
    JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-06-27T21:50:02.052Z", cwd: "/run" });
  const info = (name) => JSON.stringify({ type: "session_info", id: "ab12", parentId: null, name });
  const userMsg = (text) => JSON.stringify({ type: "message", id: "c3", parentId: "ab12", message: { role: "user", content: [{ type: "text", text }] } });

  it("extracts id, name, and firstMessage from a real header + session_info + first user message", () => {
    const jsonl = [header(), info("Refactor auth module"), userMsg("Please refactor the auth module")].join("\n") + "\n";
    const out = parseSessionHeader(jsonl);
    expect(out).toEqual({
      id: "019f0b0f-a344-705c-ad3d-4eb80c36d84c",
      name: "Refactor auth module",
      firstMessage: "Please refactor the auth module",
    });
  });

  it("uses the first user message when there is no session_info name (name → null)", () => {
    const jsonl = [header("id-no-name"), userMsg("Reply with exactly: ALPHA")].join("\n") + "\n";
    const out = parseSessionHeader(jsonl);
    expect(out.id).toBe("id-no-name");
    expect(out.name).toBeNull();
    expect(out.firstMessage).toBe("Reply with exactly: ALPHA");
  });

  it("reads a string-content user message (not just text-block arrays)", () => {
    const jsonl = [header("id-str"), JSON.stringify({ type: "message", message: { role: "user", content: "hello world" } })].join("\n") + "\n";
    expect(parseSessionHeader(jsonl).firstMessage).toBe("hello world");
  });

  it("tolerates intervening model_change / thinking_level_change entries before the first message", () => {
    const jsonl = [
      header("id-mid"),
      info("named one"),
      JSON.stringify({ type: "model_change", provider: "nebius", modelId: "zai-org/GLM-5.2" }),
      JSON.stringify({ type: "thinking_level_change", thinkingLevel: "medium" }),
      userMsg("the real first prompt"),
    ].join("\n") + "\n";
    const out = parseSessionHeader(jsonl);
    expect(out.name).toBe("named one");
    expect(out.firstMessage).toBe("the real first prompt");
  });

  it("returns the header even when no user message has been written yet (firstMessage → null)", () => {
    const out = parseSessionHeader(header("just-a-header") + "\n");
    expect(out.id).toBe("just-a-header");
    expect(out.firstMessage).toBeNull();
  });

  it("returns null for an empty or whitespace-only file (skipped, never thrown)", () => {
    expect(parseSessionHeader("")).toBeNull();
    expect(parseSessionHeader("   \n\n")).toBeNull();
    expect(() => parseSessionHeader("")).not.toThrow();
  });

  it("returns null when there is no valid session header (a non-session jsonl is skipped)", () => {
    const jsonl = userMsg("orphan message with no header") + "\n";
    expect(parseSessionHeader(jsonl)).toBeNull();
  });

  it("skips a malformed leading line and still finds the header on a later line, without throwing", () => {
    const jsonl = "this is not json {{{\n" + header("recovered") + "\n" + userMsg("after the garbage") + "\n";
    let out;
    expect(() => { out = parseSessionHeader(jsonl); }).not.toThrow();
    expect(out.id).toBe("recovered");
    expect(out.firstMessage).toBe("after the garbage");
  });

  it("condenses whitespace and truncates a very long first message", () => {
    const long = "a ".repeat(200); // 400 chars, lots of whitespace
    const jsonl = [header("id-long"), userMsg(long)].join("\n") + "\n";
    const out = parseSessionHeader(jsonl);
    expect(out.firstMessage.length).toBeLessThanOrEqual(140);
    expect(out.firstMessage.endsWith("…")).toBe(true);
    expect(out.firstMessage).not.toContain("  "); // collapsed runs of whitespace
  });
});
