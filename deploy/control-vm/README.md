# piflow cloud control plane — Fly.io control VM

A durable, authenticated **control plane** for piflow, on one Fly.io machine. One process —
`piflowctl serve --host 0.0.0.0 --port 8080 --token <SECRET>` — serves the **GUI** (`gui/dist`), the
**control API**, and the **SSE run-stream** on ONE public HTTPS origin (`https://<app>.fly.dev`). A
piflow `cloud` context points at exactly that origin, so the same CLI/GUI that drive a laptop drive
the cloud.

Per-node agents that a run spawns (`executor: pi` or `executor: claude-code`) run **inside this same
VM** under `--sandbox local` — the **bubblewrap** kernel jail — NOT in nested cloud sandboxes. So the
image carries both the control plane and a full node runtime.

## What's in the image (`Dockerfile`)

| tool | why |
|------|-----|
| node 22 (`node:22-trixie-slim`) | pi + `@piflow/*` need node ≥22; Debian **trixie** gives the unprivileged user namespaces bubblewrap needs (Ubuntu 24.04 clamps them — never rebase there) |
| `git`, `ca-certificates`, `ripgrep` | node-runtime substrate: repo init, TLS for gateway/OAuth/MCP calls, pi's `grep`/`find` |
| `bubblewrap` | the Linux `--sandbox local` jail backend — without it the userns probe fails and local sandbox fails closed |
| `pi` (`@earendil-works/pi-coding-agent@0.80.2`) | the `executor: pi` agent runtime (pinned, matching `deploy/e2b` + `deploy/daytona`) |
| Claude Code CLI (`@anthropic-ai/claude-code`) | the `executor: claude-code` agent — headless `claude -p`, authed on Linux ONLY via `CLAUDE_CODE_OAUTH_TOKEN` |
| `piflowctl` + `@piflow/server` + `gui/dist` + the built workspace | the control plane itself |

### Why a built workspace, not `npm i -g piflowctl`

The control handlers resolve two **monorepo-relative** paths at request time (`findUp`):
`gui/scripts/lib/index-snapshot.mjs` (the LIVE fleet index the SSE stream + `POST /api/runs/start`
resolve runs through) and `packages/core/dist/observe/index.js` (the run-view distiller). `start-run`
also spawns the detached runner via `findUp("packages/cli/dist/cli.js")`. A bare npm-global install
has none of these up-tree — the stream + run-view would 500. So the VM runs a **built checkout** (a
multi-stage build: stage 1 `pnpm install && pnpm -r build && gui build`; stage 2 copies the built
tree and links `piflowctl` onto PATH). This is exactly what a laptop's `piflowctl serve` runs.

### The baked demo product

`deploy/control-vm/e2e-template/` is a real §D9 **product root** (`.piflow/greet/template/…`), baked
to `/home/piflow/demo`. A run launched against it lands at `.piflow/greet/runs/<id>`, and the first
run **self-registers** the root into `~/.piflow/products.json` — so it's discoverable by the LIVE
index (SSE + run-view) with no manual registration. `PIFLOW_ALLOWED_TEMPLATES` allow-lists exactly
this template, and `PIFLOW_SCOPE_ROOTS` scopes the GUI/index to it.

## Operator runbook

> **`fly deploy` is the operator's step.** This directory only AUTHORS the image + config; building
> and deploying spends money and is yours to run. The commands below are what you run on your machine
> (with the Fly CLI installed + `fly auth login` done).

### 1. Set the secrets (BEFORE the first deploy)

Secrets are injected as env; **nothing here is baked into the image**. The server **refuses to start**
without `PIFLOW_TOKEN`, so set it first.

```bash
fly secrets set PIFLOW_TOKEN="$(openssl rand -hex 32)"     # the bearer token the GUI/CLI present
fly secrets set NEBIUS_API_KEY=...                          # your pi gateway/provider key (executor: pi)
fly secrets set CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)"   # executor: claude-code (subscription)
```

- Save the `PIFLOW_TOKEN` value — the CLI/GUI + the smoke need it.
- `claude setup-token` mints the subscription OAuth token on your laptop. **Never** set
  `ANTHROPIC_API_KEY` as a Fly secret — a non-empty API key silently outranks the OAuth token in
  `claude -p` (per-token billing). (The executor strips it in-jail as a backstop, but don't hand it in.)

### 2. Deploy (operator's paid step)

```bash
# REQUIRED first — put the prune list where the builder actually reads it (the context ROOT). Docker/Fly
# read ONLY a context-root `.dockerignore`; a `.dockerignore` sitting in deploy/control-vm/ is IGNORED, so
# without this copy the `COPY . .` would ship node_modules/.git/.claude/etc. into the image. Do it every time:
cp deploy/control-vm/.dockerignore .dockerignore

# Build the image FROM THE REPO ROOT (the build needs the whole workspace), using this Dockerfile:
fly deploy --config deploy/control-vm/fly.toml --dockerfile deploy/control-vm/Dockerfile .

rm .dockerignore   # clean up the temporary copy
```

Run this with the **repo root** as the build context (the trailing `.`).

**Secrets never enter the image.** The Dockerfile bakes NO tokens/keys — every secret (`PIFLOW_TOKEN`, the
pi gateway key, `CLAUDE_CODE_OAUTH_TOKEN`) is injected at RUNTIME via `fly secrets set` (step 1), and the
CMD fails closed if `PIFLOW_TOKEN` is unset. The root `.dockerignore` above is the belt-and-suspenders guard
that keeps any stray `.env`/`.npmrc`/`*.pem`/`*.key`/`.ssh`/`.aws`/`.claude` out of `COPY . .`.

Set the app name in `fly.toml` (`app = "…"`) or pass `-a <name>` — first time, `fly apps create <name>`.

### 3. Smoke the deployed VM

```bash
PIFLOW_CLOUD_URL=https://<app>.fly.dev \
PIFLOW_TOKEN=<the token you set> \
node deploy/control-vm/smoke-live.mjs
```

Asserts, in order (non-zero exit on any failure):

- **A** — `GET /` without the token → **401**; with the bearer token → **200 + GUI html**; `?token=`
  (the SSE query form) → **200**.
- **B** — `POST /api/runs/start` for the baked `greet` product (`sandbox=local`) → **202 `{run}`**.
- **C** — the SSE stream `/__piflow/stream/<run>?token=…` reaches `{kind:"done"}`.
- **D** — `GET /__piflow/run-view/<run>` shows the greet artifact (`out/greet/greeting.txt`).
- **E** — the in-VM invariants: a `sandbox=local` run reaching `done` proves the jail didn't fail
  closed (observable); the bwrap userns probe + the claude-code subscription-billing guarantee are
  **not** externally probeable — the check documents the in-VM commands to verify them:

  ```bash
  # bwrap jail (MUST print 0, or --sandbox local fails closed):
  fly ssh console -C 'bwrap --ro-bind / / --proc /proc --dev /dev true; echo $?'
  # claude-code subscription (OAuth present, API key absent):
  fly ssh console -C 'printenv | grep -E "CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY"'
  ```

  Run the smoke with `PIFLOW_EXECUTOR=claude-code` to launch the demo node on `claude -p` instead of pi.

### 4. Point a piflow context at it

```bash
piflowctl context add cloud https://<app>.fly.dev --token <the token>
piflowctl context use cloud
```

The GUI's API-base + the CLI then talk to the cloud origin (see `~/.piflow/contexts.json`).

## `piflowctl cloud up` — the one-click over this runbook

`piflowctl cloud up` automates steps 1–4 above. It has TWO modes (an agent runs PLAN; the operator runs
`--execute` when ready to spend):

```bash
# NOTE: bare `cloud up` now defaults to `--host railway`; this control-VM doc is the `--host fly` runbook,
# so its examples pin `--host fly`. (Every host shares the same image, mint, and smoke — only the CLI differs.)
piflowctl cloud up --host fly            # PLAN: mint the token, register a `cloud` context, PRINT the
                                         #       fly runbook (secrets redacted). Touches fly NEVER, spends $0.
piflowctl cloud up --host fly --provider mmgw   # …resolving your pi gateway from ~/.pi/agent/models.json (below)
piflowctl cloud up --host fly --execute  # RUN it: secrets set → deploy → smoke, then `context use cloud`
                                         #         on a green smoke. `--execute` IS the "spend money" opt-in.
piflowctl cloud down --host fly          # PLAN the teardown; `--execute` destroys the app + drops the context
```

Flags: `--app <name>` (default `piflow-control-plane`, stamped as `-a` on every fly command) · `--provider
<gw>` (a pi gateway in `~/.pi/agent/models.json`) · `--provider-secret <VAR>` (the single env key when there's
no gateway entry; default `NEBIUS_API_KEY`) · `--context <name>` (default `cloud`) · `--config`/`--dockerfile`.

**Credentials are projected the SAME way a node sandbox gets them** — `cloud up` reuses the exact
`parsePiProvider` decomposition the daytona/e2b node path uses (`packages/cli/src/run.ts`):

- the bearer token (`PIFLOW_TOKEN`) is freshly **minted** (never forwarded);
- with `--provider <gw>`, the gateway's `~/.pi/agent/models.json` entry (secret-free, `$VAR`-ref'd) is staged
  as the **non-secret** env `PIFLOW_PI_MODELS_JSON` (the image's CMD writes it to `~/.pi/agent/models.json` at
  boot — the Fly analog of the providers' `stageHomeFiles`), and its referenced `$VAR`(s) become the cred
  allowlist set as Fly **secrets**. Without `--provider`, the single `--provider-secret` key is used (the demo);
- the Claude subscription token resolves through the layered `resolveClaudeOAuthToken` (env → `~/.piflow/
  claude-code.json` → local login) and is set as a Fly **secret**. `ANTHROPIC_*` API keys are NEVER staged
  (a non-empty API key silently outranks the OAuth token in `claude -p` → per-token billing).

PLAN mode registers the `cloud` context row but does NOT switch to it (the endpoint isn't live yet); after a
green deploy+smoke, `piflowctl context use cloud`. The manual runbook above stays the source of truth + the
fallback for what the verb does.

## Files

- `Dockerfile` — multi-stage: build the workspace + GUI, then the control-plane + node-runtime image.
- `fly.toml` — the Fly app (http_service on 8080, force_https, one always-on machine). NON-secret env
  only; the secrets block lists what `fly secrets set` must supply.
- `smoke-live.mjs` — the live post-deploy smoke (checks A–E above).
- `.dockerignore` — prunes the build context (node_modules, dist, worktrees, env/secrets, runs).
- `e2e-template/` — the baked `greet` demo product (a §D9 product root the smoke launches).
