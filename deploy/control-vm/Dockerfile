# piflow cloud CONTROL-PLANE VM image (Fly.io).
#
# WHAT RUNS HERE — the DURABLE control plane, NOT a per-node sandbox. ONE long-lived process:
#   piflowctl serve --host 0.0.0.0 --port 8080 --token "$PIFLOW_TOKEN" --allow-templates "$PIFLOW_ALLOWED_TEMPLATES"
# It serves the built GUI (gui/dist) + the control API + the SSE run-stream on ONE public HTTPS
# origin (https://<app>.fly.dev, TLS terminated by Fly). Per-node agents (pi | claude-code) that a
# run spawns execute INSIDE THIS SAME VM under `--sandbox local` (the bwrap kernel jail) — NOT in
# nested cloud sandboxes. So this image must carry BOTH the control plane AND a full node runtime.
#
# WHY A BUILT WORKSPACE, NOT `npm i -g piflowctl` (the deviation from deploy/e2b's minimal image):
#   The control handlers (@piflow/server) resolve two MONOREPO-relative paths at request time via
#   findUp — `gui/scripts/lib/index-snapshot.mjs` (the LIVE fleet index the SSE stream + POST
#   /api/runs/start resolve runs through) and `packages/core/dist/observe/index.js` (the run-view
#   distiller). A bare npm-global install has NEITHER up-tree, so /__piflow/stream + run-view would
#   500. start-run also spawns the detached runner via findUp("packages/cli/dist/cli.js"). Hence the
#   VM runs a BUILT CHECKOUT (exactly what a laptop's `piflowctl serve` runs), with `piflowctl`
#   linked onto PATH. See deploy/control-vm/README.md for the full rationale.
#
# CONTENTS (each on a defensible layer):
#   - node + npm ......... from the base. pi + @piflow/* require node >=22 (engines).
#   - git + ca-certificates  git for a node's repo clone/init; ca-certs so pi's HTTPS gateway calls,
#                            `claude -p`'s API/OAuth calls, and any `npx <mcp-server>` fetch verify TLS.
#   - ripgrep ............ pi's built-in grep/find tools shell out to `rg`; without it they fail.
#   - bubblewrap ......... THE local jail backend on Linux (`--sandbox local`). Without `bwrap` the
#                          probe (`bwrap --ro-bind / / --proc /proc --dev /dev true`) fails and
#                          `--sandbox local` fails closed. Debian trixie (this base) supports the
#                          unprivileged user namespaces bwrap needs — Ubuntu 24.04 clamps them, so
#                          NEVER rebase onto ubuntu:24.04.
#   - pi ................. the agent runtime for `executor: pi` nodes. npm global, pinned, matching
#                          deploy/e2b + deploy/daytona (@earendil-works/pi-coding-agent@0.80.2).
#   - Claude Code CLI .... the `claude` bin for `executor: claude-code` nodes. Headless `claude -p`
#                          on Linux authenticates ONLY from CLAUDE_CODE_OAUTH_TOKEN (a fly secret) —
#                          no keychain on Linux. npm global (@anthropic-ai/claude-code).
#   - piflowctl + @piflow/server + gui/dist + the built workspace .. from the COPY + build below.
#
# BASE TAG: pinned node:22-trixie-slim (NOT latest/lts) — same base + Debian line as deploy/e2b and
# deploy/daytona, chosen for the userns support the bwrap jail depends on.

# ── STAGE 1: build the workspace (dev deps + toolchain live only here) ──────────────────────────
FROM node:22-trixie-slim AS build

# pnpm is the workspace package manager (see pnpm-workspace.yaml). Pin to the repo's packageManager.
ARG PNPM_VERSION=10.12.1
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate

WORKDIR /src
# Copy the whole workspace (the .dockerignore prunes node_modules, dist, .git, worktrees, other
# deploy dirs — so the context stays lean and the build is reproducible from source).
COPY . .

# Install + build every workspace package (packages/core, packages/cli, packages/server dist) and
# the GUI static bundle (gui/dist). `--frozen-lockfile` keeps the install reproducible.
RUN pnpm install --frozen-lockfile \
 && pnpm -r build \
 && pnpm --filter ./gui run build

# ── STAGE 2: the runtime image (control plane + node runtime, no build toolchain) ───────────────
FROM node:22-trixie-slim

ARG PI_VERSION=0.80.2
ARG CLAUDE_CODE_VERSION=latest

# OS deps + the two agent CLIs, one layer, apt cache never persisted. pi + claude are the node
# executors; git/ca-certs/ripgrep/bubblewrap are the node-runtime substrate (jail + tools + TLS).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates ripgrep bubblewrap \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}" \
 && npm install -g --ignore-scripts "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && pi --version \
 && claude --version \
 && bwrap --version

# Non-root runtime user (unprivileged, exactly how `pi`/`claude` run under the jail). The user home
# holds ~/.piflow (the global registry a run self-registers into) and ~/.pi (pi's runtime state).
RUN useradd -m -u 10001 piflow
WORKDIR /home/piflow/app

# The built workspace from stage 1 (dist + gui/dist + gui/scripts/lib + node_modules). We ship the
# whole tree because the handlers resolve gui/scripts/lib + packages/core/dist by findUp at runtime.
COPY --from=build --chown=piflow:piflow /src /home/piflow/app

# Link `piflowctl` onto PATH so `serve` and the detached `piflowctl run` it spawns both resolve.
RUN ln -sf /home/piflow/app/packages/cli/dist/cli.js /usr/local/bin/piflowctl \
 && chmod +x /home/piflow/app/packages/cli/dist/cli.js

# Bake the demo product (the smoke's target) into the runtime user's home as a real §D9 product root
# (`.piflow/greet/template/…`), so a run launched against it lands at `.piflow/greet/runs/<id>` and
# is discoverable by the LIVE index (SSE + run-view). The first run self-registers this root into
# ~/.piflow/products.json — no manual registration needed.
COPY --from=build --chown=piflow:piflow /src/deploy/control-vm/e2e-template /home/piflow/demo

USER piflow

# NON-secret config. The demo product root is the serve scope + the allow-listed template by default.
# Secrets (PIFLOW_TOKEN, the pi gateway key, CLAUDE_CODE_OAUTH_TOKEN) come from `fly secrets set` at
# deploy time — NEVER baked. PIFLOW_SCOPE_ROOTS scopes the GUI/index to the demo product.
ENV PIFLOW_HOST=0.0.0.0 \
    PIFLOW_PORT=8080 \
    PIFLOW_SCOPE_ROOTS=/home/piflow/demo \
    PIFLOW_ALLOWED_TEMPLATES=/home/piflow/demo/.piflow/greet/template \
    PIFLOW_STATIC=/home/piflow/app/gui/dist

EXPOSE 8080

# Launch the control plane. GUARD: never launch an UNAUTHENTICATED public server — fail fast if
# PIFLOW_TOKEN is unset (an empty --token disables the bearer gate, which on a public origin means
# an open control plane that can start runs). The scope root is also the cwd so resolveScope + the
# spawned runner's cwd both see the demo product.
WORKDIR /home/piflow/demo
CMD ["sh", "-c", "test -n \"$PIFLOW_TOKEN\" || { echo 'FATAL: PIFLOW_TOKEN is unset — refusing to start an unauthenticated public control plane. Set it with: fly secrets set PIFLOW_TOKEN=...' >&2; exit 1; }; exec piflowctl serve --host 0.0.0.0 --port 8080 --token \"$PIFLOW_TOKEN\" --static \"$PIFLOW_STATIC\" --roots \"$PIFLOW_SCOPE_ROOTS\" --allow-templates \"$PIFLOW_ALLOWED_TEMPLATES\""]
