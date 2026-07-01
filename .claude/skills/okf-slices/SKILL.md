---
name: okf-slices
description: >-
  OKF code-understanding slices — FIND the right slice before changing code, and MAINTAIN the slice set so it
  never goes stale. TRIGGER on either intent: (FIND) an agent — ESPECIALLY an optimizer/fixer node about to edit
  a subsystem — needs to know how a code vertical works or WHERE to change it ("how does <subsystem> work",
  "where do I change X", "which files own Y", before touching runner/sandbox/observe/optimize/etc.); or (MAINTAIN)
  someone asks when/how to update the slices, what a slice's blast scope is, whether a slice is stale, or runs the
  drift gate. Works on ANY repo that has `.agents/okf/` (config in `okf.config.json`); the cards live in
  `.agents/okf/topics/*.md`. Slices are OPTIMIZER-FACING reference, NEVER injected into a worker node's runtime
  prompt — this skill is how the out-of-band fixer reads them on demand.
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

---

## MODE A — FIND the slice for a task (the reader)

Use when you are about to change, debug, or explain a code area and want the validated map instead of re-deriving
it from the repo. **Procedure (stop at the first step that resolves):**

1. **Normalize the query** to concrete keys: the target FILE path(s), SYMBOL name(s), and/or CONCEPT keywords.
2. **Match against the cards** in `.agents/okf/topics/` and RANK by *where* the match lands — ownership beats mention:
   - FILE → `grep -rl "<path>" .agents/okf/topics/` — a card whose `resource:` IS that path is its CANONICAL owner
     (the one primary file — the strongest match of all); one listing it in `seeds:` or its **Anchors** also OWNS it.
   - SYMBOL → `grep -rl "<symbol>" .agents/okf/topics/` — a card listing it in `symbols:`/`aliases:` or Anchors OWNS it.
   - CONCEPT → match `key`/`aliases`/`title`/`tags` in frontmatter. A bare prose/DRIFT-NOTE mention is a WEAK match —
     do not pick a card just because the word appears in its prose; prefer the card that declares it in frontmatter.
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
   index, so if you just pulled/merged code, make the index current FIRST — `codegraph status --json`, then
   `codegraph sync -q` when `pendingChanges>0` — else `--check` validates against a stale graph and can lie.) Read
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
stale / what's the blast scope." **Three cadences (only the first is wired today):**

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
- **Post-merge (advisory).** Make the index current FIRST (`codegraph sync -q`). Then re-derive ONLY the cards the
  merge touched, not all of them: intersect the changed files (`git diff --name-only <base>`) with each card's
  `seeds:` (the file-level rung), and for the dependency rung run `codegraph impact <anchorSymbol> --json` — a card
  is affected when a changed file lands in an anchor symbol's `impact.affected[]` even if it is NOT one of its seeds
  (the case git-log-of-seeds misses). `node _generate.mjs --write <key>…` the affected keys only, review drift
  flags, and re-author the CURATED half of any flagged card. **NEVER auto-rewrite curated prose** — the machine only
  refills the region between the `okf:auto` markers.
- **Rolling (discovery / add-retire).** Re-run the §2 procedure: roots → codegraph reachability (MEMBERSHIP) → cluster
  by module → rank by centrality → name by commit-scope → liveness by git RECENCY (not frequency). A cluster that
  LEFT the reachable set → retire (human-gated); a new reachable cluster + fresh scope → add a card; reachable-but-old
  → dormant-flag.

**Blast scope — the granularity ladder (`code-understanding-and-anti-drift.md §4.1`).** A slice's "blast" is not one
thing; it is a ladder matched to cadence:
| Rung | Fires when | Cadence | Status |
|---|---|---|---|
| file-existence | a seed/anchor file is gone | pre-commit | ✅ built |
| symbol + line∈span | anchor symbol moved/renamed, or a def-anchor's line left its span | pre-commit (blocking) | ✅ built |
| method-body AST hash | a tracked function's body changed (formatting-insensitive) | post-merge (advisory) | 🔬 designed (E4) |
| codegraph impact | a change's blast-radius reaches the slice's anchors via a dep outside its seeds | post-merge (advisory) | 🔬 designed (E5) |
Match granularity to cadence: coarse (filename) over a 27-file slice cries wolf every commit; fine (method-body) fires
only on real change. Today the gate is symbol-accurate, not yet paragraph-accurate (E4). Anchor on the SYMBOL, treat
the line as a hint (the planned E8 stable-symbol-id upgrade).

**To ADD a card:** create `.agents/okf/topics/<key>.md` with frontmatter (`key`, `title`, `description`, `resource:`
= the one canonical primary file the card owns, `seeds:`, `symbols:`, `aliases:`, `tags:`) + a one-paragraph "Why /
how it works" tracing the spine + stage-grouped **Anchors**
(`path:line — symbol — role`, every line OPENED and verified) + a Freshness/DRIFT NOTE. Then `--write` to fill the
auto region and `--check` to gate. Keep prose paths FULL (`packages/...`) so the gate doesn't false-positive on
relative fragments.

---

## Invariants (the laws — do not violate)
- **Optimizer-facing, never injected.** A slice is read by the out-of-band fixer/optimizer; it is NEVER put into a
  worker node's own runtime prompt (a node must not see its own failure history / code map). Keep slices out of any
  directory a worker node's tools sweep.
- **Pointers + semantics, never a copy.** A slice points at code and explains it; it does not duplicate it.
- **Validate after retrieval (JIT), don't front-load.** Pull the slice when needed and `--check` it before trusting;
  stale context is actively harmful.
- **Deterministic-first; never auto-rewrite curated prose.** The gate is deterministic; an advisory/LLM signal is a
  hint to a human/agent glance, never an auto-edit of the understanding.
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
- The generator: `.agents/okf/topics/_generate.mjs` (`--write` / `--check [key]`); config: `.agents/okf/okf.config.json`.
  Incremental via a per-card input fingerprint (gitignored `.gen-cache.json`); `OKF_NO_CACHE=1` forces a full pass,
  `OKF_NO_CODEGRAPH=1` runs the deterministic line-check without the index.
- Codegraph fullest-use (escalate with `explore` · `impact` for blast · `status`→`sync` hygiene): the tool's own
  canonical guidance in `src/mcp/server-instructions.ts` / https://colbymchenry.github.io/codegraph/.
- Promotion path (Stage 2): port FIND/CHECK into a deterministic `piflowctl okf find|check|build` verb, gate on the
  E6 retrieval eval, then add this skill to the `piflowctl skills install` bundle.
