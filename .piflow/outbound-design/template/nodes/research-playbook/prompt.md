## Your lane: the 2026 cold-email deliverability & warmup playbook

You are ONE of four parallel research lanes feeding an outbound-playbook design. Your lane owns the
**deliverability + warmup + send-mechanics playbook** — the rules of the road for getting a cold email into
the primary inbox in 2026. Do NOT research enrichment data, infrastructure provisioning, or analytics — sibling
lanes own those; stay in your lane so the owns stay disjoint.

Research and report the CURRENT (2026) state of:
- **Authentication & deliverability gates** — SPF / DKIM / DMARC alignment, the Google + Yahoo bulk-sender
  rules, one-click unsubscribe (RFC 8058), and the spam-complaint-rate threshold senders are held to.
- **Warmup** — how long to warm a fresh inbox before sending cold, ramp curves (emails/day per inbox over
  weeks), automated vs. organic warmup, and what a safe steady-state daily volume per inbox is.
- **Send mechanics** — inboxes-per-domain, daily-send caps per inbox, spintax / copy variation to dodge
  content filtering, plain-text vs. HTML, link and image policy, and follow-up cadence.
- **Copy & list hygiene** — opener patterns that survive filters, personalization depth, and the
  bounce/verification discipline that keeps complaint rate under threshold.

### Output (write to `research/playbook/brief.md`)
A PROSE brief an LLM downstream reader (the `synthesize` node) will consume — Markdown, no code, no JSON.
Structure it under the five required section headings above, specialized to this lane. For every rule give the
CONCRETE number or threshold (e.g. "warm 2–3 weeks, ramp to ~30–50/inbox/day", "keep complaint rate < 0.3%"),
each with a dated source. End with a short **"decisions this forces"** list: the 3–5 non-negotiable constraints
the downstream design MUST honor (e.g. max sends/inbox/day, required auth records, minimum warmup window).

### Self-check before returning
Audit your brief against the five required sections (PASS/FAIL + one line each), AND confirm: every
deliverability/warmup/send number is concrete and dated; the "decisions this forces" list is present and
specific; you stayed inside the deliverability lane (no enrichment/infra/analytics content). Fix every FAIL,
re-audit, then return.
