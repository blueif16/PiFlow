// The control-session CHANNEL keying (Slice 2): a compose-gate authoring session is a SEPARATE `pi` from the
// Companion chat, keyed distinctly so starting a compose never rebases the user's open chat. The allowlist is
// load-bearing — an un-allowlisted channel must NOT spawn a stray pi, and the default (no channel) must key by
// the bare run id byte-identically to before (so the Companion path is untouched).
import { describe, it, expect } from "vitest";
import { parseChannel, sessionKeyFor } from "../src/control-channel.js";

describe("parseChannel — the channel allowlist", () => {
  it("accepts the compose channel", () => {
    expect(parseChannel("compose")).toBe("compose");
  });
  it("rejects anything not on the allowlist (no stray pi for a made-up channel)", () => {
    expect(parseChannel("companion")).toBeNull();
    expect(parseChannel("../escape")).toBeNull();
    expect(parseChannel("COMPOSE")).toBeNull();
    expect(parseChannel("")).toBeNull();
    expect(parseChannel(null)).toBeNull();
    expect(parseChannel(undefined)).toBeNull();
  });
});

describe("sessionKeyFor — distinct pi per channel", () => {
  it("keys a channel session under <run>::<channel> so it never collides with the Companion", () => {
    expect(sessionKeyFor("run-42", "compose")).toBe("run-42::compose");
  });
  it("keys the default (no channel) by the bare run id — the Companion path is byte-identical", () => {
    expect(sessionKeyFor("run-42", null)).toBe("run-42");
  });
  it("the compose key and the bare-run key are different (the isolation invariant)", () => {
    expect(sessionKeyFor("run-42", "compose")).not.toBe(sessionKeyFor("run-42", null));
  });
});
