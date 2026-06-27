# piflow node runtime template for E2B cloud sandboxes.
#
# WHAT RUNS HERE: one `pi` coding-agent process per workflow node. The host runner
# (@piflow/core, on the user's Mac) stages the per-node files into the sandbox at
# RUNTIME (prompt.md, the generated `pi -e` extension bundle, mcp.json, seeds) and then
# runs the `pi …` command built by command.ts `defaultPiCommand`. So this template bakes
# the RUNTIME, not the per-node files. Contents are byte-equivalent to
# deploy/daytona/Dockerfile's MINIMAL+ tier — only the base image + runtime user differ.
#
# CONTENTS RATIONALE (tier = MINIMAL+):
#   - node + npm .... from the base. pi requires node >=22.19.0 (engines).
#   - pi ............ the agent runtime, ABSENT from E2B's default `base` template. Installed
#                     as the npm global `@earendil-works/pi-coding-agent` (bin: `pi`).
#                     `--ignore-scripts` per pi.dev's own npm instructions (no install
#                     scripts needed) — also faster + avoids arbitrary postinstall.
#   - git + ca-certificates .. git for repo clone/init a node often needs; ca-certs so
#                     pi's HTTPS model calls + any `npx <mcp-server>` fetch verify TLS.
#                     (E2B's open egress means a remote/HTTP MCP server is REACHABLE from
#                     here — the whole reason for the E2B backend.)
#   - ripgrep ....... pi's built-in `grep`/`find` tools shell out to `rg`; WITHOUT it those
#                     tools fail in the sandbox. Cheap + load-bearing, so it's in the base tier.
# DELIBERATELY OMITTED (would be the ROBUST tier): build-essential, python, and pre-baked
# stdio MCP servers. The execution model pushes per-node tool wiring at runtime (the `-e`
# bundle is self-contained; its only externals are the pi-injected ones pi provides). MCP
# stdio servers, when a node needs one, are launched on demand (pi can `npx` them). Baking
# them bloats every sandbox for tools most nodes never use.
#
# BASE TAG: pinned (NOT `latest`/`lts`). `node:22-trixie-slim` keeps the engine at the
# pi-required >=22.19.0 line (same base as the Daytona image, for parity).
#
# USER: E2B's default sandbox user is `user` (home /home/user). We install as root (the
# template build runs as root), and the runner's per-run subtree (/home/user/pi/<run>/…,
# see src/e2b.ts openRun, which defaults homeDir to /home/user) lands where exec resolves it.
#
# BUILD: `e2b template build` (see deploy/e2b/build.md) is the build verb — it ships THIS
# Dockerfile to E2B, builds a Firecracker template SERVER-SIDE, and returns a template ID.
# Pass that ID as E2B_TEMPLATE to `piflowctl run --sandbox e2b` (or to createE2bProvider).

FROM node:22-trixie-slim

ARG PI_VERSION=0.80.2

# One RUN layer: install OS deps, then pi, then clean apt cache so it never persists.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates ripgrep \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}" \
 && pi --version

# Leave WORKDIR at E2B's default user home so the runner's in-VM paths resolve identically.
WORKDIR /home/user
