import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { packRunDir } from "@piflow/core";
import { makePiflowTemplatesInstall } from "../src/templates.js";
import { isTemplateAllowed } from "../src/start-run.js";
import { createApiMiddleware } from "../src/handlers.js";

// POST /__piflow/templates installs a pushed template under the plane's uploads root so it becomes a runnable
// D9 product WITHOUT an image rebuild. The teeth here are the path-traversal guard (a `../` product must never
// escape the uploads root) and the allow-list composition (an installed template is then isTemplateAllowed
// against the uploads root — the whole point).

let scratch: string;
let uploads: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "piflow-tpl-"));
  uploads = join(scratch, "uploads");
  mkdirSync(uploads, { recursive: true });
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

/** Pack a minimal template dir (meta.json + workflow.json) into the gzip bundle the endpoint expects. */
function packTemplate(name = "wf"): Promise<Buffer> {
  const tpl = join(scratch, "src-template");
  mkdirSync(join(tpl, "nodes", "greet"), { recursive: true });
  writeFileSync(join(tpl, "meta.json"), JSON.stringify({ id: name, name, phases: ["compute"] }));
  writeFileSync(join(tpl, "workflow.json"), JSON.stringify({ id: name, stages: [["greet"]], nodes: { greet: { phase: "compute", deps: [] } } }));
  writeFileSync(join(tpl, "nodes", "greet", "node.json"), JSON.stringify({ id: "greet", deps: [] }));
  return packRunDir(tpl);
}

/** Drive the install middleware with a fake req/res (mirrors migrate-endpoints.test.ts). */
function call(
  handler: ReturnType<typeof makePiflowTemplatesInstall>,
  opts: { method: string; url: string; body?: Buffer },
): Promise<{ status: number; json?: any }> {
  return new Promise((resolve, reject) => {
    let onData: ((c: Buffer) => void) | undefined;
    let onEnd: (() => void) | undefined;
    const req = {
      url: opts.url, method: opts.method, headers: {},
      on(event: string, cb: (...a: unknown[]) => void) {
        if (event === "data") onData = cb as (c: Buffer) => void;
        if (event === "end") onEnd = cb as () => void;
        return req;
      },
      destroy() {},
    } as unknown as IncomingMessage;
    let ended = false;
    const res = {
      statusCode: 200,
      setHeader() {},
      end(payload?: string | Buffer) {
        if (ended) return;
        ended = true;
        resolve({ status: this.statusCode, json: payload && !Buffer.isBuffer(payload) ? JSON.parse(payload as string) : undefined });
      },
    } as unknown as ServerResponse;
    Promise.resolve(handler(req, res, () => reject(new Error("route did not match")))).catch(reject);
    queueMicrotask(() => { if (opts.body != null) onData?.(opts.body); onEnd?.(); });
  });
}

describe("POST /__piflow/templates — install a pushed template", () => {
  it("installs the template under <uploads>/<product>/.piflow/<workflow>/template and 202s", async () => {
    const body = await packTemplate();
    const { status, json } = await call(makePiflowTemplatesInstall(uploads), {
      method: "POST", url: "/__piflow/templates?product=acad&workflow=demo", body,
    });
    expect(status).toBe(202);
    const dest = join(uploads, "acad", ".piflow", "demo", "template");
    expect(json.templateDir).toBe(dest);
    expect(existsSync(join(dest, "meta.json"))).toBe(true);
    expect(existsSync(join(dest, "nodes", "greet", "node.json"))).toBe(true);
  });

  it("the installed template is then ALLOWED against the uploads root (allow-list composition)", async () => {
    const body = await packTemplate();
    const { json } = await call(makePiflowTemplatesInstall(uploads), {
      method: "POST", url: "/__piflow/templates?product=acad&workflow=demo", body,
    });
    // This is the whole point: an uploaded template must pass the start-run gate against the uploads root.
    expect(isTemplateAllowed(json.templateDir, [uploads])).toBe(true);
  });

  it("REJECTS a `../` product segment — no write escapes the uploads root (security)", async () => {
    const body = await packTemplate();
    const { status } = await call(makePiflowTemplatesInstall(uploads), {
      method: "POST", url: "/__piflow/templates?product=..%2Fevil&workflow=demo", body,
    });
    expect(status).toBe(400);
    // nothing may have been written outside the uploads root
    expect(existsSync(join(scratch, "evil"))).toBe(false);
  });

  it("501 when the plane was not started with an uploads root (push disabled)", async () => {
    const body = await packTemplate();
    const { status } = await call(makePiflowTemplatesInstall(null), {
      method: "POST", url: "/__piflow/templates?product=acad&workflow=demo", body,
    });
    expect(status).toBe(501);
  });

  it("400 when the bundle has no meta.json (not a template)", async () => {
    const notTpl = join(scratch, "not-a-template");
    mkdirSync(notTpl, { recursive: true });
    writeFileSync(join(notTpl, "random.txt"), "hi");
    const body = await packRunDir(notTpl);
    const { status } = await call(makePiflowTemplatesInstall(uploads), {
      method: "POST", url: "/__piflow/templates?product=acad&workflow=demo", body,
    });
    expect(status).toBe(400);
  });

  it("405 on non-POST", async () => {
    const { status } = await call(makePiflowTemplatesInstall(uploads), { method: "GET", url: "/__piflow/templates?product=acad" });
    expect(status).toBe(405);
  });

  it("400 when ?product= is missing", async () => {
    const body = await packTemplate();
    const { status } = await call(makePiflowTemplatesInstall(uploads), { method: "POST", url: "/__piflow/templates", body });
    expect(status).toBe(400);
  });
});

// The composer must actually THREAD the uploads root to the install handler — else the endpoint is dead in a
// real server. (Isolated handler tests above can't catch a wiring regression in createApiMiddleware.)
describe("createApiMiddleware threads the uploads root to /__piflow/templates", () => {
  it("installs a pushed template when an uploads root is wired", async () => {
    const body = await packTemplate();
    const { status } = await call(createApiMiddleware([], [uploads], uploads), {
      method: "POST", url: "/__piflow/templates?product=acad&workflow=demo", body,
    });
    expect(status).toBe(202);
    expect(existsSync(join(uploads, "acad", ".piflow", "demo", "template", "meta.json"))).toBe(true);
  });

  it("501s (push disabled) when NO uploads root is wired", async () => {
    const body = await packTemplate();
    const { status } = await call(createApiMiddleware([], null, null), {
      method: "POST", url: "/__piflow/templates?product=acad&workflow=demo", body,
    });
    expect(status).toBe(501);
  });
});
