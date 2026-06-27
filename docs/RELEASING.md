# Releasing & maintaining the `@piflow/*` npm packages

The canonical runbook for **when** and **how** we publish. Read it before any publish — don't improvise one.

> **Default posture: you are MAINTAINING, not releasing.** Publishing is deliberate and infrequent.
> Published versions are **immutable** — npm won't let you reuse a version, and un-publishing is heavily
> restricted. When in doubt, do NOT publish: keep developing and accumulate changesets.

## What we publish

| Package | Published? | Global bin |
|---|---|---|
| `@piflow/core` | yes (public) | — |
| `@piflow/cli` | yes (public) | **`piflowctl`** |
| `@piflow/langgraph` | yes (public) | — |
| `@piflow/tool-bridge` | yes (public) | — |
| `@piflow/tui` | **no** (`private`) | `piflow-tui` (dev `npm link` only) |
| root `piflow-monorepo` | **no** (`private`) | — |

Scope `@piflow` is ours (npm org; owner `blueif23`). All four publishable packages carry
`publishConfig.access=public`. The CLI bin is `piflowctl`, **not** `piflow` (the bare name collides with the
unrelated `@arche-sh/piflow`; see `docs/research/arche-sh-piflow.md`).

## MAINTAIN vs RELEASE — the decision rule

**MAINTAIN (≈always):** writing code, fixing bugs, merging branches. The durable record of progress is
**git**, never an npm publish. For every change a consumer would notice, add a changeset (below). Do NOT publish.

**RELEASE (rare, deliberate):** publish only when **all** hold:
- a coherent, *finished* unit of work is on `main` (never mid-feature),
- it's something a consumer actually needs to `npm install`,
- the pre-release gate below is green.

Never publish to "save progress," to share with yourself, or from a feature branch — those are git / branch /
`npm pack` tarball jobs, not a registry release.

## The everyday loop (MAINTAIN)

After any consumer-facing change, while it's fresh:
```bash
npm run changeset     # pick affected packages + bump (patch/minor/major); one-sentence summary.
                      # commit the .md it writes ALONGSIDE the code change.
```
Changesets are cheap and accumulate; many batch into one release. No changeset ⇒ no release for that change.

## The release loop (RELEASE) — from `main`, clean tree

1. `git switch main && git pull` — release only from up-to-date `main`.
2. `npm run version-packages` — consumes pending changesets: bumps versions, **rewrites internal `^x.y.z`
   ranges**, updates CHANGELOGs. Review the diff, then commit (`chore(release): version packages`).
3. **Run the pre-release gate (next section). Stop on any red.**
4. `npm run release` — runs `build` then `changeset publish` (publishes in dependency order
   core → tool-bridge → cli/langgraph, `--access public`, creates git tags).
5. `git push --follow-tags`.
6. Verify: `npm view @piflow/core version` shows the new version; smoke-install in a scratch dir
   (`npm i @piflow/cli && piflowctl --help`).

2FA is `auth-and-writes`, so step 4 needs an **OTP** (interactive) **or** an npm **Automation token** in
`~/.npmrc` (`//registry.npmjs.org/:_authToken=npm_…`) for a headless/CI run.

## Pre-release gate (ALL must pass)

- [ ] On `main`, working tree clean, pulled.
- [ ] `npm run build` green (`tsc -b`).
- [ ] `npm test` green — or every failure is a **known, documented env-only** one (today: the `game-omni`
      fixture tests and `gated-live` tests that need a real model; these are not regressions).
- [ ] `npx changeset status` clean — no unconsumed changesets (i.e. step 2 ran + committed).
- [ ] `npm pack --dry-run -w packages/<each>` reviewed: `dist` present, no stray/secret files, sane size.
- [ ] CLI: bin is `piflowctl`; `piflowctl --help` matches reality; README/docs command surface in sync.
- [ ] Target versions are NOT already on the registry.
- [ ] OTP ready, or automation token in `~/.npmrc`.

## Versioning policy (we are pre-1.0)

- **patch** = fix / docs / internal. **minor** = new feature *or any breaking change* (breaking is allowed
  while `0.x` — call it out explicitly in the changeset).
- **Never hand-edit** `version` or internal dep ranges — Changesets keeps `@piflow/core`'s consumers in sync;
  hand-editing desyncs them.
- At API stability → cut `1.0.0` and switch to strict semver (breaking ⇒ major).

## Dogfood before it's real — canary / pre-release

To test a build (e.g. "fixtures rolling out", early integration feedback) without burning the stable version:
```bash
npx changeset pre enter next     # enter pre-release mode
npm run version-packages         # -> e.g. 0.2.0-next.0
npm run release                  # publishes under the `next` dist-tag:  npm i @piflow/core@next
npx changeset pre exit           # LEAVE pre mode before the real release
```
The stable `latest` tag is untouched until you exit pre mode and do a normal release.

## Anti-patterns (never)

- ❌ Publish from a feature branch or with a dirty tree.
- ❌ Publish to checkpoint progress (git does that).
- ❌ Hand-bump versions / edit `*` or internal ranges.
- ❌ Rely on un-publishing — **deprecate** instead (`npm deprecate @piflow/<pkg>@<ver> "message"`).
- ❌ Register the unscoped `piflow` package name (collision; see `docs/research/arche-sh-piflow.md`).
- ❌ Ship a stale `dist` — `prepublishOnly` rebuilds each package; never bypass it with `--ignore-scripts`.
