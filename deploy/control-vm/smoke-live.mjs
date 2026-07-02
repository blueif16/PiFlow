// LIVE control-plane smoke — targets an ALREADY-DEPLOYED Fly control VM over its public HTTPS origin and
// exercises the full born-in-cloud path: the bearer gate, POST /api/runs/start, the SSE run-stream, and the
// run-view read-back. Application-layer only (real HTTP status + real response bodies / SSE frames), never
// raw TCP. Mirrors deploy/e2b/smoke-live.mjs in shape + rigor, retargeted from an E2B sandbox to a Fly URL.
//
//   PIFLOW_CLOUD_URL=https://<app>.fly.dev PIFLOW_TOKEN=<secret> node deploy/control-vm/smoke-live.mjs
//
// Env consumed:
//   PIFLOW_CLOUD_URL  the deployed origin (required), e.g. https://piflow-control-plane.fly.dev
//   PIFLOW_TOKEN      the bearer token the VM was deployed with (required — same value as `fly secrets set`)
//   PIFLOW_PRODUCT    product id to launch (default: demo — the baked demo's PRODUCT id, i.e. its root dir
//                     name /home/piflow/demo; the `greet` WORKFLOW lives inside it. Passing `greet` here 400s
//                     ("no product in scope") — POST /api/runs/start keys on the product id, not the workflow.)
//   PIFLOW_EXECUTOR   pi | claude-code (default: pi). Use claude-code to exercise check E's OAuth note.
//   SMOKE_TIMEOUT_MS  overall per-run wait cap for the SSE done (default 240000 = 4m).
//   READY_TIMEOUT_MS  how long to poll for the origin to answer before the ordered checks (default 90000 = 90s).
//
// Exit: non-zero if ANY ordered check (A→E) fails. Prints one PASS/FAIL line per check + a summary.

const BASE = (process.env.PIFLOW_CLOUD_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.PIFLOW_TOKEN ?? "";
const PRODUCT = process.env.PIFLOW_PRODUCT ?? "demo";
const EXECUTOR = process.env.PIFLOW_EXECUTOR ?? "pi";
const RUN_TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS) || 240_000;
const READY_TIMEOUT_MS = Number(process.env.READY_TIMEOUT_MS) || 90_000;

if (!BASE || !TOKEN) {
  console.error("FATAL: set PIFLOW_CLOUD_URL (https://<app>.fly.dev) and PIFLOW_TOKEN (the deploy bearer token).");
  process.exit(2);
}

const results = [];
function record(id, label, pass, evidence) {
  results.push({ id, label, pass });
  console.log(`\n[${pass ? "PASS" : "FAIL"}] ${id} — ${label}\n      ${String(evidence).replace(/\n/g, "\n      ")}`);
}

const authHeaders = { Authorization: `Bearer ${TOKEN}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Readiness pre-wait — poll until OUR control plane answers (200 or 401), not merely until the origin replies.
// A just-deployed control plane (or the host's edge/domain routing) takes seconds-to-minutes to go live, and the
// ordered A→E checks are single-shot with no retry, so without this a warming service would falsely red check A.
// CRITICAL: a host edge with no live deployment returns 404 (Railway: {"message":"Application not found"}) / 502 /
// 503 — those are NOT ready, so we keep polling through them; only our bearer gate's 401 (or a 200) means the app
// is up. Returns true once ready, false on timeout (the checks then report the real error).
const READY_STATUSES = new Set([200, 401]);
async function waitForOrigin() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last = "";
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(`${BASE}/`, { redirect: "manual" });
      if (READY_STATUSES.has(r.status)) {
        console.log(`\n[ready] control plane ${BASE} is live — HTTP ${r.status} (attempt ${attempt})`);
        return true;
      }
      last = `HTTP ${r.status} (edge up, no live deployment yet)`;
    } catch (e) {
      last = e?.message ?? String(e);
    }
    if (Date.now() >= deadline) {
      console.log(`\n[ready] WARN: control plane ${BASE} not live within ${READY_TIMEOUT_MS}ms (last: ${last}) — running checks anyway`);
      return false;
    }
    if (attempt === 1 || attempt % 5 === 0) console.log(`\n[ready] waiting for ${BASE} … ${last} (attempt ${attempt})`);
    await sleep(2000);
  }
}

async function main() {
  await waitForOrigin();

  // ── A. bearer gate: no token → 401; with token → 200 + GUI html ─────────────────────────────
  {
    let noTokCode = -1;
    try {
      const r = await fetch(`${BASE}/`, { redirect: "manual" });
      noTokCode = r.status;
    } catch (e) {
      noTokCode = `ERR ${e?.message ?? e}`;
    }
    // The bearer gate must reject an unauthenticated GET of the GUI. (A public VM with NO token would
    // 200 here — that's exactly the open-control-plane the Dockerfile guard refuses to launch.)
    record("A1", "GET / WITHOUT token → 401 (control plane is authenticated)",
      noTokCode === 401, `HTTP ${noTokCode} (expect 401)`);

    let withCode = -1, html = "", ctype = "";
    try {
      const r = await fetch(`${BASE}/`, { headers: authHeaders });
      withCode = r.status;
      ctype = r.headers.get("content-type") ?? "";
      html = await r.text();
    } catch (e) {
      withCode = `ERR ${e?.message ?? e}`;
    }
    const looksLikeGui = /text\/html/.test(ctype) && /<div id="root"|<!doctype html|<html/i.test(html);
    record("A2", "GET / WITH bearer token → 200 + serves the GUI html",
      withCode === 200 && looksLikeGui,
      `HTTP ${withCode}; content-type="${ctype}"; body(head)=${html.slice(0, 120).replace(/\n/g, " ")}`);

    // Also prove the ?token= query form the SSE EventSource depends on is accepted on a plain GET.
    let qCode = -1;
    try {
      const r = await fetch(`${BASE}/?token=${encodeURIComponent(TOKEN)}`);
      qCode = r.status;
    } catch (e) {
      qCode = `ERR ${e?.message ?? e}`;
    }
    record("A3", "GET /?token=… (query-string auth, the SSE form) → 200",
      qCode === 200, `HTTP ${qCode} (expect 200)`);
  }

  // ── B. POST /api/runs/start for the baked greet product → 202 {run} ─────────────────────────
  let run = null, streamUrl = null, runViewUrl = null;
  {
    const body = { product: PRODUCT, sandbox: "local", executor: EXECUTOR, args: {} };
    let code = -1, json = null;
    try {
      const r = await fetch(`${BASE}/api/runs/start`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      code = r.status;
      json = await r.json().catch(() => null);
    } catch (e) {
      code = `ERR ${e?.message ?? e}`;
    }
    run = json?.run ?? null;
    streamUrl = json?.streamUrl ?? (run ? `/__piflow/stream/${encodeURIComponent(run)}` : null);
    runViewUrl = json?.runViewUrl ?? (run ? `/__piflow/run-view/${encodeURIComponent(run)}` : null);
    record("B", `POST /api/runs/start (product=${PRODUCT}, sandbox=local, executor=${EXECUTOR}) → 202 {run}`,
      code === 202 && typeof run === "string" && run.length > 0,
      `HTTP ${code}; run=${run}; streamUrl=${streamUrl}; resolved=${json?.resolved}`);
  }

  // ── C. SSE /__piflow/stream/<run>?token=… reaches {kind:"done"} ─────────────────────────────
  // No EventSource in Node core — read the text/event-stream body incrementally and parse `data:` frames.
  let sawDone = false, sawMeta = false, lastKinds = [];
  if (run) {
    const url = `${BASE}${streamUrl}${streamUrl.includes("?") ? "&" : "?"}token=${encodeURIComponent(TOKEN)}`;
    const ac = new AbortController();
    const deadline = setTimeout(() => ac.abort(), RUN_TIMEOUT_MS);
    try {
      const r = await fetch(url, { headers: { Accept: "text/event-stream" }, signal: ac.signal });
      if (r.status !== 200 || !r.body) {
        record("C", "SSE stream opens (200 text/event-stream)", false, `HTTP ${r.status} — stream did not open`);
      } else {
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        outer: while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          // SSE frames are separated by a blank line; each `data:` line carries one JSON update.
          let idx;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data:")) continue;
              let obj;
              try { obj = JSON.parse(line.slice(5).trim()); } catch { continue; }
              const kind = obj?.kind;
              if (kind) lastKinds.push(kind);
              if (kind === "meta" || kind === "snapshot") sawMeta = true;
              if (kind === "stream-error") { lastKinds.push(`stream-error:${obj.error}`); }
              if (kind === "done") { sawDone = true; break outer; }
            }
          }
        }
        try { await reader.cancel(); } catch { /* already closed */ }
      }
    } catch (e) {
      lastKinds.push(`fetch-error:${e?.name === "AbortError" ? `timeout ${RUN_TIMEOUT_MS}ms` : e?.message ?? e}`);
    } finally {
      clearTimeout(deadline);
      ac.abort();
    }
    record("C", "SSE run-stream reaches {kind:\"done\"} (run completed live)",
      sawDone, `sawMeta=${sawMeta} sawDone=${sawDone}; kinds=[${lastKinds.slice(-12).join(", ")}]`);
  } else {
    record("C", "SSE run-stream reaches {kind:\"done\"}", false, "no run id from check B — skipped");
  }

  // ── D. run-view shows the greet artifact ────────────────────────────────────────────────────
  if (run) {
    // brief settle: the run-view distills the on-disk .pi tree; the SSE `done` fires as the run closes,
    // give the final flush a moment before reading back.
    await sleep(1500);
    let code = -1, view = null;
    try {
      const r = await fetch(`${BASE}${runViewUrl}`, { headers: authHeaders });
      code = r.status;
      view = await r.json().catch(() => null);
    } catch (e) {
      code = `ERR ${e?.message ?? e}`;
    }
    // Evidence that the greet node produced its artifact: the run-view mentions greeting.txt / out/greet,
    // OR the node's status is terminal-ok. We assert on the serialized view (shape-tolerant).
    const blob = JSON.stringify(view ?? {});
    const hasArtifact = /greeting\.txt/.test(blob) || /out\/greet/.test(blob);
    const greetOk = /"(status|state)"\s*:\s*"(ok|done|complete|completed|success|passed)"/i.test(blob);
    record("D", "GET /__piflow/run-view/<run> shows the greet artifact",
      code === 200 && (hasArtifact || greetOk),
      `HTTP ${code}; artifactSeen=${hasArtifact}; nodeOk=${greetOk}; view(head)=${blob.slice(0, 220)}`);
  } else {
    record("D", "GET /__piflow/run-view/<run> shows the greet artifact", false, "no run id from check B — skipped");
  }

  // ── E. hardening NOTES — in-VM jail + subscription billing (asserted where remotely observable) ──
  // These are properties of the run that executed INSIDE the VM. From an external HTTP smoke we can
  // observe the RESULT (the run reached done + produced its artifact under sandbox=local); the two
  // in-VM invariants below are NOT externally probeable, so this check documents HOW the lead verifies
  // them in the VM and PASSES on the observable proxy (a local-sandbox run completed) rather than
  // silently claiming the unobservable. To prove them directly, shell into the VM (`fly ssh console`):
  //
  //   • bwrap jail (MUST pass or `--sandbox local` fails closed):
  //       bwrap --ro-bind / / --proc /proc --dev /dev true; echo $?      # 0 = namespace buildable (PROBE_CURRENT)
  //     This is the exact probe @piflow/core's probeBwrapUsable() runs (deploy/e2b/bwrap-proof-driver.mjs
  //     PROBE_CURRENT). Exit 0 ⇒ the jail is real; non-zero ⇒ local sandbox degrades and this VM must NOT
  //     serve runs as jailed. For the FULL in/out-of-scope read+write proof, run that driver in the VM.
  //   • claude-code subscription (NOT API billing): a claude-code node runs `claude -p` with
  //     CLAUDE_CODE_OAUTH_TOKEN injected and ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN stripped empty
  //     (@piflow/core claudeExecutorEnvAdditions). Confirm the VM has CLAUDE_CODE_OAUTH_TOKEN set and NO
  //     ANTHROPIC_API_KEY: `fly ssh console -C 'printenv | grep -E "CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY"'`
  //     (the OAuth var present, the API-key var absent ⇒ the subscription guarantee holds).
  {
    const jailedRunLanded = sawDone; // the smoke launched with sandbox=local; a done run proves the jail didn't fail closed
    const note = EXECUTOR === "claude-code"
      ? "executor=claude-code: verify CLAUDE_CODE_OAUTH_TOKEN present + ANTHROPIC_API_KEY absent via `fly ssh console`"
      : "executor=pi (default): re-run with PIFLOW_EXECUTOR=claude-code to exercise the OAuth path";
    record("E", "in-VM invariants: --sandbox local jailed the run (observable) + subscription/bwrap probes (see comment)",
      jailedRunLanded,
      `sandbox=local run reached done=${jailedRunLanded}; ${note}; bwrap probe: run in-VM \`bwrap --ro-bind / / --proc /proc --dev /dev true\``);
  }

  // ── summary ─────────────────────────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n================ CONTROL-VM SMOKE: ${passed}/${results.length} PASS ================`);
  for (const r of results) console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.id}  ${r.label}`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error("SMOKE HARNESS ERROR:", err?.stack ?? err?.message ?? err);
  process.exitCode = 1;
});
