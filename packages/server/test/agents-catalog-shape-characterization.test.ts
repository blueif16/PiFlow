import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { piflowAgents } from "../src/handlers.js";

// CHARACTERIZATION of the FROZEN `GET /__piflow/agents.json` response shape (the GUI consumes it):
// `{ <agentType id> → {label,icon,color,prompt,skills,tools,model,tier} }` + the additive `drivers`
// array — written GREEN BEFORE the enumeration loop moves onto core's `listAgentPresets`, and it must
// stay green after (the refactor is a seam swap, not a shape change). It pins the parts the sibling
// tests don't: model/tier ride the row, a malformed `.md` is SKIPPED without sinking the listing, a
// non-`.md` file is ignored, and a missing catalog dir still 200s with `{ drivers }` alone.
// PIFLOW_HOME-hermetic (never the developer's ~/.piflow), same pattern as agents-catalog-preset-detail.

/** Drive a middleware with a fake req/res; resolves with {status, json}, rejects if the route falls through. */
function call(
  handler: typeof piflowAgents,
  opts: { method: string; url: string },
): Promise<{ status: number; json?: unknown }> {
  return new Promise((resolve, reject) => {
    const req = { url: opts.url, method: opts.method, headers: {}, on: () => req, destroy() {} } as unknown as IncomingMessage;
    let ended = false;
    const res = {
      statusCode: 200,
      setHeader() {},
      end(payload?: string) {
        if (ended) return;
        ended = true;
        resolve({ status: this.statusCode, json: payload ? JSON.parse(payload) : undefined });
      },
    } as unknown as ServerResponse;
    Promise.resolve(handler(req, res, () => reject(new Error("route did not match")))).catch(reject);
  });
}

describe("agents.json — frozen response-shape characterization", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "piflow-agents-shape-"));
    prevHome = process.env.PIFLOW_HOME;
    process.env.PIFLOW_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.PIFLOW_HOME;
    else process.env.PIFLOW_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("a full preset row carries EXACTLY the frozen keys (label/icon/color/prompt/skills/tools/model/tier)", async () => {
    mkdirSync(path.join(home, "agents"), { recursive: true });
    writeFileSync(
      path.join(home, "agents", "full.md"),
      `---
id: full
display:
  label: Full
  icon: bolt
  color: "#abcdef"
skills: [okf-slices]
tools:
  allow: [read]
model: deepseek-v3
tier: deep
---
Full role prompt body.
`,
    );

    const { status, json } = await call(piflowAgents, { method: "GET", url: "/__piflow/agents.json" });
    expect(status).toBe(200);
    const body = json as Record<string, unknown>;
    const row = body.full as Record<string, unknown>;
    expect(row).toEqual({
      label: "Full",
      icon: "bolt",
      color: "#abcdef",
      prompt: "Full role prompt body.",
      skills: ["okf-slices"],
      tools: { allow: ["read"] },
      model: "deepseek-v3",
      tier: "deep",
    });
    // top-level shape: the preset id keys + the additive drivers array, nothing else
    expect(Object.keys(body).sort()).toEqual(["drivers", "full"]);
    expect(Array.isArray(body.drivers)).toBe(true);
  });

  it("a malformed .md is skipped without sinking the listing; a non-.md file is ignored", async () => {
    mkdirSync(path.join(home, "agents"), { recursive: true });
    writeFileSync(path.join(home, "agents", "broken.md"), "no frontmatter block at all\n");
    writeFileSync(path.join(home, "agents", "notes.txt"), "---\nid: notes\n---\nnot a preset file\n");
    writeFileSync(
      path.join(home, "agents", "good.md"),
      `---
id: good
display:
  label: Good
---
Good prompt.
`,
    );

    const { status, json } = await call(piflowAgents, { method: "GET", url: "/__piflow/agents.json" });
    expect(status).toBe(200);
    const body = json as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["drivers", "good"]);
    expect((body.good as { label?: string }).label).toBe("Good");
  });

  it("a missing catalog dir still 200s with `{ drivers }` alone (no preset rows)", async () => {
    // PIFLOW_HOME exists but has NO agents/ subdir
    const { status, json } = await call(piflowAgents, { method: "GET", url: "/__piflow/agents.json" });
    expect(status).toBe(200);
    const body = json as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["drivers"]);
    expect(Array.isArray(body.drivers)).toBe(true);
  });
});
