# Memory & self-correction — research home

> Created 2026-06-28. This folder collects, with `file:line` evidence, the **practices we have
> harvested** about agent **memory** and the **self-correction loop** — from vendored systems
> (`vendor/`) and from prior piflow research — and then states **our own practice** as a position to
> argue with. Living docs, not dated one-shot briefs.

## Why this folder exists

piflow has a strong **within-run** self-correction story (G8 repair, escalate-with-evidence, bounded
reroute) but a **thin memory / cross-run learning** story — the L3 "learnings registered between
runs" is *designed* (`docs/design/l2-l3-boundary-map.md:39-42`) and *not built*. Several systems we
vendored solve the memory half well (especially **Hermes**, whose name we already borrowed for the
L3 outer loop). This folder harvests how they actually do it, so our own practice is grounded, not
invented.

## The framing (read this first)

**There is no single "memory." There are four kinds**, and the best systems keep them *separate*
with different capture/recall policies. We use this taxonomy throughout:

| Kind | "Remembers…" | Natural home | Recall |
|---|---|---|---|
| **Episodic** | what happened (this run/session) | a run/session log | searched on demand |
| **Semantic** | durable facts (about the user/world/project) | a small curated store | always injected |
| **Procedural** | how to do X (the self-improvement substrate) | **skills** | progressively disclosed |
| **User model** | who you are, across sessions | a profile store | injected per turn |

And we score every harvested system on the same **seven dimensions**:

1. **What** is remembered (which of the four kinds)
2. **When** it's captured (mid-run · end-of-run · periodic nudge · on-complex-task)
3. **How** it's distilled (LLM extraction · dedup · summarization · budget pressure · none)
4. **Where** it lives (prompt blob · DB rows · files · skills · FTS index · external service)
5. **How** it's recalled (always-injected · retrieval-on-demand · agent-called search tool)
6. **Who** curates it (automatic · agent-via-prompt · human-approved)
7. **Self-correction loop** (within-run retry/repair vs across-run learning)

## Honesty rule

Same as the rest of `docs/research/`: cite code, not marketing. Where a README claim has **no code
behind it**, say so — the Hermes harvest already caught one (its "FTS5 + LLM summarization" recall
claim is half false; the summary path was removed, PR #27590).

## Existing canon — do NOT duplicate (law 5)

We already own the **method** and the deepest harvests. This folder is the **piflow application**
of them, not a second copy:
- **The method:** the global `hermes-skill-system` skill (`~/.claude/skills/hermes-skill-system`) —
  DEFINE/OBSERVE/OPTIMIZE, git as the iteration log, *index-points-at-the-changeable-files*. In
  piflow, `piflow-enhance` routes to it.
- **The real-Hermes harvest:** `hermes-skill-system/references/hermes-agent-research-2026-06-08.md`
  (skills · Curator · GEPA · the four surfaces).
- **The memory design:** `hermes-skill-system/research/agent-memory-without-bloat-2026-06-18.md`
  (four-layer · exclusion list · git-as-memory · Library Drift caps).

The new value here is **(a)** the vendor harvests those briefs don't cover (RondoFlow, ADK) and
**(b)** piflow's v1 application of the method.

## Contents

- **`harvested-practices.md`** — the cross-source harvest: a **Hermes pointer + fresh-code delta**
  (the deep dive lives in the briefs above), the new **RondoFlow** and **ADK** harvests, the
  cross-source matrix, and the distilled lessons.
- **`piflow-memory-practice.md`** — **piflow's v1 practice**: the `hermes-skill-system` method applied
  to a DAG of `pi` nodes — two capped levels (per-node + whole-DAG), the per-node editable surface
  (skill **+** `op[]` check scripts), defect→node credit assignment ("gradient descent") with
  per-node optimizer sub-agents, DAG-level defects → architectural change between runs, and the
  still-open questions.

## Sources (all vendored, `.gitignore`d under `vendor/`)

| Source | What it is | Vendored at | Depth |
|---|---|---|---|
| **Hermes Agent** (Nous Research) | "the self-improving agent" — built-in learning loop | `vendor/hermes-agent` | deep code harvest |
| **RondoFlow** | visual Claude-Code team product; Planner/Director/Advisor + memory | `vendor/rondoflow` | deep code harvest |
| **Google ADK 2.0** | in-process agent-graph runtime; event-sourced replay | `vendor/adk-python` | prior brief (`../2026-06-27-adk-python-workflow-runtime-comparison.md`) |
| piflow (us) | the substrate — G8 / escalate / reroute / L3 design | this repo | design docs |
