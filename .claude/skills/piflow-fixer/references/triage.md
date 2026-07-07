# Triage — naming the defect honestly and deciding whether it deserves an edit at all

Open this when: you are about to name a problem · the LAPSE-vs-SKILL call is unclear · the root seems
unreachable · the detector's report is ambiguous · one ticket appears to hold several defects.

## 1 · The evidence-line standard (no confident naming)
A defect exists when you can fill ALL THREE fields; until then you hold a hypothesis, not an issue:
- **Detector** — which instrument saw it: a trace signal (tool error, think-spike, repeated call, context
  bloat), a lint/schema gate, a blind judge mark, a budget breach, a diff anomaly.
- **Evidence line** — the artifact line / trace event / judge sentence that shows it. Quote or cite it.
- **Mechanism sketch** — one sentence for HOW the harness produces it (falsifiable, not "the model is bad").

If the record is ambiguous, the honest outputs are: (a) report the ambiguity as the finding, (b) propose the
INSTRUMENT sharpening that would disambiguate (a coarser-grain detector staying silent on a real defect is
itself a defect — of the detector), or (c) design the one cheap probe that separates the hypotheses. Never
resolve ambiguity by picking the story that pattern-matches a failure you have seen before: a signal that
looks like a known failure may have a different cause, and the campaign audit found exactly this (the same
mark failing twice for two DIFFERENT defects — a "recurrence" that wasn't one).

## 2 · The LAPSE gate `[[four-way-triage]]`
Before routing anything to an edit, ask: **does a correct rule already exist that would have prevented this?**

| finding | classification | the fix |
|---|---|---|
| a correct rule exists; first miss of this signature | **LAPSE** | NO edit. Routing change: tier/model/provider bump, or a protected reminder. Track the signature. |
| a correct rule exists; the SAME signature has now missed ≥2 runs | **LAPSE→SKILL flip** | the rule has proven it does not bind in its current FORM — compile it to a stronger demand lever (demand-levers.md) |
| no rule covers it | **SKILL gap** | route by detector (two-foot), compile truth-half + demand-half |
| the rule exists but is WRONG (it caused the defect) | **inverse SKILL** | fix the rule itself — and check what else obeyed it (a literal-obedience defect radiates) |
| unclear which | **default to LAPSE** | the cheap, reversible reading; a wrong LAPSE call costs one recurrence, a wrong SKILL call churns correct guidance |

Signature bookkeeping: the node ledger tracks `(node, failure-signature)` with a recurrence count; the flip at
recurrence 2 is what LICENSES an edit. This is the single strongest defense against harness churn — the
campaign's correct rules that were edited anyway produced zero binds and burned verify cycles.

## 3 · Localizing the root
- **The two-model diff** (when two executor tiers ran the same input): a dimension BOTH tiers miss = a shared
  knowledge gap → fix the shared home (reference/data both read). A dimension only the WEAK tier misses = a
  scaffold gap → fix with weak-executor structure (menu/tool/forced slot). One control run buys the whole routing.
- **Walk upstream before editing here:** if the defect's content was already wrong in this node's INPUT, the
  root is the upstream producer — report it against that node; do not compensate downstream (a downstream
  compensation is a symptom-silencer the gate should fail).
- **Facade check:** run the SKILL.md facade table over your reading before you commit to it.

## 4 · Conditions and their pre-prepared strategies
- **Root unreachable** (lives in a withheld oracle file, an absent file, or outside the candidate closure):
  HALT. Report: the root's location, why it is out of reach, the smallest scope change that would make it
  reachable. Never recreate the missing file; never substitute a reachable symptom.
- **Root is the DETECTOR** (false fire, wrong grain, silent on a real defect): the fix targets the instrument,
  and it follows the same two-half law — a detector fix pre-registers the artifact it must now catch/pass, and
  is test-first + mutation-verified (prove the check fails when the defect is present AND stays silent when absent).
- **Multi-defect ticket:** split it. One issue = one defect = one signature. A ticket naming two mechanisms
  gets two issue files with separate signals; they may share a verify run (verification.md §Batch).
- **Budget breach reported as the defect:** a breach is a TRIPWIRE, not a grade `[[budgets-as-defects]]` —
  the issue is whatever CAUSED the spend (re-derivation loop, missing answer-service, retry storm); route on
  that mechanism, don't "fix" the number by raising the budget.
- **Judge abstained / could-not-measure:** an abstain is its own verdict `[[scoring-cascade]]` — never coerce
  it into a low score or an auto-reject; the issue (if any) is the measurability gap.

## 5 · Anti-patterns
- Editing correct prose after a one-off failure (harness churn; the LAPSE gate exists to stop this).
- Naming the defect from pattern memory without an evidence line ("this looks like the anchor bug again").
- Treating token/wall spend as a quality grade instead of a difficulty-conditioned tripwire.
- Merging two mechanisms into one issue because they surfaced in the same run.
- Diagnosing "the model is too weak" — not falsifiable, not actionable; name the harness element instead.
