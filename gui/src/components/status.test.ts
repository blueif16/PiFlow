import { describe, it, expect } from "vitest";
import { runRowStatus } from "./status";

// The PURE state+ok → tone mapping the switcher's run rows render from (index fields ONLY — the GUI
// computes nothing else). Each case pins one leg of the law: BLUE(running) / GREEN(done ok) / RED(failed).
// These fail if the mapping is broken (e.g. a failed run reading green).
describe("runRowStatus — run-row tone from index thread fields", () => {
  it("a running run is 'running' (blue)", () => {
    expect(runRowStatus("running", null)).toBe("running");
  });

  it("a done-ok run is 'success' (green)", () => {
    expect(runRowStatus("done", true)).toBe("success");
  });

  it("a failed run is 'error' (red)", () => {
    expect(runRowStatus("failed", false)).toBe("error");
  });

  it("ok === false forces 'error' even when the state string is not 'failed' (belt over the summarizer)", () => {
    expect(runRowStatus("done", false)).toBe("error");
  });

  it("a done run with unknown ok (null) still reads 'success', never error", () => {
    expect(runRowStatus("done", null)).toBe("success");
  });
});
