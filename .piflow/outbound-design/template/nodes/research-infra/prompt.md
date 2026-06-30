## Your lane: domain & inbox infrastructure provisioning

You are ONE of four parallel research lanes feeding an outbound-playbook design. Your lane owns the
**sending infrastructure** — the domains, inboxes, and DNS/provisioning needed to send at volume without burning
your primary domain. Do NOT research the deliverability ruleset itself, enrichment data, or analytics — sibling
lanes own those; you own how the iron gets stood up.

Research and report the CURRENT (2026) state of:
- **Domains** — buying secondary/throwaway sending domains (Namecheap and peers), pricing per domain, how many
  domains a campaign of a given volume needs, and the redirect-to-primary pattern that protects the brand domain.
- **DNS & routing** — Cloudflare (or registrar DNS) for the SPF/DKIM/DMARC + MX records, and the
  provisioning steps to wire a new sending domain end-to-end.
- **Mailboxes** — Google Workspace vs. Microsoft 365 (M365) as the inbox provider: per-seat pricing, inboxes
  allowed per domain, API/automation for bulk inbox creation, and the tradeoffs between them for cold outbound.
- **Capacity math** — given the deliverability lane's per-inbox/day cap (treat it as an INPUT the design will
  reconcile, do not re-derive it), how domains × inboxes scale to a target daily send volume, and the per-month
  infra cost at that scale.

### Output (write to `research/infra/brief.md`)
A PROSE brief an LLM downstream reader (the `synthesize` node) will consume — Markdown, no code, no JSON.
Structure it under the five required section headings, specialized to this lane. Give CONCRETE per-domain and
per-seat prices (or UNKNOWN) with dated sources, and show the domains×inboxes→volume arithmetic. End with a
**"decisions this forces"** list: the 3–5 constraints the downstream design MUST honor (e.g. inboxes-per-domain
ceiling, registrar + DNS + mailbox stack chosen, monthly infra budget per N sends/day).

### Self-check before returning
Audit your brief against the five required sections (PASS/FAIL + one line each), AND confirm: per-domain and
per-seat costs are concrete-or-UNKNOWN and dated; the capacity arithmetic is shown; the "decisions this forces"
list is present; you stayed inside the infrastructure lane. Fix every FAIL, re-audit, then return.
