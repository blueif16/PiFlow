# HANDOFF — finish piflow's one-control-plane-two-contexts (local ⇄ cloud, one-click switch)

> Paste the block below into a fresh session to continue. It references files/commits (does not duplicate them).
> Work in the existing worktree + branch; keep the sub-agent fleet pattern; commit per coherent unit; push as you go.

---

You are continuing a multi-session build in the **piflow** monorepo. Do NOT restart — a large, tested
foundation exists on a branch. Read this handoff, verify state, then finish the last two pieces + go live.

## GOAL (north star — unchanged)
piflow's **control plane works identically local and in the cloud**, and you **switch a run between them with
one click** — UPLOAD (laptop→cloud) / DOWNLOAD (cloud→laptop). The deterministic runner loop stays the control
plane; Claude/pi are executors / console / out-of-band overlord, never the reconcile loop.

## WHERE THINGS ARE
- Worktree: `/Users/tk/Desktop/piflow/.claude/worktrees/control-plane-serve-context` — branch
  `worktree-control-plane-serve-context` (pushed to origin, `b230a8c`), ~13 commits off `main`. Continue here.
- Approved design + phase plan: `/Users/tk/.claude/plans/sunny-inventing-pudding.md` (the spec — still valid).
- Verify state: `git log --oneline main..HEAD` · `pnpm -r --filter './packages/*' build` · `pnpm test`
  (expect **1428 passing / 0 fail**) · `(cd gui && pnpm build)`. All green as of this handoff.

## STATE NOW — DONE + verified this session (P5 server+image, P6 core+endpoints+CLI, P7 redirect)
The **whole local⇄cloud migrate mechanism works end-to-end at the code level** (only the live cloud deploy +
the GUI button remain). Commits (newest first):
- `b230a8c` **deploy security** — hardened `deploy/control-vm/.dockerignore` (whole `.claude`, `.npmrc`,
  `*.pem/*.key/id_rsa/.ssh/.aws/.netrc/secrets`) + README made the copy-to-context-root a REQUIRED step.
  Audited: the Dockerfile bakes NO secrets (all injected at runtime via `fly secrets set`; CMD fails closed if
  `PIFLOW_TOKEN` unset); scan found no real keys in the build context.
- `d529c10` **`piflowctl context migrate <target> <run>`** (`packages/cli/src/migrate.ts`) — the headline
  one-click UPLOAD/DOWNLOAD. Symmetric freeze→bundle→adopt→`context use`; local side uses core primitives,
  remote side uses the migrate HTTP endpoints. Surfaces `frozen` through observe's `RunModel`
  (`read.ts`/`types.ts`) so the freeze-wait detects the park identically local + remote. Wired `migrate` verb
  into `context.ts`. All I/O boundaries injectable; upload/download/already-done flows tested.
- `412fc90` **P5 Fly image** — `deploy/control-vm/{Dockerfile,fly.toml,smoke-live.mjs,README.md,.dockerignore,
  e2e-template}`. Multi-stage build shipping the BUILT WORKSPACE (the handlers resolve `gui/scripts/lib` +
  `packages/core/dist` via findUp at request time — a bare npm-global won't work). node22+pi+claude-code+git+
  ripgrep+**bubblewrap**; CMD = `piflowctl serve --host 0.0.0.0 --port 8080 --token $PIFLOW_TOKEN
  --allow-templates …`, fails closed w/o the token. smoke = ordered A(401/200)→B(start 202)→C(SSE done)→D(run-
  view artifact)→E(sandbox=local jailed + in-VM bwrap/subscription probes).
- `091a49a` **P6 server endpoints** (`packages/server/src/migrate.ts`) — `POST …/migrate/<run>/freeze`,
  `GET …/bundle`, `POST …/adopt` (unpack + detached resume, allow-list gated like start-run).
- `e7a62b2` **P7 CLI redirect** (`packages/cli/src/remote.ts`) — the active/`--context` redirects
  `status`/`watch`/`run` to a remote serve over SSE/HTTP (remoteRunModel takes the first `{kind:snapshot}`;
  remoteUpdates feeds watch's `updates` seam; startRemoteRun → POST /api/runs/start). Bearer token on every call.
- `b75235d` **P5 server auth** — template allow-listing on `POST /api/runs/start` (403 before spawn;
  `isTemplateAllowed` pure; `--allow-templates`/`PIFLOW_ALLOWED_TEMPLATES`). Bearer gate was ALREADY correct.
- `fb1695f` + `ea4e200` **P6 core primitives** — `run.lock` lease (`lease.ts`), freeze-at-node-boundary
  (`runner.ts` + `migrate.ts`, `RunStatus.frozen`), gzipped run-dir bundle (`migrate.ts`). Full migrate loop
  proven at the core level (freeze→bundle→adopt-elsewhere→resume-via-journal).

Every new test was verified to FAIL under a deliberate mutation (lease staleness, freeze setter, bundle
exclude, allow-list gate, SSE parser, freeze-wait). +62 tests over the 1366 baseline.

## NEXT STEPS — to COMPLETE the vision (in order)
1. **A3 — `piflowctl cloud up|down` (Fly.io) + `cli.ts` dispatch.** New `packages/cli/src/cloud.ts`. `cloud up`
   = build the deploy plan (mint a bearer token + a scoped/TTL provider cred + the Claude OAuth token as Fly
   secrets via `SecretResolver{isCloud:true}` + `cloudCredEnvAdditions`, MINT-not-forward), run the deploy,
   then write + `context use` a `cloud` context at the `https://<app>.fly.dev` URL. Wire `case 'cloud'` in
   `packages/cli/src/cli.ts` (dispatch mirror of `context`/`serve`). Keep the deploy PURE-testable
   (`buildFlyDeployPlan`/`mintCloudSecrets` unit-tested) and **PAUSE before the real `fly deploy`** — it is
   outward-facing + spends money; hand that step to the user. `cloud down` tears the app down.
2. **D1 — GUI one-click migrate button.** `gui/` only (no other track touches it). A MenuBar button →
   MigrateRunPanel (context dropdown from a small `/api/contexts` reflect, or the CLI's contexts) → POST the
   server migrate endpoints; after 202, re-point `apiBase` to the target context's baseUrl (make
   `gui/src/data/apiBase.ts`'s `API_BASE` runtime-repointable — a mutable ref/Context, currently a build-time
   const) and re-`selectRun` so RunStream/Companion reconnect. Reuse StartRunPanel's pattern. See the
   understanding-map notes in this session's transcript (gui-apibase reader) for exact seams.
3. **GO LIVE (hand the paid/outward steps to the user; you author + gate):**
   - Run `deploy/control-vm/README.md`'s runbook: `fly secrets set` the 3 secrets, `cp deploy/control-vm/
     .dockerignore .dockerignore`, `fly deploy`, wait for health.
   - `deploy/control-vm/smoke-live.mjs` (env `PIFLOW_CLOUD_URL`+`PIFLOW_TOKEN`) must PASS — the P5 gate.
   - Verify in-VM: bwrap userns probe passes (`--sandbox local` jails, not fail-closed) + a `claude-code` node
     used the OAuth subscription (not API billing).
   - **Live migrate e2e**: start a run local → `piflowctl context migrate cloud <run>` mid-run → confirm it
     froze at a node boundary, bundled up, resumed on the VM via `--from`/journal, lease never double-written;
     then `piflowctl context migrate local <run>` back down.

## OPEN THREADS / RISKS
- **bwrap in Fly** must allow userns or `--sandbox local` fails closed — the smoke's E-probe covers it; run it.
- **headless `claude -p` on Linux** with only `CLAUDE_CODE_OAUTH_TOKEN` — live-verify in the VM (never set
  `ANTHROPIC_API_KEY` as a Fly secret; a non-empty API key outranks the OAuth token → per-token billing).
- **Migrate template resolution on the target**: `migrate` derives product/workflow from the source run's
  identity (or `--product/--workflow`). The TARGET must have that template (cloud: baked+allow-listed; laptop:
  it originated there). The demo `greet` works out of the box; document/verify for a real product.
- **`.dockerignore` only applies at the CONTEXT ROOT** — the README makes copying it up REQUIRED; `cloud up`
  (A3) should automate that copy so the operator can't forget.
- **Single-writer lease** guards the journal double-write — do NOT weaken it. The source releases on freeze;
  the target acquires fresh on resume (proven in `migrate-loop.test.ts`).

## DECISIONS + WHY (do not relitigate)
- **serve + context are orthogonal** (Modal/vite `serve` = process; kubectl/docker `use-context` = the switch).
  Ladder: `--context` flag > `PIFLOW_CONTEXT` env > current > `local`. `local`/`cloud` are rows in
  `~/.piflow/contexts.json`.
- **Exposure = one process, one port, same-origin**: `piflowctl serve` on the VM serves GUI+API+SSE on
  `https://<app>.fly.dev` (Fly `[http_service] internal_port`); the browser talks straight to the VM (no
  reattach proxy). SSE authenticates via `?token=` (EventSource can't set headers); everything else via Bearer.
- **Migration = checkpoint→reprovision→reload with a stable run-id, NOT live teleport** (SkyPilot model). Resume
  rides the existing journal (`seedFromJournal` REUSEs done nodes), not a live memory move.
- **Fly.io** for the control VM (durable public host + real bwrap jail; Daytona blocks bwrap, E2B is ephemeral).
- **Per-node agents run `--sandbox local` INSIDE the VM** (bwrap), NOT nested cloud sandboxes (that's v2). So
  the VM needs the bearer token + model/OAuth creds, NOT E2B/Daytona keys.

## HOW TO WORK (process the user expects)
- Own the git loop: commit per coherent unit (one idea, no "and"), push as you go, `--no-ff` merge to `main`
  when the track is done+verified. End messages with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Delegate disjoint bounded work to named sub-agents** (this session used server-authz/cloud-image/cli-redirect
  successfully — verify EVERY agent against the diff + build + tests + a test-the-test mutation, NEVER its report).
- **Tests must fail when the code is wrong** (test-discipline); a live smoke gates the server/cloud glue.
- Confirm before outward-facing/irreversible actions (the real `fly deploy`, `fly secrets set`).

## SUGGESTED SKILLS (load as relevant)
`piflow-start` (run/monitor) · `agentic-prompt-design` (before ANY sub-agent/handoff prompt) · `test-discipline`
(before any test) · `okf-slices` (FIND the runner/sandbox/observe/cloud slices) · `piflow-overlord`.

## ARTIFACTS
- Plan: `/Users/tk/.claude/plans/sunny-inventing-pudding.md`
- This handoff: `docs/handoff-cloud-control-plane.md`
- The migrate spine: `packages/core/src/runner/{lease,migrate}.ts`, `packages/server/src/migrate.ts`,
  `packages/cli/src/{migrate,remote}.ts`; the image: `deploy/control-vm/`.
- Cloud-cred seams to reuse for A3: `packages/core/src/runner/env-staging.ts` (`cloudCredEnvAdditions`,
  `CLOUD_KINDS`), `SecretResolver{isCloud:true}`; the e2b deploy for the smoke pattern: `deploy/e2b/`.
</content>
