# Full agent-in-sandbox smoke — E2B — 2026-06-27

> Goal (from `docs/handoff-2026-06-27-full-agent-smoke.md`): prove the **whole pi agent** runs inside a cloud
> sandbox on two axes — (1) a real multi-step **coding** loop, (2) pi **invoking an external MCP tool** during
> the run — verified from `.pi` telemetry, not vibes. Template: `.piflow/example-academy/` (a 2-node
> capability-isolation demo; thesis in `2026-06-27-per-node-capability-isolation.md`).

## Verdict: ✅ BOTH AXES PROVEN on E2B

| Axis | Node | Result | Evidence |
|------|------|--------|----------|
| 2 — external MCP in sandbox | `research` | **PASS** | `ok`, exit 0, 50.6s. Tools resolved to `read,write,submit_result,deepwiki_ask_question --exclude-tools bash,edit`; **deepwiki called twice**; `findings.md` (5000 B) collected to the host run dir; brief carries all four required sections **plus** the `## Ignored instructions` prompt-injection-discipline section. |
| 1 — coding in sandbox | `build` | **PASS** | `ok`, exit 0, 48.6s. pi ran `bash`/`read`/`write`/`edit` in-VM, wrote `src/binary-search.mjs` (969 B) + `test/binary-search.test.mjs` (2858 B), ran `node --test`, hit a **real** `Cannot find module .../out/build/test` error, **fixed it and re-ran**, ended **`# pass 19 # fail 0`** (19/19), then `submit_result: ok`. Both artifacts collected to the host. |

The research node reaches the outside world (deepwiki MCP) but has **no shell**; the build node has a shell but
**no internet** — the data-only `findings.md` handoff keeps the lethal trifecta split across nodes. Both ran as
**one real `pi` per node inside one E2B VM**, subtree-namespaced. That is the per-node capability-isolation thesis
in live cloud telemetry.

## Two infra bugs found and FIXED (this is what unblocked the axes)

Run history: every prior E2B run (`academy-e2b-1/2/3`) failed; this session root-caused **two distinct** bugs,
fixed both (each with a RED→GREEN test), and re-ran green.

1. **MCP nodes exited nonzero at teardown** — `fix(compile): dispose MCP bridge on agent_end` (85517ab).
   The generated extension's only cleanup was a `beforeExit` hook, which can't fire while the live MCP socket
   holds the event loop open → the node hung to teardown and exited 1. The runner **only collects artifacts on
   `code === 0`** (`runner.ts` COLLECT gate), so the nonzero exit silently **skipped collection** — `findings.md`
   was written in-VM but never copied back ("required artifact missing"). Fix: register
   `pi.on("agent_end", disposeBridge)` (gated on `needsBridge`). After the fix research exits 0 → collection runs
   → `findings.md` lands.

2. **E2B capped every node at ~60 s** — `fix(runner): thread the resolved node cap into CreateOpts.timeoutMs`
   (edb3a19). `scope.create` received `timeoutMs: node.sandbox.timeoutMs`, which `render` never sets → cloud
   backends got `undefined`. On E2B that becomes the per-command exec timeout, and the SDK defaults
   `CommandStartOpts.timeoutMs` to **60_000 ms** when unset (verified against the e2b docs via Context7), silently
   SIGKILLing any node generating >60 s — every prior run died at ~61.8 s. Local/seatbelt backends **ignore**
   `CreateOpts.timeoutMs` (watchdog-only), which is why the same research ran 94 s fine locally. Fix: resolve the
   hard cap once (`node.sandbox.timeoutMs ?? watchdog.nodeTimeoutMs`) and thread the **same** value into both
   `create` and the watchdog. Validated live: the (flaky) build node rode to **1801 s** — proving the cap is now
   the watchdog's 30 min, not 60 s.

## Notes / follow-ups (not blocking the verdict)

- **mmgw/MiniMax-M3 mid-stream hang (model flake, not piflow).** The first full run's `build` node did real
  in-sandbox work in the first ~16 s (ls, read findings, mkdir, wrote `binary-search.mjs` 1369 B) then the
  mmgw stream **froze at ~19.6 s** (events went silent) and rode the 30-min cap. A **build-only retry on the same
  gateway** (`--from build`, reusing the collected `findings.md`) completed in 49 s — so it was a one-off gateway
  flake, not reproducible.
- **30-min node default is too long for a cloud smoke.** A side effect of fix #2: a hung stream now burns the
  full watchdog cap (≈31-min VM) instead of dying at 60 s. For cloud smokes set
  `PI_RUNNER_NODE_TIMEOUT` / `PI_RUNNER_STALL_TIMEOUT` (the retry used 300 s / 120 s). Consider a saner cloud
  default.
- **Stall watchdog did not fire on ~30 min of event-silence.** `stallMs` was unset on the first run; even so,
  worth confirming the stall detector watches the right stream (raw exec stdout vs the slimmed events archive) —
  a possible genuine gap, filed as a follow-up.
- **Daytona parity NOT run this session** (focus was the E2B fixes). The expected-negative (external MCP blocked
  on Daytona Tier 1/2 tier-gated egress, per `2026-06-26-cloud-sandbox-network-egress.md`) remains to be run and
  documented separately.

## Cost
Clean. One full run + one build-only retry; **every VM torn down** — `e2b sandbox list` empty after each.

## Self-check (handoff)
(a) pi edited+ran code inside the sandbox to a passing test — **yes** (19/19, with a real fix loop).
(b) pi invoked an EXTERNAL MCP tool and used its result — **yes** (deepwiki ×2 → `findings.md`).
Both proven from `.pi` telemetry on E2B. Daytona negative: **not yet run** (noted above). VMs deleted: **yes**.
