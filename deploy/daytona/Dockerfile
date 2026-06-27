# piflow node runtime image for Daytona cloud VMs.
#
# WHAT RUNS HERE: one `pi` coding-agent process per workflow node. The host runner
# (@piflow/core, on the user's Mac) stages the per-node files into the VM at RUNTIME
# (prompt.md, the generated `pi -e` extension bundle, mcp.json, seeds) and then runs
# the `pi …` command built by command.ts `defaultPiCommand`. So this image bakes the
# RUNTIME, not the per-node files.
#
# CONTENTS RATIONALE (tier = MINIMAL+, see deploy/daytona/README is intentionally
# absent — rationale lives in the deploy script + the task report):
#   - node + npm .... from the base. pi requires node >=22.19.0 (engines).
#   - pi ............ the agent runtime, ABSENT from Daytona's default image. Installed
#                     as the npm global `@earendil-works/pi-coding-agent` (bin: `pi`).
#                     `--ignore-scripts` per pi.dev's own npm instructions (no install
#                     scripts needed) — also faster + avoids arbitrary postinstall.
#   - git + ca-certificates .. git for repo clone/init a node often needs; ca-certs so
#                     pi's HTTPS model calls + any `npx <mcp-server>` fetch verify TLS.
#   - ripgrep ....... pi's built-in `grep`/`find` tools shell out to `rg` (pi's own
#                     containerization Dockerfile installs it); WITHOUT it those tools
#                     fail in the VM. Cheap + load-bearing, so it's in the base tier.
# DELIBERATELY OMITTED (would be the ROBUST tier): build-essential, python, and
# pre-baked stdio MCP servers. The confirmed execution model pushes per-node tool
# wiring at runtime (the `-e` bundle is self-contained; its only externals are the
# pi-injected ones pi provides). MCP stdio servers, when a node needs them, are
# launched on demand (pi can `npx` them). Baking them bloats every VM for tools most
# nodes never use. Add them to a derived image only if a node's stdio server proves too
# slow to `npx` cold.
#
# BASE TAG: pinned (NOT `latest`/`lts`) — Daytona's builder rejects floating tags and
# requires linux/amd64. `node:22-trixie-slim` matches Daytona's own Debian 13 trixie
# base and keeps the engine at the pi-required >=22.19.0 line.
#
# USER: Daytona's runtime user is `daytona` (uid 1001, has sudo). We install as root,
# then leave WORKDIR at that user's home so the runner's per-run subtree
# (/home/daytona/pi/<run>/…, see daytona.ts openRun) lands where exec resolves it.

FROM node:22-trixie-slim

ARG PI_VERSION=0.80.2

# One RUN layer: install OS deps, then pi, then clean apt cache so it never persists.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates ripgrep \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}" \
 && pi --version

# Match Daytona's runtime user + home so the runner's in-VM paths resolve identically.
RUN id daytona >/dev/null 2>&1 || useradd -m -u 1001 daytona
WORKDIR /home/daytona
