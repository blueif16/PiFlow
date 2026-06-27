# Building the piflow node-runtime E2B template

The build VERB for E2B is the **`e2b` CLI's `template build`** (analogous to Daytona's snapshot
create in `deploy/daytona/`, but a CLI command, not an SDK call). It ships `e2b.Dockerfile` to E2B,
builds a Firecracker template SERVER-SIDE, and returns a **template ID** — the value you pass as
`E2B_TEMPLATE` to `piflowctl run --sandbox e2b` (or as `template` to `createE2bProvider`).

> NOTE: this is a documentation note, not a runnable build script — building a template spends cloud
> resources and is OUT of the implementation scope. Run it in the live-smoke session (portability
> plan §7) with `E2B_API_KEY` sourced from `~/.zshenv`.

## Prerequisites

```bash
npm i -g @e2b/cli            # the `e2b` CLI (separate from the `e2b` SDK npm package)
set -a; source ~/.zshenv; set +a   # E2B_API_KEY is stored here, beside DAYTONA_API_KEY
e2b auth login               # one-time, if not already authenticated
```

## Build

From this directory (`deploy/e2b/`), the CLI auto-detects `e2b.Dockerfile`:

```bash
e2b template build -d e2b.Dockerfile -n piflow-node-runtime
```

- `-d e2b.Dockerfile` — the template Dockerfile (MINIMAL+ tier: node22 + pi + git + ca-certs + ripgrep;
  tools are NOT baked — they are staged at runtime by the host runner, exactly like the Daytona image).
- `-n piflow-node-runtime` — a stable, memorable name; the build also prints the immutable template ID.
- The pi version is pinned via the Dockerfile `ARG PI_VERSION` (default 0.80.2); override at build time
  with `-c`/build args if a newer pi is required.

The Dockerfile contents are byte-equivalent to `deploy/daytona/Dockerfile`'s MINIMAL+ tier — only the
base-image USER differs (E2B's default sandbox user is `user`, home `/home/user`; Daytona's is
`daytona`, home `/home/daytona`). The provider's `homeDir` default (`/home/user`, see
`packages/e2b/src/e2b-sdk.ts` `CreateE2bProviderOpts.homeDir`) matches this template's `WORKDIR`.

## Use the built template

```bash
export E2B_TEMPLATE=piflow-node-runtime    # the name you built (or the template ID)
piflowctl run <templateDir> --sandbox e2b --provider <gw> --thinking low
```

## Smoke check (in a booted sandbox)

The egress thesis is the point of this backend — verify at the APPLICATION layer (a successful TCP
socket can be a false positive on a denied destination; see the egress research note). From inside a
booted sandbox confirm `pi --version`, `rg --version`, and an HTTP status (2xx/401, NOT a hang) against
a remote MCP gateway / LLM gateway. The full live procedure is portability-plan §7.
