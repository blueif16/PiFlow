// Compose redesign — browser behavior checks + screenshots. Slice 1 established the rail + the left overlay;
// Slice 1.5 the run-first write + promotion; Slice 2 makes the card a real CONVERSATION: an agentic-check /
// execution gate is composed by a dedicated `pi` session (channel=compose), whose reply STREAMS into the
// transcript and whose emitted chip is LANDED through the same validated run-first bake — the gate is real only
// from the run's re-read, never from the agent's claim (config is truth). A human checkpoint stays the fast-path
// direct write.
//
// The agent path is driven against a MOCKED compose session host (a fake SSE that streams one assistant reply
// carrying a gate chip) so the test is deterministic and needs no pi — exactly the "fake session host" the slice
// calls for. Everything else (the /node-edit run-first bake, the /run-view re-read) is REAL against a disposable
// greet fixture (wiped in afterAll). A separate env-gated live smoke (compose-live.spec.ts) exercises a real pi.

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
// The rubric the MOCKED agent emits in its chip — deliberately DIFFERENT from what the user types, to prove the
// AGENT's authored rubric lands (not the verbatim typed text; that was the Slice 1 direct path).
const AGENT_RUBRIC =
  "AGENT RUBRIC — PASS iff: the greeting is one friendly line addressing the reader by name; contains no placeholder (TODO/TBD); the name is never left blank.";

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

/**
 * Install a MOCK compose-session host: the fake SSE streams ONE assistant reply (built by `replyFor`) once a
 * /message has been posted, after a short delay so the PENDING (composing) state is observable. Everything not
 * on the compose control channel (the real /node-edit bake, /run-view) is left untouched.
 */
async function mockComposeSession(page: import("@playwright/test").Page, replyText: string) {
  let messageSent = false;
  let delivered = false;
  const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  await page.route("**/__piflow/control/**", async (route: Route) => {
    const url = route.request().url();
    if (!url.includes("channel=compose")) return route.continue(); // never touch the Companion channel
    const method = route.request().method();

    if (url.includes("/message")) { messageSent = true; return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ ok: true }) }); }
    if (url.includes("/start") || url.includes("/new") || url.includes("/select")) return route.fulfill({ status: method === "POST" ? 202 : 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    if (url.includes("/sessions")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sessions: [] }) });

    if (url.includes("/stream")) {
      const sseHeaders = { "content-type": "text/event-stream", "cache-control": "no-cache" };
      if (delivered) return route.fulfill({ status: 200, headers: sseHeaders, body: "retry: 100000\n\n:idle\n\n" });
      if (!messageSent) return route.fulfill({ status: 200, headers: sseHeaders, body: "retry: 150\n\n:waiting\n\n" });
      delivered = true;
      await sleep(700); // keep the PENDING state on-screen long enough to observe + screenshot
      const body =
        "retry: 100000\n\n" +
        frame({ v: 1, type: "meta", run: RUN_ID }) +
        frame({ type: "agent_start" }) +
        frame({ type: "message_start", message: { id: "a1", role: "assistant", content: [{ type: "text", text: "" }] } }) +
        frame({ type: "message_update", message: { id: "a1", role: "assistant", content: [{ type: "text", text: replyText }] } }) +
        frame({ type: "message_end", message: { id: "a1", role: "assistant", content: [{ type: "text", text: replyText }] } }) +
        frame({ type: "agent_end" }) +
        ":end\n\n"; // a trailing keepalive comment so the browser reliably flushes agent_end before EOF
      return route.fulfill({ status: 200, headers: sseHeaders, body });
    }
    return route.continue();
  });
}

/** A realistic agent reply: prose + a fenced json judge chip carrying the AGENT's rubric. */
const agentJudgeReply = (rubric: string) =>
  ["I read the node and turned your ask into a concrete rubric:", "", "```json", JSON.stringify({ kind: "judge", rubric, judgeTier: "deep", threshold: "pass", retryMax: 1 }), "```"].join("\n");

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

test("ACCEPTANCE — the compose AGENT wires an agentic check: streamed reply → landed on the run → promoted", async ({ page }) => {
  await mockComposeSession(page, agentJudgeReply(AGENT_RUBRIC));
  // Guard: the template starts with NO judge gate (only the seeded advisory floor).
  expect(JSON.parse(await readFile(NODE_JSON, "utf8")).judgeGate).toBeUndefined();

  await page.goto(GUI_URL);
  await expect(page.locator(`.react-flow__node[data-id="${NODE}"]`)).toBeVisible();
  await enterCompose(page);

  const target = dropTarget(page);
  const gesture = await dragRailOnto(page, page.locator(".ds-gaterail .ds-rail-item").first(), target);
  await page.screenshot({ path: path.join(SHOTS, "03-drag-over.png") });
  await gesture.drop();

  const card = page.locator(".ds-composecard");
  await expect(card).toBeVisible();
  await expect(card.locator(".ds-composecard__kind")).toHaveText("Agentic check");
  await expect(card.locator(".ds-composecard__node")).toContainText(NODE);
  await expect(card.getByRole("button", { name: "Compose gate" })).toBeVisible(); // AGENT path, not "Create gate"

  await card.locator(".ds-composecard__ta").fill("make sure the greeting is friendly and uses the reader's name");
  await page.screenshot({ path: path.join(SHOTS, "04-composecard-open.png") });
  await card.getByRole("button", { name: "Compose gate" }).click();

  // (1) PENDING: the target node shows a ghost/pending hex while the agent composes, and the transcript shows
  //     the "you" turn — this is the mid-conversation state.
  await expect(page.locator(`.react-flow__node[data-id="${NODE}"] .ds-gatedrop .ds-hex--pending`)).toBeVisible();
  await expect(card.locator(".ds-composecard__turn--you")).toContainText("friendly");
  await page.screenshot({ path: path.join(SHOTS, "11-composecard-pending.png") });

  // (2) STREAMED: the agent's reply renders as a markdown turn in the transcript.
  await expect(card.locator(".ds-composecard__turn--agent")).toContainText("turned your ask into a concrete rubric");

  // (3) LANDED FROM THE RE-READ (not the claim): the RUN's .pi/ now carries a judge/reroute gate entry.
  await expect
    .poll(async () => {
      const run = JSON.parse(await readFile(RUN_PI, "utf8"));
      const entries = run.nodes?.[NODE]?.config?.gates?.entries ?? [];
      return entries.some((e: { kind?: string }) => e.kind === "reroute");
    }, { message: "the agent's chip must land on the run's .pi/ via the validated bake", timeout: 8000 })
    .toBe(true);
  // ...while the TEMPLATE is still UNTOUCHED (run-first — not promoted yet).
  expect(JSON.parse(await readFile(NODE_JSON, "utf8")).judgeGate, "template must NOT change on a run-first save").toBeUndefined();

  // the on-node row flags the un-promoted run-only gate; the pending hex has solidified (composing cleared).
  await expect(target.locator(".ds-gatedrop__runscoped")).toBeVisible();
  await expect(page.locator(`.react-flow__node[data-id="${NODE}"] .ds-gatedrop .ds-hex--pending`)).toHaveCount(0);

  // (4) the promotion CHOICE turn appears.
  const choice = card.locator(".ds-composecard__choice");
  await expect(choice).toContainText("Applied to this run");
  await expect(choice).toContainText("Apply to the entire template?");
  await page.screenshot({ path: path.join(SHOTS, "09-composecard-question.png") });

  // (5) PROMOTE: "Apply to template" writes the AGENT's rubric VERBATIM into the template node.json.
  await card.getByRole("button", { name: "Apply to template" }).click();
  await expect(choice).toContainText("Promoted to the template");
  await page.screenshot({ path: path.join(SHOTS, "10-composecard-promoted.png") });
  expect(JSON.parse(await readFile(NODE_JSON, "utf8")).judgeGate?.rubric).toBe(AGENT_RUBRIC);
});

test("honesty — an agent reply with NO gate spec lands nothing (the claim is never trusted)", async ({ page }) => {
  await mockComposeSession(page, "Done! I've wired up the agentic check for you."); // prose only, no chip

  await page.goto(GUI_URL);
  await expect(page.locator(`.react-flow__node[data-id="${NODE}"]`)).toBeVisible();
  await enterCompose(page);

  const gesture = await dragRailOnto(page, page.locator(".ds-gaterail .ds-rail-item").first(), dropTarget(page));
  await gesture.drop();

  const card = page.locator(".ds-composecard");
  await card.locator(".ds-composecard__ta").fill("verify it reads naturally");
  await card.getByRole("button", { name: "Compose gate" }).click();

  // the agent "claims" success, but no parseable chip ⇒ an honest system turn + the run stays unchanged.
  await expect(card.locator('.ds-composecard__sys[data-tone="err"]')).toContainText("didn't produce a usable gate spec");
  const run = JSON.parse(await readFile(RUN_PI, "utf8"));
  const entries = run.nodes?.[NODE]?.config?.gates?.entries ?? [];
  expect(entries.some((e: { kind?: string }) => e.kind === "reroute"), "a prose-only claim must NOT land a gate").toBe(false);
  await expect(page.locator(`.react-flow__node[data-id="${NODE}"] .ds-gatedrop .ds-hex--pending`)).toHaveCount(0);
});

test("fast path — a HUMAN checkpoint is a direct write (no agent); dismiss keeps it run-only", async ({ page }) => {
  await page.goto(GUI_URL);
  await expect(page.locator(`.react-flow__node[data-id="${NODE}"]`)).toBeVisible();
  await enterCompose(page);

  // the human hex is the third rail item; drop it → "Create gate" (fast path), NOT "Compose gate".
  const gesture = await dragRailOnto(page, page.locator(".ds-gaterail .ds-rail-item").nth(2), dropTarget(page));
  await gesture.drop();

  const card = page.locator(".ds-composecard");
  await expect(card.locator(".ds-composecard__kind")).toHaveText("Human");
  await expect(card.getByRole("button", { name: "Create gate" })).toBeVisible();
  await card.locator(".ds-composecard__ta").fill("Does this greeting read well?");
  await card.getByRole("button", { name: "Create gate" }).click();

  const choice = card.locator(".ds-composecard__choice");
  await expect(choice).toContainText("Applied to this run");
  await choice.getByRole("button", { name: "Keep on this run" }).click();
  await expect(choice).toContainText("Kept on this run only");

  // The template was NEVER written — dismiss keeps it run-only.
  expect(JSON.parse(await readFile(NODE_JSON, "utf8")).checkpoint, "dismiss must not promote to the template").toBeUndefined();
});

test("error path — a failed write surfaces the FULL server error (never truncated) as a system turn", async ({ page }) => {
  const LONG_ERROR =
    "edit would make node.json invalid: nodes/greet/node.json — op[1] must match exactly one schema in oneOf (an op carries exactly one body: run | gate | action). Fix the gate and try again.";
  // the human fast-path writes directly — force the write to 400 to prove the FULL message renders untruncated.
  await page.route("**/__piflow/node-edit/**", (route: Route) =>
    route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: LONG_ERROR }) }),
  );

  await page.goto(GUI_URL);
  await expect(page.locator(`.react-flow__node[data-id="${NODE}"]`)).toBeVisible();
  await enterCompose(page);

  const gesture = await dragRailOnto(page, page.locator(".ds-gaterail .ds-rail-item").nth(2), dropTarget(page));
  await gesture.drop();

  const card = page.locator(".ds-composecard");
  await expect(card).toBeVisible();
  await card.locator(".ds-composecard__ta").fill("anything");
  await card.getByRole("button", { name: "Create gate" }).click();

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

    const chrome = [".ds-dir", ".react-flow__controls", ".ds-modebar", ".ds-cpchip__btn"];
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
