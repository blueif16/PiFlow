# The Understand System — philosophy, the whole loop, and the global-skill design

_The consolidated map of piflow's code-understanding leg (Leg B). Twin of `docs/telemetry.md` (observe)._
_Rationale + experiments: `docs/research/memory/code-understanding-and-anti-drift.md`. Portability plan +_
_milestones: `docs/design/portable-understanding-library.md`. Operational procedure: the `okf-slices` skill._
_This doc is the WHY + the shape; those are the deep dive + the plan + the how-to. Cite, don't restate._

The understand system answers one question for an agent about to change code — **"how does this vertical work,
and where exactly do I change it?"** — from a validated map instead of a from-scratch grep, and keeps that map
honest as the code moves. It is the "world/code" half of piflow's two-leg memory design; the "self/history"
half (per-node lessons + recurrence) is its twin, the `memory-slices` skill (Leg A). They meet at ONE point:
a memory lesson `[[links]]` the code slice it concerns, resolved at fix time.

---

## Part 1 — Philosophy (the laws that shape everything)

1. **Two legs, one cross-reference.** Leg B (this system) = how the CODE works. Leg A (memory) = what this NODE
   has learned/failed. They stay separate and join by a single `[[okf-slice]]` pointer resolved AT READ time —
   never an embedded copy (a copy has no `--check` to keep it fresh). The optimizer's fixer is where they meet.

2. **Ownership over mention.** A slice OWNS a query when its frontmatter declares it (`resource:` = the one
   canonical file is strongest, then `seeds:`/`symbols:`/`aliases:`/`key`/`tags`). A card that merely name-drops
   the word in prose is a WEAK signal and can NEVER crown an owner — the rule is structural, not a stopword list.
   This is the whole basis of the ranker (`_rank.mjs`) and the reason FIND is precise at ~5× fewer tokens than a
   codegraph explore.

3. **Pointers + semantics, never a copy.** A slice points at `path:line — symbol` and explains the spine in a
   paragraph; it never duplicates code. Duplicated code rots silently; a pointer drifts loudly (the gate catches
   it).

4. **Optimizer-facing, never injected.** A slice is read by the OUT-OF-BAND fixer/optimizer, never placed into a
   worker node's own runtime prompt (a node must not see its own code map / failure history). Keep slices out of
   any directory a worker node's tools sweep.

5. **Deterministic-first; the machine never rewrites understanding.** The gate is deterministic (file exists ·
   line ∈ symbol span · span-hash · graph impact). Advisory signals are hints for a human/agent to JUDGE — the
   machine judges structure, never prose. The ONE bounded machine exception: `--write` may re-stamp a drifted
   anchor's LINE NUMBER (span-verified), because a line is a hint, not meaning. Words are always hand-authored.

6. **Freshness ≠ sufficiency.** `--check` certifies anchors aren't STALE; it says nothing about whether they
   COVER your task. A green card can still be too coarse for a function-level change. After the freshness verdict,
   make a SEPARATE judgment: do the anchors reach the file/symbol and granularity the task needs? If fresh-but-
   thin, use what's anchored, escalate to `codegraph explore` for the rest, and flag the gap.

7. **Anchors are the contract.** The `path:line — symbol` anchors (+ seeds) are what the gate validates and what
   FIND returns; prose is commentary. One source of truth: the same anchor set the gate checks is what the
   incremental fingerprint stats, so they can never disagree about a card's dependency set.

8. **The CLI is a projection; the substance is data + a script + a skill.** The understanding travels with the
   repo as `.agents/okf/` (cards + the vendored engine) and with the operator as a global skill. `piflowctl` is a
   fast accessor — never a dependency. (The observe-side analog: config is truth, the GUI is a projection.)

---

## Part 2 — The whole loop

### FIND (just-in-time retrieval)
- An agent asks `piflowctl understand "<query>"` (or standalone `node .agents/okf/topics/_generate.mjs --find
  "<query>"`). The ONE ranker (`_rank.mjs`) scores every card by ownership (law #2), with a tokenized phrase
  fallback for natural-language questions (gated by the same ownership law, so glue words can't crown a card).
  It returns the owning card's *"Why/how"* + `owns:` + related slices, or `UNCOVERED`.
- **Uncovered → escalate** to exactly ONE `codegraph explore "<symbol|question>"` (source + call paths + blast in
  one round-trip); map the owning module to a card's `seeds:`, or declare the vertical uncovered (a gap to author).
  Never invent a slice.
- **Validate before trusting** (JIT): `--check <key>` — a stale slice is worse than none. Read WHICH signal it
  returns: `HEALTH` (anchors may be WRONG — first rule out branch skew) vs `DRIFT` (only the auto-region is stale;
  the curated anchors are still valid) vs `ok`.

### The optimizer consumption (FIND, in code)
- The fixer doesn't wait for an explicit link: `findSliceForDefect` ranks a defect's structured signals against
  the card set (via the same engine `--find --json`) and injects the owning slice into the fixer's scope-context
  — but ONLY at ownership strength (score ≥ 45, the `seeds:` rung), provenance-marked as FIND-matched, budgeted.
  An explicit lesson `[[okf-slice]]` pointer always wins over the FIND fallback.

### RECONCILE (keeping the map honest — three cadences)
- **Pre-commit (blocking) — the gate.** `--check --staged` runs on every commit (`.githooks/pre-commit`), scoped
  to cards whose seeds/anchors intersect the staged files; CI runs the full no-index HEALTH pass. Blocks (exit 1)
  ONLY on HEALTH (an anchor/seed moved → anchors may be wrong). Auto-region DRIFT is advisory. Incremental: a card
  whose inputs are byte-identical to its last clean derive is skipped (`ok (cached)`).
- **Post-merge (advisory) — `--reconcile`.** After every merge/pull and before any optimize pass. Emits
  deterministic TRIGGERS the agent JUDGES: `SEMANTIC?` (E4 span-hash: an anchored symbol's body changed →
  re-read the prose), `IMPACT?` (E5, graph-only: a change-site symbol's blast reaches a card's deps from outside
  the change set), `UNCOVERED-HOT` (a hot product file no card owns; instrument paths excluded by rule). The
  machine emits facts; the agent judges prose; `--write` auto-repairs only mechanical line drift.
- **Rolling (discovery).** roots → codegraph reachability → cluster by module → rank by centrality → name by
  commit-scope → liveness by git recency. Left the reachable set → retire (human-gated); new cluster → add.

### The blast / granularity ladder (match granularity to cadence)
| Rung | Fires when | Cadence |
|---|---|---|
| file-existence | a seed/anchor file is gone | pre-commit |
| symbol + line∈span | anchor symbol moved/renamed | pre-commit (blocking, auto-repairable) |
| normalized span-hash | a def-anchored symbol's body changed | post-merge `SEMANTIC?` (E4) |
| codegraph impact | a change's blast reaches a card's deps outside the change set | post-merge `IMPACT?` (E5) |
| coverage | a hot product file no card owns | post-merge `UNCOVERED-HOT` |

Coarse over a 27-file slice cries wolf every commit; fine (span-hash) fires only on real change.

### Quality is measured, not asserted
`.agents/okf/eval/` scores FIND against a `codegraph explore` baseline over a golden set (E6). Current truth:
FIND 20/22 (91%) positive vs explore 77%, at ~5× fewer tokens; file/symbol/concept 100%; phrase 3/5. A miss is a
recorded FINDING (a card-frontmatter alias gap), never edited away to make a run pass.

---

## Part 3 — The global-skill design (what makes it portable)

**The portable unit is the skill, installed once at the GLOBAL level** (`~/.claude/skills/okf-slices`,
`memory-slices`) — NOT a per-repo copy, NOT the CLI. Three tiers, by owner:

- **Global skill = the portable brain.** Present in every Claude Code session in every repo automatically. It
  carries the METHOD (FIND / MAINTAIN) and the SETUP procedure — and it physically CARRIES the engine under
  `assets/`, so it can seed `.agents/okf/` into any repo with `node` alone. CLI-optional by construction.
- **Per-repo `.agents/okf/` = data + the vendored engine (the scripts).** The cards + `_generate.mjs` +
  `_rank.mjs`. The only artifact that lives in the product repo. FIND/gate/reconcile run here on `node`.
- **`piflowctl` = an optional fast accessor** (+ piflow's own pre-commit hook and the optimizer's in-process
  inject — piflow-internal ops). Every operation has a `node …/_generate.mjs …` equivalent, so for "understand my
  other codebases" the CLI is pure convenience: the command line is just a fast way to run the scripts.

**One source of truth for the ranker AND the engine.** The scoring lives once in `_rank.mjs`; the CLI reader and
the optimizer source ranking from the engine's `--find` (no TS re-implementation). The skill's `assets/` copy of
the engine is byte-identical to the canonical `.agents/okf/topics/` copy, enforced by a parity gate
(`packages/cli/test/skill-assets-parity.test.ts`) — the bundled distribution copy can never silently rot
(code-as-truth). When the engine changes, re-copy it into `assets/`; the gate fails until you do.

**SETUP (MODE S).** Seeds `.agents/okf/{topics/_generate.mjs, topics/_rank.mjs, okf.config.json}` into an
unseeded repo from `assets/` (fresh-seed), or swaps the engine while preserving cards (upgrade). Bar: the two
engine files match `assets/`, `--check` exits 0, upgrade changes only the engine. Fresh-seed leaves zero cards —
a valid empty-but-healthy substrate; cards are authored via MAINTAIN (never hallucinated).

**Two distribution paths, kept BOTH.**
- **Global (the default for the solo operator):** `piflowctl skills install ~ --with understand --with memory
  --force` → `~/.claude/skills/`. Per-machine, present everywhere, NOT in git.
- **Per-repo (the opt-in for shareable repos):** `skills install <repo> --with understand` → `<repo>/.claude/
  skills/`, recorded in `<repo>/.piflow/skills.json`. Travels to collaborators/CI via git.

---

## Part 4 — Where it stands

- **M1 SHIPPED** (`ec52580`): `_rank.mjs` is the one ranker; engine `--find`; CLI reader + fixer wire source
  ranking from it. Standalone ranked FIND on `node` alone.
- **M2 (this doc's subject):** global-skill promotion + CLI-optional + SETUP mode + the parity-gated bundled
  engine.
- **Open (M3–M6, per `docs/design/portable-understanding-library.md`):** skill-driven seed/upgrade UX, the
  codegraph-centrality starter-card bootstrap, codegraph auto-init, and the CLI-less game-omni proof.
- **The one strategic lever still open:** E8 (stable SCIP/LSIF symbol anchors — derive `:line` as a hint instead
  of storing it), a sibling project, not part of the portability arc.

### Pointers
- Operational how-to: the `okf-slices` skill (`SKILL.md` — MODE A FIND · MODE B MAINTAIN · MODE S SETUP).
- Rationale + experiment backlog (E0–E8): `docs/research/memory/code-understanding-and-anti-drift.md`.
- Portability plan + milestones: `docs/design/portable-understanding-library.md`.
- Retrieval eval: `.agents/okf/eval/_eval.mjs` + `golden.json`.
- Leg A twin (self/history): the `memory-slices` skill; design in `docs/research/memory/`.
