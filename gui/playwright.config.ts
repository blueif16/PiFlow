// L4 browser-journey config (Target 9 of docs/design/full-run-e2e-LOCKED.md).
//
// The webServer is the REAL control plane — `piflowctl serve` — with a seeded bearer token, the built
// GUI as its static root (`--static`), and a fixture product dir as its run-scope (`--roots`) so
// `resolveRunDir` finds the replay run. The browser opens `/?token=<TOKEN>` (the `?token=` bearer path,
// gui/src/data/apiBase.ts:20-30) so every gated request (API, SSE, static GUI) carries the token.
//
// PR mode (default): journey.spec.ts's `test.beforeAll` does an IN-PROCESS `runFromTemplate` (sandbox=local,
// a real artifact + real run.json, NO model/pi) into the fixture product dir — the same honest replay the
// L2 tier populates (Target 6). `serve` then serves that real run dir. Nightly/live mode is env-gated
// (PIFLOW_E2E_LIVE=1) and left to the orchestrator's e2e-live.yml (Target 10); this config's default path
// is free and deterministic.
//
// SETUP (orchestrator follow-up — NOT run here): `@playwright/test` is a needed devDep and
// `npx playwright install chromium` must run once before `pnpm --filter flowmap-design-system test:e2e`.
// This file only AUTHORS the config; no browser is installed or launched in the authoring step.

import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A deterministic, non-secret token seeded into BOTH the serve (`--token`) and every browser/probe request
// (`?token=` / `Authorization: Bearer`). Overridable so a live run can inject its own.
export const E2E_TOKEN = process.env.PIFLOW_E2E_TOKEN ?? "e2e-journey-token";
// A fixed port so the webServer URL and the in-test artifact probe agree; overridable to avoid CI collisions.
export const E2E_PORT = Number(process.env.PIFLOW_E2E_PORT ?? 5399);
export const E2E_BASE = `http://127.0.0.1:${E2E_PORT}`;

// The fixture product dir `serve --roots` scopes to. journey.spec.ts's beforeAll populates a real run under
// `<PRODUCT_ROOT>/.piflow/<wf>/runs/<id>` via runFromTemplate; `resolveRunDir` then finds it.
export const PRODUCT_ROOT = process.env.PIFLOW_E2E_PRODUCT_ROOT ?? path.join(__dirname, "e2e", ".fixture-product");

// The built GUI. `serve --static` needs `<staticDir>/index.html`; build once with `pnpm --filter
// flowmap-design-system build` (writes gui/dist). The webServer command fails loud if it's absent.
const GUI_DIST = path.join(__dirname, "dist");

// The piflowctl bin (NOT the unscoped `piflow`; see CLAUDE.md). Resolve the workspace-local CLI so the
// webServer runs THIS tree's serve, not a globally-linked one.
const PIFLOWCTL = process.env.PIFLOW_E2E_CTL ?? path.resolve(__dirname, "..", "packages", "cli", "dist", "cli.js");

export default defineConfig({
  testDir: "./e2e",
  // NOTE: the IN-PROCESS replay run that populates the served run dir happens in journey.spec.ts's
  // `test.beforeAll` (kept in-spec to stay within Target 9's 3-file scope — no separate global-setup file).
  // `serve` resolves the run dir LIVE per request (resolveRunDir → buildSnapshot(loadScopedRegistry) each
  // call, packages/server/src/resolve.ts:68), so a run created after the webServer boots is still found.
  // A journey visits a live run end-to-end; give it room but never an unbounded wait (poll, not sleep).
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  // A leaked live run is a bug, not something to paper over with a retry — assertion steps get 0 retries.
  retries: 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: E2E_BASE,
    trace: "retain-on-failure",
    // Fail loud on any TLS/self-signed edge if a live plane URL is ever injected.
    ignoreHTTPSErrors: false,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Real control plane: static GUI + fixture run-scope + the seeded bearer. `node <cli.js> serve …`.
    command: `node ${JSON.stringify(PIFLOWCTL)} serve --port ${E2E_PORT} --host 127.0.0.1 --token ${E2E_TOKEN} --static ${JSON.stringify(GUI_DIST)} --roots ${JSON.stringify(PRODUCT_ROOT)}`,
    url: `${E2E_BASE}/?token=${E2E_TOKEN}`,
    timeout: 60_000,
    // Never silently reuse a stale plane in CI — a fresh serve per run keeps the scope/token honest.
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
  },
});
