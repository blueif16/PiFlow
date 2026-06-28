# piflow memory & self-correction — v1 practice

> Reframed 2026-06-28 from a working discussion. **The METHOD already exists** — the global
> `hermes-skill-system` skill (`~/.claude/skills/hermes-skill-system`); `piflow-enhance` routes to it.
> This doc is **piflow's v1 application of that method**, not a second copy. The canonical harvest of
> the real Hermes Agent and the memory design live inside that skill — cite, don't restate:
> `references/hermes-agent-research-2026-06-08.md` (skills/Curator/GEPA, the four surfaces) and
> `research/agent-memory-without-bloat-2026-06-18.md` (four-layer, exclusion list, git-as-memory,
> Library Drift caps). **Status: NOT finalized — §5 is the still-open set.**

## 0. The decision in one line

piflow's memory = **the `hermes-skill-system` method applied to a DAG of `pi` nodes**: a per-product
**registry that indexes the editable files of every node**, with **two capped levels** (per-node +
whole-DAG); **every defect is credit-assigned ("gradient descent") to a node**, where a **per-node
optimizer sub-agent** edits that node's files, recorded as `skillsys(<node>)` git commits — and a
defect that routes to the **DAG itself** becomes an **architectural change** (add / re-wire a node)
**between runs** (L2 COMPOSE), under the human gate.

## 1. What we adopt wholesale (don't rebuild)

`hermes-skill-system` **is** our method — capture → route → edit → verify → approve → commit; **git
is the iteration log** (`skillsys(<id>)`, why/lesson/**rejected**/verify trailers); the registry
**indexes, never copies** the changeable files; caps; *generalize-or-don't-ship*; *the human is the
eye*; *smallest durable edit* (patch > references > new). It is itself the "meta-skill" that *Library
Drift* shows is the single most valuable governance component. v1 only **pins the piflow specifics**
below.

## 2. The piflow delta — what's specific to a DAG-of-`pi`-nodes

### 2a. The per-node editable surface is MORE than `SKILL.md`
Memory ≠ just the prompt/skill. A node's optimizable surface = **every authored file in its
envelope**:
- the **prompt / `node.skill`** (WORK);
- the `op[]` pre/post **gate + `run` scripts** — the check *code* (e.g. `scripts/lint.mjs`); ← the
  key point: editing a check script *is* a node optimization;
- *(candidate)* the contract knobs — `retry`/`escalate`/`reroute`, `readScope`, `tools.allow`.

The registry row for a node points at **all** of these; a `skillsys(<node>)` edit may touch the
skill **or** a check script. This fits piflow exactly: a node is a *declarative envelope compiled to
files*, so its editable surface already **is** a set of files — precisely what the method indexes.

### 2b. Two capped levels — per-node + whole-DAG
- **Per-node memory** = that node's files + the `skillsys(<node>)` git log of its edits/failures —
  **capped per node**.
- **System memory** = the template (`workflow.json`/`meta.json`) + the registry index + a capped
  **open-threads** block — **capped for the whole DAG**.
- **Episodic** = git + the product's `runs/` — uncapped, *queried not loaded*.
- Caps at **both** levels are the mechanism, not a flourish (*Library Drift*: LLM-authored skills
  +0.0pp vs human-curated +16.2pp; the recoverable governance is retire-on-measured-contribution +
  a hard cap + the meta-skill).

### 2c. Defect routing = credit assignment ("gradient descent")
The method's **route** step, made concrete for a DAG:
- a **defect** (a failed gate / verify / missing artifact, carrying the `consultPreamble` evidence)
  is **assigned to the owning node** → a **per-node optimizer sub-agent** edits that node's files →
  `skillsys(<node>)` commit → the next run uses it;
- **the signal already exists** — `run-status.json` + per-node artifacts + `consultPreamble` name the
  owning node, so the router consumes existing output, not new plumbing;
- **per-node sub-agents** ("a sub-agent optimizing per node") isolate context per node — the
  delegate-noisy-bounded-work discipline;
- this is the **inner→outer bridge**: the *same* failure evidence that drives a within-run
  `escalate`/`reroute` becomes the across-run node edit **when it recurs** (don't learn from a
  one-off — *generalize or don't ship*).

### 2d. When the defect points at the DAG, not a node
If credit **can't** localize to one node (coordination / wiring / an end-product that was never
specified) → **route up**:
- it's an **architectural change** — add a node, re-wire an edge, split a producer from a verifier —
  i.e. an **L2 COMPOSE / template edit**;
- it happens **between runs, before the next flow** (never mid-run — the piflow hard constraint,
  `l2-l3:42`), under the **law-3 human gate** (a structural change always needs an explicit yes);
- this is `hermes-skill-system` **law 4** ("prefer fixing the chain over one skill") expressed as a
  **routing altitude**: node-edit commits as `skillsys(<node>)`; DAG-edit commits as `feat`/`docs`
  + a COMPOSE pass — the two are kept out of the same log so the generalize signal stays clean
  (law 7).

## 3. Does this need piflow architecture changes? (mostly no)

It is **method + tooling on the existing file structure**, not runtime surgery:
- the per-node surface already **is** files (prompt + `op[]` scripts referenced by `node.json`) — no
  runtime change;
- system memory = the template + a registry under the product's `.piflow`/`.agents` — files, no
  runtime change;
- `skillsys` = a commit convention — no runtime change.

The genuinely **new** pieces are L3 ("composition, not new machinery"):
1. the per-product **registry** that indexes node→files (a DEFINE artifact);
2. the **defect→node router + per-node optimizer sub-agent** (consumes `run-status.json` + evidence
   we already emit);
3. **cap enforcement** + the **human-approve** gate UX.

One real prerequisite — *the run must record which node owns which defect* — is **already satisfied**.

## 4. Where it lives (data boundary)

Per project `CLAUDE.md`: memory is **product data, never in `@piflow/core`**.
- per-node files + the registry + criteria → the **product**'s `.piflow`/`.agents` (per-template);
- episodic → the product's `runs/` + git;
- the **method** (`hermes-skill-system`) stays the **global, portable** skill.

## 5. Still open — we have NOT decided

1. **Final layer composition.** The exact file set per node + system. (Semantic facts: a line *in*
   the node's skill, or a separate per-node `MEMORY.md`? Lean: fold into the skill first.)
2. **The caps.** Numbers/policy per-node vs system; the retirement metric (*Library Drift* "measured
   contribution" vs simple recency).
3. **Registry granularity.** One row per node, or per (node, surface)? A **shared script** edited by
   two nodes — one home or two? (Coordination memory has no single owning node.)
4. **The approval UX.** Per-edit approval vs a batched between-runs review (the lightest gate that's
   still a gate).
5. **Sub-agent isolation.** Does the per-node optimizer edit in a **worktree** (composes with our
   worktree sandbox) and the human merges?
6. **DAG-change proposer.** Who proposes "add a node" — an L2 COMPOSE re-invocation, or only the
   human? (COMPOSE proposes → human approves is the candidate.)
