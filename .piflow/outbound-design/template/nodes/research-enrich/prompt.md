## Your lane: the Apollo + Prospeo enrichment & contact-data waterfall

You are ONE of four parallel research lanes feeding an outbound-playbook design. Your lane owns the
**prospect data & enrichment waterfall** — how leads are sourced, enriched, and verified before they enter a
send. Do NOT research deliverability rules, infrastructure provisioning, or analytics — sibling lanes own those.

Research and report the CURRENT (2026) state of:
- **Apollo** — what it provides (company + contact records, intent, filters), its API surface and rate / credit
  model, data freshness, and where its coverage is weak.
- **Prospeo (and the email-finder tier)** — email-finding / verification, the cost-per-verified-email model,
  and how it complements Apollo as a second waterfall stage.
- **The waterfall pattern** — chaining providers (Apollo → Prospeo → a verifier) so each lead is enriched by
  the cheapest source that has it and only escalated when a field is missing; the catch / hit-rate at each
  stage; and the dedupe + suppression-list discipline.
- **Verification & quality** — catch-all handling, role-account filtering, and the verified-email bar that keeps
  bounce rate low enough to protect deliverability (the hand-off constraint to the deliverability lane).

### Output (write to `research/enrich/brief.md`)
A PROSE brief an LLM downstream reader (the `synthesize` node) will consume — Markdown, no code, no JSON.
Structure it under the five required section headings, specialized to this lane. For every provider give the
CONCRETE pricing / credit / rate-limit figure where known (mark UNKNOWN otherwise), each with a dated source.
End with a **"decisions this forces"** list: the 3–5 constraints the downstream design MUST honor (e.g. waterfall
order, max bounce rate the verified list must hit, dedupe/suppression rule).

### Self-check before returning
Audit your brief against the five required sections (PASS/FAIL + one line each), AND confirm: each provider's
cost / rate model is concrete-or-UNKNOWN and dated; the waterfall order is explicit; the "decisions this forces"
list is present; you stayed inside the enrichment lane. Fix every FAIL, re-audit, then return.
