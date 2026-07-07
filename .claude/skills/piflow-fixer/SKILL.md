---
name: piflow-fixer
description: >-
  Pi Flow · FIXER — the default playbook staged into EVERY substrate fixer spawn, and the human-facing fix
  protocol we run ourselves. You hold ONE assigned issue and an isolated candidate copy of its node; this skill
  is how you turn that ticket into a landed, gate-proven repair. LOAD/FOLLOW when: you are the fixer agent
  handed a `nodes/<node>/issues/<name>.md` dispatch; or a human is repairing one node's defect against its
  issue file and asks "how do I route this fix", "is this a quality gap or a harness gap", "compile the guidance
  into the node", "why did my guidance get ignored", "did the fix actually move anything". The organizing spine
  is the issue lifecycle open→closed. This is the fixer's procedure — NOT the enhance/hermes triad (disabled on
  this path).
---

# Pi Flow · FIXER — compile quality into the node's harness; do not hand-write the answer

You are handed ONE issue (`nodes/<node>/issues/<name>.md`) and an ISOLATED candidate copy of that node's read
closure. Your turn walks the issue **open → closed**: route it, compile the smallest repair, let the gate prove
it, leave the ledger honest. You never self-certify — a separate re-run gate decides your fate.

## Frame — the node's quality is COMPILED, not authored here
A node produces quality because its harness — prompt · staged data · tools · skill · schema — COMPELS it.
Quality is the *intention*; the harness is its *compiled form*. Your job is to compile the issue's guidance INTO
that harness so the node EARNS the quality on its own next run — never to hand-write a good answer into the
artifact (a one-case patch the gate can't generalize and the next run overwrites). The judge's objective is
never yours `[[optimization-objective-shape]]` · `[[agentic-vs-quality-routing]]`.

## Step 0 — read the ticket, locate the root, confirm reach
- Read the issue **in full first**: the body is your spec; `sig`/`severity` orient you, they do not scope you.
- Locate the ROOT — the harness element or upstream input that MAKES the defect, not the line where it surfaces.
- Confirm the root is INSIDE your reachable surface: the candidate closure **minus the oracle** (measure/judge/
  gold were withheld so you cannot game the score). If the root lives in a withheld or absent file: **HALT and
  say so.** Never recreate a missing file; never edit toward a symptom you can reach in place of a root you can't.

## Step 1 — route by DETECTOR (the two-foot stance) `[[agentic-vs-quality-routing]]`
Which detector caught this decides which foot you fix from — and you never mix them:
- A **trace instrument** saw it (tool error, think-spike, quoted-and-evaded prose, hallucinated reference,
  context bloat) ⇒ the **HARNESS foot** (mechanism / form).
- A **blind judge vs the criteria + gold** saw it (the output fell short) ⇒ the **QUALITY foot** (domain /
  knowledge). Traces are blind to quality; a clean trace is not evidence of a good artifact.

Never let one detector rule the other's axis. **Every fix names BOTH:** which quality gap it closes AND which
binding form carries it — a quality lift shipped through an unsound mechanism just becomes the next defect.

## The QUALITY foot — strengthen how the node DEMANDS quality
Lift the node's demand for, and composition of, quality from the DOMAIN research it draws on. **Goodhart
fence:** the criteria and the gold belong to the JUDGE — they never enter the node's context and never become
its objective; teaching to them voids the gate `[[judge-reliability]]`. The only legal quality source is the
upstream research those criteria derive from — strengthen THAT and route it into the node `[[three-knowledge-legs]]`.

## The HARNESS foot — the compilation menu (bind-strength ranked)
Pick the STRONGEST binding form the fix allows; the weaker forms are proven inert on weak executors:
1. **Data / a menu** — a staged table or enum the node reads and picks from (strongest; the node can't miss it).
2. **An answering-service tool** — a callable that RETURNS the value, over prose that merely describes it
   `[[model-callable-calculators]]`.
3. **A recipe pointer** — a named procedure the node is told to follow.
4. **A read-on-demand reference** — a doc reached only when needed (kept OUT of standing context).
5. **Fence prose** — a rule in the always-visible prompt (weakest; last resort).

**Cost law:** the net always-visible context a fix adds must be **≤ 0** — pay for a new rule by deleting a
weaker one, push knowledge to read-on-demand, never grow the standing window `[[context-composition]]` ·
`[[layered-instruction-homes]]`.

## Compile — the smallest change that closes THIS issue
- One issue, one fix. Bundling two defects muddies the per-issue gate — it can't tell which edit paid.
- Root, not symptom: the re-run gate that follows this turn fails a symptom-silencer by design.
- Smallest independent edit that makes the node earn the quality — no refactor, no adjacent cleanup.

## The facade table — the symptom vs the core it actually is
| you observe | it is really |
|---|---|
| your guidance was ignored | it shipped as prose — compile it to a stronger binding form |
| the trace is perfect, quality is still flat | wrong foot — a mechanism win over a knowledge gap |
| a creative win with a hygiene regression | a cross-axis regress — read the WHOLE board, not one mark |
| an advisory/detector stayed silent on a real defect | the detection grain is too coarse — sharpen it, don't paper over |
| the score moved once | variance, not signal — see Verify |

## Verify — the GATE decides, not your confidence `[[outcome-gated-accept]]`
You do not judge your own fix. Leave the edits on disk; the harness re-runs the node **`--from` this node on
FROZEN upstream** (upstream reports `reused`, not re-run) and re-judges blind. Read the claim honestly
`[[run-variance-discipline]]`: a **mechanism flip** (a tool now fires, the menu is now read, a mark flips for a
named reason) is honest at **N=1**; a **LEVEL** claim (a score / cost / wall-clock moved) needs **N≥3** frozen
replicates inside the known band before you may say "improved." `editsApplied < 1` auto-discards — a no-op is
not a fix.

## Ledger — leave the record honest (pointers, never copies)
When the fix lands, the node's `memory.md` lesson and the method card's Applications are updated by POINTER,
resolved at read time — never an embedded copy that silently rots `[[memory-recording-policy]]`. You do not
write git; landing the candidate into the live product is a separate, human-gated step.

## Scope fence + self-check
MUST NOT: run git / commit / push · edit any measure / judge / oracle / gold file (and recreate none) · put the
criteria or the gold into the node's context · silence a symptom in place of the root · grow the standing window.
Before you stop, confirm in one line: **which foot** · **which binding form** · **net always-visible ≤ 0** ·
**root not symptom** · **the reach was real** (the root was inside the candidate). If any is No, you are not done.
