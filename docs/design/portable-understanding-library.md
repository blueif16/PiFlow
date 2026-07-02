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

### M2 — Seed / init verb: `understand init [<repo>]`  · OPEN · the one documented gap
- **What:** scaffold `.agents/okf/{topics/_generate.mjs, okf.config.json}` into a target repo. Two
  paths: **fresh-seed** (repo has no `.agents/okf/`) and **upgrade** (repo has a *stale* one — copy the
  latest engine, preserve existing cards). Install the skill via the existing
  `skills install --with understand,memory-slices` (`packages/cli/src/skills.ts:144`).
- **Why it's the gap:** documented-as-unbuilt in three places — `understand.ts:9-11`, `cli.ts:263`,
  `skills.ts:225-226`. Nothing scaffolds `.agents/okf/` today.
- **Acceptance bar:** on a temp repo with no substrate, `init` then `--check` exits 0 (empty but valid);
  on a repo with a v0 engine, `init` swaps in the latest and **preserves** the existing cards (diff shows
  only the engine + config changed). `okf.config.json` is generated with correct `repoRoot`/`memoryDir`,
  not hand-copied.
- **Gate:** integration test on a throwaway temp dir (real fs, no mocks) — fresh-seed and upgrade both green.

### M3 — Starter-card bootstrap  · OPEN · the "unseeded repo" missing piece
- **What:** for a repo with no cards, emit a small set of **starter cards** from the codegraph's
  high-centrality modules (skeleton frontmatter + a TODO curated body), so the human/agent curates rather
  than authors from a blank page. This is the only genuinely new *generation* work; the `okf-slices`
  MAINTAIN procedure already covers add/retire of individual cards.
- **Acceptance bar:** on game-omni, bootstrap proposes cards for the top-N centrality modules, each
  passing `--check` (anchors resolve) with an explicit `TODO: curate` body — never a hallucinated
  "how it works". Prompt authored via `agentic-prompt-design` (it drives an LLM to draft card prose).
- **Gate:** LLM-eval (golden repo → expected covered modules) + `--check` must pass on every emitted card.

### M4 — codegraph auto-init wiring  · OPEN · degrade-gracefully already true
- **What:** `init` runs `codegraph init` for the target if absent (the E4/E5 rungs + blast use it).
  Everything already degrades gracefully without codegraph (`OKF_NO_CODEGRAPH`), so this is convenience,
  not a hard dep.
- **Acceptance bar:** `init` on a repo with no `.codegraph/` produces a working index; on one that has it,
  it's left alone.
- **Gate:** integration smoke.

### M5 — Prove end-to-end on game-omni  · OPEN · the real target
- **What:** game-omni already has a **stale** hand-built `.agents/okf/` (older engine, 3 cards, failing
  its own `--check` on a dangling `pi-runner/run.mjs` anchor). Run the upgrade path, fix the anchor,
  `--write` to refresh, then `--find` real questions against it.
- **Acceptance bar:** game-omni `--check` exits 0 after upgrade; `--find "how does the generation
  pipeline work"` crowns the right card; the whole thing runs with `node` only (prove the standalone
  claim by unsetting piflow from PATH for the FIND).
- **Gate:** live e2e transcript, host-verified, no piflow bin on PATH for the standalone leg.

## Out of scope (explicit fence)
- **E8 stable-symbol anchors** — the SOTA lever, but its own multi-day project; not blocking portability.
  Tracked separately.
- **A Baton-style issue-polling autonomous runner** (from the GitHub-native brief) — a different arc.
- **Publishing a standalone non-piflow-branded `understand` package** — possible later; the vendored
  `_generate.mjs` already *is* the standalone artifact, so this is packaging, not capability.

## Linear binding
This doc is the **Source** for the "Understand as a portable library" Project. Issues:
M1 (spine) blocks M2 → M3 → M4 → M5 (edge-basis: `c` interface-before-consumer for M1; `a` artifact for
M2→M5). E8 + the piflow-side curation cleanup are *sibling* issues, not part of this arc.
