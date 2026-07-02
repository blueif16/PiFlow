import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { packRunDir, unpackRunDir } from "@piflow/core";

// The migration endpoints: freeze drops the .pi/freeze sentinel; bundle ships packRunDir(runDir); adopt
// unpacks a posted bundle onto THIS host and spawns a detached resume — allow-list-gated like start-run.

// vi.hoisted: @piflow/core (imported below) transitively loads node:child_process at import time, which
// invokes this mock factory BEFORE a plain top-level `const spawnSpy` would initialize — so hoist the spy.
const { spawnSpy } = vi.hoisted(() => ({ spawnSpy: vi.fn(() => ({ on: () => {}, unref: () => {} })) }));
vi.mock("node:child_process", () => ({ spawn: spawnSpy }));

// resolveRunDir is used by freeze + bundle; make it settable per test.
let runDirStub: { runDir: string; workspaceRoot: string | null } | null = null;
vi.mock("../src/resolve.js", async () => {
  const actual = await vi.importActual<typeof import("../src/resolve.js")>("../src/resolve.js");
  return { ...actual, resolveRunDir: vi.fn(async () => runDirStub) };
});

const { makePiflowMigrate } = await import("../src/migrate.js");

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "piflow-mig-"));
  spawnSpy.mockClear();
  runDirStub = null;
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

/** Drive a migrate middleware with a fake req/res. `body` may be a Buffer (the gzip bundle) or a string. */
function call(
  handler: ReturnType<typeof makePiflowMigrate>,
  opts: { method: string; url: string; body?: Buffer | string },
): Promise<{ status: number; json?: unknown; buffer?: Buffer; contentType?: string }> {
  return new Promise((resolve, reject) => {
    let onData: ((c: Buffer) => void) | undefined;
    let onEnd: (() => void) | undefined;
    const req = {
      url: opts.url,
      method: opts.method,
      headers: {},
      on(event: string, cb: (...a: unknown[]) => void) {
        if (event === "data") onData = cb as (c: Buffer) => void;
        if (event === "end") onEnd = cb as () => void;
        return req;
      },
      destroy() {},
    } as unknown as IncomingMessage;

    const headers: Record<string, string> = {};
    let ended = false;
    const res = {
      statusCode: 200,
      setHeader(k: string, v: string) { headers[k.toLowerCase()] = v; },
      end(payload?: string | Buffer) {
        if (ended) return;
        ended = true;
        const isBuf = Buffer.isBuffer(payload);
        resolve({
          status: this.statusCode,
          contentType: headers["content-type"],
          buffer: isBuf ? (payload as Buffer) : undefined,
          json: !isBuf && payload ? JSON.parse(payload as string) : undefined,
        });
      },
    } as unknown as ServerResponse;

    Promise.resolve(handler(req, res, () => reject(new Error("route did not match")))).catch(reject);
    queueMicrotask(() => {
      if (opts.body != null) onData?.(Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body));
      onEnd?.();
    });
  });
}

describe("migrate endpoints", () => {
  it("POST freeze drops the .pi/freeze sentinel into the run-dir (parks the live runner)", async () => {
    const runDir = join(scratch, "run");
    mkdirSync(join(runDir, ".pi"), { recursive: true });
    runDirStub = { runDir, workspaceRoot: null };

    const { status } = await call(makePiflowMigrate(), { method: "POST", url: "/__piflow/migrate/r1/freeze" });
    expect(status).toBe(202);
    expect(existsSync(join(runDir, ".pi", "freeze"))).toBe(true);
  });

  it("GET bundle returns a gzip snapshot that unpacks back to the run-dir contents", async () => {
    const runDir = join(scratch, "run");
    mkdirSync(join(runDir, ".pi"), { recursive: true });
    writeFileSync(join(runDir, ".pi", "journal.json"), '{"version":3}');
    writeFileSync(join(runDir, "a.txt"), "produced");
    runDirStub = { runDir, workspaceRoot: null };

    const { status, contentType, buffer } = await call(makePiflowMigrate(), { method: "GET", url: "/__piflow/migrate/r1/bundle" });
    expect(status).toBe(200);
    expect(contentType).toBe("application/gzip");
    const dst = join(scratch, "unpacked");
    await unpackRunDir(buffer!, dst);
    expect(readFileSync(join(dst, "a.txt"), "utf8")).toBe("produced");
    expect(readFileSync(join(dst, ".pi", "journal.json"), "utf8")).toBe('{"version":3}');
  });

  it("POST adopt unpacks the posted bundle into the target run-dir and spawns a detached resume", async () => {
    // A template fixture whose basename is `template` ⇒ runsHomeFor → sibling `runs`.
    const tplDir = join(scratch, "wf", "template");
    mkdirSync(tplDir, { recursive: true });
    writeFileSync(join(tplDir, "meta.json"), JSON.stringify({ name: "wf" }));

    // Build a real bundle from a fake source run-dir.
    const src = join(scratch, "src");
    mkdirSync(join(src, ".pi"), { recursive: true });
    writeFileSync(join(src, ".pi", "journal.json"), '{"version":3,"nodes":{"a":{}}}');
    writeFileSync(join(src, "a.txt"), "carried");
    const bundle = await packRunDir(src);

    const url = `/__piflow/migrate/mig1/adopt?templateDir=${encodeURIComponent(tplDir)}`;
    const { status, json } = await call(makePiflowMigrate(), { method: "POST", url, body: bundle });

    expect(status).toBe(202);
    expect((json as { adopted: boolean }).adopted).toBe(true);
    const destRunDir = join(scratch, "wf", "runs", "mig1");
    expect(readFileSync(join(destRunDir, "a.txt"), "utf8")).toBe("carried"); // bundle landed on the target
    expect(spawnSpy).toHaveBeenCalledTimes(1); // resume was launched
    // the resume is PINNED to the local context so it runs HERE and never redirects (P7) back out over HTTP.
    const opts = (spawnSpy.mock.calls[0] as [unknown, unknown, { env?: Record<string, string> }])[2];
    expect(opts.env?.PIFLOW_CONTEXT).toBe("local");
  });

  it("POST adopt recovers the source run's launch config (provider + model) from the bundled .pi/run.json into the resume argv", async () => {
    // The source run persisted its launch config in .pi/run.json (RunStatus.provider / .model). On resume the
    // migrated tail MUST keep them (regression: it ran on provider "cp" instead of the source's "mmgw" and
    // dropped the model), so the unpacked run.json is read back and threaded onto the resume flags.
    const tplDir = join(scratch, "wf", "template");
    mkdirSync(tplDir, { recursive: true });
    writeFileSync(join(tplDir, "meta.json"), JSON.stringify({ name: "wf" }));

    // A real bundle whose .pi/run.json records the source launch config.
    const src = join(scratch, "src");
    mkdirSync(join(src, ".pi"), { recursive: true });
    writeFileSync(join(src, ".pi", "run.json"), JSON.stringify({ run: "mig1", provider: "mmgw", model: "deepseek", nodes: {} }));
    writeFileSync(join(src, ".pi", "journal.json"), '{"version":3,"nodes":{"a":{}}}');
    const bundle = await packRunDir(src);

    const url = `/__piflow/migrate/mig1/adopt?templateDir=${encodeURIComponent(tplDir)}`;
    const { status } = await call(makePiflowMigrate(), { method: "POST", url, body: bundle });

    expect(status).toBe(202);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    // The spawned argv is [cliBin, ...argv] or [argv]; grab the argv array (it contains "run").
    const spawnArgs = spawnSpy.mock.calls[0] as unknown[];
    const argv = (spawnArgs.find((a) => Array.isArray(a) && (a as string[]).includes("run")) as string[]) ?? [];
    expect(argv).toContain("--provider");
    expect(argv[argv.indexOf("--provider") + 1]).toBe("mmgw");
    expect(argv).toContain("--model");
    expect(argv[argv.indexOf("--model") + 1]).toBe("deepseek");
  });

  it("POST adopt is allow-list gated: a non-listed template ⇒ 403 and NO resume spawn", async () => {
    const tplDir = join(scratch, "wf", "template");
    mkdirSync(tplDir, { recursive: true });
    writeFileSync(join(tplDir, "meta.json"), JSON.stringify({ name: "wf" }));
    const bundle = await packRunDir(scratch); // any bytes; the gate fires before unpack matters

    const url = `/__piflow/migrate/mig1/adopt?templateDir=${encodeURIComponent(tplDir)}`;
    const { status, json } = await call(makePiflowMigrate(["/some/other/template"]), { method: "POST", url, body: bundle });

    expect(status).toBe(403);
    expect(json).toEqual({ error: "template not allowed" });
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});
