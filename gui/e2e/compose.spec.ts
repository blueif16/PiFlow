// Compose redesign — Slice 1 browser behavior checks + screenshots (the gate rail, the left-side natural-
// language authoring overlay, the on-node hexagon icons, and the HUD "Hooks" section). Reuses the journey
// harness: a REAL local replay run is seeded into the fixture product `serve --roots` scopes to, then the
// built GUI is driven in a real browser. The template edits land in the DISPOSABLE fixture (wiped in
// afterAll), never a real product.
//
// The headline is the acceptance test: dragging AGENTIC CHECK onto the node and creating with a pasted
// paragraph WRITES the template node.json with that paragraph as the rubric VERBATIM — the path that 400'd on
// every drop before (compose-gate-audit.md §4.1). Asserted on the RE-READ file, not the response.

import { test, expect, type Locator, type Route } from "@playwright/test";
import { cp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_BASE, E2E_TOKEN, PRODUCT_ROOT } from "../playwright.config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WF = "greet";
const NODE = "greet";
const RUN_ID = process.env.PIFLOW_COMPOSE_RUN ?? "compose-fixture";
const ARTIFACT = "out/greet/greeting.txt";
const EXPECTED = "CONTROL-VM-OK";
// A realistic multi-sentence rubric a user pastes into the overlay — asserted byte-for-byte on the template.
const RUBRIC =
  "A good greeting is a single friendly line that addresses the reader by name. It contains no placeholder text (no TODO, no TBD) and never leaves the name blank.";

const DEPLOY_TEMPLATE = path.resolve(__dirname, "..", "..", "deploy", "control-vm", "e2e-template", ".piflow", WF, "template");
const TEMPLATE_DIR = path.join(PRODUCT_ROOT, ".piflow", WF, "template");
const NODE_JSON = path.join(TEMPLATE_DIR, "nodes", NODE, "node.json");
const RUN_DIR = path.join(PRODUCT_ROOT, ".piflow", WF, "runs", RUN_ID);
const RUN_PI = path.join(RUN_DIR, ".pi", "run.json"); // where a run-first bake lands (config.gates)
const GUI_URL = `${E2E_BASE}/?token=${E2E_TOKEN}`;
const SHOTS = path.join(__dirname, "..", "test-results", "compose");

// Mirrors journey.spec.ts's contentBuilder — writes EXACT bytes to each declared artifact (no pi/model).
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

test.beforeAll(async () => {
  const core = await import("@piflow/core");
  const { runFromTemplate, LocalSandboxProvider, buildRunView, assessRunView } = core as unknown as {
    runFromTemplate: (dir: string, opts: Record<string, unknown>) => Promise<{ status: { ok: boolean } }>;
    LocalSandboxProvider: new (opts?: Record<string, unknown>) => { kind: string };
    buildRunView: (dir: string) => { view: { nodes: Array<{ config?: { gates?: { entries: unknown[] } } }> } };
    assessRunView: (view: unknown, opts: { expectNodes: string[] }) => { pass: boolean; failures: string[] };
  };

  await rm(PRODUCT_ROOT, { recursive: true, force: true });
  await mkdir(path.dirname(TEMPLATE_DIR), { recursive: true });
  await cp(DEPLOY_TEMPLATE, TEMPLATE_DIR, { recursive: true });

  // Seed the greet node with ONE harmless advisory floor gate so the RUN's distilled config.gates is
  // non-empty — that populates the on-node hexes AND the HUD "Hooks" post lane for the screenshots. Advisory
  // so it can never fail/block the seed run.
  const node = JSON.parse(await readFile(NODE_JSON, "utf8"));
  node.op = [{ when: "post", gate: { kind: "non-empty", path: ARTIFACT, advisory: true } }];
  await writeFile(NODE_JSON, JSON.stringify(node, null, 2) + "\n");

  await mkdir(RUN_DIR, { recursive: true });
  const { status } = await runFromTemplate(TEMPLATE_DIR, {
    run: RUN_ID,
    runDir: RUN_DIR,
    outDir: RUN_DIR,
    workspace: PRODUCT_ROOT,
    provider: new LocalSandboxProvider({ enforceReadScope: false }),
    buildCommand: contentBuilder({ [ARTIFACT]: EXPECTED }),
    nodeTimeoutMs: 30_000,
  });
  expect(status.ok, "seed replay must succeed before the browser observes it").toBe(true);
  const { view } = buildRunView(RUN_DIR);
  const a = assessRunView(view, { expectNodes: [NODE] });
  expect(a.pass, `seed must pass the rubric: ${a.failures.join("; ")}`).toBe(true);
  expect(view.nodes[0]?.config?.gates?.entries.length ?? 0).toBeGreaterThan(0);

  // Snapshot the pristine seed (template + run.json) so each test can restore it → order-independent.
  pristineTemplate = await readFile(NODE_JSON, "utf8");
  pristineRunJson = await readFile(RUN_PI, "utf8");
});

// The run-first bake and the promote both MUTATE the fixture (run.json / template node.json). Restore the
// pristine seed before every test so tests don't clobber each other regardless of order.
let pristineTemplate = "";
let pristineRunJson = "";
test.beforeEach(async () => {
  if (pristineTemplate) await writeFile(NODE_JSON, pristineTemplate);
  if (pristineRunJson) await writeFile(RUN_PI, pristineRunJson);
});

test.afterAll(async () => {
  // The fixture product is DISPOSABLE (created here, never a real product) — wipe it, edits and all.
  await rm(PRODUCT_ROOT, { recursive: true, force: true });
});

/** Enter compose mode via the ModeBar and wait for the rail to mount. */
async function enterCompose(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await expect(page.locator(".ds-gaterail")).toBeVisible();
}

/** The greet node's compose drop target. */
const dropTarget = (page: import("@playwright/test").Page): Locator =>
  page.locator(`.react-flow__node[data-id="${NODE}"] .ds-gatedrop`);

/** Simulate an HTML5 drag of a rail hex onto a target using a SHARED DataTransfer (the reliable recipe:
 *  the dragstart handler's setData and the drop handler's getData read the SAME object). Leaves the target
 *  in its is-over state after dragover so the caller can screenshot, then drops. */
async function dragRailOnto(page: import("@playwright/test").Page, rail: Locator, target: Locator) {
  const dt = await page.evaluateHandle(() => new DataTransfer());
  await rail.dispatchEvent("dragstart", { dataTransfer: dt });
  await target.dispatchEvent("dragenter", { dataTransfer: dt });
  await target.dispatchEvent("dragover", { dataTransfer: dt });
  await expect(target).toHaveClass(/is-over/);
  // NOTE: no dragend — the rail unmounts the moment the drop opens the overlay (both are left-anchored).
  return { drop: async () => { await target.dispatchEvent("drop", { dataTransfer: dt }); } };
}

test("rail renders ONLY in compose mode, and each hex expands on hover", async ({ page }) => {
  await page.goto(GUI_URL);
  await expect(page.locator(`.react-flow__node[data-id="${NODE}"]`)).toBeVisible();

  await expect(page.locator(".ds-gaterail")).toHaveCount(0); // not present outside compose

  await enterCompose(page);
  const items = page.locator(".ds-gaterail .ds-rail-item");
  await expect(items).toHaveCount(3); // agentic check / execution / human
  await page.screenshot({ path: path.join(SHOTS, "01-rail-resting.png") });

  const agentic = items.first();
  await agentic.hover();
  await expect(agentic.locator(".ds-rail-item__desc")).toBeVisible();
  await expect(agentic).toContainText("an agent verifies this node's output");
  await page.screenshot({ path: path.join(SHOTS, "02-rail-hover-expanded.png") });

  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await expect(page.locator(".ds-gaterail")).toHaveCount(0);
});

test("ACCEPTANCE — Create applies to THIS RUN first; promote writes the rubric VERBATIM to the template", async ({ page }) => {
  // Guard: the template starts with NO judge gate (only the seeded advisory floor).
  expect(JSON.parse(await readFile(NODE_JSON, "utf8")).judgeGate).toBeUndefined();

  await page.goto(GUI_URL);
  await expect(page.locator(`.react-flow__node[data-id="${NODE}"]`)).toBeVisible();
  await enterCompose(page);

  const target = dropTarget(page);

  // Drag the agentic-check hex onto the node → drag-over affordance → screenshot → drop.
  const gesture = await dragRailOnto(page, page.locator(".ds-gaterail .ds-rail-item").first(), target);
  await page.screenshot({ path: path.join(SHOTS, "03-drag-over.png") });
  await gesture.drop();

  // The drop opens the LEFT overlay bound to the node; the rail yields (hides) while it's open.
  const card = page.locator(".ds-composecard");
  await expect(card).toBeVisible();
  await expect(page.locator(".ds-gaterail")).toHaveCount(0);
  await expect(card.locator(".ds-composecard__kind")).toHaveText("Agentic check");
  await expect(card.locator(".ds-composecard__node")).toContainText(NODE);
  await expect(page.locator(`.react-flow__node[data-id="${NODE}"] .ds-node[data-compose-target="true"]`)).toHaveCount(1);
  await expect(card.locator(".ds-composecard__ta")).toBeFocused();

  await card.locator(".ds-composecard__ta").fill(RUBRIC);
  await page.screenshot({ path: path.join(SHOTS, "04-composecard-open.png") });

  await card.getByRole("button", { name: "Create gate" }).click();

  // (1) RUN-FIRST: the gate lands on THIS RUN's .pi/run.json (config.gates), and the choice turn appears.
  const youTurn = card.locator(".ds-composecard__turn--you");
  await expect(youTurn.locator(".ds-composecard__chip")).toContainText(`Agentic check → ${NODE}`);
  await expect(youTurn).toContainText("addresses the reader by name");
  const choice = card.locator(".ds-composecard__choice");
  await expect(choice).toContainText("Applied to this run");
  await expect(choice).toContainText("Apply to the entire template?");
  await page.screenshot({ path: path.join(SHOTS, "09-composecard-question.png") });

  // assert on the RUN's .pi/ (re-read): the run now carries a judge/reroute gate entry...
  await expect
    .poll(async () => {
      const run = JSON.parse(await readFile(RUN_PI, "utf8"));
      const entries = run.nodes?.[NODE]?.config?.gates?.entries ?? [];
      return entries.some((e: { kind?: string }) => e.kind === "reroute");
    }, { message: "run .pi/ must carry the run-first gate", timeout: 5000 })
    .toBe(true);
  // ...while the TEMPLATE is still UNTOUCHED (run-first — not promoted yet).
  expect(JSON.parse(await readFile(NODE_JSON, "utf8")).judgeGate, "template must NOT change on a run-first save").toBeUndefined();

  // the on-node compose row truthfully flags the un-promoted run-only gate once the run-view re-polls.
  await expect(target.locator(".ds-gatedrop__runscoped")).toBeVisible();

  // (2) PROMOTE: "Apply to template" writes the rubric VERBATIM into the template node.json (the durable path).
  await card.getByRole("button", { name: "Apply to template" }).click();
  await expect(choice).toContainText("Promoted to the template");
  await page.screenshot({ path: path.join(SHOTS, "10-composecard-promoted.png") });

  const tmpl = JSON.parse(await readFile(NODE_JSON, "utf8"));
  expect(tmpl.judgeGate?.rubric).toBe(RUBRIC); // byte-for-byte

  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  await page.screenshot({ path: path.join(SHOTS, "06-node-hexes-after.png") });
});

test("dismiss keeps a run-first gate RUN-ONLY — the template is never touched", async ({ page }) => {
  await page.goto(GUI_URL);
  await expect(page.locator(`.react-flow__node[data-id="${NODE}"]`)).toBeVisible();
  await enterCompose(page);

  const gesture = await dragRailOnto(page, page.locator(".ds-gaterail .ds-rail-item").first(), dropTarget(page));
  await gesture.drop();

  const card = page.locator(".ds-composecard");
  await card.locator(".ds-composecard__ta").fill("Verify the greeting reads naturally.");
  await card.getByRole("button", { name: "Create gate" }).click();

  const choice = card.locator(".ds-composecard__choice");
  await expect(choice).toContainText("Applied to this run");
  await choice.getByRole("button", { name: "Keep on this run" }).click();
  await expect(choice).toContainText("Kept on this run only");

  // The template was NEVER written — dismiss keeps it run-only.
  expect(JSON.parse(await readFile(NODE_JSON, "utf8")).judgeGate, "dismiss must not promote to the template").toBeUndefined();
});

test("error path — a failed create surfaces the FULL server error (never truncated) as a system turn", async ({ page }) => {
  const LONG_ERROR =
    "edit would make node.json invalid: nodes/greet/node.json — op[1] must match exactly one schema in oneOf (an op carries exactly one body: run | gate | action). Fix the gate and try again.";
  await page.route("**/__piflow/node-edit/**", (route: Route) =>
    route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: LONG_ERROR }) }),
  );

  await page.goto(GUI_URL);
  await expect(page.locator(`.react-flow__node[data-id="${NODE}"]`)).toBeVisible();
  await enterCompose(page);

  const gesture = await dragRailOnto(page, page.locator(".ds-gaterail .ds-rail-item").first(), dropTarget(page));
  await gesture.drop();

  const card = page.locator(".ds-composecard");
  await expect(card).toBeVisible();
  await card.locator(".ds-composecard__ta").fill("anything");
  await card.getByRole("button", { name: "Create gate" }).click();

  // The overlay stays open and shows the WHOLE message (not a 28-char slice) as an error system turn.
  const err = card.locator('.ds-composecard__sys[data-tone="err"]');
  await expect(err).toContainText(LONG_ERROR);
  await expect(err).toContainText("carries exactly one body"); // the tail survives (proves no truncation)
  await page.screenshot({ path: path.join(SHOTS, "05-composecard-error.png") });
});

for (const vp of [{ w: 1440, h: 900 }, { w: 1100, h: 800 }]) {
  test(`rail clears the floating chrome at ${vp.w}×${vp.h} (no overlap)`, async ({ page }) => {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await page.goto(GUI_URL);
    await expect(page.locator(`.react-flow__node[data-id="${NODE}"]`)).toBeVisible();
    await enterCompose(page);

    const rail = page.locator(".ds-gaterail");
    const railBox = await rail.boundingBox();
    expect(railBox).not.toBeNull();

    const chrome = [".ds-dir", ".react-flow__controls", ".ds-modebar", ".ds-epswitch__btn"];
    for (const sel of chrome) {
      const el = page.locator(sel).first();
      if ((await el.count()) === 0) continue;
      const b = await el.boundingBox();
      if (!b || !railBox) continue;
      const overlap = railBox.x < b.x + b.width && railBox.x + railBox.width > b.x && railBox.y < b.y + b.height && railBox.y + railBox.height > b.y;
      expect(overlap, `rail overlaps ${sel} at ${vp.w}×${vp.h}`).toBe(false);
    }
    await page.screenshot({ path: path.join(SHOTS, `08-rail-clearance-${vp.w}x${vp.h}.png`) });
  });
}

test("HUD Hooks — the node detail renders plain-language pre / post / human lanes from config", async ({ page }) => {
  await page.goto(GUI_URL);
  const node = page.locator(`.react-flow__node[data-id="${NODE}"]`);
  await expect(node).toBeVisible();
  await node.click(); // expand the HUD

  const hooks = page.locator(".ds-hooks");
  await expect(hooks).toBeVisible();
  await page.waitForTimeout(500); // let the node→identity morph settle before the screenshot
  await expect(hooks.locator(".ds-hooks__title")).toHaveText("Hooks");
  await expect(hooks.getByText("pre", { exact: true })).toBeVisible();
  await expect(hooks.getByText("post", { exact: true })).toBeVisible();
  await expect(hooks.locator(".ds-hook .ds-hex")).toHaveCount(1);
  await page.screenshot({ path: path.join(SHOTS, "07-hud-hooks.png") });
});
