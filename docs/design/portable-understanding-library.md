# Portable "library of understanding" — design + plan

_status: DESIGN · 2026-07-02 · supersedes the vague "build a `piflowctl understand init` verb" framing_
_source slices: `piflowctl understand understand` · skills `okf-slices`, `memory-slices` · memory `use-understanding-system-first`, `piflow-rollout-enablement`_

## Purpose
Make the OKF code-understanding system a **portable capability** we can point at *any* codebase
(our other projects — game-omni first — and eventually foreign repos), not just piflow. The prompt
that started this: _"why `piflowctl understand` though — does it mean it only works for repos with
piflowctl installed?"_ The answer is **no**, and this doc pins the architecture so it stays that way.

## The coupling insight (the thing that shapes everything below)
The understanding travels **with the repo as data + a vendored script + a skill**. `piflowctl` is a
*global* npm bin operating on `cwd` — it is never installed *into* a target repo. What lands in a
target repo is self-contained:

| Layer | Where it lives | Needs piflow? |
|---|---|---|
| **Cards** — `.agents/okf/topics/*.md` | markdown **in the repo** | No — an agent just reads them |
| **Gate + maintenance** — `_generate.mjs` (`--check` · `--write` · `--reconcile` · `--owns`) | one **vendored `.mjs`**, plain `node` (+ optional codegraph) | No — this is what the pre-commit hook runs |
| **Skill** — `okf-slices` / `memory-slices` | markdown in `.claude/skills/` | No — teaches the agent to FIND by reading cards |
| **Ranked forward-FIND** — `rankCards` (`packages/cli/src/understand.ts:80`) | the piflow CLI (TypeScript) | **Yes — this one part, today** |

Coupling is proportional to how much piflow machinery you use:
- **Understand a codebase (a human/agent reading it):** cards + skill. Works anywhere Claude Code
  runs. Zero piflow.
- **Understand *for the optimizer* (auto-inject a slice into a headless fixer):** needs the ranker
  → piflowctl. But that only matters if the repo is a piflow product being optimized.

The engine already owns the gate modes, and the CLI **already shells out to it**
(`defaultRunGate`, `understand.ts:178`). The *only* logic still stranded in TypeScript is the
ranker — consumed by the interactive reader (`understand.ts:248`) **and** the optimizer's in-process
`findSliceForDefect` (`packages/cli/src/optimize-fix.ts`, `OWNERSHIP_FLOOR = 45` at `:159`).

## Decision: vendor the ranker → one source of truth in the engine
Move the ~130-line ranker (`rankCards` + its card parsing, all pure, zero deps) **into `_generate.mjs`
as a `--find` mode**, and make both consumers source ranking from the engine — exactly the pattern
already used for `--check/--write/--reconcile/--owns`. Result:
- `.agents/okf/` **alone** gives any repo the complete loop — gate, reverse-lookup, **and** ranked
  FIND — on nothing but `node`. `piflowctl` becomes pure sugar.
- **One** ranker. No second copy to drift. Lines up with piflow's own SDK-boundary law: the engine is
  product-agnostic *logic* (may ship in an SDK/vendored script); the cards are per-repo *data* (live in
  the repo).

Rejected alternative: keep a TS mirror of the ranker "for the optimizer hot path." Two copies of a
scoring function that a whole suite trusts is exactly the drift the OKF system exists to prevent.

## What is actually portable — the GLOBAL skill (not a per-repo install, not the CLI)
Refinement (2026-07-02): the portable unit is **the skill installed once at the global level**
(`~/.claude/skills/okf-slices`, `~/.claude/skills/memory-slices`), NOT a per-repo copy and NOT
`piflowctl`. Today the skills are PROJECT-scoped (`piflow/.claude/skills/`, verified) and distributed by
copy via `skills install` — the wrong default for a solo operator working across many local products.

The three tiers, by owner:
- **GLOBAL skill = the portable brain.** One copy in `~/.claude/skills/`, present in EVERY Claude Code
  session in EVERY product automatically. Carries the METHOD (FIND / MAINTAIN) **and** the SETUP
  instructions (how to seed `.agents/okf/` into whatever repo you're in). CLI-optional by construction:
  _"run `piflowctl understand <q>` if present, else `node .agents/okf/topics/_generate.mjs --find <q>`."_
- **Per-repo `.agents/okf/` = data + the vendored engine (the scripts).** The cards + the one
  `_generate.mjs`. The only artifact that lives in the product repo.
- **`piflowctl` = an optional fast accessor to the scripts** (+ piflow's own pre-commit hook and the
  optimizer's in-process auto-inject — piflow-internal operations). After M1 every operation has a
  `node _generate.mjs …` form, so for "understand my other codebases" the CLI is pure convenience:
  *the command line is just a fast way to run the scripts.*

Caveat — keep BOTH distribution paths: a global skill is per-MACHINE and not in git (great for YOU
across your projects, but it does not travel to a collaborator who clones the repo). So
`skills install --with understand` stays as the OPT-IN for a repo you want self-describing to others
(teammate, CI, OSS clone). Global = the default for your multi-project work; per-repo install = the
opt-in for shareable repos.

Single source of truth for the engine: SETUP must copy a canonical `_generate.mjs` from somewhere. The
global skill CARRIES it as an asset (`~/.claude/skills/okf-slices/assets/_generate.mjs`), kept identical
to piflow's live `.agents/okf/topics/_generate.mjs` by the drift gate — the anti-drift system guarding
its own distribution copy (the check already exists).

## Target-repo contract (what a seeded repo can do, and with what)
After seeding, a repo contains only `.agents/okf/` (+ the installed skill). Then:
- `node .agents/okf/topics/_generate.mjs --find "how does X work"` → ranked owning card. **(node only)**
- `… --check [--staged]` · `--write` · `--reconcile` · `--owns <path>` → gate + maintenance. **(node only)**
- An agent with `okf-slices` installed → reads the cards directly, no binary at all.
- `piflowctl understand …` → the same, with nicer UX + the pre-commit hook wiring. **(optional)**
- The piflow optimizer auto-injecting slices → the only path that genuinely needs piflowctl.

## Milestones (test-first; each returns the moment it is committed + green)
Ordered by dependency. Each names its **falsifiable acceptance bar** and its **gate** (per
`test-discipline` §0). BUILT/OPEN reflects today.

### M1 — Vendor the ranker into the engine `--find` mode  · OPEN · the decided spine
- **What:** add `--find "<query>" [--json]` to `_generate.mjs`, reusing the engine's existing card
  parser; port the ownership + phrase-fallback scoring verbatim. Rewire the CLI reader
  (`runUnderstandCli`, `understand.ts:238`) and `findSliceForDefect` to shell to `--find --json`
  (returns `[{key, score}]`); the `OWNERSHIP_FLOOR ≥ 45` check now reads the engine's score; delete the
  TS `rankCards`.
- **Acceptance bar (behavior-preserving refactor):** the E6 golden eval (`.agents/okf/eval/`) produces
  **identical verdicts and scores** — phrase pass stays **3/5**, the recorded negative
  ("kubernetes reconcile overlord loop") stays failing, positive % unchanged. Iron Law: the golden is
  the oracle — if the port changes ranking, **fix the port, never the golden**.
- **Gate:** deterministic golden eval as characterization oracle + the §4 hand-mutation drill (flip a
  `+`→`-` in a score rung → the golden must go red). Consider isolating the test-writer (§2a) since the
  ranker is a rubric the optimizer trusts.
- **RED first:** a failing test that `node _generate.mjs --find --json "sandbox jail"` returns
  `sandbox` as rank-1 (the mode doesn't exist yet → errors, then fails for the right reason once stubbed).

### M2 — Promote the skills to GLOBAL + make them portable-complete  · OPEN · the portability primitive
- **What:** move `okf-slices` + `memory-slices` to `~/.claude/skills/` (the portable brain). Edit them
  (via `agentic-prompt-design`) for two things they lack: (i) a **CLI-optional contract** — prefer
  `piflowctl understand`, fall back to `node .agents/okf/topics/_generate.mjs --find`; (ii) a **SETUP
  mode** — an explicit procedure the agent follows to seed `.agents/okf/` into an unseeded repo. Carry
  the canonical `_generate.mjs` as `assets/_generate.mjs`.
- **Acceptance bar:** the skill triggers in a NON-piflow repo (no per-repo install); its instructions
  never assume `piflowctl` exists; the bundled `assets/_generate.mjs` is **byte-identical** to piflow's
  live engine (enforced — see M2-drift). Keep the piflow project copy too (dev repo).
- **M2-drift:** a check that `assets/_generate.mjs` == `.agents/okf/topics/_generate.mjs` (fail-on-diff),
  so the distribution copy can never rot. Wire it into the same pre-commit gate.
- **Gate:** eval — the skill, loaded globally, produces the right FIND/SETUP routing on a seeded and an
  unseeded fixture repo (deterministic checks first, per `test-discipline` evals row).

### M3 — Skill-driven SEED / upgrade of a repo  (piflowctl init = optional fast path)  · OPEN
- **What:** the primary path is the M2 skill's SETUP mode — the agent, in any product, seeds
  `.agents/okf/{topics/_generate.mjs, okf.config.json}` by copying the skill's bundled engine + writing a
  config. Two sub-paths: **fresh-seed** (no `.agents/okf/`) and **upgrade** (a *stale* one — swap the
  engine, preserve existing cards). Optionally add `piflowctl understand init` as the *fast* accessor for
  the same steps (not the mechanism). The gap is documented-as-unbuilt: `understand.ts:9-11`, `cli.ts:263`,
  `skills.ts:225-226`.
- **Acceptance bar:** on a temp repo with no substrate, SETUP then `--check` exits 0 (empty but valid); on
  a repo with a v0 engine, upgrade swaps the engine and **preserves** the cards (diff shows only engine +
  config changed); `okf.config.json` has correct `repoRoot`/`memoryDir`, not hand-copied.
- **Gate:** integration test on a throwaway temp dir (real fs, no mocks) — fresh-seed and upgrade both green.

### M4 — Starter-card bootstrap  · OPEN · the "unseeded repo" missing piece
- **What:** for a repo with no cards, emit a small set of **starter cards** from the codegraph's
  high-centrality modules (skeleton frontmatter + a `TODO: curate` body) so the agent curates rather than
  authors from a blank page. The only genuinely new *generation* work; `okf-slices` MAINTAIN already covers
  add/retire of individual cards.
- **Acceptance bar:** on game-omni, bootstrap proposes cards for the top-N centrality modules, each passing
  `--check` (anchors resolve) with an explicit `TODO: curate` body — never a hallucinated "how it works".
  Card-drafting prompt authored via `agentic-prompt-design`.
- **Gate:** LLM-eval (golden repo → expected covered modules) + `--check` must pass on every emitted card.

### M5 — codegraph auto-init wiring  · OPEN · degrade-gracefully already true
- **What:** SETUP runs `codegraph init` for the target if absent (the E4/E5 rungs + blast use it).
  Everything already degrades gracefully without codegraph (`OKF_NO_CODEGRAPH`), so this is convenience,
  not a hard dep.
- **Acceptance bar:** SETUP on a repo with no `.codegraph/` produces a working index; on one that has it,
  it's left alone.
- **Gate:** integration smoke.

### M6 — Prove end-to-end on game-omni, CLI-less  · OPEN · the real target
- **What:** game-omni already has a **stale** hand-built `.agents/okf/` (older engine, 3 cards, failing its
  own `--check` on a dangling `pi-runner/run.mjs` anchor). With ONLY the global skill (no per-repo install,
  no piflow bin on PATH), run the upgrade path, fix the anchor, `--write` to refresh, then `--find` real
  questions against it.
- **Acceptance bar:** game-omni `--check` exits 0 after upgrade; `node …/_generate.mjs --find "how does the
  generation pipeline work"` crowns the right card — the whole leg on `node` only, proving the standalone
  claim (piflow bin off PATH).
- **Gate:** live e2e transcript, host-verified, no piflow bin on PATH.

## Out of scope (explicit fence)
- **E8 stable-symbol anchors** — the SOTA lever, but its own multi-day project; not blocking portability.
  Tracked separately.
- **A Baton-style issue-polling autonomous runner** (from the GitHub-native brief) — a different arc.
- **Publishing a standalone non-piflow-branded `understand` package** — possible later; the vendored
  `_generate.mjs` already *is* the standalone artifact, so this is packaging, not capability.

## Linear binding
This doc is the **Source** for the "Understand as a portable library" Project. Issues:
M1 (ranker spine, `c` interface-before-consumer) and M2 (global skill, the portability primitive) are the
two roots; M2 blocks M3 → {M4, M5} → M6 (`a` artifact). M1 and M2 are independent and can run in parallel.
E8 + the piflow-side curation cleanup are *sibling* issues, not part of this arc.
