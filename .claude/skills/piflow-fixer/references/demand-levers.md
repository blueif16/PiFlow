# Demand levers — choosing the binding form and authoring good content inside it

Open this when: you are picking a fix's binding form · your guidance keeps getting ignored · every lever
looks blocked · you are about to add anything to a standing (always-visible) surface.

## 1 · Why the two-half law exists (the evidence, once)
The 2026-07 fixer-method audit (best-designs `research/fixer-method-debug-2026-07-07.md`) measured one
campaign's ~27 fixes by form: data/menus bound 3/3, forced-slot references 2/2, procedural fence lines 5/5
(one PERVERSELY — obeyed literally, causing a new defect), answering tools 1/2 (the miss was grain, not form),
while quality-demand prose bound 0/3 and a whole-skill context injection regressed every axis. External
research agrees from both sides: concrete, itemized context (strategies, failure modes, interface rules) lifts
even small models (ACE, arXiv 2510.04618), while stacked free-form constraints collapse compliance (~81%→37%
from 1→4 constraints; exemplars beat listed rules — MulDimIF, ACL 2026). The discriminator is
**compliance-shaped vs generation-shaped**: an executor can OBEY an action, SELECT from data, FOLLOW a recipe
placed where its procedure forces a visit — it cannot TRANSLATE a described quality property into behavior.

## 2 · Authoring guidance per lever
**1. Data / a menu (strongest).**
- Shape: a staged table/enum the node reads at its decision point; the node's procedure names the read.
- Author exemplar-shaped: each entry carries the pieces that INSTANTIATE it (fields, composes-with, the beat
  it generates), not just a label — a bare label gets name-checked while the stock behavior ships anyway.
- Encode the divergence by construction: name the stock/default entry explicitly and exclude it in the
  selection rule ("pick two, excluding stock, commit the bolder") — never "be creative".
- A property every selected entry must realize (a flip beat, a recurrence) rides the ENTRY as a field the
  procedure realizes, not a separate exhortation.

**2. An answering-service tool `[[model-callable-calculators]]`.**
- Ships the ANSWER (or the measurement) on call; the executor stops re-deriving it per run.
- **Grain law:** the tool must detect at the grain where the defect actually lives. A milestone-grain linter
  is silent on a defect living in band prose; silence at the wrong grain reads as a pass. If the right grain
  is unreachable, the tool is NOT a lever for this issue — say so rather than shipping a silent advisor.
- Advisories report the measurement + location; they never choose the design and never fail the run.
- Test-first, mutation-verified: the firing test watched RED before wiring; invert the condition to prove both
  the fire and the no-false-fire tests bind.

**3. A forced-slot reference.**
- Read-on-demand content binds ONLY in a slot the executor's procedure MUST visit: a numbered decision item
  it walks, a self-critique checklist line it runs, a recipe retrieved by an existing pointer chain.
- The test for "forced": trace the procedure — is there a step that cannot complete without reading this
  content? If not, the same paragraph in the same file is free-floating craft and will not bind (0/1 in the
  audit; the two forced-slot instances bound 2/2).
- Prefer extending an EXISTING forced slot (add a decision item, a checklist line) over creating a new read.

**4. A procedural fence line (always-visible).**
- Binds — LITERALLY. Word it as the exact behavior wanted; a cost heuristic placed here becomes law (the
  audit's first-fit line was obeyed into a stock-output generator). Before adding, ask: "if the executor obeys
  this to the letter in the worst case, what ships?"
- Position: top or end of the surface. Mid-context decays (lost-in-the-middle, arXiv 2307.03172).
- Scope the trigger to survive reordering: key it to "the LAST X", "per item", "on every Y" — a rule keyed to
  one named event fires-and-lapses when the executor reorders its steps.
- Do NOT fix precision/format failures by adding reasoning instructions — added deliberation degrades
  exact-form compliance (arXiv 2606.09662); fix format with structure (schema, fenced shape, de-baited
  surface) instead.

## 3 · Form ↔ failure-type quick table
| the failure is… | compile it as… |
|---|---|
| picks the stock/default option | menu with stock named + excluded by construction |
| re-derives the same answer every run (think-spike) | answering-service tool returning it |
| violates a grammar/contract it never reliably sees | contract hoisted to the guaranteed-read surface + `explain`-style tool |
| skips a required element | required slot in the skeleton/schema (structure), not a reminder |
| does X when it should do Y at a decision point | procedural fence line stating Y as the next action |
| lacks domain craft for a branch it takes | recipe in the branch's forced slot, retrieved by pointer |
| quality property missing (depth, feel, arc) | find the generative MOVE that produces it upstream; encode THAT as data/recipe — never the property |

## 4 · Cost accounting (net always-visible ≤ 0)
- Pay for any new fence line by deleting a weaker one from the SAME surface; record both in the fix note.
- Whole-artifact injection is never the fix for a paging/retrieval problem — the audit's inject arm regressed
  every axis; guarantee the READ of the load-bearing part (hoist the contract, add the tool) instead.
- Growth belongs in read-on-demand homes; standing surfaces only shrink or stay flat. Stacked new constraints
  split across cycles — one factor per cycle also keeps the gate attributable.

## 5 · §Blocked — every demand lever is blocked
When data/tool/forced-slot/fence are all unavailable (blast radius, false-fire risk, fenced files):
1. File the truth-half in its correct home anyway (free; feeds retrieval and the drift gate). It claims nothing.
2. Mark the issue **BLOCKED** with the block named per lever (what blocks it, what would unblock it, at what cost).
3. Escalate the unblock DECISION to the owner with the options costed — do not silently pick the invasive
   unblock, and do NOT downgrade to generation-shaped prose "to have done something" (0/3 in the audit; it
   burns a verify cycle and false-closes the issue).
4. The issue stays open; its signature keeps accruing recurrences while blocked — that rising count is the
   evidence the unblock decision needs.

## 6 · Anti-patterns
- Prose-only quality fix on a weak executor ("the correct home" without a demand lever) — bookkeeping sold as a fix.
- Injecting a whole skill/corpus into standing context to fix retrieval — regresses both fronts.
- Burying the critical rule mid-surface, or keying it to one named event.
- A "be careful / be creative / make it deep" clause anywhere producer-facing — mirrors the judge's language
  and is exactly what gets quoted-and-evaded.
- An advisory tool at a grain that cannot see the defect — silent ≠ pass.
- Parameterizing a bad heuristic (a knob that still defaults to the failure) instead of replacing its shape.
