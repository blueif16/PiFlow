# Multi-Provider Sandbox Portability — the seam is built; add E2B next

> **Status:** PLAN (2026-06-26). Research complete; **implementation deferred to the next session.**
> This doc is the implementation + live-test spec. Companion research:
> `docs/research/2026-06-26-cloud-sandbox-network-egress.md` (WHY E2B — egress), and the per-provider
> capability matrix / adopt-vs-build / reuse-audit findings synthesized below.
> Cross-ref: `docs/design/daytona-cloud-integration.md`, `docs/design/credential-architecture.md`.
> Memory: `daytona-cloud-path`, `capability-catalog-feed`.

---

## 0. Verdict (answers to the five questions)

1. **Can we have a unified surface compatible with all cloud sandboxes?** — **Yes, and it already exists.**
   `SandboxProvider` + `Sandbox` + `RunScope` (`packages/core/src/types.ts:498-609`) is the "horizontal seam,
   one impl per backend." Daytona is implemented behind it; `'e2b'` is already in the `SandboxProviderKind`
   union (`types.ts:210`) and in `CLOUD_KINDS` (`runner.ts:443`). No seam refactor is required to add a backend.
2. **How much of "our snapshots / everything" can we reuse?** — **Most of it for free** (see §2). The runner's
   orchestration, the cloud credential allowlist, the `SecretResolver`, output collection via `downloadDir`,
   and the entire tool/MCP/skill staging path are **provider-agnostic**. The image *bakes only the runtime*;
   tools are staged at runtime — so "tools bundled in the image" is **incorrect**, and that's good (the tool
   path transfers to any backend untouched).
3. **Does a portable "one SDK, many providers" service already exist?** — Yes (Sandbank, ComputeSDK, LangChain
   sandboxes, …) but **none cover our four hard capabilities** + `SecretResolver` + the run-scoped one-VM model.
   **Decision: BUILD per-provider behind our own seam** (§5).
4. **How much extra per provider?** — Two files + one deploy dir + a CLI branch + a test-case row. **E2B = M**
   (medium); Vercel = S; Modal = M; Cloudflare = L; Northflank = L (§4, §6).
5. **Is it a robust, relatively simple basis?** — Yes. The hard cross-cutting work is done once in the runner;
   a backend is "implement the 6 `Sandbox` methods + the SDK adapter + the image." The one real risk is the
   `exec` streaming/cancel semantics, which need a **live** e2e (a fake can't catch it) — §4 item 5, §7.

**Why E2B specifically:** Daytona tier-gates egress (Tier 1/2 = fixed org allowlist, custom hosts blocked) —
which kills remote MCP gateways and custom LLM gateways. **E2B defaults to OPEN egress** with per-sandbox
allow/deny, so heterogeneous/remote MCP works without a billing-tier gate. That is the unblock for piflow's
one-real-pi-per-node thesis. (Full mechanism: the egress research note.)

---

## 1. Where things live (verified)

- Seam contract: `packages/core/src/types.ts` — `CreateOpts` (:501), `ExecResult` (:517), `ExecOpts` incl. the
  `signal` cancel contract (:524), `Sandbox` (:546), `RunScope` (:587), `SandboxProvider` w/ optional `openRun`
  (:596), `SecretResolver` (:626).
- Reference + stub: `packages/core/src/sandbox/index.ts` (`InMemorySandbox`, `NotImplementedProvider`).
- Daytona backend (the template to mirror): `packages/core/src/sandbox/daytona.ts` (view :195, run-scope :447,
  provider :493) + `packages/core/src/sandbox/daytona-sdk.ts` (the ONLY file importing `@daytona/sdk`;
  `realDaytonaSdk()` + `createDaytonaProvider()`).
- Worktree backend (a second `openRun` impl, for contrast): `packages/core/src/sandbox/worktree.ts`.
- Runner wiring: `packages/core/src/runner/runner.ts` — `CLOUD_KINDS` (:443), `IN_PLACE_KINDS` (:456),
  `cloudCredEnvAdditions` (:545), `mcpEnvAdditions` (:507), `openRunScope` (:1672), per-node create (:1067),
  per-node + run-level dispose (:1583, :2112), `downloadDir` collection (:1252), tool/MCP/skill staging
  (:1158-1188).
- Image pipeline (mirror per provider): `deploy/daytona/{Dockerfile,build-and-smoke.mjs,promote-snapshot.mjs}`.
- CLI surface: `packages/cli/src/run.ts` — `SandboxChoice`/`SANDBOX_CHOICES` (:117,120 — today only
  `inmemory|local|danger-full-access|daytona`), the `--sandbox` branch (~:467-503), `makeDaytonaProvider` in
  `RunDeps` (~:344-347), `providerCredVar` (~:277).
- Contract tests (table-driven — add a row, don't rewrite): `packages/core/test/sandbox-cloud-parity.test.ts`
  (`SANDBOX_CASES` :238, `PROVIDER_CASES` :212, `describe.each` :263,:293); streaming regression:
  `sandbox-daytona-streaming.test.ts`; gated live e2e pattern: `sandbox-daytona-e2e.test.ts`.

**Credentials (corrected — no new file):** infra/sandbox keys are plain env vars read from `process.env`
(`run.ts` reads `process.env.DAYTONA_API_KEY`; `daytona-sdk.ts:148`). They live in **`~/.zshenv`**
(auto-loaded). `E2B_API_KEY` has been added there beside `DAYTONA_API_KEY`/`NEBIUS_API_KEY`. The E2B provider
must read `process.env.E2B_API_KEY` (mirror Daytona). Custom LLM gateways (`mmgw`/`nebius`) live in
`~/.pi/agent/models.json`; tool/MCP `$VAR`s use the `~/.piflow/credentials.json` store per
`credential-architecture.md` §3 — unchanged by this work.

---

## 2. Reuse ledger

### (A) Provider-agnostic — E2B inherits these for ZERO work
- The seam interfaces (`types.ts:501-609`) — E2B implements them, never edits them.
- `openRun`-vs-`create` selection (`runner.ts:1672`); per-node `create`/`dispose` ordering and the
  "VM destroyed exactly once after the last node, even on node failure" guarantee (`runner.ts:1067,1583,2112`).
- Cloud credential allowlist — `cloudCredEnvAdditions` + `isCloud = CLOUD_KINDS.has(kind)` (`runner.ts:545,1006`).
  Because `'e2b' ∈ CLOUD_KINDS`, the pi gateway key is forwarded with **no new runner code**.
- MCP `$VAR` allowlist + `_pi/mcp.json` write (`runner.ts:507,1015,1166`); `SecretResolver` invocation
  (`types.ts:626`).
- Output collection via `downloadDir` (`runner.ts:1252`; `'e2b' ∉ IN_PLACE_KINDS` so it IS collected, like Daytona).
- Tool/MCP/skill staging — `_pi/<id>/tools.ts` (:1158), `_pi/<id>/mcp.json` (:1166), skill dir + `--skill`
  (:1176) — **all `Sandbox.writeFile`/`CreateOpts.env` calls (the seam, not a Daytona method).**
- Shared `tailAppend` (`capture.ts:15`); the table-driven parity tests (add an E2B row).

### (B) Daytona-shaped — copy/generalize for E2B
- `vmDefaults` shape + `stageHome` mechanism (`daytona.ts:496-537`) — the *concept* is generic; the *shape* is
  Daytona-named (`snapshot`, `/home/daytona`). E2B uses "templates" + a different home → its own `vmDefaults`.
  (No shared `CloudVmDefaults` type today; lifting one is optional — faster to let E2B declare its own,
  matching the current one-file-per-backend pattern.)
- `deploy/daytona/` pipeline — contents rationale (node22 + pi + git + ca-certs + ripgrep, MINIMAL+ tier) is
  fully reusable as the *spec*; the build *verb* differs (`e2b template build` vs Daytona snapshot create) →
  a parallel `deploy/e2b/`.
- CLI `--sandbox daytona` branch + `makeDaytonaProvider` `RunDeps` + `SANDBOX_CHOICES` — mirror for `e2b`;
  `providerCredVar` is reusable as-is.

### (C) Genuinely new code
- `packages/core/src/sandbox/e2b.ts` — `E2bSandbox` (mirror `daytona.ts:195`), `E2bRunScope` (:447),
  `E2bSandboxProvider` (:493), the SDK seam interfaces (mirror `DaytonaSdk`/`Vm`/`Fs`/`Process` :49-156),
  file-local `decode`/`toBytes` (:161-168).
- `packages/core/src/sandbox/e2b-sdk.ts` — `realE2bSdk()` + `createE2bProvider()`, the ONLY file importing the
  E2B SDK (mirror `daytona-sdk.ts`).
- `deploy/e2b/` — `e2b.Dockerfile` + build script, contents = `deploy/daytona/Dockerfile` MINIMAL+ tier.
- Barrel exports in `packages/core/src/index.ts` (mirror the Daytona exports).

---

## 3. E2B API surface (from the provider capability research — cite before coding)

`e2b` (TS/JS), auth `E2B_API_KEY`. Verify against current docs at implementation time.

| Contract method | E2B call | Note |
|---|---|---|
| create | `Sandbox.create({ timeoutMs, envs, template? })` | sandbox timeout in **ms**; template = pre-built Firecracker snapshot via `e2b template build` (Debian-based `e2b.Dockerfile`) |
| putFiles | `sandbox.files.write([{path,data}])` | **native bulk array** (better than Daytona) |
| writeFile | `sandbox.files.write(path,data)` | — |
| readFile | `sandbox.files.read(path)` | — |
| downloadDir | **GAP** — enumerate + N `files.read()`, or `tar`/`zip` in-VM then one `files.read` | mirror Daytona's enumerate-then-fetch (`daytona.ts:410`), or tar for fewer round-trips |
| exec (stream) | `sandbox.commands.run(cmd,{cwd,envs,timeout,onStdout,onStderr})` | **native streaming**; timeout in **seconds**; `envs` not `env` |
| exec (cancel) | **GAP** — no `AbortSignal`; `commandHandle.kill()` / `commands.kill(pid)` | wrap: on `opts.signal` abort → `handle.kill()` |
| exec (background) | `commands.run(cmd,{background:true})` → `CommandHandle{ wait(), kill() }` | satisfies optional `spawn?` |
| env | `Sandbox.create({envs})` + per-call `commands.run(...,{envs})` | no host inheritance (correct for cloud) |
| run-scoped (`openRun`) | **GAP (no native)** — one long-lived E2B sandbox = "the VM"; node views = workdir subtrees; `dispose` kills it once | structurally identical to `DaytonaRunScope`; E2B sandboxes are long-lived + accept concurrent `commands.run` |
| egress | **open by default**; `network:{allowOut,denyOut}` (IP/CIDR/domain, allow wins); `allowInternetAccess:false` | the WHY for E2B |

**exec is LIKELY SIMPLER than Daytona:** E2B gives native streaming AND a background handle whose `wait()`
returns a real exit code — so **no poll loop and no "follow-socket never resolves" bug** (the live-only
Daytona trap, `daytona.ts:297-304`). Only the cancel is weaker (kill, not AbortSignal) → wrap kill-on-abort,
and document it as SEAM FRICTION (the runner's `killGraceMs` backstops it, same as Daytona's soft cancel).

---

## 4. E2B implementation checklist (ordered; sizes)

1. SDK seam interfaces in `e2b.ts` → mirror `daytona.ts:49-156` → **S**
2. `E2bSandboxProvider` + `E2bRunScope` skeleton (`kind:'e2b'`, `openRun`+`create`, `vmDefaults`) → **M**
3. `realE2bSdk()` + `createE2bProvider()` in `e2b-sdk.ts` (only SDK-importing file) → **M**
4. `putFiles`/`writeFile` (use E2B's bulk `files.write`) → **S**
5. `exec` — buffered + streaming/cancel (background handle + `wait()`; `kill()` on `signal`) → **L** ← biggest risk
6. `readFile` → **S**
7. `downloadDir` (enumerate+fetch, or in-VM tar) → **M**
8. env/cred merge in exec (`{...this.env,...opts.env}`) — runner already forwards the allowlist → **S**
9. `stageHome` (custom-gateway `models.json` into the VM before any node) → **S**
10. `deploy/e2b/` template (MINIMAL+ tier: node22 + pi + git + ca-certs + ripgrep) → **M**
11. `dispose`/teardown (no-op when run-scoped; kill VM once in run-scope dispose / throwaway `create`) → **S**
12. CLI: add `'e2b'` to `SandboxChoice`/`SANDBOX_CHOICES`, an `--sandbox e2b` branch, `makeE2bProvider` in
    `RunDeps`, reuse `providerCredVar` → **M**
13. Tests: add an E2B row to `SANDBOX_CASES`/`PROVIDER_CASES` (fake E2B SDK over a host temp dir, mirror the
    Daytona fake); add a streaming regression ONLY if E2B exec needs a poll workaround; gated live e2e → **M**

**No seam refactor.** Every cross-cutting concern is already provider-agnostic (§2A).

---

## 5. Adopt-vs-build — BUILD per-provider behind our seam

None of Sandbank (166★; **no streaming on its Daytona/Fly adapters**), ComputeSDK (222★; streaming/cancel
UNVERIFIED), LangChain sandboxes (single synchronous `execute()`), or agentsh (a security overlay, not an
abstraction) cover our **four hard capabilities** — streaming exec, cancel, `downloadDir`-as-collection,
run-scoped one-VM-many-nodes — *and* none expose a `SecretResolver`/scoped-token hook. Our seam already does
the hard part; wrapping an immature third-party abstraction adds a dependency for negative value. **Revisit
ComputeSDK only if it reaches production scale (~2k★ + documented streaming+cancel across providers).**

---

## 6. Provider ranking (after E2B)
- **E2B — M, PRIMARY.** Open egress (the unblock); clean files/exec; only `downloadDir` + AbortSignal gaps.
- **Vercel Sandbox — S.** Cleanest contract match (native `AbortSignal`, bulk `writeFiles`, streaming, per-call
  cwd/env, per-domain egress + credential brokering). Gap: no bring-your-own Docker image (named runtimes only).
- **Modal — M.** Open egress; native streaming; one long-lived sandbox fits `openRun`. Gaps: no per-process
  cancel (sandbox-level terminate), no bulk file I/O, cwd not persisted.
- **Cloudflare Sandbox — L.** Best egress/credential story (Outbound Workers) but the SDK runs *inside* a
  Worker — architectural mismatch with our Node runner.
- **Northflank — L.** No SDK file-I/O primitives (rsync/curl workarounds) — a custom transfer layer.

---

## 7. Live smoke test (the "quick testing of major features" — run in the NEXT session)

Goal: prove the egress thesis end-to-end on real E2B with the stored key — the things Daytona Tier 1/2 blocked.
Source the key first: `set -a; source ~/.zshenv; set +a` (E2B_API_KEY now present).

1. **Boot** an E2B sandbox (base image first; the `deploy/e2b/` template once built).
2. **Provider connectivity (application layer, NOT TCP):** from inside the sandbox,
   `curl -sS -o /dev/null -w "%{http_code}\n"` against (a) a package registry [baseline], (b) the user's LLM
   gateways — `https://minnimax.chat` (mmgw) and `https://api.tokenfactory.nebius.com` (nebius) — expect 2xx/401
   (reachable), NOT a hang/blackhole. Then a real `pi --provider mmgw` one-shot model call.
3. **MCP egress proof (the core test):** from inside the sandbox, reach (a) a **public remote MCP server**
   (HTTP/SSE) and (b) the user's **own outside MCP gateway** (e.g. OpenClaw on another server) — confirm the
   request COMPLETES (an application-level response), proving remote MCP works where Daytona blocked it.
4. **End-to-end:** one-node piflow run `--sandbox e2b` using an MCP tool + a custom provider; assert the
   artifact is collected via `downloadDir`.
5. **Record** results in `docs/research/2026-06-<dd>-e2b-smoke-test.md` (or a `learning-records/` entry):
   per-check PASS/FAIL with the observed status code / response, and any SEAM FRICTION found.

**Acceptance for the E2B milestone:** `--sandbox e2b` runs a node e2e · a remote-MCP call from inside E2B
succeeds (egress proven) · parity test green with the E2B row · artifacts collected.

---

## 8. Next-session subagent dispatch guide (ready contracts — DO NOT run now)

Hand each agent THIS doc + `docs/research/2026-06-26-cloud-sandbox-network-egress.md`. Dispatch 1+2 in
parallel, then 3 after 1 lands. Each contract: facts inline, scope fence, no-fabrication failure path,
verify against the diff/tests (not the agent's self-report).

- **Agent 1 — Implement the E2B backend (general-purpose, edit).**
  GO: build `e2b.ts` + `e2b-sdk.ts` mirroring `daytona.ts`/`daytona-sdk.ts` per §4 items 1-11; wire the CLI
  per item 12; add the parity-test row per item 13. Read the E2B SDK docs (Context7 / official) for exact
  signatures before coding (§3 is the map, not gospel). SCOPE FENCE: do NOT modify the seam interfaces in
  `types.ts` or the runner's cross-cutting logic; mirror Daytona's patterns; if a seam refactor seems required,
  HALT and report why. VERIFY: `npm run build` + the parity suite green (E2B fake row); report the exec
  streaming/cancel approach chosen and any SEAM FRICTION. Commit at coherent boundaries.
- **Agent 2 — E2B template image (general-purpose, edit).**
  GO: create `deploy/e2b/` (an `e2b.Dockerfile` + build script) with contents byte-equivalent to
  `deploy/daytona/Dockerfile`'s MINIMAL+ tier (node22 + pi via `@earendil-works/pi-coding-agent` + git +
  ca-certificates + ripgrep). SCOPE FENCE: image only; no provider code. VERIFY: `e2b template build` succeeds
  and `pi --version` + `rg --version` run in a booted sandbox; record the template id.
- **Agent 3 — Live smoke test (general-purpose, bash+edit).** Run AFTER Agent 1.
  GO: execute §7 steps 1-5 against real E2B (`E2B_API_KEY` from `~/.zshenv`). Use application-layer checks, not
  TCP (the false-positive trap from the egress note). SCOPE FENCE: read-only on piflow code; you may create
  ONLY the test-report doc; keep VM count + spend minimal (reuse one sandbox); HALT and report if a provider
  key is missing rather than inventing one. VERIFY: write the dated test report with per-check PASS/FAIL +
  observed status codes; the MCP-egress check (step 3) is the load-bearing result.
