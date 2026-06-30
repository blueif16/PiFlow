# CI/CD — decision record

How the `@piflow/*` monorepo is built, gated, and published, and **why** each piece is shaped the way it is.
This is the rationale; for the step-by-step publish runbook see [`RELEASING.md`](./RELEASING.md).

## Pipeline at a glance

Two GitHub Actions workflows, one per intent:

| Workflow | Trigger | Does |
|---|---|---|
| `ci.yml` | every PR + push | the gate ladder: lint, build, pack-verify, the test matrix (Node 22/24 × ubuntu/macos), and the CLI smoke test |
| `release.yml` | push to `main` | `changesets/action` — opens/updates a "Version Packages" PR, and on merge **publishes** changed packages via npm OIDC trusted publishing |

`ci.yml` proves the artifact is *correct*; `release.yml` is the only thing that *ships* it. Nothing publishes from a PR.

## What ships

**6 publishable** (public scope `@piflow`): `@piflow/core`, `@piflow/cli` (bin **`piflowctl`**), `@piflow/tool-bridge`, `@piflow/langgraph`, `@piflow/e2b`, `@piflow/daytona`.

**Private** (never published): root `piflow-monorepo`, `@piflow/tui`, `gui`.

The CLI bin is `piflowctl`, not `piflow` — the bare name collides with the unrelated `@arche-sh/piflow` (see [`research/arche-sh-piflow.md`](./research/arche-sh-piflow.md)).

## The gate ladder — what each gate *uniquely* catches

A gate earns its place only if it **fails when a real defect ships**. Each one below catches a class the gate above it cannot see:

- **`pnpm lint`** (Biome) — style/correctness lint; the cheapest, fastest reject.
- **`pnpm run build`** (`tsc -b`) — type errors and broken project-reference wiring across the workspace.
- **`pnpm pack-verify`** (per publishable package) — what `tsc` and the test runner never look at: the **published tarball**.
  - **publint** — broken `exports`/`files`/`bin` shebang that npm would publish *silently*.
  - **`@arethetypeswrong/cli` (attw)** — types resolving to `any`, or CJS/ESM masquerading that a green `tsc` never surfaces for a *consumer*.
  - **tarball-content assertion** — a missing `dist/` (or, once it lands, the GUI assets) in the actual packed tarball.
- **`pnpm test`** (vitest `default` project) — behavioral regressions, on no-credential code only (see Tests below).
- **`pnpm smoke:cli`** — packs + installs `@piflow/cli` *with its workspace deps*, then runs `piflowctl --version` / `--help`: catches a CLI that **installs but won't run**.
- **Test matrix incl. Windows** — shebang/path/`spawn` breakage specific to a cross-platform CLI that a single-OS run hides.

All gates are **required** to merge. None gate on coverage.

## Tests — two vitest projects

- **`default`** — the CI gate. Green with **no credentials**; runs everywhere, every PR.
- **`live`** — opt-in, gated behind `PIFLOW_LIVE` / `PIFLOW_E2E` + the relevant API keys. Never runs in the merge gate (no secrets in PR CI).

The split keeps the required gate fast, deterministic, and forkable, while real end-to-end coverage stays one env var away.

## Key choices & why

### pnpm (migrated from npm)
- Internal deps are `workspace:*` — always the local package, no version drift across the monorepo; Changesets rewrites them to real ranges at publish.
- `pnpm-workspace.yaml` spans `packages/*`, `tui`, `gui`.
- `autoInstallPeers: false` — adapter peers (`@langchain/*`, `e2b`, `@daytona/sdk`) stay **optional**; each adapter's own devDeps cover build/test, so the workspace never silently pulls them in.
- `onlyBuiltDependencies: [esbuild]` — only the one dep we trust runs install scripts; everything else is blocked by default.
- **zod pinned to `^3.25`** via `pnpm.overrides` — the MCP SDK's `zod-to-json-schema` path requires zod 3; the override stops a transitive zod 4 from breaking it.
- **`ajv` + `ajv-formats` added to `@piflow/core`** — `loadTemplate`'s mandatory draft-2020-12 validation gate; shipping `core` without them broke downstream consumers, so they're hard deps, not optional.

### Changesets
- The record of progress is **git**; a changeset is how a consumer-facing change *declares* it wants a release.
- `release.yml` runs `changesets/action`, which accumulates changesets into a "Version Packages" PR and publishes on merge — versions and internal ranges are owned by Changesets, never hand-edited.

### npm OIDC trusted publishing (no long-lived token)
- `release.yml` publishes via **OIDC** — GitHub mints a short-lived token per run; there is **no npm token stored** anywhere.
- Hardened with `environment: release` (scoped, optionally approval-gated) and **provenance on** (publicly attests the build came from this repo + workflow).
- Trust anchor: npm org `piflow` (owner `blueif23`) ↔ GitHub repo `blueif16/PiFlow`, workflow `release.yml`, environment `release`.

## One-time bootstrap (chicken-and-egg)

OIDC trusted publishing needs a package to already exist on npm to attach a Trusted Publisher to — and there's no pending-publisher configured. So the **first** publish is manual; every release after is CI/OIDC:

1. **`npm login`** as a member of the `piflow` org, then run a manual **`pnpm release`** locally to put the 6 packages on the registry.
2. On npmjs.com, configure a **Trusted Publisher** per package: org/user `blueif16`, repo `PiFlow`, workflow `release.yml`, environment `release` — and tick the post-May-2026 "npm publish" allowed action.
3. From then on, **all** releases run through CI via OIDC; never publish a long-lived token again.

Full step-by-step (and the MAINTAIN-vs-RELEASE rule): [`RELEASING.md`](./RELEASING.md).

## Deferred

- **GUI live-embed** into the CLI tarball is a separate feature, not yet shipped. The `pack-verify` tarball-content assertion is already built to enforce the GUI assets *the moment that lands* — no gate change needed when it does.
