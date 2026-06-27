# Building the piflow node-runtime E2B template

The build VERB for E2B is the **`e2b` CLI's `template create`** (analogous to Daytona's snapshot
create in `deploy/daytona/`, but a CLI command, not an SDK call). It ships `e2b.Dockerfile` to E2B,
builds a Firecracker template SERVER-SIDE, and returns a **template ID** — the value you pass as
`E2B_TEMPLATE` to `piflowctl run --sandbox e2b` (or as `template` to `createE2bProvider`).

> NOTE — CLI VERB CHANGE (verified live 2026-06-27, `@e2b/cli@2.13.0`): the old `e2b template build`
> is now **deprecated** ("use `e2b template create` instead") and is a no-op stub. Use
> `e2b template create <name>`. The `-n/--name` flag is gone — the **template name is a positional
> arg**, lowercase + `[a-z0-9_-]` only. This doc was written against the old verb; the commands below
> are the ones that actually built the live template.

## Prerequisites

```bash
# The E2B CLI is NOT on PATH here — invoke via npx (no global install needed):
#   npx --yes @e2b/cli@latest <cmd>          (used below)
# or install it once:  npm i -g @e2b/cli
set -a; source ~/.zshenv; set +a   # E2B_API_KEY is stored here, beside DAYTONA_API_KEY
# `e2b auth login` is NOT needed when E2B_API_KEY is in the env (the CLI authenticates from it).
```

## Build (the EXACT command that worked — 2026-06-27)

From this directory (`deploy/e2b/`), the CLI auto-detects `e2b.Dockerfile` via `-d`:

```bash
cd deploy/e2b
set -a; source ~/.zshenv; set +a
npx --yes @e2b/cli@latest template create -d e2b.Dockerfile piflow-node-runtime
```

Live result (44s build, status `ready`):

```
Template created with ID: riwrtwrfanz3tewd5pw6  (name: piflow-node-runtime; team: rans-default-team)
Build ID: 77fa3564-805c-4991-90c8-8b1298f8241a
```

- `-d e2b.Dockerfile` — the template Dockerfile (MINIMAL+ tier: node22 + pi + git + ca-certs + ripgrep;
  tools are NOT baked — they are staged at runtime by the host runner, exactly like the Daytona image).
- `piflow-node-runtime` (positional) — a stable, memorable name; the build also prints the immutable
  template ID above. Pass EITHER the name OR the ID as `E2B_TEMPLATE`.
- The pi version is pinned via the Dockerfile `ARG PI_VERSION` (default 0.80.2). NOTE: `template create`
  has no `-n`; build-arg overrides go through the Dockerfile `ARG` or a `--build-arg`-style mechanism if
  the CLI version exposes one (2.13.0 did not — edit the Dockerfile `ARG PI_VERSION` to bump pi).
- `template create` did NOT write an `e2b.toml` (unlike the old SDK-init flow); the template is tracked
  server-side and listable with `npx --yes @e2b/cli@latest template list`.

The Dockerfile contents are byte-equivalent to `deploy/daytona/Dockerfile`'s MINIMAL+ tier — only the
base-image USER differs (E2B's default sandbox user is `user`, home `/home/user`; Daytona's is
`daytona`, home `/home/daytona`). The provider's `homeDir` default (`/home/user`, see
`packages/e2b/src/e2b-sdk.ts` `CreateE2bProviderOpts.homeDir`) matches this template's `WORKDIR`.

## Use the built template

```bash
export E2B_TEMPLATE=riwrtwrfanz3tewd5pw6    # the template ID (or the name `piflow-node-runtime`)
piflowctl run <templateDir> --sandbox e2b --provider <gw> --thinking low
```

## Smoke check (in a booted sandbox)

The egress thesis is the point of this backend — verify at the APPLICATION layer (a successful TCP
socket can be a false positive on a denied destination; see the egress research note). From inside a
booted sandbox confirm `pi --version`, `rg --version`, and an HTTP status (2xx/401, NOT a hang) against
a remote MCP gateway / LLM gateway. The full live procedure is portability-plan §7.
