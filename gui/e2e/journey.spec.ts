// L4 browser journey (Target 9 of docs/design/full-run-e2e-LOCKED.md) — the J2 slice:
//   run dir (real replay) → serve → GUI DOM render → live SSE transport → independent artifact probe.
//
// This is the ONLY tier that proves the browser actually renders a real run's status AND that the artifact
// the run claims to have produced is byte-identical on host disk, read through a DIFFERENT code path than the
// runner (GET /__piflow/file, a fresh readFile). The three assertions map 1:1 to the SPEC's TEST CONTRACT:
//   (1) DOM   — the greet node's status element reaches the "ok" (visual "success") state via expect.poll.
//   (2) SSE   — Playwright ROUTE INTERCEPTION on /__piflow/stream/** counts `data:` frames (≥1 per node
//               transition), proving the graph rendered from the LIVE transport, not a stale cache.
//   (3) FILE  — the Node test process (outside the browser) GETs the artifact with the bearer and asserts
//               sha256(body) === sha256('CONTROL-VM-OK') — the same path+hash the smoke/L1 probe verified.
//
// PR mode (default): `test.beforeAll` populates a REAL run dir in-process via runFromTemplate (sandbox=local,
// a real artifact + real run.json, NO pi/model) into the fixture product dir that `serve --roots` scopes to.
// `serve` resolves the run LIVE per request, so a run created after the webServer boots is still found. The
// GUI auto-focuses the single in-scope run (pickCurrentRun), so no console POST is needed for the replay path.
// Nightly/live mode (PIFLOW_E2E_LIVE=1) is the orchestrator's e2e-live.yml concern (Target 10) — this file's
// default path is free, deterministic, and needs no cloud credentials.
//
// SELECTOR NOTE (SPEC assertion 1): the run status "ok" maps to the visual NodeStatus "success"
// (gui/src/data/runView.ts:357 toNodeStatus), which the card renders as `data-status="success"` on the
// `.ds-node` div (gui/src/components/WorkflowNode.tsx:240), inside the React Flow node wrapper
// `.react-flow__node[data-id="greet"]`. That composite selector is the stable observable WITHOUT a source
// edit. FOLLOW-UP (out of Target 9's file scope): add a stable `data-testid="node-status-<id>"` to the
// WorkflowNode status element so the journey can key off a purpose-built hook instead of the internal
// data-status attr — flagged for the WorkflowNode.tsx owner, not applied here.

import { test, expect, request as pwRequest, type Route } from "@playwright/test";
import { createHash } from "node:crypto";
import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_BASE, E2E_TOKEN, PRODUCT_ROOT } from "../playwright.config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The workflow id + node id the greet template declares (deploy/…/e2e-template/.piflow/greet/**).
const WF = "greet";
const NODE = "greet";
const RUN_ID = process.env.PIFLOW_E2E_RUN ?? "l4-journey";
const ARTIFACT = "out/greet/greeting.txt";
const EXPECTED = "CONTROL-VM-OK";

// The deploy greet template (already carries Target 3's `output:"."` + artifacts:["out/greet/greeting.txt"]).
const DEPLOY_TEMPLATE = path.resolve(
  __dirname, "..", "..", "deploy", "control-vm", "e2e-template", ".piflow", WF, "template",
);
// Where the replay run lands so `serve --roots PRODUCT_ROOT` discovers it: <root>/.piflow/<wf>/runs/<id>.
const RUN_DIR = path.join(PRODUCT_ROOT, ".piflow", WF, "runs", RUN_ID);
// The GUI URL with the bearer seeded (the ?token= path apiBase.ts:20-30 reads on load).
const GUI_URL = `${E2E_BASE}/?token=${E2E_TOKEN}`;

const LIVE = process.env.PIFLOW_E2E_LIVE === "1";

/**
 * A CommandBuilder that writes EXACT bytes to each declared artifact — mirrors runner.test.ts:69
 * `contentBuilder` (the L1/L2 replay seam), inlined here to keep the artifact honest without importing a
 * test-only helper. With the greet node's `output:"."`, the write dest is `./out/greet/greeting.txt` — the
 * exact contract path (traced in Target 3's truth table). No pi/model runs.
 */
function contentBuilder(contents: Record<string, string>) {
  return (node: { id: string; sandbox: { output: string } }): string => {
    const out = node.sandbox.output;
    const writes = Object.entries(contents)
      .map(([p, c]) => {
        const dest = `${out}/${p}`;
        const dir = dest.includes("/") ? dest.slice(0, dest.lastIndexOf("/")) : ".";
        return `mkdir -p ${dir} && printf '%s' '${c}' > ${dest}`;
      })
      .join(" && ");
    return writes || "true";
  };
}

// Populate the served run dir with a REAL local run (unless a live run is env-injected). Done in beforeAll —
// after the webServer boots but before navigation — since serve resolves the run dir live per request.
test.beforeAll(async () => {
  if (LIVE) return; // live path: the orchestrator injects PIFLOW_E2E_RUN / a live plane; skip the replay seed.

  // dynamic import so a config-parse (which loads this module's siblings) never eagerly pulls core dist.
  const core = await import("@piflow/core");
  const { runFromTemplate, LocalSandboxProvider, buildRunView, assessRunView } = core as unknown as {
    runFromTemplate: (dir: string, opts: Record<string, unknown>) => Promise<{ status: { ok: boolean } }>;
    LocalSandboxProvider: new (opts?: Record<string, unknown>) => { kind: string };
    buildRunView: (dir: string) => { view: Record<string, unknown> };
    assessRunView: (view: unknown, opts: { expectNodes: string[] }) => { pass: boolean; failures: string[] };
  };

  // Clean, then stage a product: the deploy greet template under <PRODUCT_ROOT>/.piflow/<wf>/template so the
  // dir is a real piflow PRODUCT (isProductRoot: has .piflow/<wf>/runs after the run lands). We do NOT mutate
  // the deploy tree — templateDir points at the copied template inside the fixture product.
  await rm(PRODUCT_ROOT, { recursive: true, force: true });
  const productTemplate = path.join(PRODUCT_ROOT, ".piflow", WF, "template");
  await mkdir(path.dirname(productTemplate), { recursive: true });
  await cp(DEPLOY_TEMPLATE, productTemplate, { recursive: true });
  await mkdir(RUN_DIR, { recursive: true });

  const { status } = await runFromTemplate(productTemplate, {
    run: RUN_ID,
    runDir: RUN_DIR,
    outDir: RUN_DIR,
    workspace: PRODUCT_ROOT,
    provider: new LocalSandboxProvider({ enforceReadScope: false }), // kind 'local' → non-inmemory, real host files
    buildCommand: contentBuilder({ [ARTIFACT]: EXPECTED }),
    nodeTimeoutMs: 30_000,
  });

  // Sanity-gate the SEED itself (not the browser assertion): the replay must have honestly produced the run
  // the journey then observes. This uses the SAME rubric as the L2 tier so a broken seed fails LOUD here,
  // not confusingly in the browser step.
  expect(status.ok).toBe(true);
  const { view } = buildRunView(RUN_DIR);
  const a = assessRunView(view, { expectNodes: [NODE] });
  expect(a.pass, `seed replay must pass the rubric before the browser observes it: ${a.failures.join("; ")}`).toBe(true);
});

test.afterAll(async () => {
  if (!LIVE) await rm(PRODUCT_ROOT, { recursive: true, force: true }).catch(() => {});
});

test("J2 journey — GUI renders the run over live SSE and the artifact is byte-verified on disk", async ({ page }) => {
  // ── (2) SSE transport proof: intercept the real SSE endpoint and COUNT `data:` frames ─────────────────
  // The GUI's live client opens EventSource('/__piflow/stream/<run>') (runStream.ts:199). We route that URL,
  // stream the upstream response through, and count `data:` frames as they flow. A stale-cache render (no
  // live transport) yields 0 frames → assertion below reds. We must NOT consume/replace the body (the GUI
  // needs it), so we tee: fetch upstream, count on a clone, and fulfill with the original bytes.
  let dataFrames = 0;
  await page.route("**/__piflow/stream/**", async (route: Route) => {
    // Forward the request (carrying its headers/query, incl. ?token=) to the real serve, count frames in the
    // returned body, then fulfill the browser with those exact bytes. SSE bodies for a finished run are
    // bounded (the handler breaks on kind:"done", handlers.ts:92), so awaiting the full body is safe here.
    const resp = await route.fetch();
    const body = await resp.text();
    dataFrames += (body.match(/^data:/gm) ?? []).length;
    await route.fulfill({ response: resp, body });
  });

  await page.goto(GUI_URL);

  // ── (1) DOM proof: the greet node's status reaches "ok" (visual "success") — POLLED, never a fixed sleep ─
  const statusOf = async (): Promise<string | null> =>
    page.evaluate((id) => {
      const wrap = document.querySelector(`.react-flow__node[data-id="${id}"]`);
      const card = wrap?.querySelector<HTMLElement>("[data-status]") ?? wrap?.querySelector<HTMLElement>(".ds-node");
      // Prefer a purpose-built testid if the WorkflowNode owner adds one later; fall back to the data-status attr.
      const testid = wrap?.querySelector<HTMLElement>('[data-testid^="node-status"]');
      return testid?.getAttribute("data-status")
        ?? testid?.textContent?.trim()
        ?? card?.getAttribute("data-status")
        ?? null;
    }, NODE);

  await expect
    .poll(statusOf, { message: `greet node never reached ok/success`, timeout: 30_000, intervals: [500, 1000, 2000] })
    // "ok" run status renders as the visual "success"; accept either the future testid text ("ok") or the attr.
    .toMatch(/^(ok|success)$/);

  // The GUI must have actually opened the SSE stream — at least one live `data:` frame flowed.
  expect(dataFrames, "GUI must render from the live SSE transport (≥1 data: frame), not a stale cache").toBeGreaterThanOrEqual(1);

  // ── (3) FILE proof: independent artifact probe from the Node process, bearer-carried, byte-hashed ──────
  // A fresh readFile through GET /__piflow/file (handlers.ts:284) — a DIFFERENT code path than the runner's
  // stat — so it reds on empty/garbage/wrong-path/no-op. sha256 must match sha256('CONTROL-VM-OK').
  const ctx = await pwRequest.newContext({ baseURL: E2E_BASE, extraHTTPHeaders: { Authorization: `Bearer ${E2E_TOKEN}` } });
  try {
    const fileResp = await ctx.get(`/__piflow/file/${encodeURIComponent(RUN_ID)}?path=${encodeURIComponent(ARTIFACT)}`);
    expect(fileResp.status(), "artifact must be served (404 = missing/blocked run)").toBe(200);
    const bytes = await fileResp.body();
    const got = createHash("sha256").update(bytes).digest("hex");
    const want = createHash("sha256").update(Buffer.from(EXPECTED)).digest("hex");
    expect(got, `artifact bytes must hash to sha256('${EXPECTED}')`).toBe(want);
  } finally {
    await ctx.dispose();
  }
});
