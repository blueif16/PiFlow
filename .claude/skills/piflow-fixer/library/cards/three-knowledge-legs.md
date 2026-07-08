---
key: three-knowledge-legs
title: Three knowledge stores, one join law — pointer + resolve-at-read
domain: knowledge
status: adopted
description: Deciding where a lesson, a code map, or a practice belongs, and how cross-leg refs stay fresh — split by freshness gate, join by pointer, never copy.
aliases: [three knowledge legs, self history leg, world code leg, methods leg, pointer and resolve at read, cross-leg reference, knowledge leg join law, never embed a copy, one writer per store]
tags: [knowledge, memory, cross-reference, freshness, architecture]
updated: 2026-07-03
---

# Three knowledge stores, one join law — pointer + resolve-at-read

## Trigger
- You're about to paste another store's content into the record you're writing "so it's all in one place."
- A fixer/optimizer needs "what recurred here + how the code works now + which method applies" before it edits anything.
- You're deciding where a new record belongs — a failure lesson, a code map, or a portable practice.
- A lesson and the code it concerns have drifted because one was edited and the other wasn't.
- A knowledge store is being written from more than one place, or read straight into a worker's runtime prompt.

## Practice
1. **Split knowledge into exactly three legs, each carrying its OWN freshness gate — never merge two into one store.**
   - **Self/history leg** — per-unit failure lessons (Symptom → Root → Prevention), each with a recurrence
     count. Freshness = RECOMPUTE recurrence from the run trail (traces + version-control log) at read
     time; never trust a count baked in when the lesson was written.
   - **World/code leg** — slices/maps of how the code actually works, anchored to real source spans.
     Freshness = an anchor/drift check that re-verifies the anchor still matches current code before the
     slice is trusted.
   - **Methods leg** — portable, product-agnostic practices, validated across systems rather than tied to
     one codebase. Freshness = an application track record: every use is logged with its outcome, and a
     practice that stops working flips status instead of being silently deleted.
   A merged file cannot carry two different freshness gates at once — the gate is what keeps each half
   honest, so combining legs for convenience is exactly what breaks that.
2. **The join law: cross-leg references are POINTERS, dereferenced fresh AT READ TIME — never an embedded
   copy.** When a self/history lesson concerns a piece of code, or a methods practice grounds a fix, store
   a link (an id/key/path into the other leg), not that leg's content. At read time the consumer resolves
   the pointer and re-runs the TARGET's own freshness check (recompute recurrence / re-run the drift check /
   read the practice's current status) before trusting what it finds. A pasted-in copy has no gate to ride —
   it silently goes stale the moment its source changes and nothing will ever flag it.
3. **A decision-time consumer (fixer / optimizer / designer) reads every leg it needs before acting,
   resolving each pointer at that moment** — never off a merged, pre-baked context assembled earlier.
   Before touching anything, gather: what recurred here and why (self/history), how the relevant code
   works right now (world/code), and which portable method fits this shape of problem (methods). Missing
   one leg is a signal to go read it, not license to act on the other two.
4. **Give each leg exactly ONE writer path; every other actor is read-only against it.** The self/history
   leg is written only by its own out-of-band distillation step — never by the unit whose failures it
   records, and never injected back into that unit's runtime prompt. The world/code leg is written only by
   its own maintenance/regeneration pass. The methods leg is written only by whoever curates that library.
   Two writers on one leg is how the freshness gate gets bypassed: one writer forgets to re-check what the
   other just changed.
5. **The methods leg is product-agnostic and lives OUTSIDE any single product's repo** — its own
   repo/library, referenced by pointer from every product that uses it, never vendored or copied into one
   product's codebase. A consuming fixer cites a method by key and reads it fresh from the shared library
   at decision time, exactly like it dereferences a same-repo self/history or world/code pointer — the join
   law is uniform whether the other leg lives in the same repo or a separate one.

## Evidence
- The self/history ↔ world/code join is SHIPPED as pointer + resolve-at-read: a defect record carries
  cross-run recurrence plus a link to the code slice, dereferenced into the code map at fix time; the
  embed-a-copy alternative was explicitly closed the same day, on "a copy has no `--check` to ride"
  (piflow, 2026-07-01 — FACTS block / piflow-memory-v1.5.md update).
- Recall from a self/history-style store only helps when the new case is similar to a past one above a
  measured **>0.8** threshold (GitOfThoughts, arXiv 2606.14470) — the freshness signal must be a
  recomputed, same-signature match, not a loose keyword hit.
- Full-rewrite consolidation of a standing-state store measurably COLLAPSED performance, **66.7%→57.1%**
  in one step (ACE, arXiv 2510.04618) — grounds rule 4's "one writer, incremental delta, never a rewrite."
- The bounded per-unit store the self/history leg mirrors defaults to a **~40-line** cap, tunable but never
  unbounded (memory-slices SKILL.md) — a leg that grows without bound can't be read whole at decision time.
- Isolation-by-default plus an access-controlled shared tier beats one merged memory pool for multi-agent
  systems (G-Memory, NeurIPS 2025; SAMEP, arXiv 2507.10562) — the basis for three separate leg-stores.
- This library itself is the methods leg instantiated outside any product repo, added 2026-07-03 (FACTS
  block) — the slot the join law above already had for it.

## Anti-patterns
- Pasting a code slice's content into a lesson (or vice versa) "for convenience" — a copy has no gate and
  silently outlives the truth it was copied from.
- Injecting a self/history lesson into the runtime prompt of the unit it describes, or letting that unit
  write its own lesson — both collapse the out-of-band, one-writer read/write split.
- Vendoring the methods leg into a product's own repo instead of referencing it by pointer — reintroduces
  the exact copy-drift problem the join law exists to prevent.
- Proceeding on two of three legs because the third "probably hasn't changed" — resolve the pointer, don't
  assume freshness.

## Applications
- 2026-07-03 · piflow ecosystem · third leg instantiated as this library → A↔B join already live via pointer+resolve-at-read · piflow DefectScope wire + this repo

## See also
[[memory-recording-policy]] · [[context-composition]] · [[library-maintenance]]
