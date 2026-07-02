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

// Dynamic template PUSH: an uploaded template lands under the plane's uploads root, and that root is an
// allow-list entry. So the gate must allow a templateDir that lives UNDER an allow-listed DIRECTORY, not only
// one that equals a listed entry — while still rejecting a `../` escape and a sibling that merely shares a
// string prefix (the classic `startsWith` boundary bug). This is what makes "push a template, then run it"
// work without a rebuild, and it is a SECURITY gate, so the negatives are the teeth.
describe("isTemplateAllowed — uploads-root prefix (dynamic template push)", () => {
  const UPLOADS = "/home/piflow/uploads";
  const UPLOADED = "/home/piflow/uploads/acad/.piflow/example-academy/template";

  it("a template UNDER an allow-listed uploads root is allowed (the push seam)", () => {
    expect(isTemplateAllowed(UPLOADED, [UPLOADS])).toBe(true);
  });

  it("a template NOT under the uploads root (and not exact) is rejected", () => {
    expect(isTemplateAllowed("/somewhere/else/.piflow/wf/template", [UPLOADS])).toBe(false);
  });

  it("a ../ escape out of the uploads root is rejected (path boundary, not string match)", () => {
    expect(isTemplateAllowed("/home/piflow/uploads/../evil/.piflow/wf/template", [UPLOADS])).toBe(false);
  });

  it("a sibling sharing a STRING prefix ('uploads-evil') is rejected (not a path child)", () => {
    // '/home/piflow/uploads-evil' string-startsWith '/home/piflow/uploads' but is NOT a child of it.
    expect(isTemplateAllowed("/home/piflow/uploads-evil/.piflow/wf/template", [UPLOADS])).toBe(false);
  });

  it("exact baked-template match still works alongside a prefix root", () => {
    expect(isTemplateAllowed(TPL, [UPLOADS, TPL])).toBe(true);
    expect(isTemplateAllowed(UPLOADED, [UPLOADS, TPL])).toBe(true);
  });
});
