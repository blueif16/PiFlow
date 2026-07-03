// The bearer gate's AUTH BOUNDARY: a token-gated `serve --static` must still LOAD in a real browser. The L4
// journey (gui/e2e/journey.spec.ts) was the first thing to drive a browser at `serve --token` and caught the
// bug: `page.goto('/?token=…')` gets index.html through the gate, but the browser's follow-up `<script>/<link>`
// requests for `/assets/*.js|css` carry NO token (a document's query string is NOT inherited by sub-resource
// requests) → they 401, the JS bundle never runs, React never mounts, and every DOM assertion times out.
//
// The fix: exempt ONLY the content-hashed, DATA-FREE bundle under `/assets/**` from the gate. The teeth of THIS
// test are the two "STILL gated" cases — the `/` shell and `/__piflow/*` data must remain 401 without a token
// (broaden the exemption to `/` or everything and they go red; that is the test-the-test).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../src/create-server.js";

describe("createServer bearer gate — the /assets bundle loads ungated, all data stays gated", () => {
  const TOKEN = "secret-token";
  let server: http.Server;
  let base: string;
  let staticDir: string;

  beforeAll(async () => {
    staticDir = await fs.mkdtemp(path.join(os.tmpdir(), "piflow-serve-"));
    await fs.mkdir(path.join(staticDir, "assets"), { recursive: true });
    await fs.writeFile(path.join(staticDir, "index.html"), "<!doctype html><script src=/assets/app.js></script>");
    await fs.writeFile(path.join(staticDir, "assets", "app.js"), "console.log('mounted')");
    server = createServer({ staticDir, token: TOKEN });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await fs.rm(staticDir, { recursive: true, force: true });
  });

  it("serves the hashed /assets bundle WITHOUT a token (so a browser can mount the SPA)", async () => {
    const res = await fetch(`${base}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("mounted");
  });

  it("STILL gates the SPA shell `/` without a token (control plane is authenticated — smoke A1)", async () => {
    expect((await fetch(`${base}/`)).status).toBe(401);
  });

  it("STILL gates the data API `/__piflow/*` without a token (the real data boundary)", async () => {
    expect((await fetch(`${base}/__piflow/index.json`)).status).toBe(401);
  });

  it("serves the shell WITH a token via both ?token= and Authorization: Bearer", async () => {
    expect((await fetch(`${base}/?token=${TOKEN}`)).status).toBe(200);
    expect((await fetch(`${base}/`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
  });
});
