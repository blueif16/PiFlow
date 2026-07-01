import { describe, it, expect } from "vitest";
import { isTemplateAllowed } from "../src/start-run.js";

// `POST /api/runs/start` spawns agents with credentials, so on a public cloud host the templateDir it will
// run MUST be allow-listed. This pins the gate's contract: no allowlist ⇒ ALLOW ALL (today's local behavior);
// an allowlist ⇒ allow iff the templateDir resolves to a listed entry, comparing absolute resolved paths so
// trailing slashes and relative-vs-absolute forms of the SAME dir are treated as equal.

const TPL = "/repo/.piflow/wf/template";

describe("isTemplateAllowed — the start-run template gate", () => {
  it("no allowlist (undefined) ⇒ allow all (preserves local dev behavior)", () => {
    expect(isTemplateAllowed(TPL, undefined)).toBe(true);
  });

  it("no allowlist (null) ⇒ allow all", () => {
    expect(isTemplateAllowed(TPL, null)).toBe(true);
  });

  it("empty allowlist ⇒ allow all (an empty list is NOT a deny-all)", () => {
    expect(isTemplateAllowed(TPL, [])).toBe(true);
  });

  it("a listed templateDir passes", () => {
    expect(isTemplateAllowed(TPL, ["/other", TPL])).toBe(true);
  });

  it("an UNlisted templateDir is rejected", () => {
    expect(isTemplateAllowed(TPL, ["/other", "/repo/.piflow/other/template"])).toBe(false);
  });

  it("a trailing slash on the ALLOWLIST entry still matches (path.resolve normalizes)", () => {
    expect(isTemplateAllowed(TPL, [`${TPL}/`])).toBe(true);
  });

  it("a trailing slash on the templateDir still matches a bare listed entry", () => {
    expect(isTemplateAllowed(`${TPL}/`, [TPL])).toBe(true);
  });

  it("a RELATIVE-form allowlist entry resolving to the same abs dir matches", () => {
    // process.cwd() + relative ⇒ the same absolute path the template resolves to.
    const abs = "/repo/.piflow/wf/template";
    // Build a request/allowlist pair that only agree after path.resolve on both sides:
    // both point at cwd/./x, one absolute-with-dot-segments, one plain.
    const withDots = "/repo/.piflow/wf/./template";
    expect(isTemplateAllowed(abs, [withDots])).toBe(true);
  });

  it("a relative request path is resolved against cwd before comparing", () => {
    // A relative allowlist entry equals the absolute request when resolved from the same cwd.
    const rel = "some/nested/template";
    const abs = `${process.cwd()}/some/nested/template`;
    expect(isTemplateAllowed(abs, [rel])).toBe(true);
    expect(isTemplateAllowed(rel, [abs])).toBe(true);
  });
});
