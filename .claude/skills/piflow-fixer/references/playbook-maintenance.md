# Playbook maintenance — the self-improving artifact, improved without corrupting it

Open this when: closing a cycle with playbook deltas · writing/retiring a lesson · a rule seems stale ·
the playbook is growing, contradicting itself, or being asked to absorb a big rewrite.

## 1 · The close-out contract
Every cycle ends with **PLAYBOOK DELTAS or an explicit "no deltas"** — silence is not an option, and neither
is silent self-application. Each delta: the change · the cycle evidence licensing it (which fix bound / failed
and where that is recorded) · what it replaces or deletes. Deltas are OWNER-GATED: proposed, never
self-applied. Legitimate delta shapes: a lever that failed twice moves down (or off) the menu · a new facade
row from a mis-read symptom · a new condition + strategy in a reference file · a threshold recalibrated from
measured outcomes · a rule DELETED as dead or harmful.

## 2 · Delta discipline (how the artifact is edited)
- **Localized deltas, never a monolithic rewrite.** Full-prompt rewrites cause context collapse — binding
  detail (tool rules, failure modes) silently drops, and concise "improved" summaries are lossier than they
  read (brevity bias; ACE, arXiv 2510.04618).
- **Delete-not-resummarize.** Compaction removes whole items; it never paraphrases surviving ones — every
  LLM rewrite of a rule is a lossy resample that drifts toward the model's prior, and iterated consolidation
  degrades below no-memory baselines (arXiv 2605.12978).
- **Each rule carries its evidence.** A rule cites the outcome(s) that license it; outcomes keep accruing
  (helpful/harmful) as cycles apply it. A rule whose harmful outcomes outweigh helpful ones is DELETED, not
  softened.
- **Contradiction census after every edit:** re-read the sections a delta touches for rules it now
  contradicts; two live contradictory rules are worse than either alone (the audit's first-fit line
  contradicted the skill's own divergence step — and the executor obeyed the nearer one).
- **Keep the spine lean; grow the references.** New depth lands in references/; the SKILL.md spine stays the
  operational contract with pointers. Position-privilege the absolutes (top/end) — a long spine buries its
  own laws mid-file.

## 3 · Verify-before-store
A pattern enters the playbook only after it has PASSED a gate in the field (Voyager, arXiv 2305.16291):
- N=1 verified discovery → a **watch-item** (named, with its candidate rule) — visible but not yet law.
- Recurrence ≥2 with consistent outcome → a **lesson/rule**, written where its stage lives.
- A hypothesis that has never gated → stays in the cycle report, enters nothing.
Raw run evidence (run records, ledgers, verdicts) stays FIRST-CLASS and untouched — the playbook abstracts
from it and points to it; it never replaces it. When an abstraction and its raw evidence disagree, the raw
evidence wins and the rule is re-derived.

## 4 · Expiry and staleness
- Rules and lessons are tied to the harness/executor generation they were proven on. On a version bump
  (executor model change, node protocol change, template overhaul): re-verify the rules that touch the changed
  surface, or mark them `stale: pending re-verify` — an expired lesson applied confidently is a new defect
  source (Reflexion's memory-expiry finding, arXiv 2303.11366).
- Thresholds (retry caps, call budgets, N floors) are calibration data, not eternal truths — recalibrate from
  measured outcomes when the fleet or model tier changes, and record the calibration run.

## 5 · Library + memory write-back `[[library-maintenance]]` `[[memory-recording-policy]]`
- Every card CONSULTED during a cycle gets its Applications line updated with the dated outcome (bound /
  did-not-bind / perverse, with the run pointer) — the fixer holds this evidence at gate time and it is lost
  if not written back immediately.
- Node ledger (`memory.md`): update by POINTER, resolved at read time — never an embedded copy that rots.
  Lessons follow the node ledger's parseable shape (signature, recurrence, root, prevention).
- A card the cycle proved wrong or under-delivering gets a status-flip PROPOSAL (with the evidence), not a
  quiet divergence between what the playbook says and what the fleet does.

## 6 · Anti-patterns
- Auto-consolidating the playbook every cycle "to keep it fresh" — iterated rewriting corrupts it.
- A delta with no evidence pointer ("this feels cleaner").
- Softening a harmful rule instead of deleting it.
- Absorbing a big-bang rewrite from one bad week — one cycle's pain licenses targeted deltas, not a new playbook.
- Letting the spine grow until its laws sit mid-file (position decay) — move depth to references/.
- Writing lessons as embedded copies of code/criteria that then rot (pointer + resolve-at-read, always).
- Counting an unverified hypothesis as a lesson because it is well-written.
