# Handoff — next session: FULL agent-in-sandbox smoke test

> For a FRESH session. Goal: prove the **entire pi agent** runs inside a cloud sandbox — real **coding** + real
> **external MCP** tool use — so we know "the whole agent ports inside" (the foundation for the detached
> control-VM direction). Branch: `feat/programmatic-node` (everything is here; pushed).

## Goal (the bar)
The prior smoke (`docs/research/2026-06-26-e2b-template-and-smoke-test.md`) proved *plumbing*: a trivial `greet`
node + a **curl-level** MCP egress probe. That is NOT enough. This session must prove the **agent itself** works
inside the sandbox, on two axes the user named:
1. **Coding works** — pi runs a REAL multi-step coding task inside the sandbox (read/write/edit + bash + rg),
   producing correct code, ideally with an in-sandbox test it makes pass.
2. **External MCP works** — pi ACTUALLY INVOKES a tool from an MCP server hosted OUTSIDE the sandbox *during the
   run* (not a curl probe) and uses the result.
Together these prove a full agent can be ported inside → green-lights the control-VM
(`docs/design/detached-run-control-vm.md`).

## State now (verified, on `feat/programmatic-node @ 80eca4b`)
- **Both providers are installable extensions:** `@piflow/e2b` + `@piflow/daytona` (mirroring `@piflow/langgraph`);
  CLI `--sandbox e2b|daytona` DYNAMICALLY imports them. Core no longer contains `daytona*.ts`.
- **E2B template built:** name `piflow-node-runtime`, id `riwrtwrfanz3tewd5pw6` (runtime: node22 + pi 0.80.2 +
  git + ca-certs + ripgrep; tools/MCP/skills staged at RUNTIME, not baked). Rebuild verb:
  `npx --yes @e2b/cli@latest template create -d e2b.Dockerfile piflow-node-runtime` (in `deploy/e2b/`).
- **Credentials (env, auto-loaded by zsh from `~/.zshenv`):** `E2B_API_KEY`, `DAYTONA_API_KEY`, `NEBIUS_API_KEY`.
  Custom LLM gateway `mmgw` (baseUrl https://minnimax.chat, anthropic-messages, literal key) is in
  `~/.pi/agent/models.json`. If a fresh non-zsh shell lacks a var: `set -a; source ~/.zshenv; set +a`.
- **Scaffolding to extend:** trivial e2e template `deploy/e2b/e2e-template/` (greet node) + harness
  `deploy/e2b/smoke-live.mjs`. Build + full deterministic suite are green.

## Next steps (do these; each has an observable bar)
1. **Coding-agent smoke template.** Author a small piflow template whose node has pi do a REAL coding task
   inside the sandbox — e.g. "implement `fizzbuzz(n)` (or a tiny parser) in `out/<id>/src/`, write a test, run it
   with node/vitest, fix until the test passes." Node prompt must exercise write + edit + bash + rg. (Use the
   `agentic-prompt-design` skill when writing the node prompt.) MUST write artifacts under `out/<id>/` — the
   runner flattens `out/<id>/*` → the host outDir (a node writing to `out/foo` directly shows as "missing"; this
   bit the last author and fails identically on `--sandbox local`, so it is a convention, not a bug).
2. **External-MCP smoke node.** Add a node with an `mcp.json` wiring a REMOTE HTTP/SSE MCP server, and a prompt
   that forces pi to call one of its tools and use the result (e.g. deepwiki: "use the deepwiki MCP tool to fetch
   X, then write the summary to `out/<id>/answer.md`"). The bar is pi **invoking** the tool, not reachability —
   verify the tool call appears in the run's `.pi` telemetry/events.
3. **Run both providers.** `piflowctl run --sandbox e2b` (primary) and `--sandbox daytona` (parity). Set the E2B
   template via the CLI's env (`E2B_TEMPLATE`/equivalent — confirm the exact var in `packages/cli/src/run.ts`).
   NOTE: external MCP is EXPECTED to FAIL on Daytona Tier 1/2 (tier-gated egress, see
   `docs/research/2026-06-26-cloud-sandbox-network-egress.md`) — that is a correct negative result, document it;
   E2B is the one that must PASS.
4. **Verify from telemetry, not vibes.** For each run assert: coding artifact present + correct (and the
   in-sandbox test passed); the MCP tool call is present in `.pi` events with a real result; run verdict `ok`.
5. **Report:** `docs/research/2026-06-27-full-agent-sandbox-smoke.md` — per-axis PASS/FAIL with evidence (event
   excerpts, artifact contents, status), any live-only SEAM FRICTION, and the Daytona-MCP negative result.

## Open threads / gotchas to carry
- **OpenClaw**: the user's own MCP gateway URL is still unknown — to point step 2 at it, drop the URL into the
  node `mcp.json` (and put auth in front first). Until then use a public MCP server. Do NOT invent a URL.
- **Two deferred non-bugs** (optional cleanup): (a) one-line CLI copy fix — `run.ts` prints a misleading "no
  credential resolved" warning for a LITERAL-key gateway because it branches on `cloudSecrets.length` not
  `stageHome`; (b) the `out/<id>/` convention (above) — worth a line in template-authoring docs.
- **Cost discipline:** reuse ONE sandbox per provider, short autoStop, DELETE every VM (`npx e2b sandbox list`
  must be clean at the end). Cloud spend is authorized but bounded.

## Decisions + why (don't relitigate)
- Providers are choose-to-install extensions (not in core) — so a user installs only the backend they use; core
  stays product-agnostic. E2B is the default-open-egress backend that unblocks external MCP (Daytona tier-gates).
- BUILD per-provider behind our own seam (not Sandbank/ComputeSDK) — they miss our hard caps + SecretResolver.

## Suggested skills
`test-discipline` (design the smoke as a test that FAILS when the agent is broken), `agentic-prompt-design`
(authoring the node prompts), `systematic-debugging` + `search_past_bugs` if a run misbehaves. Context7 for any
E2B/pi SDK signature questions.

## Artifacts / pointers
Plan: `docs/design/multi-provider-sandbox-portability.md` · Egress: `docs/research/2026-06-26-cloud-sandbox-network-egress.md`
· Prior smoke: `docs/research/2026-06-26-e2b-template-and-smoke-test.md` · Control-VM next:
`docs/design/detached-run-control-vm.md` · Provider code: `packages/e2b/`, `packages/daytona/` · Templates/harness:
`deploy/e2b/`. Memory: `cloud-sandbox-portability`.

## Self-check before declaring done
Did pi actually (a) edit+run code inside the sandbox to a passing test, and (b) invoke an EXTERNAL MCP tool with
its result used — both proven from `.pi` telemetry, on E2B? Is the Daytona MCP negative documented? Are all VMs
deleted? If any "no", it is not done.
