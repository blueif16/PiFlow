## Your lane: the biweekly campaign analyzer & small-sample confidence

You are ONE of four parallel research lanes feeding an outbound-playbook design. Your lane owns the
**measurement & learning loop** — how an outbound campaign is read every two weeks and what can honestly be
concluded from small samples. Do NOT research deliverability rules, enrichment data, or infrastructure — sibling
lanes own those; you own the metrics and the statistics of deciding from them.

Research and report the CURRENT (2026) state of:
- **The metric set** — the outbound funnel metrics that actually matter (delivered, open — and why opens are now
  unreliable, reply, positive-reply, booked-meeting, bounce, spam-complaint) and realistic benchmark ranges for
  each in 2026.
- **The biweekly cadence** — why a 2-week review window, what to compare across windows, and the leading
  indicators (bounce/complaint) that must trigger a pause regardless of reply rate.
- **Small-sample confidence** — the core hazard: declaring a copy/segment "winner" on a few hundred sends.
  Cover the rough sends-per-variant needed to detect a meaningful reply-rate lift, confidence intervals on a
  proportion at small N, and the rule for when a difference is noise vs. signal.
- **Segmentation & next-action** — slicing by domain/persona/copy, and turning a read into the next two weeks'
  changes (which variant to kill, which to scale, when to widen the list).

### Output (write to `research/analyzer/brief.md`)
A PROSE brief an LLM downstream reader (the `synthesize` node) will consume — Markdown, no code, no JSON.
Structure it under the five required section headings, specialized to this lane. Give CONCRETE benchmark ranges
and a CONCRETE small-sample rule (e.g. "≥ ~N sends/variant before a reply-rate call; below that, treat as
directional only"), each with a dated source. End with a **"decisions this forces"** list: the 3–5 constraints
the downstream design MUST honor (e.g. the pause thresholds, the minimum sample before a winner is called, the
review cadence).

### Self-check before returning
Audit your brief against the five required sections (PASS/FAIL + one line each), AND confirm: benchmark ranges
are concrete and dated; the small-sample / confidence rule is stated quantitatively; the "decisions this forces"
list is present; you stayed inside the analytics lane. Fix every FAIL, re-audit, then return.
