import { describe, it, expect } from "vitest";
import { remoteRawCandidates } from "./remoteSkillDoc";

// remoteRawCandidates is the coverage GUARANTEE for the remote detail fetch: get the candidate SKILL.md
// URLs (and their ORDER) wrong and a GitHub skill silently shows no detail. Each case fails when the
// resolution is wrong. The network fetch/parse glue (fetchRemoteSkillDoc) is verified by driving the GUI.

describe("remoteRawCandidates — raw.githubusercontent.com SKILL.md URLs for a remote row", () => {
  it("a /tree/<branch>/<subdir> link resolves to the EXACT raw URL, first and only (no guessing)", () => {
    const c = remoteRawCandidates("https://github.com/o/r/tree/dev/skills/pdf", "pdf");
    expect(c[0]).toBe("https://raw.githubusercontent.com/o/r/dev/skills/pdf/SKILL.md");
    expect(c).toHaveLength(1);
  });

  it("a bare repo guesses root → <slug>/ → skills/<slug>/, BRANCH-major (all main, then all master)", () => {
    const c = remoteRawCandidates("https://github.com/o/r", "pdf");
    expect(c).toEqual([
      "https://raw.githubusercontent.com/o/r/main/SKILL.md",
      "https://raw.githubusercontent.com/o/r/main/pdf/SKILL.md",
      "https://raw.githubusercontent.com/o/r/main/skills/pdf/SKILL.md",
      "https://raw.githubusercontent.com/o/r/master/SKILL.md",
      "https://raw.githubusercontent.com/o/r/master/pdf/SKILL.md",
      "https://raw.githubusercontent.com/o/r/master/skills/pdf/SKILL.md",
    ]);
  });

  it("a non-GitHub source (a claudskills catalog page) yields NO candidates — the degrade signal", () => {
    expect(remoteRawCandidates("https://claudskills.com/skills/x", "x")).toEqual([]);
  });

  it("a .git suffix is stripped from the repo segment", () => {
    expect(remoteRawCandidates("https://github.com/o/r.git", "s")[0]).toBe(
      "https://raw.githubusercontent.com/o/r/main/SKILL.md",
    );
  });

  it("a /blob/<branch>/<dir>/SKILL.md link normalizes to that dir (drops the trailing SKILL.md)", () => {
    expect(remoteRawCandidates("https://github.com/o/r/blob/main/skills/pdf/SKILL.md", "pdf")).toEqual([
      "https://raw.githubusercontent.com/o/r/main/skills/pdf/SKILL.md",
    ]);
  });

  it("a bare owner/repo shorthand (no scheme) is treated as GitHub", () => {
    expect(remoteRawCandidates("anthropics/skills", "pdf")[0]).toBe(
      "https://raw.githubusercontent.com/anthropics/skills/main/SKILL.md",
    );
  });
});
