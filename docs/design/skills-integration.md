# Skills Integration — wiring a `node.skill` so pi actually loads it (reuse-first)

> **What this is.** The converged, reuse-first plan to make a piflow node's `node.skill` an Agent Skill
> that **pi loads at run time**, by REUSING the existing readScope/jail + seed-staging machinery rather than
> bolting on a parallel skills subsystem. Answers the owner's question directly: **is a skill a special case
> of readScope / the staging mechanism — and if so, exactly how?** Companion to
> `docs/design/capability-catalog.md` (§3 the `~/.piflow/skills/` install) and
> `docs/design/tool-calling-architecture.md` (§7 calls skills "the cheapest next lane").
>
> **Confidence:** `[GROUND]` = in-repo `file:line` (opened + confirmed) · `[PI]` = pi's docs via the
> in-repo research doc · `[EXA]` = external standard · `[SYNTH]` = this doc's recommendation ·
> `[UNVERIFIED]` = not confirmed, with the file/URL to check. Written 2026-06-26.

---

## 1. Format — what a skill IS

A **skill** is a directory: a `SKILL.md` with YAML frontmatter (`name`, `description`, optional
`license`/`allowed-tools`/…) over a freeform Markdown body, beside optional `scripts/`, `references/`,
`assets/` `[PI: pi docs/skills.md, via docs/research/pi-native-tools-and-marketplace.md §2; EXA:
agentskills.io/specification]`. It is the **Agent Skills standard** (agentskills.io) — the same `SKILL.md`
shape Claude Code / Codex use, and pi can even load those dirs `[PI: research §3]`. pi loads skills
**NATIVELY** from `~/.pi/agent/skills/`, `.pi/skills/`, `.agents/skills/` (cwd→repo root), package `skills/`
dirs, and `--skill <path>` (repeatable, **additive even with `--no-skills`**) `[PI: research §3:74-77]`. The
system prompt lists available skills; `/skill:name` forces a load. **The point for piflow: a skill is
"just files on the filesystem"** — pi is already the loader; piflow only has to put the folder where pi looks.

## 2. Current state — `node.skill` is CARRIED but UNWIRED (skills do not load today)

The field exists and threads end-to-end into the spec, but nothing emits it to pi:

- **Authored:** `node.json` `prompt.skill: string` `[GROUND: workflow/template/types.ts:19;
  schema/node.schema.ts:42]` — a `{{WORKSPACE}}`-rooted DEFERRED ref, deliberately NOT existence-checked at
  load (no workspace bound then) `[GROUND: workflow/template/checks.ts:239-243]`.
- **Carried into the spec — two seams:** `loader.ts:135` (`skill: n.def.prompt.skill`) sets
  `NodeSpec.skill` `[GROUND: workflow/template/loader.ts:135]`; the realized-prompt renderer also reads it
  (`render.ts:51` `skill: def.prompt.skill`) `[GROUND: workflow/template/render.ts:51]`. The field lives at
  `NodeSpec.skill?: string` `[GROUND: types.ts:29]` and is part of `NodeIntent` `[GROUND: types.ts:815]`;
  `mergePreset` even falls a node's skill back to a preset's first skill `[GROUND:
  workflow/agent-preset.ts:77,82]`.
- **DROPPED at the boundary — three independent dead-ends:**
  1. The command builder emits **no `--skill`**: `defaultPiCommand` emits only `--provider/--model/--tools/
     --exclude-tools/--thinking/-e/@prompt` and **never reads `node.skill`** `[GROUND:
     runner/command.ts:61-77]`. A repo-wide grep for `--skill` returns **zero hits** in `packages/`
     `[GROUND: grep '--skill' packages/ → empty]`.
  2. The runner **never stages the skill folder**: the staging block writes `prompt.md`, `tools.ts`
     (the `-e`), and `_pi/mcp.json` only — `node.skill` is untouched `[GROUND: runner/runner.ts:1093-1108]`.
  3. The contract codec **does not emit it**: `markersFromNode`/`emitMarkers` has no `skill` reference
     `[GROUND: grep 'skill' packages/core/src/contract.ts → empty]`, so the schema's claim that skill is
     "inlined into the realized prompt" `[GROUND: schema/node.schema.ts:42]` is **aspirational and false** —
     even the prompt-mention path is dead.

**Plain statement: `node.skill` is inert. No skill loads in any piflow node run today.** The field is a
fully-wired *carrier* with no *emitter*.

## 3. The reuse thesis + options

**Thesis.** pi already loads skills from a fixed set of dirs and from `--skill <path>`. So integration is
not "build skill loading" — it is "make a node's skill folder *present + jail-readable* and *named to pi*."
Both halves already exist as named seams: **presence** = the seed/stage machinery (`stageSeed`,
`stageHostPathIntoSandbox`); **jail-readability** = readScope → `computeScopeRoots`; **named-to-pi** = one
new `--skill` token in the command builder OR a pi-discoverable stage path. The only real question is which
combination, and whether the skill dir must join readScope.

| | **(A) `--skill <resolvedPath>`** (flag at the readScope-granted dir) | **(B) STAGE into `.pi/skills/<name>/`** (seed-machinery, no flag) | **(C) Hybrid — stage-into-`.pi/skills/` THEN `--skill` it** |
|---|---|---|---|
| **Mechanism** | Resolve `node.skill` (`{{WORKSPACE}}`/`~/.piflow/skills/<id>` ref) to an abs path; pass it to pi as `--skill <path>` from `defaultPiCommand`. No copy. | Copy the skill folder into the sandbox at `.pi/skills/<name>/` via `stageHostPathIntoSandbox` (the exact dir-walk seed-staging already does); pi auto-discovers `.pi/skills/` — no flag. | Stage into the sandbox `.pi/skills/<name>/` (so it's *inside* the jail, no host readScope grant needed) **and** point `--skill` at that in-sandbox path (load is explicit + survives `--no-skills`). |
| **REUSE** | High — one `if (skillPath) parts.push('--skill', q(skillPath))` in `command.ts:61-77`; reuses the `node.skill` path-resolution + `~/.piflow/skills/` install. No staging code. | High — reuses `stageHostPathIntoSandbox` (runner.ts:619, already walks a dir) verbatim; sibling of the `_pi/mcp.json` / `tools.ts` writes (runner.ts:1093-1108). No command change. | Highest — uses BOTH existing seams as-is (the stage seam + a one-line flag), each in its proven role. |
| **ROBUSTNESS** | Medium — load is explicit (`--skill` is additive even under `--no-skills` `[PI §3]`), but the path must be inside the jail or pi EPERMs reading it (see READSCOPE row). | Medium — relies on pi's **auto-discovery** of `.pi/skills/`; the runner already sets `--no-extensions`/`--no-context-files`, and `[UNVERIFIED: whether any pi flag suppresses `.pi/skills/` auto-discovery — check pi docs/skills.md; if `--no-skills`-like is ever added to the headless flag set, auto-discovery silently dies]`. | Highest — staged INSIDE the jail (always readable) AND named by `--skill` (explicit, survives any future `--no-skills`); the two mechanisms cover each other's failure mode. |
| **PI-NATIVE FIT** | High — `--skill <path>` is pi's documented per-run, repeatable, additive entry `[PI §3:74-77]`. | High — `.pi/skills/` is one of pi's native discovery dirs `[PI §3]`. | High — both are pi-native; nothing bespoke. |
| **READSCOPE / JAIL FIT** | **Requires the skill dir ∈ readScope.** If `node.skill` points at `{{WORKSPACE}}/...` or `~/.piflow/skills/<id>` (OUTSIDE the workdir), that path must be added to `node.sandbox.read` so `computeScopeRoots` grants it (scope.ts:71-97); else the seatbelt/bwrap jail denies the read and pi can't open `SKILL.md`. | **No host readScope grant needed** — the folder is COPIED *into* the sandbox workdir (`.pi/skills/`), which is auto-readable (workdir ∈ readRoots, scope.ts:88). The jail is satisfied by construction. | **No host grant needed** — same as (B): staged inside the workdir, so `--skill` points at an in-jail path. The cleanest jail story. |
| **CLOUD / Daytona FIT** | Weak — a host path (`~/.piflow/skills/...`) doesn't exist in a fresh VM; the flag would point at nothing. Needs the file shipped anyway → collapses toward (B)/(C). | **Strong** — staging copies bytes into the sandbox, identical to how `tools.ts`/`_pi/mcp.json` already ride into a VM (the "`-e` bundle ships into an empty VM" invariant, tool-calling-architecture §2:41). | **Strong** — same staged-bytes path as (B); the flag just names the in-VM location. Local + cloud identical. |
| **DATA-BOUNDARY FIT** | OK — the artifact lives in `~/.piflow/skills/<id>/` (CLAUDE.md-compliant, capability-catalog §3); the SDK only resolves a path. | OK — source is `~/.piflow/skills/<id>/` (or `{{WORKSPACE}}`), copied per-run; nothing skill-DATA enters `packages/`. | OK — same source-of-truth; SDK ships only the stage+flag logic. |

### Recommendation — **(C) Hybrid: STAGE the skill folder into the sandbox `.pi/skills/<name>/` via the seed-staging seam, THEN name it with `--skill <in-sandbox path>`** `[SYNTH]`

Reasons, in order:

1. **It is the maximal-reuse path: two existing seams, each in its proven role, zero new subsystem.**
   Staging reuses `stageHostPathIntoSandbox` (runner.ts:619) — which *already* recursively walks a directory
   and `sandbox.writeFile`s each file, the exact thing a skill folder needs — landing the skill beside the
   already-staged `tools.ts` and `_pi/mcp.json` (runner.ts:1093-1108). The flag reuses the one-line emit
   pattern already used for every other pi flag in `defaultPiCommand` (command.ts:61-77).
2. **It makes the jail a non-issue without weakening it.** Because the folder is copied *into* the sandbox
   workdir, it's covered by the workdir read-grant `computeScopeRoots` already adds (scope.ts:88) — so **no
   readScope expansion, no host-path grant, no escape-hatch.** Option (A) alone would force the skill's host
   dir into `node.sandbox.read`, enlarging the jail surface for every skill-bearing node.
3. **It is local≡cloud by construction.** Staged bytes ride into a Daytona VM exactly like the `-e` bundle
   and `_pi/mcp.json` already do (tool-calling-architecture §2:41); a bare `--skill ~/.piflow/...` (option A)
   points at a path that doesn't exist in a fresh VM.
4. **The flag hardens the load.** `--skill` is additive even with `--no-skills` `[PI §3:74-77]`, so the load
   doesn't depend on auto-discovery surviving the headless flag set (the (B)-only `[UNVERIFIED]` risk).

(A) alone is rejected for the jail-surface + cloud reasons; (B) alone is the acceptable fallback if adding a
flag is undesirable, but it leaves the load on auto-discovery. **(C) costs one extra `--skill` token over (B)
and buys robustness — take it.**

## 4. Wiring deltas (file:line) — REUSED seams vs NEW code

The recommended (C) is **one new resolver + two ~3-line emits**, riding entirely on existing seams.

| # | Change | NEW vs REUSE | Where |
|---|---|---|---|
| 1 | **Resolve `node.skill` → a `{to, from}` skill-stage** (a `Seed`-shaped struct: `from` = the abs source under `~/.piflow/skills/<id>/` or the `{{WORKSPACE}}`-resolved dir; `to` = `.pi/skills/<name>/`). Name = the skill's `name` (frontmatter) or the dir basename. | **NEW** — ~15 lines, a pure helper `resolveSkillStage(node, resolveCtx)`; ideally in `runner/` or a tiny `workflow/ops/skill.ts` sibling of `ops/seed.ts`. | new helper |
| 2 | **Resolve the `{{WORKSPACE}}`/`~/.piflow` token** in the source path | **REUSE** — `resolveTokens`/`resolveSeedTokens` (ops/seed.ts:42) for `{{WORKSPACE}}`/`{{RUN}}`; `globalDir()` (observe/registry.ts:33) for the `~/.piflow/skills/<id>` install root. | reuse |
| 3 | **Stage the folder into the sandbox** after the existing seed loop | **REUSE** — call `stageHostPathIntoSandbox(sandbox, <skill-source-root>, '.pi/skills/<name>')` (runner.ts:619), the same fn the seed PRE op uses (runner.ts:1042); it already dir-walks + `writeFile`s. (If the source isn't already under `ctx.outDir`, either stage it through the host run dir first like a seed, or generalize the helper's base arg.) | reuse | runner.ts ~1102 (beside the `tools.ts` stage) |
| 4 | **Pass the in-sandbox skill path to the builder** | **REUSE+tiny** — add `skillPath?: string` to `CommandContext` (command.ts:25-38) and thread it from the `buildCommand(...)` call (runner.ts:1136), exactly as `extensionFile` is threaded. | reuse seam, +1 field |
| 5 | **Emit `--skill <path>`** | **NEW** — one line in `defaultPiCommand`: `if (ctx.skillPath) parts.push('--skill', q(ctx.skillPath));` placed before the `@prompt` (command.ts:74-75), mirroring the `-e` emit. | NEW, ~1 line | command.ts:74 |
| 6 | **(If skill source lives outside the workdir) add it to readScope** — ONLY if a future variant keeps the skill on a host path instead of staging (option A). For (C) this is **NOT needed**. | n/a for (C) | — |
| 7 | **The `~/.piflow/skills/<id>/` install** (download + SHA-256 verify) | **REUSE the catalog client pattern** — capability-catalog §3/§4; the catalog client (`catalog/client.ts`, which already keys off `globalDir()`, client.ts:20/60) gains a skill-install path. Pre-existing local dirs / `{{WORKSPACE}}` skills work with NO install. | reuse (catalog client) | catalog/client.ts |

Net new surface: **one resolver helper + one `CommandContext.skillPath` field + one `--skill` emit line + one
`stageHostPathIntoSandbox` call.** Everything else is an existing function called in an existing place.

## 5. Robustness — a typed special-case, not a bolt-on

**Is a skill a special case of readScope?** *Partly — and more precisely a special case of the seed/stage
op, with readScope as the fallback knob.* A skill is a **forced, deterministic, pre-model staging of a
read-only artifact** — which is exactly what `stageSeed`/`stageHostPathIntoSandbox` already are (stage a
node's STARTING artifact before the model runs, idempotently, dir-aware). So a skill is best modeled as a
**typed seed whose destination is a pi-discovery dir** (`.pi/skills/<name>/`) and whose presence is then
*announced* with `--skill`. It composes with the three existing concepts cleanly:

- **The jail (readScope/`computeScopeRoots`):** because the skill is *staged into the workdir*, it inherits
  the workdir read-grant (scope.ts:88) — **skill dir ∈ readScope by construction**, no widening. The
  readScope path stays the *escape hatch* for the rare host-resident skill (option A), not the default.
- **Cloud (Daytona):** the staged bytes ride into the VM exactly like `tools.ts`/`_pi/mcp.json`
  (tool-calling-architecture §2:41) — the same "self-contained, ships into an empty VM" invariant, no host
  path assumed.
- **The existing `node.skill` field:** the carrier (types.ts:29 → loader.ts:135) is finally *consumed*; the
  inert `render.ts:51`/codec-mention path can stay (a human-legible hint) or be retired — it's orthogonal.
- **Presets:** `mergePreset`'s skill fallback (agent-preset.ts:77) already populates `node.skill`, so
  preset-driven nodes light up for free.

**Sharp edges (call them out):**
- **Skill NAME vs DIR basename.** `--skill <path>` takes a path, but pi's system prompt + `/skill:name` key
  off the frontmatter `name`. Stage under the *frontmatter name* (`.pi/skills/<name>/`), reading it from
  `SKILL.md`; fall back to the dir basename if absent. `[UNVERIFIED: whether pi requires the dir name to
  equal the frontmatter `name` — check pi docs/skills.md.]`
- **Trust / SHA-verify.** A skill is executable instructions (and may carry `scripts/`). The
  `~/.piflow/skills/<id>/` install MUST SHA-256-verify against the catalog `digest` before staging
  (capability-catalog §3, agent-skills `.well-known` ships a `sha256` `[EXA]`). A `{{WORKSPACE}}`/local-dir
  skill is operator-trusted (in-repo).
- **`--no-skills` interaction.** The headless flag set (command.ts:65) doesn't set `--no-skills` today; even
  if it ever did, `--skill` is additive past it `[PI §3:74-77]` — which is the core reason (C) names the flag
  rather than relying on (B)'s auto-discovery.
- **Idempotency / resume.** Reuse the seed idempotency (`stageSeed` skips an already-filled dest, seed.ts:108-123)
  so a resumed run doesn't re-copy; `stageHostPathIntoSandbox` is a plain overwrite, acceptable for a
  read-only skill.

## 6. Test plan — prove the skill LOADS and is READABLE inside the jail

Meaningful tests (each FAILS if the wiring is wrong — never coverage theater):

1. **Command emits `--skill` at the staged path (unit, command.ts).** Given a node with `skill` set, assert
   `defaultPiCommand(...)` output contains `--skill '.pi/skills/<name>'` (or the abs in-sandbox path), and
   that a node WITHOUT a skill emits NO `--skill`. *Fails today* (no `--skill` exists) → proves wiring delta
   #5. Mirrors the existing command tests' shape.
2. **Runner stages the folder into the sandbox (integration, offline, fake `buildCommand`).** Reuse the
   offline runner harness (the test command builder that writes the declared artifact — command.ts:5-8 docs
   it): run a node whose `skill` points at a temp `SKILL.md` dir; after the run, assert the sandbox contains
   `.pi/skills/<name>/SKILL.md` **and** a `scripts/`/`references/` child (proves the *recursive* dir-walk via
   `stageHostPathIntoSandbox`, not just the top file). *Fails today* (skill never staged).
3. **Jail-readability (the load-bearing one).** Under `--sandbox local` (seatbelt on macOS / bwrap on Linux),
   assert the staged `.pi/skills/<name>/SKILL.md` path is within `computeScopeRoots({workdir,...}).readRoots`
   (the folder is under the workdir, so it must be) — i.e. a jailed read of `SKILL.md` would be GRANTED. The
   negative control: a skill on a host path OUTSIDE the workdir and NOT in `node.sandbox.read` is NOT in
   `readRoots` (proving why (C)'s stage-into-workdir is what makes it readable). This asserts the actual jail
   policy, not a mock.
4. **`name` resolution (unit).** A `SKILL.md` with frontmatter `name: foo` in a dir named `bar/` stages to
   `.pi/skills/foo/` (frontmatter wins); a dir with no frontmatter `name` stages to the basename. Fails if the
   resolver ignores frontmatter.
5. **[Owed, live] E2E load proof.** One live pi node with a trivial skill (e.g. a `name`/`description` that
   instructs a sentinel output) → assert the model's output reflects the skill, confirming pi *loaded* it
   (not just that the file is present). Gated on a live pi run, like the other owed E2E checks
   (tool-calling-architecture §7).

## 7. Bar audit

| # | Item | PASS/FAIL | Evidence |
|---|---|---|---|
| 1 | Format — SKILL.md / agentskills.io, cited, ~6 lines | **PASS** | §1, cited `[PI: research §2/§3]` + `[EXA: agentskills.io/specification]`; discovery dirs + `--skill` additive `[PI §3:74-77]`. |
| 2 | Current state — carried-but-unwired with the exact file:line chain; plainly states skills don't load | **PASS** | §2: types.ts:29 → loader.ts:135 / render.ts:51 → command.ts:61-77 has no `--skill` (grep empty), runner.ts:1093-1108 doesn't stage, codec has no skill. "node.skill is inert." |
| 3 | Reuse thesis + 2-3 options table (REUSE/ROBUSTNESS/PI-NATIVE/READSCOPE/CLOUD/DATA), each says if skill∈readScope, decisive recommendation | **PASS** | §3: (A)/(B)/(C) table across all six axes + per-option readScope answer; decisive **(C)** with 4 ordered reasons; (A)/(B) explicitly rejected/fallback. |
| 4 | Wiring deltas file:line, NEW vs REUSE, names real fns (stageSeed/stageHostPathIntoSandbox/computeScopeRoots/command builder/node.skill resolution/catalog client), minimal | **PASS** | §4 table: NEW = resolver + `--skill` line + `CommandContext.skillPath`; REUSE = `stageHostPathIntoSandbox` (619), `resolveSeedTokens` (seed.ts:42), `globalDir` (registry.ts:33), command builder (command.ts:61-77), catalog client (client.ts:20/60). |
| 5 | "Special case not bolt-on" — typed special-case, composes with jail/cloud/`node.skill`; sharp edges | **PASS** | §5: skill = a typed seed→pi-discovery-dir; jail by construction (workdir grant, scope.ts:88), cloud = staged bytes (§2:41), `node.skill` consumed; edges = name-vs-dir, SHA-verify, `--no-skills`, idempotency. |
| 6 | Test plan — proves load AND jail-readability; what asserts it (not coverage) | **PASS** | §6: 5 tests — `--skill` emit, recursive stage, `readRoots` membership + negative control (the jail proof), name resolution, owed live E2E. Each fails if wiring wrong. |
| 7 | Bar-audit table | **PASS** | this table. |

---

## Sources
- **pi skill format + loading:** `docs/research/pi-native-tools-and-marketplace.md` §2/§3 (pi docs/skills.md).
- **agentskills.io standard / `.well-known` `sha256`:** `[EXA: agentskills.io/specification; cloudflare/agent-skills-discovery-rfc]` (via capability-catalog §2).
- **Catalog-side skill install (`~/.piflow/skills/`, SHA-256-verify):** `docs/design/capability-catalog.md` §3/§4.
- **Lane priority:** `docs/design/tool-calling-architecture.md` §7 (skills = the cheapest next lane).
- **In-repo seams (opened + confirmed):** `types.ts:29`, `workflow/template/{types.ts:19, loader.ts:135, render.ts:51, checks.ts:239, schema/node.schema.ts:42}`, `workflow/agent-preset.ts:77`, `runner/command.ts:61-77`, `runner/runner.ts:{619, 959, 1012, 1042, 1093-1108, 1136}`, `sandbox/scope.ts:71-97`, `workflow/ops/seed.ts:{42,93,108}`, `observe/registry.ts:33`, `catalog/client.ts:{20,60}`.
