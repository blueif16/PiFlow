---
name: okf-slices
description: >-
  OKF code-understanding slices — FIND the right slice before changing code, and MAINTAIN the slice set so it
  never goes stale. TRIGGER on either intent: (FIND) an agent — ESPECIALLY an optimizer/fixer node about to edit
  a subsystem — needs to know how a code vertical works or WHERE to change it ("how does <subsystem> work",
  "where do I change X", "which files own Y", before touching runner/sandbox/observe/optimize/etc.); or (MAINTAIN)
  someone asks when/how to update the slices, what a slice's blast scope is, whether a slice is stale, or runs the
  drift gate; or (SETUP) a repo has NO `.agents/okf/` yet (FIND errors "not set up") or a stale/older engine and
  needs the substrate seeded or upgraded. Works on ANY repo — SETUP (MODE S) seeds `.agents/okf/` into one that
  lacks it, from the engine this skill carries under `assets/`, so it needs nothing but `node`. Slices are
  OPTIMIZER-FACING reference, NEVER injected into a worker node's runtime prompt — this skill is how the
  out-of-band fixer reads them on demand.
---

# OKF slices — find the right one, keep them honest

A **slice** is a per-vertical *lifecycle* card: it traces one functionality along its spine (where it's DECLARED →
its TERMINAL effect) and points an agent at the exact files/lines that implement it, plus the invariants and known
drift. It is pointers + understanding, never a copy of the code. The cards live in `.agents/okf/topics/*.md`; the
design/rationale is `docs/research/memory/code-understanding-and-anti-drift.md` (§2 discovery · §4+§4.1 anti-drift &
blast ladder · §5 backlog) — cite it, don't restate it. This skill is the OPERATIONAL procedure for the two things
you actually do with slices.

**Why this exists:** a fixer that greps the whole repo to understand a subsystem wastes context and gets stale
facts; a slice gives it the validated map. But a slice is only useful if (a) you can FIND the right one and (b) it
is FRESH. This skill is both halves.

## Invocation — the CLI is optional (the skill just runs the scripts)
Every command below has TWO equivalent forms; use whichever the repo has, and prefer the first when present:
- **With `piflowctl`** (a piflow product, or the bin on PATH): `piflowctl understand <query> | --check | --rebuild | --reconcile | --owns <path>`.
- **Standalone** (ANY repo with `.agents/okf/`, `node` only): `node .agents/okf/topics/_generate.mjs --find <query> | --check | --write | --reconcile | --owns <path>` (add `--json` to `--find` for a machine list).

The engine (`_generate.mjs` + the pure `_rank.mjs` it imports) is vendored IN the repo, so the understanding
travels with the repo as **data + a script**; `piflowctl` is a fast accessor, NEVER a dependency. This skill
itself carries the engine under `assets/` so it can seed a fresh repo (MODE S). The rest of this doc writes the
`piflowctl` form for brevity — the standalone `node …/_generate.mjs …` form is always equivalent.

---

## MODE A — FIND the slice for a task (the reader)

Use when you are about to change, debug, or explain a code area and want the validated map instead of re-deriving
it from the repo. **Procedure (stop at the first step that resolves):**

1. **Normalize the query** to concrete keys: the target FILE path(s), SYMBOL name(s), and/or CONCEPT keywords.
2. **Run the ranker — it returns the owning card.** `piflowctl understand "<query>"` (or standalone
   `node .agents/okf/topics/_generate.mjs --find "<query>"`; add `--json` for a ranked machine list). It scores
   every card by WHERE the query lands — **ownership beats mention**: a card whose frontmatter declares the query
   (`resource:` = its canonical file is the strongest of all, then `seeds:`/`symbols:`/`aliases:`/`key`/`tags`)
   far outranks one that merely name-drops it in prose (a bare prose mention can NEVER crown a card — the law is
   structural). A natural-language question is handled by a tokenized fallback gated by that same ownership law.
   It prints the top card's *"Why / how it works"* + `owns:` + related slices, or `UNCOVERED` when no card owns
   the query. This is the ONE ranker (`_rank.mjs`) — the SAME scoring the optimizer's fixer wire uses, so you are
   reading exactly what the fixer reads. (Grep the cards directly only to debug a ranking you doubt.)
3. **If no card matches** (the file/symbol is uncovered): escalate to codegraph with ONE
   `codegraph explore "<symbol | how-does-X question>"` call — it returns the owning symbols' verbatim
   line-numbered source grouped by file + the call paths (incl. dynamic-dispatch hops grep can't follow) + a
   blast-radius summary in a single round-trip, so it IS the Read and usually the only call you need. Do NOT
   grep+Read the repo or hand the lookup to a file-reading sub-agent — that repeats work the index already did and
   makes codegraph pure overhead; query it DIRECTLY. Use `codegraph query <symbol> --json` only for a bare file:line
   locate. Map the owning module → the card whose `seeds:` live there. If STILL none, the vertical is **UNCOVERED**:
   say so plainly (a gap to author a card via MAINTAIN) and answer from the `explore` source. NEVER invent a slice.
4. **Read the matched card**: the *"Why / how it works"* paragraph = the mental model; the **Anchors** (grouped by
   stage) = the exact `path:line` to edit; the **Freshness / DRIFT NOTE** = known gaps and branch caveats. In the
   machine-derived (auto) region below the marker, the **Lessons** `[[wikilinks]]` are the LOWEST-confidence signal
   in the card — *Alias matches* are a machine guess (the region itself says "may include false positives"): treat
   them as leads to VERIFY, never as authoritative, and prefer curated prose links and the card's Anchors over them.
5. **VALIDATE before you trust it** (just-in-time; a stale slice is worse than none): run the gate for that one card —
   `cd .agents/okf/topics && node _generate.mjs --check <key>`. (The gate resolves anchors against the codegraph
   index and SELF-SYNCS a stale one — `status --json` → `sync -q` when changes are pending — so no manual sync step
   precedes it; `OKF_NO_SYNC=1` opts out. A stale index once hid 17 real anchor drifts here.) Read
   WHICH signal it returns — they mean DIFFERENT things, and only one affects whether you can trust the anchors:
   - `HEALTH: anchor …` / `seed missing` → an anchor's symbol/line moved or a file is gone — the anchors you'd return
     may be WRONG. First rule out **branch skew**: a HEALTH failure on a branch that is BEHIND the one the slice was
     validated on is usually a FALSE drift — the symbol just isn't on your branch yet (`git log <branch>..main -- <path>`
     to confirm), and the fix is to merge/rebase, NOT to edit the anchor. If it is real drift, reconcile against the
     live file (or re-author per MAINTAIN) before relying on the anchors; flag it.
   - `DRIFT: auto region is stale — run --write` → ONLY the machine-derived region (git arc / lessons cluster / blast
     section) is out of date — e.g. a new memory was added. The CURATED anchors are still VALID; you may trust them.
     `--write` to refresh is a MAINTAIN chore, it does NOT block FIND.
   - `ok` → fresh.
6. **Apply**: navigate by the anchors, respect the stated INVARIANT, and check the DRIFT NOTE for traps.

**Freshness ≠ sufficiency.** `--check` only certifies the anchors aren't *stale* — it says NOTHING about whether they
*cover your task*. A card can be `ok` yet insufficient: it maps the subsystem but not the specific function/edge your
change touches. So after the freshness verdict, make a SEPARATE judgment — do the returned anchors actually reach the
FILE/SYMBOL and the GRANULARITY the task needs? If fresh-but-thin, treat the card as PARTIAL: use what's anchored,
escalate to `codegraph explore` for the uncovered part, and flag the gap for MAINTAIN. A green `--check` is never a
stand-in for "this answers the question."

**FIND output shape** (what you return to whoever asked): the slice key(s); the *specific* anchors relevant to THIS
task (not the whole card); the INVARIANT you must not break; and a freshness verdict — `fresh` / `stale-flagged` /
`uncovered`. If `uncovered`, name the gap.

**FIND bar (must hold):** you cited a REAL card (or honestly reported `uncovered`); you returned the anchors that
matter for the task, not a card dump; the slice's GRANULARITY matched the task's scope (you did NOT answer a
function-level question with only a subsystem-level card, nor bury a subsystem question in one function's anchors) —
if it didn't, you escalated/flagged the gap instead of over-trusting the slice; you ran `--check` on the chosen card
and reported its verdict; you did NOT present a stale or invented slice as authoritative.

---

## MODE B — MAINTAIN the slice set

Use when adding/updating slices, after a merge, before a commit that touches anchored code, or when asked "is this
stale / what's the blast scope." **Three cadences (the first is WIRED — `.githooks/pre-commit` runs
`--check --staged` on every commit, scoped to cards whose seeds/anchors intersect the staged files, and CI's
`okf-gate` job runs the full `OKF_NO_CODEGRAPH=1` pass, where only HEALTH is reported — DRIFT isn't computable
without the index):**

- **Pre-commit (blocking) — the gate.** `cd .agents/okf/topics && node _generate.mjs --check`. It emits TWO signal
  kinds and BLOCKS (exit 1) on only ONE: `HEALTH:` = a seed/anchor file or symbol/line moved → the anchors may be
  WRONG, a REAL fix (reconcile the anchor) — THIS is what fails the commit; `DRIFT: auto region is stale` = only the
  machine-derived region is out of date → ADVISORY (exit 0), refresh with `node _generate.mjs --write` at your leisure.
  (DRIFT fires whenever the code or a derived substrate changed — a new commit or memory note — so expect it routinely;
  HEALTH should be rare and is the one that matters.) The anchor check resolves definition anchors as cited line ∈ the
  symbol's codegraph span, call-site/field anchors as symbol-present-in-file. The gate is INCREMENTAL — it skips any
  card whose inputs are byte-identical to its last clean derive (a gitignored `.gen-cache.json` fingerprint; skipped
  cards print `ok (cached)`), so repeat runs are cheap; `OKF_NO_CACHE=1` forces a full re-derive. Run `--write` then
  re-`--check` to refresh drifted regions before committing.
- **Post-merge (advisory) — `piflowctl understand --reconcile`.** WHEN: after every merge/pull to main, and BEFORE
  an optimize pass (the fixer must read judged-fresh cards). The engine emits deterministic TRIGGERS; your job is
  to JUDGE them — the machine never judges prose:
  - `SEMANTIC? [card] \`sym\` body changed` (E4 span-hash) → re-read the card's prose against the new behavior;
    re-author the sentence(s) that now lie. This is the rung that catches anchor-green-but-prose-stale rot.
  - `IMPACT? [card] change to \`sym\` reaches its dep <file>` (E5, graph-only) → a change OUTSIDE the card's deps
    reached them through the blast radius; verify the card's claims about that path.
  - `UNCOVERED-HOT: <file> (n commits, no card)` (coverage) → a hot product file no card owns; add it as a SEED to
    the nearest true card, or author a card if it's a new vertical. Instrument paths are excluded BY RULE (shared
    tooling is skill-documented, never card material).
  Then `--write` the affected keys (it AUTO-REPAIRS same-file line drift — span-verified re-stamps of the
  `path:line` token only) and re-author the CURATED half where a trigger proved it stale. **The machine may
  re-stamp an anchor's line number; it NEVER touches words** — prose re-authoring is always yours.
- **Rolling (discovery / add-retire).** Re-run the §2 procedure: roots → codegraph reachability (MEMBERSHIP) → cluster
  by module → rank by centrality → name by commit-scope → liveness by git RECENCY (not frequency). A cluster that
  LEFT the reachable set → retire (human-gated); a new reachable cluster + fresh scope → add a card; reachable-but-old
  → dormant-flag.

**Blast scope — the granularity ladder (`code-understanding-and-anti-drift.md §4.1`).** A slice's "blast" is not one
thing; it is a ladder matched to cadence:
| Rung | Fires when | Cadence | Status |
|---|---|---|---|
| file-existence | a seed/anchor file is gone | pre-commit | ✅ built |
| symbol + line∈span | anchor symbol moved/renamed, or a def-anchor's line left its span | pre-commit (blocking, auto-repairable) | ✅ built |
| normalized span-hash | a def-anchored symbol's body changed (comments/whitespace-insensitive) | post-merge `--reconcile` (SEMANTIC? advisory) | ✅ built (E4 approx) |
| codegraph impact | a change-site symbol's blast radius reaches a card's deps outside the change set | post-merge `--reconcile` (IMPACT? advisory) | ✅ built (E5) |
| coverage | a hot product file no card owns | post-merge `--reconcile` (UNCOVERED-HOT advisory) | ✅ built |
Match granularity to cadence: coarse (filename) over a 27-file slice cries wolf every commit; fine (span-hash) fires
only on real change. Anchor on the SYMBOL, treat the line as a hint (the planned E8 stable-symbol-id upgrade). The
retrieval side has its own gate: `.agents/okf/eval/_eval.mjs` scores FIND against a golden set with `codegraph
explore` as the honest baseline — run it after any ranker or card-frontmatter change; never edit a golden
expectation to make a run pass.

**To ADD a card:** create `.agents/okf/topics/<key>.md` with frontmatter (`key`, `title`, `description`, `resource:`
= the one canonical primary file the card owns, `seeds:`, `symbols:`, `aliases:`, `tags:`) + a one-paragraph "Why /
how it works" tracing the spine + stage-grouped **Anchors**
(`path:line — symbol — role`, every line OPENED and verified) + a Freshness/DRIFT NOTE. Then `--write` to fill the
auto region and `--check` to gate. Keep prose paths FULL (`packages/...`) so the gate doesn't false-positive on
relative fragments.

---

## MODE S — SET UP `.agents/okf/` in a repo that lacks it (the seeder)

Use when a repo has NO `.agents/okf/` (FIND/`understand` errors "not set up") or a STALE/older engine. This skill
CARRIES the engine under `assets/`, so setup needs nothing but `node` + this skill — no piflowctl, no network.

**Procedure (stop-and-report at any HALT):**
1. **Detect.** Does `<repo>/.agents/okf/topics/_generate.mjs` exist? Absent → **fresh-seed**; present → **upgrade**.
   If the existing engine is NEWER than this skill's `assets/` (e.g. it has modes `assets/` lacks), HALT — never downgrade.
2. **Seed the engine (both paths).** Create `<repo>/.agents/okf/topics/`; copy BOTH `assets/_generate.mjs` AND
   `assets/_rank.mjs` into it (`_generate.mjs` imports `_rank.mjs` — one without the other is broken). On **upgrade**,
   overwrite ONLY those two engine files; PRESERVE every existing `*.md` card byte-for-byte.
3. **Config (fresh-seed only).** Copy `assets/okf.config.template.json` → `<repo>/.agents/okf/okf.config.json` and set
   `repoRoot` (repo root relative to `.agents/okf/`, usually `../..`), `memoryDir` (this repo's memory dir or `""`),
   `codegraph` (`"codegraph"` if that binary is on PATH, else `""`). On upgrade, KEEP the existing config.
4. **codegraph (optional).** If `codegraph` is on PATH and the repo has no `.codegraph/`, run `codegraph init` then
   `codegraph sync` (unlocks the SEMANTIC?/IMPACT? reconcile rungs + blast). Everything degrades gracefully without
   it (`codegraph: ""` / `OKF_NO_CODEGRAPH=1` → deterministic line-check only).
5. **Cards.** Fresh-seed leaves ZERO cards — that is a VALID empty-but-healthy substrate. Author the first cards via
   MODE B "To ADD a card" (or a codegraph-centrality starter set). NEVER hallucinate a card's "how it works"; a card
   with a `TODO: curate` body + REAL anchors is honest, a confidently-wrong one is harmful.
6. **Prove it.** `node .agents/okf/topics/_generate.mjs --check` (or `piflowctl understand --check`) MUST exit 0
   (empty-but-valid, or every card healthy). On upgrade, if `--check` now flags a REAL anchor drift, reconcile per
   MODE B before relying on it.

**SETUP output shape / bar (ALL must hold):** `<repo>/.agents/okf/{topics/_generate.mjs, topics/_rank.mjs,
okf.config.json}` exist; the two engine files are byte-identical to this skill's `assets/`; `--check` exits 0; on
upgrade EVERY pre-existing card is unchanged and ONLY the two engine files changed. **Report:** which path ran
(fresh-seed / upgrade), the config values set, whether codegraph was initialized, and the `--check` verdict.

**SETUP scope fence:** do NOT author a card you cannot ground in real anchors; do NOT delete or rewrite existing
cards on upgrade; do NOT downgrade a newer engine (HALT and report instead).

**SETUP self-check before returning:** Did I copy BOTH engine files? Is `repoRoot` correct (does `--check` resolve
its paths)? Did `--check` exit 0? On upgrade, did I preserve every card and change only the engine? Did I report the
path, config, codegraph state, and verdict?

---

## Invariants (the laws — do not violate)
- **Optimizer-facing, never injected.** A slice is read by the out-of-band fixer/optimizer; it is NEVER put into a
  worker node's own runtime prompt (a node must not see its own failure history / code map). Keep slices out of any
  directory a worker node's tools sweep.
- **Pointers + semantics, never a copy.** A slice points at code and explains it; it does not duplicate it.
- **Validate after retrieval (JIT), don't front-load.** Pull the slice when needed and `--check` it before trusting;
  stale context is actively harmful.
- **Deterministic-first; never auto-rewrite curated prose.** The gate is deterministic; an advisory signal is a
  hint to a human/agent glance, never an auto-edit of the understanding. ONE machine exception, bounded: `--write`
  may re-stamp a drifted anchor's LINE NUMBER (span-verified against the graph) — it never touches words.
- **Anchors are the contract.** The `path:line — symbol` anchors (+ seeds) are what the gate validates and what FIND
  returns; prose is commentary.

## Self-check before returning
- FIND: Did I cite a real card (or say `uncovered`), return task-relevant anchors (not a dump), run `--check`, and
  report freshness — AND separately judge SUFFICIENCY (right granularity + coverage for the task, not merely fresh)?
  Did I avoid presenting a stale/invented slice as truth?
- MAINTAIN: Did I run `--check` (and `--write` if curated content changed)? Did I leave curated prose hand-authored
  (no auto-rewrite)? For add/retire, did I use codegraph reachability + git recency, not a guess?

## Pointers
- Design + rationale: `docs/research/memory/code-understanding-and-anti-drift.md` (§2 discovery · §4.1 blast ladder · §5 backlog E0–E8).
- External SOTA verification: `docs/research/memory/sota-verification-2026-06-30.md`.
- The generator: `.agents/okf/topics/_generate.mjs` (`--find [--json] <query>` / `--write` / `--check [--staged]
  [key]` / `--reconcile` / `--owns <path>`) + the pure ranker `_rank.mjs` it imports, fronted by `piflowctl
  understand <query>`/`--rebuild`/`--check`/`--reconcile`/`--owns`; config:
  `.agents/okf/okf.config.json`.
  Incremental via a per-card input fingerprint (gitignored `.gen-cache.json`); `OKF_NO_CACHE=1` forces a full pass,
  `OKF_NO_CODEGRAPH=1` runs the deterministic line-check without the index (HEALTH only), `OKF_NO_SYNC=1` skips the
  automatic index sync, `--staged` scopes to cards touching the git-staged files (the pre-commit hook's mode).
- The retrieval eval: `.agents/okf/eval/_eval.mjs` + `golden.json` (E6) — FIND vs the `codegraph explore` baseline.
- Codegraph fullest-use (escalate with `explore` · `impact` for blast · `status`→`sync` hygiene): the tool's own
  canonical guidance in `src/mcp/server-instructions.ts` / https://colbymchenry.github.io/codegraph/.
- Entry verb (SHIPPED): `piflowctl understand [subsystem]` (FIND, ranked) · `--check [key]` (this gate) ·
  `--rebuild [key]` (`--write`) · `--reconcile` · `--owns <path>` — a fast accessor over the SAME engine; the
  standalone `node .agents/okf/topics/_generate.mjs --find|--check|…` form is equivalent (the CLI is optional).
- This skill is the PORTABLE brain: install it GLOBALLY once (`piflowctl skills install ~ --with understand --with
  memory --force` → `~/.claude/skills/`) so it is present in every repo; it CARRIES the engine under `assets/`
  (parity-gated to the canonical `.agents/okf/topics/` copy) so MODE S can seed a fresh repo with `node` alone.
- Consolidated reference (philosophy · the whole loop · the global-skill design): `docs/understand.md`.
- Still open (per `docs/design/portable-understanding-library.md`): the E6 retrieval-eval promotion gate; the
  codegraph-centrality starter-card bootstrap (M4).
