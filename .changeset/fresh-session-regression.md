---
"@piflow/core": patch
---

fix(runner): re-allow a node's own `.pi/sessions` dir under the bookkeeping read-deny so warm-resume works under the seatbelt jail

A warm-resume addresses the pi native session by its absolute path (`--session '<abs>'`),
which pi opens via `loadEntriesFromFile → openSync`. But the per-node seatbelt jail DENIES
reading `<run>/.pi/**` (bookkeeping, run 260710-02) and only re-allowed `.pi/staged/<id>` +
`.pi/skills` — NOT `.pi/sessions`. So a warm retry under `--sandbox local` EPERMed loading its
own session and pi died before any model turn (run 260716-01/plan: events.jsonl starved). The
CREATE (`--session-id`) attempt only WROTE the session (the write jail grants the run dir), so
the gap was READ-only. Re-allow the per-run session dir in `readDenyExcept` — the first (create)
invocation is unchanged; the warm-resume-by-path now actually resolves under the jail.
