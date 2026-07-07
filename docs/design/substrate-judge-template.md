# The substrate soft-judge — authoring template

> Companion to `docs/specs/optimize-substrate-plan.md` §M4. This is the reusable CONTRACT a product author
> fills in when writing a node's `optimize.judge` file (referenced from `nodes/<id>/node.json`). It is not
> code and it is never executed — `substrate/judge.ts`'s `buildJudgePrompt` reads the resulting file's
> content VERBATIM and embeds it into the live judge agent's prompt, alongside the measure report,
> `memory.md`, the existing-issues ledger, and the git-history instruction it assembles itself. Author the
> judge file to THIS shape; do not repeat the parts `judge.ts` already supplies (see "What judge.ts adds").

## Why this exists

The soft judge is the second half of the substrate's measurement stage (M3 is the hard, mechanical half). Its
ONE job: read what M3 measured plus the node's quality references, and turn "something's off here" into a
concrete, evidence-backed, independently-actionable issue file — never a fix. A vague "review this node and
flag problems" prompt gets you a vague pass (skims the obvious, stops at 1–2 items, invents a fix nobody
asked for). This template exists so every product's judge file states the bar explicitly instead of relying
on the agent to guess it.

## What `judge.ts` adds (so you don't repeat it)

`buildJudgePrompt` wraps your judge file with everything else the agent needs — write your file assuming
these sections already exist ABOVE and BELOW it in the final prompt:

- `<role>` — a one-line frame naming the node being judged.
- `<separation_law>` — the identify-only law (below) — restated so it survives even if your file is skimmed.
- `<measure_report>` — the M3 hard-measurement report for THIS run, embedded verbatim (or a clear
  "NOT AVAILABLE" marker if M3 hasn't run / produced nothing for this node).
- `<memory>` — the node's `memory.md` (Leg-A lessons), if one exists.
- `<existing_issues>` — the CURRENT ledger for this node (name / severity / status / sig / title per row) —
  read this before drafting anything; see `<scope_fence>` below.
- `<git_history_instruction>` — the exact `git log --grep '^skillsys(<node>)'` search to run yourself
  (git only) before concluding something is new.
- `<output_spec>` — the tool's own restatement of the draft frontmatter shape (§ below); your file's own
  `<output_spec>` (if you include one) should match it, not contradict it.

Your file supplies the PRODUCT-SPECIFIC content: what "good" means for this node, where the criteria/gold
live, and how to judge severity. The sections below are what your file should contain.

## Sections your judge file should carry

### `<role>`
Name the node, the standard a senior reviewer of THIS artifact type would hold, and the one job: identify
defects, not fix them. Describe the artifact the node produces, not just a generic "reviewer" label —
naming the artifact does more work than naming a role.

```
<role>You are the quality judge for the "gameplay" node's blueprint output — a senior game-design reviewer
who catches structural and pacing defects a schema check can't see. You identify; you do not fix.</role>
```

### `<inputs>`
Point at the product-specific references the agent must ground its judgment in — paths, not paraphrases.
At minimum:
- **Criteria anchor** — the path (and section/anchor) of this node's quality-bar document.
- **Gold reference(s)** — the path to a canonical exemplar output, if one exists, plus a GOLD-NOTE (what
  the gold demonstrates and does NOT — a gold is a reference point, not a template to imitate literally).
- Anything else the criteria assumes (a schema file, a style guide, a prior milestone's report).

```
<inputs>
Criteria: .agents/skill-system-criteria.md#harden-harden-blueprint — read EVERY bullet, not just the first few.
Gold: eval/gold/platformer/mecha-plumber.blueprint.json — GOLD-NOTE: demonstrates pacing/threat variety at
  this archetype's scale; it is NOT a shape to copy verbatim, and its OMISSIONS are not license to omit.
</inputs>
```

### `<the_bar>` — what makes a GOOD issue (not a good node)
This is the load-bearing section. State it as checkable properties of the ISSUE the agent writes, not
adjectives about the node:
- **Independent, smallest unit** — one issue = one defect a fix could land on its own. Two symptoms of the
  SAME root cause are one issue; two unrelated defects are two, never bundled.
- **Severity justified by evidence** — the issue's body must cite the SPECIFIC measure-report number, criteria
  bullet, or gold contrast that justifies the severity, not "this seems bad."
- **A stable `sig` tag** — `<node>::<short-kebab-tag>`, e.g. `gameplay::pacing-flat-after-room-3`. Stable
  means: the SAME underlying defect, reworded, must hash to the SAME tag next run — name the DEFECT, not the
  symptom's current phrasing (`::wrong-count` survives a rewording of "count is 3" → "count is off by one";
  `::count-is-3-should-be-4` does not).
- **A suspect-scope hint** — one line pointing at where a fixer would likely look (a file, a prompt section,
  a config key) — a hint, not a diagnosis; the fixer still investigates.
- **A ~30–40 line context brief** — the body: what you observed, where, the evidence, why it matters, the
  suspect scope. Long enough to brief a fixer cold; short enough to stay a brief, not an essay.

### `<coverage>` — enumerate, then judge
Never let the agent stop at the first 1–2 obvious defects. Require an enumeration pass BEFORE conclusions:

```
<coverage>First, walk EVERY criteria bullet, every named red flag, and every hard flag in the criteria
document — for each, note pass/fail/uncertain with one line of evidence. Only AFTER that full pass, draft
issues for the failing/uncertain ones. Cap at the <N> most severe if more surface than that — do not silently
truncate the enumeration pass itself, only the issues you draft from it.</coverage>
```
`<N>` is the per-pass cap `judge.ts` also enforces mechanically (default 5) — state the SAME number here so
the agent doesn't over-draft and get silently trimmed; align it with your node's actual `cap` config.

### `<output_spec>` — the EXACT draft shape (repeat it; it is worth repeating)
The agent authors ONLY this subset — `id`/`name`/`firstSeen`/`lastSeen`/`attempts`/`reason` are tool-stamped
by `postProcessJudgeDrafts` and must NEVER appear in a draft:

```
---
title: <one-liner>
severity: critical|high|medium|low
sig: <node>::<stable-tag>
status: open
---
<the ~30–40 line context brief>
```

One file per NEW issue, written under the node's `issues/` directory (any filename — the tool renames it on
mint). To act on an EXISTING issue, edit that file directly instead of drafting a new one (see the scope
fence below) — never hand-author `id`/`name`/dates there either.

### `<scope_fence>`
State these explicitly — they are the law `judge.ts`'s mechanical layer partially backstops, but the agent
should never rely on the backstop:
- **Zero fix proposals.** No patch, no "suggested change" section, no code. An issue that proposes a fix
  fails review — describe the DEFECT and its evidence, nothing else.
- **Reopen-over-create.** Read `<existing_issues>` FIRST. If a listed issue's `sig`/description already
  covers what you're seeing, do NOT draft a new file — edit the existing issue's body/severity in place
  (never its `id`). The tool's hash backstop catches a same-`sig` miss, but the agent's own semantic read is
  the PRIMARY dedup path — don't rely on the backstop to do your job.
- **Never resurrect a `resolved` issue by editing it directly.** A `resolved` issue you believe has
  regressed should be raised as a plain new draft with the SAME `sig` — the mechanical layer reopens it
  (`status → regressed`) for you; do not hand-edit a resolved file's status.
- **Criteria/gold are judging references, never worker instructions.** Nothing here is prompt content for
  the node being judged — it never reaches that node's own runtime prompt.

### `<self_check>` — before returning
Require a pass over what was just drafted, named explicitly (a generic "review your work" yields nothing):

```
<self_check>For each issue you are about to write, confirm: (1) INDEPENDENT — could a fixer land this alone,
without touching another issue's fix? (2) STABLE sig — would a differently-worded observation of the SAME
defect hash to this same tag? (3) EVIDENCED — does the body cite a specific number/bullet/contrast, not a
feeling? (4) NO fix proposal anywhere in the body. Revise or drop any issue that fails one of these before
writing it.</self_check>
```

## Worked example — a complete judge file (game-omni's `gameplay` node)

```
<role>You are the quality judge for the "gameplay" node's blueprint output — a senior game-design reviewer
who catches structural and pacing defects a schema check can't see. You identify; you do not fix.</role>

<inputs>
Criteria: .agents/skill-system-criteria.md#harden-harden-blueprint — read every bullet.
Gold: eval/gold/platformer/mecha-plumber.blueprint.json — GOLD-NOTE: demonstrates pacing/threat variety at
  this archetype's scale; not a shape to imitate literally, and its omissions are not license to omit.
</inputs>

<the_bar>
A good issue is: one independent defect a fixer could land alone; severity justified by a specific
measure-report number or criteria bullet; a stable `gameplay::<tag>` sig naming the DEFECT not its current
phrasing; a one-line suspect-scope hint; a 30–40 line brief a fixer could act on cold.
</the_bar>

<coverage>Walk every bullet in the criteria doc and every named red/hard flag — pass/fail/uncertain with one
line of evidence each — before drafting anything. Cap at the 5 most severe failing/uncertain items.</coverage>

<output_spec>
---
title: <one-liner>
severity: critical|high|medium|low
sig: gameplay::<stable-tag>
status: open
---
<30-40 line brief>
</output_spec>

<scope_fence>Zero fix proposals. Read <existing_issues> first — edit an existing file in place (never its
id) rather than draft a duplicate. Never hand-edit a resolved issue's status — a regression is a new draft
with the SAME sig; the tool reopens it. Criteria/gold here are judging references only.</scope_fence>

<self_check>Before writing, confirm each issue is independent, has a stable sig, cites real evidence, and
proposes no fix. Drop or revise anything that fails.</self_check>
```

## Anti-patterns (do not ship these)

- ❌ `"Review this node's output and flag any problems."` — no bar, no coverage floor, no output shape. Gets
  you 1 vague issue or zero.
- ❌ Repeating `judge.ts`'s own sections (the measure report, the git instruction, the separation law) inside
  your file — it's already there; repeating it wastes tokens and risks drifting out of sync.
- ❌ An issue body that ends with "Suggested fix: …" — a fix proposal in ANY form fails the scope fence, even
  phrased as a suggestion.
- ❌ A `sig` that encodes the CURRENT wording of the symptom (`::thinking-block-is-11-seconds`) instead of the
  defect (`::compose-in-thinking`) — it will never dedupe against a differently-worded rediscovery of the
  same defect.
- ❌ Skipping `<coverage>`'s enumerate-first pass — without it the agent anchors on the first 1–2 obvious
  defects and never surfaces the rest.
