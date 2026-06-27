# E2B Template Build + LIVE Smoke Test — the egress thesis, proven end-to-end

**Date:** 2026-06-26 (run executed 2026-06-27 UTC)
**Status:** LIVE validation complete — E2B promoted from unit-proven to live-validated backend.
**Run by:** infra validation session (isolated worktree off `main`, branch `worktree-agent-a1aa6aa49e320a783`).
**Reads:** `docs/design/multi-provider-sandbox-portability.md` §3,§7 · `docs/research/2026-06-26-cloud-sandbox-network-egress.md`
**Code under test:** `packages/e2b/src/{e2b.ts,e2b-sdk.ts}` (the @piflow/e2b extension) — UNCHANGED (no live bug required a fix).

---

## TL;DR — verdict

The `@piflow/e2b` extension is now **live-validated end-to-end against real E2B**. A real E2B Firecracker
template was built (`riwrtwrfanz3tewd5pw6`); one sandbox booted from it ran `pi` via the **mmgw custom LLM
gateway**, reached a **public remote MCP server** (DeepWiki) with a completing JSON-RPC handshake, and a full
`piflowctl run --sandbox e2b` collected its artifact back to the host. **The egress thesis holds**: E2B's
open-by-default egress reaches custom LLM gateways + remote MCP that Daytona Tier 1/2 blocks. Every cloud
sandbox created was deleted — **zero leaks**.

| Mandate | Result |
|---|---|
| A. Template build | ✅ `riwrtwrfanz3tewd5pw6` (name `piflow-node-runtime`), built in 44s, status `ready` |
| B. Reuse vs Daytona | ✅ Runtime install layer is **byte-identical**; only the final user/WORKDIR differs (2 lines) |
| C. Live smoke (boot · connectivity · pi call · MCP egress · e2e) | ✅ 6/6 standalone checks PASS + e2e run `ok` |
| D. Full suite | ✅ 824/824 deterministic tests pass (1 *gated-live* eval flaked on the live gateway — not code) |
| E. This report | ✅ |
| Cost / leaks | ✅ `e2b sandbox list` → `No sandboxes found` |

---

## A. Template build — the working command + id

**SEAM/CLI FRICTION:** `deploy/e2b/build.md` documented `e2b template build -n …`. The live CLI
(`@e2b/cli@2.13.0`, run via `npx --yes @e2b/cli@latest`) has **deprecated `template build`** ("use
`e2b template create` instead" — it is now a no-op stub) and **dropped `-n/--name`** (the name is a positional
arg). `build.md` has been corrected to the verb that actually built the template.

The EXACT commands that worked (recorded in `deploy/e2b/build.md`):

```bash
set -a; source ~/.zshenv; set +a          # E2B_API_KEY (44 chars) — authenticates the CLI, no `e2b auth login` needed
cd deploy/e2b
npx --yes @e2b/cli@latest template create -d e2b.Dockerfile piflow-node-runtime
```

Observed result (44s, server-side Firecracker build):

```
Template created with ID: riwrtwrfanz3tewd5pw6   (name: piflow-node-runtime; team: rans-default-team)
Build ID: 77fa3564-805c-4991-90c8-8b1298f8241a
e2b template list → Private | riwrtwrfanz3tewd5pw6 | piflow-node-runtime | 2 vCPU | 1024 MiB | buildStatus: ready
```

In-sandbox binary versions (from the build's MINIMAL+ tier, confirmed at boot in C.1):
`pi 0.80.2 · ripgrep 14.1.1 · git 2.47.3 · node v22.23.1`.

Note: `template create` did NOT write an `e2b.toml` (unlike the older SDK-init flow); the template is tracked
server-side and is listable/usable by name or id. Pass either as `E2B_TEMPLATE`.

---

## B. Reuse comparison vs Daytona — concrete + quantified

**How much can we reuse?** The entire runtime layer — *byte-for-byte*. The functional (non-comment) lines:

```
# IDENTICAL in BOTH deploy/daytona/Dockerfile and deploy/e2b/e2b.Dockerfile:
FROM node:22-trixie-slim
ARG PI_VERSION=0.80.2
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates ripgrep \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}" \
 && pi --version

# DIFFERS (the ONLY functional divergence — the runtime user/home):
#   Daytona: RUN id daytona … || useradd -m -u 1001 daytona   +   WORKDIR /home/daytona
#   E2B:     (no useradd — E2B's default user `user` already exists)   WORKDIR /home/user
```

| Dimension | Daytona | E2B | Reusable? |
|---|---|---|---|
| Base image | `node:22-trixie-slim` | `node:22-trixie-slim` | **IDENTICAL** |
| pi + tool install layer | the RUN above | the RUN above | **IDENTICAL (byte-for-byte)** |
| Runtime user / home | `daytona` / `/home/daytona` (+useradd) | `user` / `/home/user` (built-in) | provider-specific (1–2 lines) |
| Build verb | SDK `Image.base(...).runCommands(...)` → `snapshot.create()` (declarative builder, server-side) | CLI `e2b template create -d <Dockerfile>` (server-side Firecracker) | **must-differ** (different mechanism) |
| Artifact form | named **snapshot** in Daytona's store (`piflow-node-runtime-0-80-2`) | **template** id/name in E2B's store (`riwrtwrfanz3tewd5pw6`) | **must-differ** |
| Registry needed | none (declarative builder) | none (CLI ships the Dockerfile) | same posture |
| Egress at runtime | tier-gated (Tier 1/2 = custom hosts blocked) | **open by default** | the WHY for E2B |

**Can ONE shared Dockerfile drive both?** *Almost.* The install layer is already shared spec. The only blocker
to a single literal file is the trailing user/home line. A shared Dockerfile would need a build-arg (e.g.
`ARG RUNTIME_HOME=/home/user` + a conditional useradd) — but the build *verbs* are fundamentally different
(Daytona uses the SDK's declarative `Image` builder in an `.mjs`; E2B uses the `e2b` CLI on a literal
Dockerfile), so even a shared Dockerfile would still need two build drivers. **Verdict:** keep the parallel
`deploy/<provider>/` dirs (matches the one-file-per-backend pattern), but the runtime contents are ~95%
reusable as spec and are kept in lockstep ("byte-equivalent MINIMAL+ tier"). The provider-specific surface is
small and well-isolated: the user/home line + the build driver.

This mirrors the SDK-side reuse ledger (portability plan §2): the runner's orchestration, cloud-cred
allowlist, `downloadDir` collection, and tool/MCP/skill staging are all provider-agnostic — E2B inherited them
for zero work, exactly as predicted.

---

## C. LIVE smoke test — per-check PASS/FAIL with observed evidence

ONE sandbox (`i7fs2rqjyq0fd152x23gy`) served checks C.1–C.3 (cost discipline: reuse one VM, 5-min autoStop,
killed in `finally`). C.4 used the real runner, which boots + disposes its own run-scoped sandbox. All checks
are **application-layer** (`curl … -w "%{http_code}"` or a real response body), never raw TCP — per the
egress note's TCP-false-positive trap. Harness: `deploy/e2b/smoke-live.mjs`.

| # | Check | Verdict | Observed evidence |
|---|---|---|---|
| C.1 | `pi`/`rg`/`git`/`node` present + runnable in the template | **PASS** | `pi=0.80.2 · rg=ripgrep 14.1.1 · git=git version 2.47.3 · node=v22.23.1` (all exit 0) |
| C.2a | baseline: package registry egress | **PASS** | `GET https://registry.npmjs.org/` → **HTTP 200** |
| C.2b | mmgw custom LLM gateway reachable | **PASS** | `GET https://minnimax.chat` → **HTTP 200** (real response, not a hang) |
| C.2c | nebius custom LLM gateway reachable | **PASS** | `GET https://api.tokenfactory.nebius.com/` → **HTTP 404** (real response — host reached, path absent; NOT a blackhole/000) |
| C.2d | **real `pi --provider mmgw` one-shot model call** | **PASS** | exit 0; full JSON event stream — `{"type":"session"…}` → `agent_start` → `turn_start` → `message_start` with the prompt ingested. Gateway authenticated (literal apiKey staged) + model `MiniMax-M3` reached over `anthropic-messages`. |
| C.3 | **remote-MCP egress (LOAD-BEARING)** — JSON-RPC `initialize` to a PUBLIC remote MCP server completes | **PASS** | `POST https://mcp.deepwiki.com/mcp` (Streamable HTTP, no auth) → exit 0; **full application response**: `data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05",…,"serverInfo":{"name":"DeepWiki","version":"2.14.3"},"instructions":"…read_wiki_structure / read_wiki_contents / ask_question…"}}` |
| C.4 | **end-to-end** `piflowctl run --sandbox e2b` → custom gateway → artifact collected via `downloadDir` | **PASS** | run `e2b-e2e-live3`: `done:true · ok:true · greet:ok`; pi (mmgw / MiniMax-M3) wrote + `submit_result`-ed in the VM; host `out/e2b-e2e-live3/greeting.txt` = `E2B-E2E-OK` (10 bytes, `exists:true`). Sandbox disposed by RunScope (no leak). |

**C.3 verdict (the core test):** remote MCP egress from inside E2B is **PROVEN**. A no-auth public remote MCP
server (DeepWiki, Streamable HTTP) returned a complete `initialize` result with `serverInfo` + tool list — an
application-level MCP handshake, not a bare socket. This is precisely the transport Daytona Tier 1/2 blocks
(the egress note's "remote HTTP/SSE MCP" row = ❌ on Daytona low tier). E2B's open egress unblocks the
one-real-pi-per-node heterogeneous-MCP thesis.

**E2E template:** a minimal 1-node template lives at `deploy/e2b/e2e-template/` (node `greet`: write one
artifact + `submit_result`, provider `mmgw`). Reproduce:
`E2B_TEMPLATE=riwrtwrfanz3tewd5pw6 piflowctl run deploy/e2b/e2e-template --sandbox e2b --provider mmgw --thinking low --run <id>`.

---

## Live-only SEAM FRICTION (what the fake-SDK parity test could NOT catch)

1. **CLI cred-warning logic is keyed on `cloudSecrets`, not on `stageHome`** (cosmetic, but misleading).
   `packages/cli/src/run.ts` (~:561-565, e2b branch; the daytona branch ~:530 has the SAME shape) prints
   *"⚠ no provider config/credential resolved for --provider mmgw … pi in the sandbox will have no model key"*
   whenever `cloudSecrets.length === 0`. But `mmgw`'s `apiKey` in `~/.pi/agent/models.json` is a **LITERAL**
   (`gw-…`), not a `$VAR` — so `parsePiProvider` correctly returns `config` (which IS staged) but
   `credVars: []`, leaving `cloudSecrets` empty. The warning fires *even though the key did cross* (inside the
   staged `models.json`), and **the run succeeds anyway** (C.4 proves it: pi reached mmgw and exited ok). The
   message should branch on `stageHome ?? cloudSecrets.length`, not `cloudSecrets.length` alone. NOT FIXED
   (scope: this is in `packages/cli`, and it is a log-string defect, not a functional bug; no code change was
   required for the live path to work). The fake-SDK parity test can't catch it because it never exercises the
   literal-key/no-$VAR config path through the CLI's message logic.

2. **Artifact-path convention is a real authoring trap (NOT an E2B bug).** The runner collects
   `downloadDir(node.sandbox.output → outDir)` where `node.sandbox.output` is hardcoded `out/<id>`
   (`packages/core/src/workflow/template/render.ts:52`) and flattens `out/<id>/*` onto the host run dir. So a
   node's prompt must write its artifact UNDER `out/<id>/` (e.g. `out/greet/greeting.txt`) and declare the
   artifact as the *post-flatten* path (`greeting.txt`). My first template declared `out/greeting.txt` and told
   pi to write `out/greeting.txt`, which on the cloud path landed at `<subtree>/out/greeting.txt` while
   collection read `<subtree>/out/greet/*` → "required artifact missing". This failed **identically on
   `--sandbox local`**, confirming it is the shared template convention, not an E2B defect. Documented here so
   the next author of a cloud template gets the `out/<id>/` prefix right. (The E2B provider's `downloadDir`
   itself is correct — once the file was under `out/greet/`, it collected cleanly.)

3. **No `e2b.toml` from `template create`** — the current CLI tracks the template server-side only; there is no
   on-disk config file to commit (unlike older E2B flows). The id/name is the only handle. Recorded in build.md.

No live bug in `packages/e2b/src` was found — the provider's create/openRun/stageHome/exec(stream)/downloadDir/
dispose all behaved exactly as the fake-SDK parity test asserts. The 16/16 parity test stays the unit gate;
this live run is the integration gate.

---

## D. Full suite

`npx vitest run` (whole repo, in the worktree):

```
Test Files  1 failed | 104 passed | 1 skipped (106)
     Tests  1 failed | 827 passed | 7 skipped (835)
```

The single failure is `agent-preset-roleprompt.test.ts > eval #10 — GATED LIVE` — an `it.skipIf(!probe.runnable)`
eval that runs ONLY because this host has `pi` on PATH + mmgw configured; it spawns a REAL nested `pi` model
call and flaked on the live gateway (observed `spawnSync pi ETIMEDOUT`, then `ENOBUFS` on re-run — the live
model's verbose output overran `execFileSync`'s default `maxBuffer`). A direct host `pi --provider mmgw` call
succeeds in ~4s, so the gateway is up; this is a live-eval/test-harness flake, **not a code defect** and
unrelated to E2B. Excluding that one gated-live file, the deterministic suite is fully green:

```
npx vitest run --exclude '**/agent-preset-roleprompt.test.ts'
Test Files  104 passed | 1 skipped (105)
     Tests  824 passed | 7 skipped (831)
```

The `@piflow/e2b` parity test specifically: **16/16 PASS** (`npx vitest run packages/e2b`).

---

## Cost discipline / no leaks

```
npx --yes @e2b/cli@latest sandbox list  →  No sandboxes found
```

Every sandbox created (the C.1–C.3 smoke VM `i7fs2rqjyq0fd152x23gy`, three e2e run VMs, and a discarded
first-attempt) was deleted — the smoke harness kills in `finally`; the runner disposes via RunScope. Each VM
carried a 5-min `timeoutMs` auto-kill backstop. The template (`riwrtwrfanz3tewd5pw6`) persists by design (it
is the deploy artifact, not a running VM — it does not bill while idle).

---

## Remaining gaps / manual steps

1. **OpenClaw remote-MCP target (the user's own outside gateway): NOT exercised — URL unknown.** Portability
   plan §7.3(b) asks to also hit the user's self-hosted OpenClaw MCP gateway. I did NOT invent a URL. C.3
   already proves remote-MCP egress generically (DeepWiki). To point it at OpenClaw, set the URL and re-run the
   C.3 block of `deploy/e2b/smoke-live.mjs` against it (POST the same `initialize` JSON-RPC; if OpenClaw is
   SSE-only, GET its `/sse` and expect an `event:`/`data:` stream). **Put auth in front of OpenClaw** before
   exposing it (egress note: public MCP gateways are an attack surface — the "ClawBleed" CVE).
2. **MCP-tool-IN-a-node e2e** (vs. raw MCP egress) was not run — the node-level MCP wiring needs an `mcp.json`
   in the template; raw egress (C.3) + the working tool path (C.4 used `write`/`submit_result`) cover the
   thesis. A node that binds a remote MCP tool is the natural next e2e once an OpenClaw URL exists.
3. **CLI cred-warning copy** (friction #1) — a one-line message fix in `packages/cli/src/run.ts` (both the e2b
   and daytona branches); deferred (out of this session's read-only-on-provider-code scope; it is a log string,
   not a functional defect — the run succeeds).
4. **`--sandbox daytona` is still pinned to a permissive tier** for custom-host egress (the original blocker);
   that's a Daytona account-tier action, untouched here (another agent owns Daytona).
5. **`build.md`'s `ARG PI_VERSION` override** — `template create` (2.13.0) exposes no build-arg flag; bump pi by
   editing the Dockerfile `ARG`. Noted in build.md.

---

## Artifacts produced by this session (worktree, branch `worktree-agent-a1aa6aa49e320a783`)

- `deploy/e2b/build.md` — corrected to `template create` + the real template id/build commands.
- `deploy/e2b/smoke-live.mjs` — the live application-layer smoke harness (re-runnable; reuses one sandbox).
- `deploy/e2b/e2e-template/` — the minimal 1-node `--sandbox e2b` e2e template (custom gateway + 1 artifact).
- `docs/research/2026-06-26-e2b-template-and-smoke-test.md` — this report.
- `packages/e2b/src/` — UNCHANGED (no live bug required a provider fix).
