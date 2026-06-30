# piflow memory v1

> Recorded 2026-06-28 from a working discussion (supersedes the earlier `piflow-memory-practice.md`
> sketch). **The METHOD already exists** — the global `hermes-skill-system` skill
> (`~/.claude/skills/hermes-skill-system`); `piflow-enhance` routes to it. This is **piflow's v1
> application** of that method, not a second copy. Canonical harvests (cite, don't restate):
> `hermes-skill-system/references/hermes-agent-research-2026-06-08.md` (skills · Curator · GEPA · the
> four surfaces) and `…/research/agent-memory-without-bloat-2026-06-18.md` (four-layer · exclusion
> list · git-as-memory · Library Drift caps). **Status: v1 structure agreed; two-leg + Tier-0↔Tier-1
> framing added 2026-06-28; the §2 SCAFFOLD slice SHIPPED 2026-06-29 (§11); §10 tracks the remaining opens.**
>
> **→ SUPERSEDED IN PART by `piflow-memory-v1.5.md` (2026-06-29):** v1's §7 triage ("ROUTES ONLY — assigns
> each defect to a node") is sharpened there into a **FOUR-way** credit-assignment (LAPSE / SKILL /
> FUNCTIONALITY / ARCH), the "human-gated" approval is split into the *within-run* vs *across-run optimization*
> gate, and **scoring** (the signal both the gate and §10.1 retirement need) is named as the open question.
> Read v1 for the substrate + two legs; read v1.5 for the triage + gate + scoring layer on top.

## 0. The decision in one line

piflow's memory = **the `hermes-skill-system` method applied to a DAG of `pi` nodes**: per-node +
per-template **`memory.md` files on top of git**, where each node's **optimization scope is its
declared contract** (`io.reads`/`readScope`/`owns`), every defect is **credit-assigned to a node**
and fixed by a **per-node optimizer sub-agent** (recorded as `skillsys(<node>)` commits), a
defect that escapes a node's scope **routes up** to a reconcile step that may edit the **template**
(L2 COMPOSE) — all human-gated.

## 1. Adopt wholesale (don't rebuild)

`hermes-skill-system` **is** the method — capture → route → edit → verify → approve → commit; **git
is the iteration log** (`skillsys(<id>)`, `why/lesson/rejected/verify` trailers); the registry
**indexes, never copies** the changeable files; caps; *generalize-or-don't-ship*; *the human is the
eye*; *smallest durable edit*. v1 only **pins the piflow specifics** below.

## 2. Two legs — self vs world (the storage map)

Memory has **two legs**, split by *what they describe* and *who writes them*:

- **Leg A — SELF / history.** What the node knows about **its own behavior** over time. Lives in
  **git** (episodic, generated) + **`memory.md`** (standing state).
- **Leg B — WORLD / code.** What the node knows about the **product code it operates on**. Lives in
  **`code-map.md`** — one or more OKF-standard slices (§5b).

Both legs are the same move — **Karpathy's compiler analogy** (LLM-Wiki gist, Apr 2026: *raw → wiki →
schema*) applied twice: raw **runs/git** compile into `memory.md`; raw **product code** compiles into
OKF slices; the **schema** that says how to maintain both is the hermes method / per-node `SKILL.md`.

**Leg A maps Karpathy's "three-file" coding-agent memory onto two surfaces** — because we split by
write-authority + freshness, not by topic (so no "is this a scar or a status?" disambiguation, and the
session log is *generated*, never the hand-kept `sessions` file that is the #1 memory-rot,
`agent-memory-without-bloat:12,41`):

| Karpathy file | piflow surface | kind |
|---|---|---|
| `sessions` (one line each) | **git** (`git log --grep`, generated) | episodic, append-only |
| `scars` (durable lessons) | `memory.md` → *Known failure modes* | standing, durable, retire-by-contribution |
| `working-on` (status) | `memory.md` → *_status_ + Open threads* | standing, ephemeral, drops when absorbed |

Three storage tiers carry the two legs; **two curated files** sit on top of git:

- **2.1 git — deep, full, unbounded, *queried not loaded*.** Every edit (envelope **or** project
  code) is a `skillsys(<node>)` commit: full diff + `why/lesson/rejected/verify`. This **is** the
  changelog → `git log --grep '^skillsys(<node>)'`. If a node→commit index is wanted, **generate** it
  from git (like `review-edits.sh`); never write it by hand.
- **2.2 per-node `memory.md` — short, curated, the standing state of the NODE's own behavior.** What
  is *true now*, not what *happened* (history is git). Capped (~40 lines / ~2 KB; bottom truncates,
  so most-important first). Spec + example in §4.
- **2.3 per-node `code-map.md` — Leg B; the node's understanding of the PROJECT CODE in its scope.** A
  reference-tier surface (§5b) — *how the code it operates on actually works*. **Always OKF-standard**;
  **one slice** (Tier 0, no codegraph) or a **registration** into the product-global OKF layer (Tier 1).
- **2.4 template/system `memory.md` — the reconcile summary.** Cross-node decisions, architectural
  changes, "how we run the next stack." Capped.
- **2.5 episodic — `runs/` + git.** Already exists; queried, never loaded eagerly.

**Layout — two legs under the template; the Tier-1 code layer lives product-side:**
```
.piflow/<workflow>/
  template/
    meta.json
    workflow.json
    memory.md                    ← SYSTEM · Leg A (reconcile summary; cross-node)
    nodes/<node-id>/
      node.json                  ← config/contract  ┐
      prompt.md                  ← prompt           │ editable ENVELOPE
      skill/SKILL.md             ← skill            │ (the "schema": how to maintain memory)
      scripts/{pre,post,gate}.*  ← hook+check code  ┘
      memory.md                  ← NODE · Leg A (own behavior: status + scars)
      code-map.md                ← NODE · Leg B (Tier 0 = one OKF slice for this node's scope)
  runs/<run-id>/…                ← episodic (Leg A, git-backed)

<product repo>/                  ← Tier 1 ONLY · opt-in · PRODUCT data (never @piflow/core):
  codegraph.sqlite               ← ① structural, auto-fresh from product AST
  okf/{index.md, slices/*, log.md}  ← global functionality memory; nodes register slices
```

## 3. Two capped levels — per-node + whole-DAG

- **Per-node**: the node's files + `skillsys(<node>)` git log + `memory.md`/`code-map.md` — capped
  per node.
- **System**: the template + the registry index + a capped **open-threads** block + template
  `memory.md` (Leg A) + — at Tier 1 — the product-global `okf/index.md` (Leg B) — capped for the whole DAG.
- Caps at **both** levels are the mechanism, not a flourish (*Library Drift*: LLM-authored +0.0pp vs
  human-curated +16.2pp; the recovery is retire-on-measured-contribution + a hard cap + the
  meta-skill, which `hermes-skill-system` is).

## 4. What a node's `memory.md` records (spec + example)

**Records:** *what is true and standing right now* — current behavior; **known failure modes as the
generalized lesson + why** (not the diff); active invariants; open threads. **Excludes** (the
exclusion list): the dated change record (git), in-progress run state (run-status), one-off instances,
anything deducible from the node's files in 5 s. *Facts without reasoning decay; reasoning compounds.*

```
# node: w4-execute — memory      (cap ~40 lines; oldest/lowest drops first)
_status: stable; last change skillsys(w4-execute) 2026-06-28_

## Current behavior
Produces impl + tests from the blueprint; reaches green in ≤2 attempts.

## Known failure modes (the LESSON, generalized — not the diff)
- Skips error handling under token pressure → prompt now REQUIRES a try/catch slot.  (recurred 3 runs)
- lint gate false-failed on BOM files → gate script strips BOM.

## Active invariants
- Must NOT write outside verify/** (readScope).

## Open threads (drop when absorbed)
- Flaky timer-mock test, not yet root-caused.

## History →  git log --grep '^skillsys(w4-execute)'
```

## 5. The change SCOPE — envelope vs project code

piflow runs **per project**, and most of a node's real work is **project code outside the template**
(game-omni: the pre-built components the workflow pieces together). A node's optimization must
understand — and sometimes fix — that code. Two parts, handled separately:

**5a. Scope = the node's contract (reuse it, don't reinvent).** `io.reads` + `sandbox.readScope`/
`owns` already declare *which* project code the node operates on and may touch. So:
- a per-node fixer may edit project code **only within `owns`/`readScope`**;
- a fix that must reach code **outside** that scope **routes up** to reconcile (coordination issue,
  or the contract is wrong) — never a silent wild edit.
- **The runtime jail IS the optimization blast radius** — the same `readScope` that OS-jails the node
  bounds what its optimizer may rewrite (`node-action-protocol.md:320-334`). "Wild change scope" is
  bounded by construction.

**5b. Understanding = `code-map.md`, always OKF-standard; resolution scales with codegraph.** *How the
project code in the node's scope actually works* — what the components do, the seams, their contracts,
the non-obvious gotchas.
> **→ Designed in depth (2026-06-30) in `code-understanding-and-anti-drift.md`:** the function/vertical
> LIFECYCLE slice (def→derive→consume→observe→render, not the per-node stub), the internal deterministic
> ANTI-DRIFT cascade, and the experiment backlog. Read that for Leg B; this §5b is the original framing. The **OKF format is the constant (always on, ~free); the codegraph is the one
opt-in that scales the resolution** — slice cardinality 1→N, a structural anchor, and a global
functionality index. Two tiers, one reader:

- **Tier 0 — no codegraph (default; tiny / skill-only repos).** Each node's `code-map.md` = **exactly
  one OKF slice** (`type: reference`): the functionality + the whole flow running *inside this node*.
  Self-contained — no `resource:` anchor, no global index. Touches **nothing of the user's repo** beyond
  reading the node's declared scope; all our own config.
- **Tier 1 — codegraph opt-in (large, cross-coupled product code, e.g. game-omni).** The OKF layer fans
  out to a product-global `okf/index.md` + `slices/*` = a **global memory of all functionalities** (one
  slice per subsystem), each `resource:`-anchored **down** into codegraph nodes (auto-fresh). A node's
  `code-map.md` becomes a **registration** — "operates on slices X, Y, Z`@sha`" — a selection over the
  shared layer, not a private copy.

**Tier 0's single slice is just the N=1 degenerate case of Tier 1** → one OKF-standard reader (the
`memory-search` read path) serves both; codegraph is a pure upgrade, never a fork.

**Why codegraph is the optional seam (adoption).** It is the **only** component that reaches into
someone else's repo to build a structural index — everything else is our own config reading the node's
declared scope. So precisely *that* is opt-in; it earns its keep only on larger, cross-coupled code
(`okf-claude/DESIGN.md §5`) and is unproven on piflow until measured. Disciplines (both tiers):
1. **Pointers + semantics, never a copy.** *Which* files come from `io.reads`; the slice adds only the
   non-obvious understanding (exclusion list: nothing deducible from source in 5 s).
2. **Freshness is tier-shaped (bi-temporal, `agent-memory-without-bloat:68`).** Tier 0: refresh lazily
   when the node's own scope-files change. Tier 1: structure auto-fresh (codegraph), meaning slow
   (consolidated out-of-band); the node pins `slice@sha` and a stale-flag triggers re-read.
3. **Shared code is the graduation signal.** Tier 0 accepts an honest **duplicate** slice when two
   nodes touch the same code (no graph exists to detect the overlap). When that overlap **recurs and
   costs**, it is the trigger to graduate the product to Tier 1, where the shared component is one
   slice both nodes register.

**The recursive insight:** fixing project code is the *same loop* as fixing the envelope — "edit
files within this node's scope, record the lesson." Only the target differs (template files vs product
files); git unifies both.

## 6. The editable surface (what a fixer may touch)

| Concern | piflow file | Side |
|---|---|---|
| prompt | `prompt.md` | envelope (template) |
| skill | `skill/SKILL.md` | envelope |
| scripts / pre+post hooks / gate checks | `scripts/*` + `op[]` in `node.json` | envelope |
| configuration / contract | `node.json` (tools.allow, readScope/owns, retry/escalate/reroute, mcp, artifacts) | envelope |
| **the project code the node owns** | files within `io.reads`/`owns` | **product** (bounded by §5a) |
| the record | `memory.md`, `code-map.md` | both |

## 7. The optimization flow — a meta-DAG (control nodes are nodes)

```
run finishes
 → [Hermes triage]  attribute blame from run-status + per-node artifacts + consultPreamble evidence.
                    ROUTES ONLY — assigns each defect to a node (or up to the DAG). Does not fix.
 → N parallel per-node FIXERS (one sub-agent per blamed node, context-isolated):
        root-cause → edit within the node's scope (prompt/skill/scripts/config/PROJECT CODE)
        → skillsys(<node>) commit  +  update memory.md / code-map.md
 → [reconcile / init node]  summarize all node edits, reconcile config, decide template edits
        (add/rewire a node = L2 COMPOSE) → write template memory.md  ← HUMAN-GATED (law 3)
 → next run
```
**Disjoint write authority** (the four-memory-jobs rule, `agent-memory-without-bloat:81-88`): node
fixers touch only their node's scope; the reconcile node is the **only** one that edits the template;
neither crosses. The signal triage needs (which node owns which defect) is **already emitted**
(`run-status.json`, per-node artifacts, `consultPreamble`).

## 8. Does this need piflow runtime changes? (mostly no)

Method + tooling on the existing file structure: the envelope + project code are already files; scope
is the existing contract; `skillsys` is a commit discipline. The genuinely **new** pieces are L3
("composition, not new machinery"): the per-product **registry** (DEFINE), the **triage router +
per-node fixer** meta-DAG, and **cap/freshness enforcement** + the human-approve gate. The one
prerequisite — recording which node owns which defect — is already satisfied.

## 9. Where it lives (data boundary) + Hermes keep-it-short rules

**Data boundary** (project `CLAUDE.md`): memory is **product data, never in `@piflow/core`** — per-node
files + registry under the product's template/`.agents`; episodic in `runs/` + git; the **method**
stays the global skill.

**Keep-it-short rules (Hermes / Claude Code):** exclusion list (don't store what git/run-state/code
holds) · hard cap, top-loaded (bottom truncates) · reflect on **failures** not successes · reasoning
> facts · consolidate-under-pressure, don't append · frozen snapshot (edits take effect next run) ·
freshness marker on aging entries · **no silent learning** (every edit a human-gated `skillsys`
commit).

## 10. Open + resolved

**Resolved 2026-06-28 (the two-leg / Tier-0↔Tier-1 pass):**
- ~~code-map separate file vs a section of `memory.md`~~ → **separate** — they are the two *legs*
  (self vs world, §2), not two slices of one file.
- ~~code-map refresh trigger~~ → **tier-shaped** (§5b.2): Tier 0 lazy on scope-files change; Tier 1
  codegraph auto-fresh + `slice@sha` stale-flag. No explicit DEFINE pass needed.
- ~~shared-code home~~ → the **OKF slice** is the shared-code home (Tier 1); Tier 0 accepts the honest
  duplicate until recurrence graduates the product (§5b.3).

**Still open:**
1. **Caps** — numbers + retirement metric (measured contribution vs recency), per-node vs system.
2. **Registry row granularity** — one row per node, or per (node, surface)? (Shared-code *home* now
   resolved above; the row shape is not.)
3. **Approval UX** — per-edit vs batched between-runs review.
4. **Fixer isolation** — does the per-node fixer edit in a **worktree** (composes with our worktree
   sandbox) and the human merges?
5. **DAG-change proposer** — L2 COMPOSE re-invoked to propose "add a node," or human-only?
6. **Codegraph build/host + proof-before-promote** — which tool builds the per-product graph
   (`okf-claude` generators?), where the SQLite + `okf/` live (product repo, never `@piflow/core`), and
   the token/tool-call win to measure on one product before Tier 1 goes from opt-in to default.

## 11. Implementation status

**SHIPPED — the §2 scaffold slice (2026-06-29; branch `worktree-memory`).** SDK-first: the layer is a
**`@piflow/core`** feature; the CLI is its thin accessor (the established pattern). The two legs are
**separate modules**:
- **Leg A — `packages/core/src/memory/`** (the customizable, growing one): facade `index.ts` over
  `skeleton.ts` (`buildNodeMemory` §4 · `buildSystemMemory` §2.4) + `seed.ts` (create-if-absent writers).
- **Leg B — `packages/core/src/code-map.ts`** (separate, self-contained): `buildNodeCodeMap` (Tier-0 OKF
  slice) + `seedNodeCodeMap`.
- **CLI accessor** (`packages/cli/src/scaffold.ts`): `new` seeds the template `memory.md`; `add-node`
  seeds each node's `memory.md` + `code-map.md`; `piflowctl memory scaffold <dir>` backfills an older
  template. ALL **create-if-absent** (never clobber curated content — the `prompt.md` discipline).
- **Invariants baked into every seed header:** OPTIMIZER-FACING · **NEVER injected into a node's runtime
  prompt** (a node must not see its own failure history). The maintenance contract (caps/exclusion list)
  lives ONCE in the optimizer skill, not per file. Loader untouched — sidecars are invisible to the §8
  compile gate. Test-first (RED→GREEN + a create-if-absent mutation proven to redden).

**NOT YET BUILT (the next slices):** the §7 optimizer meta-DAG (triage→per-node fixer→reconcile) that
READS + UPDATES these files from run traces — the actual self-correction loop; cap/freshness enforcement
(§9); Tier-1 codegraph (§5b). The scaffold gives the optimizer its substrate; the optimizer is the work.
