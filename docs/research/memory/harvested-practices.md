# Harvested practices — memory & self-correction

> Created 2026-06-28. Cross-source harvest, `file:line`-cited in the vendored repos. Framing +
> taxonomy: `README.md`. Our resulting practice: `piflow-memory-practice.md`.
>
> **Do-not-duplicate note (law 5).** The deep harvest of the **real Hermes Agent** and the **memory
> design** already live, in richer form, inside the `hermes-skill-system` skill —
> `references/hermes-agent-research-2026-06-08.md` (skills · Curator · GEPA · the four surfaces ·
> agentskills.io) and `research/agent-memory-without-bloat-2026-06-18.md` (four-layer · exclusion
> list · git-as-memory · Library Drift caps). This file therefore keeps only **(a)** a Hermes pointer
> + the *delta* our 2026-06-28 fresh code-harvest of the vendored runtime adds, and **(b)** the
> genuinely-new vendor harvests (RondoFlow, ADK) those briefs don't cover.

---

## 1. Hermes Agent — pointer + the fresh-code delta

**Read first:** `hermes-skill-system/references/hermes-agent-research-2026-06-08.md` (the canonical,
multi-source harvest) and `…/research/agent-memory-without-bloat-2026-06-18.md` (the memory design).
The headline that both establish and we keep: **memory is four separated surfaces — SOUL (identity) ·
MEMORY/USER (facts) · skills (procedures) · session-FTS (recall)** — and **skills are the
self-improvement substrate**, governed by *no silent learning*, *progressive disclosure*, *patch >
edit > new*, *benchmarks-are-gates*, and *a hard cap + the meta-skill* (Library Drift: LLM-authored
+0.0pp vs human-curated +16.2pp).

**Delta from reading the vendored *runtime code* (`vendor/hermes-agent`) on 2026-06-28** — what the
prior briefs (docs/videos/companion-repo) didn't pin to code:
- **README claim is half false.** "FTS5 session search **with LLM summarization**" — the
  summarization path was **removed** (`tools/session_search_tool.py:23,28` "No LLM calls anywhere";
  commit `abf1af540 …no LLM (#27590)`). The FTS recall is real; the LLM-summary half is stale
  marketing.
- **Distillation is budget pressure, not a summarizer** — confirmed in code: an over-limit
  `MEMORY.md` add is *refused* with "Consolidate now: use 'replace' to merge… then retry — all in
  this turn" (`tools/memory_tool.py:327-340`). No LLM distiller, no embeddings, no importance rank.
- **Capture is a background-review *fork* on a turn/iteration counter** (default 10), spawned **after
  the user is served** so curation never competes with the task (`agent/turn_context.py:252-260`,
  `agent/background_review.py:839-864`).
- **The "do NOT capture" guardrail is in the prompt, in code** — the skill-review fork enforces a
  strict preference order *and* an anti-pattern list (don't persist environment failures or negative
  tool claims as "persistent self-imposed constraints", `background_review.py:240-272`). Memory needs
  a stop-list as much as a save-list.
- **Memory is an injection surface** — curated entries are **threat-scanned at injection**; a poisoned
  entry becomes `[BLOCKED: …]` (`memory_tool.py:171-205`).
- **Almost no within-run reflect loop** — only a one-shot empty-response retry
  (`conversation_loop.py:4259-4262`) + API backoff; bounded by `max_iterations` + `iteration_budget`.
  (Hermes leans on *across-run* skill edits, not in-task verify loops.)

---

## 2. RondoFlow — `vendor/rondoflow` (server `packages/server/src/engine`)

The shipped Planner/Director/Advisor product (full study: `../2026-06-28-rondoflow-vs-piflow.md`).
Where Hermes bets on agent-curation, RondoFlow bets on **automatic extraction**.

**(1) What:** semantic facts + failure-learnings (no skills-as-memory; skills are static catalog
items).

**(2) When:** (a) **mid-run** — the Director banks a typed `learning` after *every* step
(`director.ts:135-145`); (b) **end-of-run** — an auto-extractor over the transcript
(`memory-extractor.ts`).

**(3) How distilled — automatic LLM extraction + heuristic dedup.** A cheap **Haiku** call returns
≤5 *durable* facts as JSON `{key,value,scope,confidence}`, dropping `confidence<0.6`
(`memory-extractor.ts`); stored via `upsertMemory` with **Jaccard>0.8 dedup** (`memory-store.ts`).
Existing facts are previewed back into the extraction prompt so the model avoids repeats. The
**opposite** of Hermes — a pipeline, not a nudge.

**(4) Where:** Postgres `Memory` rows, scoped `workspace`|`agent`, with `pinned`/`importance`,
`source ∈ {auto, manual, director}` (`schema.prisma:316-327`).

**(5) How recalled — always-injected blob**, ranked `pinned desc, importance desc, updatedAt desc`,
top 30 (`prompt-builder.ts:96-110, 355-367`).

**(6) Who curates:** **automatic** (Haiku extractor + Director) + manual. **No human-approval gate.**

**(7) Self-correction:**
- **Within-run = the Director loop** — an LLM quality gate after every step → `continue/redirect/
  conclude` with a **rigor knob 1–5** (`director.ts:48,317`); `redirect` = **runtime retry**
  (`chain-executor.ts:452-462`), capped at 2.
- **Loop-until-goal** with a **deterministic** criterion — regex / shell test exit / human / max
  (`loop-engine.ts:288`), fresh process per iteration (`:220`).
- Advisor returns structured, apply-able `actionPayload`s (attach skill / rewrite persona)
  (`advisor.ts:9-22`).

**Takeaway:** auto-extraction + always-inject + an LLM-judge mid-run loop. The **rigor dial** and the
**structured-edit suggestion** are borrowable; auto-extract-without-approval and runtime re-entry are
refused.

---

## 3. Google ADK 2.0 — `vendor/adk-python`

A **runtime, not a memory system** (full brief: `../2026-06-27-adk-python-workflow-runtime-comparison.md`).

- **What/Where:** in-memory only — `ctx.state` (Pydantic `state_schema`, `_base_node.py:115`),
  `_LoopState.node_outputs` (`_workflow.py:99`). **No filesystem, no cross-run learning.**
- **Durability = event-sourced replay** — node state reconstructed from session events on resume
  (`_scan_child_events:734`) with a `ReplaySequenceBarrier` (`_workflow.py:93,553`). Episodic-as-replay,
  for resume, not recall.
- **Within-run self-correction:** per-node `RetryConfig{backoff, jitter, exceptions}`
  (`_retry_config.py:26`) on **raised exceptions** + per-node `timeout` + HITL resume.
- Contributes the **retry-backoff shape** and the **replay-resume** idea; nothing on memory.

---

## 4. Others (lighter touch)

- **PDW** (`docs/specs/competitive-gaps-vs-pi-dynamic-workflows.md`): in-process, shared memory; no
  durable cross-run memory of note.
- **Mid-run swarm consensus** (`../2026-06-27-swarm-agent-communication-mid-run-consensus.md`,
  memory `swarm-consensus-deferred`): evaluated + **deferred** — the win is the static fusion/judge
  node, not agents learning from each other mid-run.
- **OpenClaw / agentskills.io**: the `SKILL.md`+frontmatter **format** standard — the same shape
  piflow's `node.skill` already uses.

---

## Cross-source matrix (the seven dimensions)

| Dimension | **Hermes** | **RondoFlow** | **ADK** | **piflow (current)** |
|---|---|---|---|---|
| **What** | all 4 kinds, separated | semantic facts + learnings | none (replay log only) | procedural (skills) only; no facts |
| **When** | turn-counter nudge + proactive | mid-run (Director) + end-of-run | n/a | within-run only |
| **How distilled** | **budget pressure** (self-compress) | **auto LLM extract** + Jaccard dedup | n/a | n/a (none yet) |
| **Where** | MD files · SQLite/FTS · skills · Honcho | Postgres rows | in-memory + event log | files (skills, run-view, journal) |
| **How recalled** | blob + **FTS tool** + **progressive disclosure** | always-inject top-30 | replay-resume | skill body in prompt; io.reads |
| **Who curates** | **agent-via-prompt**, guardrailed | **automatic** (+ manual) | n/a | author + (designed) human-approve |
| **Within-run loop** | minimal (1-shot retry) | **LLM-judge** redirect + loop | RetryConfig backoff/jitter | **G8 repair · escalate · reroute** |
| **Across-run loop** | **skills edited in place** | Director learnings → inject | none | **designed only** (L3 Hermes) |

---

## Distilled cross-cutting lessons

1. **Memory is four things, not one — keep the stores separate.** A tiny always-injected semantic
   blob, an on-demand episodic FTS, progressively-disclosed procedural skills, an optional user model
   — each with its *own* capture/recall policy. Conflating them is what rots the prompt.
2. **Procedural memory (skills) IS the self-improvement substrate.** Both serious systems treat
   "learning" primarily as **editing skill files**, not accumulating facts.
3. **Agent-curated-via-prompt > automatic extraction** — *for what's worth keeping*. The model knows
   salience better than a generic extractor, **if** constrained by a budget gate + an anti-pattern list.
4. **Budget pressure is an elegant distiller.** No summarizer — an over-limit write is refused with
   "consolidate now." Model-independent; keeps the store small by construction.
5. **Progressive disclosure is the only scalable recall for a growing library.** Names+descriptions
   in the prompt, bodies on demand.
6. **Curation belongs off the critical path.** Hermes forks a background review agent; RondoFlow
   extracts post-run. Memory writing never competes with the task.
7. **Separate the two self-correction layers.** *Within-run* robustness (retry/repair/escalate,
   deterministic-triggered, bounded) ≠ *across-run* learning (skill/fact edits, between runs).
8. **A "do NOT capture" guardrail is essential.** Naive memory accumulates *negative* learnings that
   cripple future runs; needs a stop-list as much as a save-list.
9. **Memory is an injection surface.** Anything injected next session is an attack vector — threat-scan
   it; especially for a system whose thesis is per-node capability isolation.
10. **The human-approval gate is the white-space.** Neither Hermes nor RondoFlow gates on a human —
    both auto-register. piflow's differentiator is the **approval edge** (`l2-l3:42`: generate →
    verify → **human-approve** → register), already encoded as `hermes-skill-system` law 3.
