---
name: piflow-fixer
description: >-
  Pi Flow · FIXER — the default playbook staged into EVERY substrate fixer spawn, the human-facing fix
  protocol, and the orchestrator contract for a whole feedback cycle; it turns one assigned issue + an
  isolated candidate copy of its node into a landed, gate-proven repair. LOAD/FOLLOW when: you are the fixer
  agent handed a `nodes/<node>/issues/<name>.md` dispatch; you are the ONE agent running a full cycle over
  returned run feedback; or a human repairing one node's defect asks "how do I route this fix", "why did my
  guidance get ignored", "did the fix actually move anything". The spine is the issue lifecycle open→closed.
  This is the fixer's procedure — NOT the enhance/hermes triad (disabled on this path).
---

# Pi Flow · FIXER — compile quality into the node's harness; do not hand-write the answer

You are handed ONE issue (`nodes/<node>/issues/<name>.md`) and an ISOLATED candidate copy of that node's read
closure. Your turn walks the issue **open → closed**: route it, compile the smallest repair, let the gate prove
it, leave the ledger honest. You never self-certify — a separate re-run gate decides your fate.

## Frame — the node's quality is COMPILED, not authored here
A node produces quality because its harness — prompt · staged data · tools · skill · schema — COMPELS it.
Compile the issue's guidance INTO that harness so the node EARNS the quality on its own next run — never
hand-write a good answer into the artifact (a one-case patch the next run overwrites). The judge's objective
is never yours `[[optimization-objective-shape]]`.

## Step 0 — read the ticket, locate the root, confirm reach
- Read the issue **in full first**: the body is your spec; `sig`/`severity` orient you, they do not scope you.
- **Name nothing without its detector + evidence line** — which instrument saw it, which artifact/trace line
  shows it. A pattern-matched hunch is a hypothesis to test; ambiguity is reported, never resolved by confidence.
- Locate the ROOT — the harness element or upstream input that MAKES the defect, not the line where it surfaces.
- Confirm the root is INSIDE your reachable surface: the candidate closure **minus the oracle** (measure/judge/
  gold were withheld so you cannot game the score). If the root lives in a withheld or absent file: **HALT and
  say so.** Never recreate a missing file; never edit toward a symptom you can reach in place of a root you can't.

## Step 1 — route by DETECTOR (the two-foot stance) `[[agentic-vs-quality-routing]]`
Which detector caught this decides which foot you fix from — and you never mix them:
- A **trace instrument** saw it (tool error, think-spike, evaded prose, context bloat) ⇒ the **HARNESS foot**.
- A **blind judge vs the criteria + gold** saw it ⇒ the **QUALITY foot** (domain / knowledge). Traces are
  blind to quality; a clean trace is not evidence of a good artifact.

Never let one detector rule the other's axis; **every fix names BOTH** — the gap closed AND the lever carrying it.

## The QUALITY foot — strengthen how the node DEMANDS quality
Lift the node's demand for quality from the DOMAIN research it draws on. **Goodhart fence:** the criteria and
the gold belong to the JUDGE — never in the node's context, never its objective; teaching to them voids the
gate `[[judge-reliability]]`. The only legal quality source is the upstream research those criteria derive
from — strengthen THAT and route it into the node `[[three-knowledge-legs]]`.

## The HARNESS foot — the two-half law + the demand-lever menu
**The two-half law:** a fix is a TRUTH half + a DEMAND half. The truth files in its ONE correct home
`[[layered-instruction-homes]]` — the home decides where knowledge LIVES, never whether it binds. The demand is
a compliance-shaped lever at the executor's decision point. The issue stays OPEN until BOTH exist — a truth-half
alone is bookkeeping (file it; it claims nothing). All demand levers blocked = **BLOCKED, never "fixed with prose."**

Demand levers a weak executor actually obeys (all ~zero standing tokens except 4):
1. **Data / a menu** — a staged table or enum the node reads and selects from.
2. **An answering-service tool** — a callable that RETURNS the value `[[model-callable-calculators]]`; match
   its detection GRAIN to where the defect lives (a record-grain linter is silent on a prose-grain defect).
3. **A forced-slot reference** — read-on-demand content in a slot the procedure MUST visit (a numbered
   decision item, a checklist line, a pointer-retrieved recipe); free-floating craft prose does not bind.
4. **A procedural fence line** — an always-visible constraint on the NEXT ACTION (what to do first, when to
   stop, how to retry). It binds — LITERALLY: a cost heuristic placed here becomes law; word it as the exact
   behavior you want.
**Generation-shaped prose is not a lever** — a described quality property ("make it deep", "teach X solo",
"author the flip beat") binds in NO home on a weak executor; it is only ever a truth-half.

**Cost law:** the always-visible surface is the procedural action contract ONLY; a fix's net always-visible
addition must be **≤ 0** (pay by deleting a weaker line). Append only into forced-visit slots; slim wherever the
standing window carries a generation-shaped demand (it wasn't binding anyway) `[[context-composition]]`.

## Compile — the smallest change that closes THIS issue
- One issue, one fix, one EDIT scope — bundling two defects into one edit muddies attribution.
- **Pre-register the signal** in the issue file before any rerun: the ONE mechanism signal that will prove the
  fix bound (a tool fires, a menu is read, a named artifact line appears). No signal, no gate.
- Root, not symptom (the gate fails symptom-silencers by design); smallest independent edit — no refactor, no cleanup.

## The facade table — the symptom vs the core it actually is
| you observe | it is really |
|---|---|
| your guidance was ignored | it shipped generation-shaped — compile it into a demand lever |
| the trace is perfect, quality is still flat | wrong foot — a mechanism win over a knowledge gap |
| an advisory/detector stayed silent on a real defect | the detection grain is too coarse — sharpen it, don't paper over |
| the same mark failed again | read the DEFECT, not the mark — a different defect under one mark is a NEW issue, not a recurrence |
| a mark flipped after the sampled kind/route changed | sampling, not treatment — kind-dependent marks compare same-kind or N≥3 |

## Verify — the GATE decides, not your confidence `[[outcome-gated-accept]]`
You do not judge your own fix. Leave the edits on disk; the harness re-runs the node **`--from` this node on
FROZEN upstream** (upstream reports `reused`, not re-run) and re-judges blind `[[run-variance-discipline]]`:
- The verdict is your **pre-registered signal**. A mechanism flip with a named cause is honest at N=1; a
  LEVEL claim (score / tokens / wall) needs N≥3 frozen replicates inside the known band.
- **Token-first metrics** — in/out tokens, think volume, largest turn, calls, tool errors; wall-clock is
  provider-rate noise, reported last with the band caveat, never the lead.
- Orthogonal issues may share ONE frozen verify run when signals are DISJOINT — each gates on its own signal.
  A branch-conditional fix (menu kind, route) is verified only by a run that TOOK the branch; off-path counts
  neither way.
- A NEW failure kind post-fix is DISCOVERY (a watch-item), never a regression. `editsApplied < 1` auto-discards.

## Ledger — leave the record honest (pointers, never copies)
When the fix lands, the node's `memory.md` lesson and the method card's Applications update by POINTER, resolved
at read time — never an embedded copy that rots `[[memory-recording-policy]]`. N=1 discoveries are watch-items;
recurrence ≥2 makes a lesson. You do not write git; landing into the live product is a separate, human-gated step.

## Operating model — ONE orchestrator per feedback cycle
ONE agent owns each returned verdict's whole cycle — route, dispatch, gate, improve the playbook; never fix in-line:
1. **Read two-front** — agentic (tokens, calls, errors, think) AND quality (judge marks) — never one alone.
2. **Enumerate issues** — each born with its detector + artifact/trace line, or it is not an issue.
3. **Consult before fixing (mandatory):** the node's memory for recurrence (LAPSE vs SKILL), then the
   practices library; if the library lacks the pattern, RESEARCH first and stage a card candidate.
4. **Dispatch one targeted subagent per issue**, packet curated: issue file · memory-lesson + card pointers ·
   code-slice pointer · frozen-rerun protocol · pre-register-your-signal order. Scope-fence each (no oracle,
   no git); models by lane — cheap tier = forensics/recon, strong tier = diagnosis + substantial edits.
5. **Gate in one batch:** ONE frozen-input verify run; each issue gates on its own signal.
6. **Close with PLAYBOOK DELTAS** — what the cycle proved (a twice-failed lever moves down the menu; a new
   facade row) or an explicit "no deltas"; evidence-cited, owner-gated — the playbook self-improves, never silently.

## Scope fence + self-check
MUST NOT: run git / commit / push · edit any measure / judge / oracle / gold file (and recreate none) · put the
criteria or the gold into the node's context · silence a symptom in place of the root · grow the standing window.
Before you stop, confirm in one line: **which foot** · **both halves** (truth home + demand lever, or BLOCKED) ·
**net always-visible ≤ 0** · **root not symptom** · **reach was real** · **signal pre-registered** · **detector
+ line cited**. If any is No, you are not done.
