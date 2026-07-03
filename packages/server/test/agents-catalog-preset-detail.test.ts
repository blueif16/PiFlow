import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { piflowAgents } from "../src/handlers.js";

// The agents.json catalog row is WIDENED from pure display branding to the preset's full public
// identity — the ROLE PROMPT (the base agent's system prompt), skills, and tools — so the GUI's
// agent hover card can show what a node inherited from its base WITHOUT a second endpoint. This
// drives the REAL handler against a PIFLOW_HOME-hermetic fixture preset (never the developer's
// ~/.piflow), and FAILS if the row carries only display fields (the pre-widen shape) or if the
// display fields regress (additive widen — existing consumers keep working).

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

describe("agents.json — preset rows carry the full public identity (prompt/skills/tools)", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "piflow-agents-"));
    mkdirSync(path.join(home, "agents"), { recursive: true });
    writeFileSync(
      path.join(home, "agents", "sample.md"),
      `---
id: sample
display:
  label: Sample
  icon: code
  color: "#123456"
skills: [test-discipline]
tools:
  allow: [read, write]
---
You are a sample role prompt for the hover card.
`,
    );
    prevHome = process.env.PIFLOW_HOME;
    process.env.PIFLOW_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.PIFLOW_HOME;
    else process.env.PIFLOW_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("a preset row carries display AND prompt + skills + tools (the hover card's data)", async () => {
    const { status, json } = await call(piflowAgents, { method: "GET", url: "/__piflow/agents.json" });
    expect(status).toBe(200);
    const row = (json as Record<string, unknown>).sample as {
      label?: string; icon?: string; color?: string;
      prompt?: string; skills?: string[]; tools?: { allow?: string[] };
    };
    // display survives (additive widen — the per-agentType branding lookup is unchanged)
    expect(row.label).toBe("Sample");
    expect(row.icon).toBe("code");
    expect(row.color).toBe("#123456");
    // the widen: the base agent's public identity rides the same row
    expect(row.prompt).toContain("You are a sample role prompt");
    expect(row.skills).toEqual(["test-discipline"]);
    expect(row.tools?.allow).toEqual(["read", "write"]);
  });
});
