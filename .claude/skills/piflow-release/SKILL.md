---
name: piflow-release
description: >-
  Pi Flow · RELEASE — publish the @piflow/* npm packages (the @piflow/core SDK, the `piflowctl` CLI, and the
  langgraph/e2b/daytona extension adapters) the disciplined way: Changesets OWNS the versions, CI publishes via
  npm OIDC Trusted Publishing, and every release passes one gate sweep. LOAD THIS SKILL BEFORE any publish or
  version action — it pins the canonical flow (pnpm + changesets/action + OIDC; NEVER a hand `npm publish` nor a
  hand-edited version) and the one-time first-publish bootstrap. Triggers — load on ANY of: "ship it", "cut /
  make a release", "publish (to npm)", "release piflow", "push a version", "bump and publish", "version
  packages", "do a release", or the words "changeset" / "npm publish" / "release the SDK/CLI" appearing at all.
  To CREATE a workflow use piflow-init; to RUN one use piflow-start; to IMPROVE one use piflow-enhance — this is
  for shipping the PACKAGES.
---

# Pi Flow · RELEASE — ship the @piflow/* packages

**You are the operator — you run every command; the user runs nothing** (at most: a click to merge the
"Version Packages" PR, or to approve the `release` environment). The full step-by-step + the pre-release
checklist live in **`docs/RELEASING.md`**; the WHY (pnpm · Changesets · OIDC · the gate ladder) lives in
**`docs/CI.md`**. Read them — this skill is the contract on top, not a duplicate.

## What ships
Six PUBLIC packages, all `@piflow/*`: `@piflow/core` (SDK), `@piflow/cli` (bin **`piflowctl`**),
`@piflow/tool-bridge`, `@piflow/langgraph`, `@piflow/e2b`, `@piflow/daytona`. PRIVATE (never published —
Changesets auto-skips them): the root `piflow-monorepo`, `@piflow/tui`, `gui`.

## The iron rules (MUST / MUST NOT)
- **Default to MAINTAIN, not RELEASE.** The record of progress is git, NOT an `npm publish`. Most "I changed
  something" turns end at a `pnpm changeset`, never a publish.
- **Changesets OWNS every version + internal range.** NEVER hand-edit a `version` field or a
  `workspace:*`/dependency range. NEVER run `npm publish` / `pnpm publish` directly — the bootstrap
  `pnpm release` is the ONE sanctioned publish command, and only for the first publish.
- **Publish ONLY from `main`, clean tree, gate-green.** NEVER from a feature branch or "to save progress."
  Published versions are IMMUTABLE.
- **CI publishes, not your laptop** (except the one-time bootstrap). Auth is **npm OIDC Trusted Publishing** —
  there is NO `NPM_TOKEN`; never add one.
- **The bin is `piflowctl`** — NEVER register the unscoped `piflow` name (it collides with `@arche-sh/piflow`).

## MAINTAIN — the everyday loop (this, not a release)
After any consumer-facing change: `pnpm changeset` → select the bumped packages + semver → commit the generated
`.changeset/*.md` ALONGSIDE the code. Changesets accumulate; they ARE the queued release. Do not publish.

## SHIP — cut a release (steady state, CI-driven)
1. **Pre-flight, LOCAL (fast feedback before CI).** On `main`, clean, pulled, run the gate sweep:
   ```bash
   pnpm install --frozen-lockfile && pnpm lint && pnpm run build && pnpm test && pnpm pack-verify && pnpm smoke:cli
   pnpm exec changeset status   # MUST list pending bumps — if empty, nothing to release: STOP (run MAINTAIN)
   ```
   Any gate RED → fix the root cause; NEVER bypass a gate to ship.
2. **Let CI publish.** Push `main`. The `release.yml` workflow's `changesets/action` opens/updates a **"Version
   Packages" PR** (the bumps + changelogs). Review it, then **merge it** → CI runs `pnpm release` and publishes
   the changed packages via OIDC with provenance; private packages are auto-skipped. Your job is review → merge →
   verify, NOT typing a publish command.
3. **VERIFY (after the publish job is green):** `npm view @piflow/core version` (and the others) match the
   Version PR; the npm package page shows the **Provenance** badge; a scratch-dir smoke:
   `cd "$(mktemp -d)" && npm i @piflow/cli && npx piflowctl --version`.

## BOOTSTRAP — the FIRST publish ONLY (packages not yet on npm)
npm has NO "pending publisher", so OIDC cannot be configured for a package that does not exist yet — the first
publish is MANUAL + LOCAL, exactly once:
1. `npm login` as a member of the `piflow` npm org (scope `@piflow`).
2. Run the SHIP pre-flight gate sweep (step 1) — all green.
3. `pnpm release` (= `pnpm run build && changeset publish`) — creates all 6 packages on npm. **The one
   sanctioned local publish.**
4. On npmjs.com, for EACH published package → *Settings → Trusted Publisher → GitHub Actions*, EXACT
   case-sensitive: org/user `blueif16`, repo `PiFlow`, workflow `release.yml`, environment `release`; tick the
   "npm publish" allowed action.
5. From then on, releases go through CI/OIDC (the SHIP loop) — never publish locally again.

## Failure paths (HALT — don't improvise)
- A gate is RED → fix the root cause; NEVER edit/skip a test or bypass `pack-verify`/`smoke:cli` to publish.
- A target version already exists on the registry → STOP (immutable; the bump was wrong — let Changesets
  recompute, don't force a new number by hand).
- Tree dirty or not on `main` → STOP.
- `changeset status` empty → nothing to release; do MAINTAIN.
- The `release` environment requires an approval → that's the deliberate human gate; approve only after a
  green, VERIFY-able pre-flight.

## Scope fence
- CREATE / PORT a workflow template → **piflow-init**. RUN / monitor a workflow on the fleet → **piflow-start**.
  IMPROVE a node or the chain → **piflow-enhance**. This skill is ONLY for publishing the npm packages.
- The granular runbook (full pre-release checklist, canary/prerelease via `changeset pre`, anti-patterns) lives
  in **`docs/RELEASING.md`**; the pipeline + gate rationale in **`docs/CI.md`**. Read them; do not duplicate.
