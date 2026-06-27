# Cloud Sandbox Network Egress — the tier gate, the MCP implication, and the provider landscape

**Date:** 2026-06-26
**Status:** research finding (feeds the multi-provider portability plan)
**Context:** the `--sandbox daytona` path (branch `feat/sandbox-daytona-m1`) went RED against a custom LLM
gateway (`minnimax.chat`). This note records WHY — the real mechanism, two corrections to the earlier
ad-hoc investigation, and what it means for the architecture's reliance on outbound MCP tool access.

## TL;DR
- The Daytona sandbox is **not** cut off from the internet. Egress passes through a **runner-side firewall
  gated by the org's billing tier**. On **Tier 1 & 2** the egress policy is fixed at the org level and
  **cannot be overridden per-sandbox**; on **Tier 3 & 4** full internet is the default and per-sandbox
  config is honored. (Daytona docs, "Network Limits (Firewall) → Tier-based network restrictions".)
- **"Essential services" are allowlisted on ALL tiers**: package registries (pip/npm), container
  registries, git repos, CDNs, system package managers. So you can *install and launch* tools on any tier;
  what you cannot do on Tier 1/2 is reach an **arbitrary custom host**.
- **Daytona is the outlier.** Most agent-sandbox providers default to **open egress** (E2B, Modal). E2B
  ships `allowInternetAccess: true` and exposes per-sandbox allow/deny lists (allow takes precedence).
  Locked-allowlist-by-default networking is the minority (E2B/Vercel/Northflank/Blaxel offer it as opt-in).

## The mechanism (authoritative)
From `https://www.daytona.io/docs/en/network-limits/`:

> **Tier 1 & Tier 2:** Network access is restricted and cannot be overridden at the sandbox level.
> Organization-level network restrictions take precedence over sandbox-level settings. Even with
> `networkAllowList` or `domainAllowList` specified when creating a sandbox, the organization's network
> restrictions still apply.
> **Tier 3 & Tier 4:** Full internet access is available by default, with the ability to configure custom
> network settings.
> **Essential services** are available on all tiers: package registries, container registries, Git
> repositories, CDN services, platform services, and system package managers.

Per-sandbox knobs (honored only on Tier 3/4): `networkAllowList` (IPv4 CIDR, ≤10 entries),
`domainAllowList` (domains + wildcards), `networkBlockAll` (block-all; precedence over the allow lists).
Org-level default exists too (`/organizations/{id}/sandbox-default-limited-network-egress`).

## Two corrections to the earlier investigation
1. **`domainAllowList` IS a real platform parameter** (domains + wildcard domains). The earlier conclusion
   "the SDK has no domainAllowList" was about our *pinned* `@daytona/sdk@0.185.0` not exposing it — the
   platform/API supports it. So "domainAllowList isn't real" was wrong; "our SDK version can't express it"
   is the accurate statement.
2. **The earlier empirical tests were likely false readings.** E2B's own docs warn: *"a TCP connection can
   succeed and report the socket as open even when the destination is denied — no packets reach it. Verify
   with an application-level response (HTTP status / TLS handshake), not a successful socket."* The
   "anthropic still reachable with `networkBlockAll=true`" observation has exactly this shape. The clean
   statement needs no per-host theory: on Tier 1/2, **nothing set at the sandbox level applies at all**.

To get ground truth for our account, probe at the **application layer**, not the socket:
`curl -sS -o /dev/null -w "%{http_code}\n" <url>` against (a) pypi [essential], (b) the LLM provider,
(c) the custom gateway — and read the actual tier at `app.daytona.io/dashboard/limits`.

## The MCP implication (why this matters for the architecture)
The firewall is **protocol-blind** — it sees destination `host:port`, not "this is MCP." So MCP tool access
splits by transport:

| MCP transport | Needs egress? | Daytona Tier 1/2 | E2B-default / Daytona Tier 3-4 |
|---|---|---|---|
| **stdio** (server spawned as a subprocess inside the sandbox) | No (pipes) | ✅ launches; `npx`/`pip` install works via essential-services | ✅ |
| **stdio that calls out** (web-search / API-calling tool) | Yes (the tool's own egress) | ⚠️ launches, but its call to a custom host is **blocked** | ✅ |
| **remote HTTP/SSE MCP** (e.g. a self-hosted OpenClaw gateway on another server) | Yes (the transport *is* outbound HTTPS) | ❌ **blocked** — same wall as the LLM gateway | ✅ |

**Consequence:** piflow's thesis — one real pi per node with *heterogeneous* MCP tools — depends on
outbound reach to *arbitrary* hosts. A default-restricted, tier-gated backend is hostile to that thesis.
A self-hosted remote MCP gateway is blocked on Daytona Tier 1/2 exactly like the LLM gateway was.
**Do not pin the network model to Daytona's low tier.** Treat egress as a per-node capability (piflow
already models per-node `readScope`/`writeScope`) over a backend that defaults open and lets *us* set the
allowlist — which is E2B's model.

Security caveat (from the Reddit/landscape scan): a **public** MCP gateway is itself an attack surface —
e.g. the "ClawBleed" CVE on an open-source agent gateway (~42k exposed instances) and repeated Claude Code
egress-policy bypasses (SOCKS5 hostname null-byte injection). If we expose OpenClaw, put auth in front of it.

## Provider network landscape (egress posture)
- **Daytona** — tier-gated; default-restricted on Tier 1/2; per-sandbox config only on Tier 3/4. *Outlier.*
- **E2B** — open by default (`allowInternetAccess: true`); per-sandbox allow/deny (IP/CIDR/domain), allow
  precedence; MCP servers reach external services out of the box.
- **Modal** — open egress by default.
- **Vercel Sandbox** — per-domain egress allow-list; deny overrides allow (opposite precedence to E2B).
- **Northflank / Blaxel** — locked allow-list networking available.
- General market doctrine: "full open egress: most by default"; allow-lists are a security opt-in.

## Decision implied by this finding
1. Keep Daytona as ONE backend, but stop treating its low-tier egress as a blocker to "fix in code" — it is
   an account-tier action (upgrade to Tier 3/4, or org allowlist). The `domainAllowList` wire-in is small
   *once the tier permits it* (and requires bumping `@daytona/sdk` past 0.185.0 to expose the field).
2. Add **E2B** as the default-open-egress backend so heterogeneous/remote MCP works without a tier gate.
   This is the real unblock for the MCP value prop. (See the portability plan / reuse audit.)

## Sources
- Daytona Network Limits (Firewall): https://www.daytona.io/docs/en/network-limits/
- Daytona OpenAPI (network-settings, sandbox-default-limited-network-egress): https://www.daytona.io/docs/openapi.json
- E2B Internet Access: https://e2b.dev/docs/sandbox/internet-access
- E2B granular egress (allow/deny, TCP-false-positive caveat): https://x.com/e2b/status/1990782187994575345
- Vercel Sandbox vs E2B: https://vercel.com/kb/guide/vercel-sandbox-vs-e2b
- Sandbox provider comparison: https://www.vibereference.com/ai-development/code-execution-sandbox-providers
- Reddit (egress-as-security-feature + gateway CVEs): r/AI_Agents "Every cloud sandbox has a front desk";
  "Two Claude Code sandbox bypasses"; r/LocalLLaMA "YSA".
