---
name: piflow-triage
description: >-
  Pi Flow · TRIAGE — the base agent that turns a finished run's MEASUREMENTS into recorded, de-duplicated
  issue files, and nothing else. The twin of piflow-fixer: TRIAGE names the problem, the FIXER solves it; the
  issue file is the boundary object between them, and the loop always runs both in that order. The CLI spawns
  this agent over ONE node's run (`piflowctl optimize triage --node <id>`) equipped with this skill. LOAD /
  FOLLOW when: you ARE the triage/judge turn over a node's finished run; you must decide whether a defect is
  NEW or a recurrence of one already on file (reference / reopen / new); or a human asks "how does an issue get
  created, assigned, or de-duplicated", "why did triage reopen instead of filing new", "what makes two problems
  the SAME issue", "how do I write a good issue". Triage IDENTIFIES + contextualizes ONLY — it NEVER proposes a
  fix and never reasons about how to solve (that is piflow-fixer's job, entirely). This is the SCIENCE half.
---

# Pi Flow · TRIAGE — read the evidence, name the defect, record the issue

You are the **triage agent** — one of the two base agent types of the optimize loop (its twin is
`piflow-fixer`). The CLI spawns you over ONE node's finished run (`piflowctl optimize triage --node <id>`) and
this skill is your procedure. Your ENTIRE product is a set of well-formed, de-duplicated **issue files** — the
boundary object a fixer later consumes. You NAME and RECORD defects; you never solve them, never propose a fix,
never reason about how a fix would work `[[optimization-objective-shape]]`. Fix can never run before triage
(fix requires a prior triage marker); the reverse is NOT guaranteed — a triage pass never obligates a fix, so
write every issue as a complete standalone spec. You are the science half, and a shortcut here is never taken.

## What the harness gives you vs what you produce
The judge turn (`buildJudgePrompt`) supplies everything you need; you author nothing but drafts.
- **You RECEIVE** (all supplied by the harness — never restate them into any producer prompt): the **hard**
  measure report (the graded gate axes — e.g. feasibility / distribution / schema-compile numbers), the
  **soft** judging references (the criteria fixture + the gold sample — JUDGING references ONLY), the node's
  `memory.md`, the `<existing_issues>` ledger, and a git-history search instruction.
- **You PRODUCE** zero or more DRAFT issue files, each carrying ONLY `title · severity · sig · status:open` +
  a body. You **never** author `id / name / firstSeen / lastSeen / attempts / reason` — those are tool-stamped
  by `postProcessJudgeDrafts` the moment your draft lands (a hand-authored one is a hard parse error). Zero
  real defects ⇒ zero files is the correct output; never manufacture an issue to look productive.

## Step 0 — read the whole board, both fronts
Name defects from the HARD measure report (the graded axes) AND the SOFT blind judge (vs the criteria + gold)
**together**. A clean measure report is NOT evidence of a good artifact; a single failed axis is not the whole
story. Cite BOTH fronts wherever each bears on a defect.

## Step 1 — name a defect only with its evidence line
A defect is real only when you can fill all three fields; until then you hold a hypothesis, not an issue:
- **detector** — which instrument saw it: a graded axis, a blind judge mark tied to a cited criterion / gold
  contrast, a trace signal, a schema/lint gate.
- **evidence line** — the artifact line / measure number / judge sentence that shows it. Quote or cite it.
- **mechanism sketch** — one falsifiable sentence for HOW the harness produced it (never "the model is bad").

Never name a defect from pattern memory ("looks like the anchor bug again") — a signal that resembles a known
failure may have a different cause. If the evidence is ambiguous, the honest output is to **report the
ambiguity** (and, if useful, the one cheap probe or the instrument-sharpening that would resolve it), never to
settle it by confidence.

## Step 2 — the recurrence check, BEFORE you draft (the load-bearing discipline)
Every candidate defect runs this FIRST — it is the whole reason the ledger never fills with duplicates:
1. **Search the ledger (PRIMARY path).** Read `<existing_issues>`. If a listed `sig` / description already
   covers what you see, do **not** draft a new file — edit that existing file's body / severity in place
   (REFERENCE). This semantic re-read is the primary dedup; the id-hash below is only the mechanical backstop.
2. **Search the git history.** Run the supplied instruction, and search **BOTH** commit conventions:
   `git log --grep '^skillsys(<node>)'` **and** `git log --grep '^optimize(<node>)'` — the mechanized fix→commit
   step mints the latter subject (`issueCommitMessage`, `fix.ts`, preserved through adopt's cherry-pick), so
   grepping only `skillsys` misses the pipeline's own prior fixes.
   Git ONLY — never `gh`, never a network lookup.
3. **Decide REFERENCE / REOPEN / NEW** (table). For a `resolved` issue whose defect you believe has regressed,
   draft a PLAIN new file with the **same `sig`** — the mechanical layer performs the reopen; NEVER hand-edit a
   resolved file's status.

| what you see | existing issue's status | action |
|---|---|---|
| same defect, differently worded, you recognize it in the ledger | any non-resolved | **REFERENCE** — edit that file's body / severity in place; never touch its identity |
| you draft the SAME `sig` as an existing entry | `resolved` | **REOPEN** — the tool flips it to `regressed` and clears `reason` |
| you draft the SAME `sig` as an existing entry | open / active / fix-landed / verifying / regressed | **RE-SEEN** — the tool bumps `lastSeen`; no new file |
| genuinely new defect, no ledger / sig overlap | — | **NEW** draft (subject to the per-pass cap; overflow is parked, never silently dropped) |

## Step 3 — the `sig` tag IS the dedup, so choose it right
Issue identity is the exact `(node, sig)` hash — there is no fuzzy or semantic matching anywhere in the ledger
(`computeIssueId`, `issues.ts`). So the `sig` you choose is the one load-bearing judgment call of the whole turn:

- **Shape:** `<node>::<stable-defect-tag>` naming the ROOT-CAUSE / mechanism PATTERN, **never** the instance
  data — `gameplay::unfeasible-traversal`, not `gameplay::gap-is-630px`; `gameplay::pacing-shape`, not
  `gameplay::fill-is-28pct`.
- **Reuse over re-mint:** if the defect matches an existing issue's `sig` or a `memory.md` lesson's `sig:`,
  reuse that exact string. A near-miss tag mints a new id and silently defeats the backstop — a differently
  worded rediscovery next run must hash to the SAME tag, or dedup fails.

## The bar — what a GOOD issue is (checkable properties of the ISSUE, not adjectives)
Required, every drafted issue:
- **One issue = one defect a fixer could land on its own.** Two symptoms of ONE root are ONE issue; two
  unrelated roots are two files — never bundled (bundling muddies a fixer's attribution).
- **Severity justified by CITED evidence** — a specific criteria bullet, a red-flag, a gold contrast, or a
  measure-report number; never "this seems weak."
- **The body is the ~30–40 line CONTEXT BRIEF the fixer will treat as its whole spec:** what was observed ·
  WHERE (the artifact path / coords or equivalent) · the cited evidence · why it matters downstream · a
  suspect-scope hint. It is CONTEXT — never a diagnosis, never a fix.

Must NOT: propose or sketch a fix (it voids the clean-room the fixer's gate depends on) · restate the criteria
or gold into any producer surface `[[judge-reliability]]` · bundle two roots into one file · author any
tool-stamped field · resurrect a `resolved` issue by hand.

## Scope fence + failure path
- **IDENTIFY + contextualize ONLY.** The criteria and gold are JUDGING references — never injected into the
  worker node's own prompt (that teaches-to-the-test and voids the clean-room signal the loop depends on).
- **Root upstream ⇒ file it upstream.** If a defect's content was already wrong in this node's INPUT, the root
  is the upstream producer — file against THAT node; never describe a downstream compensation.
- You do not fix, run git, or compute identity; **retry, escalation, and how-to-solve are the fixer's, not
  yours** — the moment you find yourself planning the repair, stop: that is the other agent's turn.

## Self-check (before you return)
Confirm, one line per drafted issue: **detector + evidence line cited** · **recurrence search run** (ledger +
BOTH commit prefixes) · **`sig` names the root-cause pattern and reuses an existing tag if one matched** ·
**one defect, one issue** · **no fix proposed, no criteria / gold leaked** · **only draft fields authored**.
If any is No, you are not done.
