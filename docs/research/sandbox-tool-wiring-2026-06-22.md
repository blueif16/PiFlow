# Wiring function tools to sandboxed agents — production patterns (2026-06-22)

How to wire **function/tool execution** to AI agents that run **inside sandboxes**, across BOTH local
process-sandboxes (in-memory / seatbelt / git-worktree on a trusted host) AND cloud microVMs (E2B,
Daytona, Modal, Fly Machines, Firecracker, Cloudflare). The decision under test: **where does the tool/MCP
server live relative to the sandbox, and how does the sandboxed agent reach it?** Driven by the live finding
that reusing OpenClaw as a tool gateway is a **343 MB** install — infeasible to bake into every cloud
microVM (see `docs/research/openclaw-plugin-sourcing-2026-06-21.md` + the OpenClaw-as-MCP-gateway spike).

**Method:** Exa + Reddit fan-out (no YouTube), 13+ sources, 2025–2026 material. **Confidence legend:**
`[PRIMARY]` = vendor doc / spec · `[SECONDARY]` = engineering blog / write-up · `[SENTIMENT]` =
Reddit/practitioner · `[UNVERIFIED]` = no strong primary source.

**Headline verdict:** our direction — a **thin in-sandbox MCP client + a shared, remote HTTP gateway for
cloud, with stdio reserved for local providers** — is the **converging industry default.**

---

## 1. Patterns (where the server lives)

**A. Server-in-sandbox via stdio (baked into the image).** The MCP server binary ships inside the sandbox;
the agent spawns it and speaks JSON-RPC over stdin/stdout. *Best fit:* local trusted host, and per-user
"run untrusted tools" cloud sandboxes — **E2B's `e2b-mcp` does exactly this**, installing + running the
server in a Firecracker microVM per call. *Tradeoffs:* zero network/auth handshake, free process+fault
isolation, sub-ms warm latency; BUT 200–400 ms cold start per spawn, no transport auth (env-var creds only),
no central audit, and **you must install the binary in every microVM** — fatal for a heavy (343 MB) gateway
at fan-out. `[SECONDARY: TrueFoundry]` `[PRIMARY-adjacent: github.com/cased/e2b-mcp]`

**B. Remote HTTP MCP (egress to a shared server).** Sandbox holds only a thin client; it makes an outbound
Streamable-HTTP call with `Authorization: Bearer` to a server hosted elsewhere. *Best fit:* cloud microVMs at
scale. *Tradeoffs:* one cold start amortized across all callers, shared hot caches (a 200 MB graph held by 2
replicas, not N), centralized identity/RBAC/audit/rate-limit; costs ~5–10 ms same-DC overhead (negligible vs
the LLM call) + an ingress to operate. `[SECONDARY: TrueFoundry]` `[PRIMARY: Cloudflare enterprise-MCP]`

**C. MCP gateway / tool broker (one gateway OUTSIDE, many clients IN).** A proxy aggregates many upstream
servers behind one endpoint, doing auth, audit, tool-filtering, secret injection. *Best fit:* any
multi-server / multi-tenant deployment, local or cloud. *Tradeoffs:* solves tool-schema context bloat +
credential sprawl + discovery; single chokepoint to run/secure. Gateways require an HTTP-facing transport —
**stdio servers get wrapped with `mcp-proxy` first.** `[SECONDARY: TrueFoundry §8]` `[PRIMARY: Docker
MCP Gateway]`

**D. "Code Mode" — sandbox isolated from the internet, tools reached via an RPC callback.** The agent writes
code in a sandbox whose only outside access is a generated, typed **tool API**; it calls RPC back to the
agent/gateway loop, which dispatches to the real MCP server (outside). *Best fit:* cloud + edge — this is
**Cloudflare's and Anthropic's recommended direction.** *Tradeoffs:* **94–99.9 % tool-context token
reduction**, keeps data/PII out of the model, strong egress control; needs a secure code sandbox.
`[PRIMARY: Cloudflare blog/code-mode + enterprise-mcp]` `[PRIMARY: Anthropic code-execution-with-MCP]`

> **Convergence note (ours):** OpenClaw **already ships Code Mode** (`docs/reference/code-mode.md`: the model
> sees only `exec`/`wait`; real tools are hidden behind a guest catalog the generated code calls). So adopting
> OpenClaw as the shared remote gateway gives us pattern **C + D** in one MIT package — the exact recommended
> architecture, not a workaround.

**E. Per-server container sidecar (Docker).** Each upstream runs in its own container with cgroup limits +
per-server network allowlist + quarantine-by-default, behind the gateway. *Best fit:* production
multi-tenant gateways handling untrusted servers. *Tradeoffs:* strongest blast-radius/network isolation;
hundreds-of-ms start + tens-of-MB each. `[SECONDARY: mcpproxy "Three Sandboxes"]` `[PRIMARY: Docker MCP
Gateway]`

## 2. What real platforms do

| Platform | Tool-execution pattern | Source |
|---|---|---|
| **E2B** | Run the MCP server *inside* the Firecracker sandbox (stdio), install per-sandbox, auto-cleanup | github.com/cased/e2b-mcp `[PRIMARY-adj]` |
| **Cloudflare Agents** | Code Mode: sandbox isolated from internet; tools = TS API that RPCs back to the agent loop → MCP servers outside; V8 isolates per run | blog.cloudflare.com/code-mode; /enterprise-mcp `[PRIMARY]` |
| **Anthropic / MCP** | Tools-as-code-API on a filesystem; intermediate results stay in the exec env; `sandbox-runtime` wraps seatbelt/Landlock for the *process* | anthropic.com/engineering/code-execution-with-mcp `[PRIMARY]` |
| **Daytona** | Ships an MCP server so *external* agents manage sandboxes (create/exec/files) — the **inverse** direction; NOT tool-calls-from-inside | deepwiki.com/daytonaio/docs `[PRIMARY]` |
| **Docker** | MCP Gateway: shared gateway runs catalog servers as containers; secrets + interception centralized | github.com/docker/mcp-gateway `[PRIMARY]` |
| **Composio / Smithery / Arcade / Lunar / TrueFoundry** | Managed/self-host remote gateway; per-user HTTP endpoints; managed OAuth across many toolkits | mcp.directory; truefoundry.com; lunar.dev `[SECONDARY]` |
| **Modal** | Not independently confirmed — appeared only in third-party comparisons | `[UNVERIFIED]` |

## 3. Secrets — keep keys OUT of the sandbox

- **Broker holds creds; agent gets a reference / short-lived token**, never the raw secret. `[SECONDARY:
  ars-system/mcp-credentials-broker; apistronghold session-scoped credentials]`
- **Gateway injects creds at the egress boundary**, swapping inbound identity for a downstream credential —
  agent code never sees it; rotation is one update. `[SECONDARY: TrueFoundry §5]` `[PRIMARY: Cloudflare
  Access as OAuth provider]`
- **Resolve-at-runtime from a vault, discard immediately; scope by identity, not just hide.** Values live in
  Vault/AWS/GCP/Azure SM, decrypted in memory per authenticated user, never logged. `[SECONDARY: lunar.dev]`
- **Tokenize PII before it reaches the model**; un-tokenize only at the downstream tool call. `[PRIMARY:
  Anthropic]`

> **Delta vs our current plan:** our `tool-bridge-env` design carries `$VAR` *references* in `_pi/mcp.json`
> and injects the real secret into the cloud node's env (allowlisted). The research says go one step further
> for cloud: **don't put the Bearer in the microVM at all** — issue a scoped reference and let the gateway
> swap it for the real downstream credential.

## 4. Cold-start / perf / footprint

Per-call over HTTP is ~5–10 ms same-DC — **noise** beside the tool's own work (an LLM call, a scrape, a
vector query) and the agent's model call. The real axis is footprint: a per-sandbox server multiplies
install size + cold start by N; a shared gateway amortizes one boot and shares hot caches across all
callers. For a 343 MB gateway this is decisive. `[SECONDARY: TrueFoundry; mcpproxy]`

## 5. Verdict + refinements

**YES — our direction is correct and is the converging default:** a thin in-sandbox MCP client + a shared
remote HTTP gateway for cloud, stdio only for local. The 343 MB-per-microVM problem is precisely why the
server belongs outside (E2B's in-sandbox model doesn't scale for a heavy gateway). Highest-leverage
refinements, in order:

1. **Adopt Code Mode at the bridge**, not just HTTP transport — the sandbox calls a typed tool code-API that
   RPCs back, instead of exposing raw tool schemas. 94–99.9 % token cut + data stays out of the model.
   OpenClaw already implements it. `[Cloudflare; Anthropic]`
2. **Never put a Bearer in a cloud microVM — use a sealing/egress broker** (scoped short-lived reference →
   gateway swaps for the real credential). `[lunar.dev; mcp-credentials-broker; TrueFoundry §5]`
3. **Run untrusted/heavy servers as host-side containers behind the gateway** (per-server network allowlist,
   quarantine-by-default), not inside each agent sandbox. `[Docker MCP Gateway; mcpproxy]`
4. **Keep stdio for local providers, but front it with an `mcp-proxy` HTTP wrapper** so one gateway/audit
   layer covers local and cloud uniformly. `[TrueFoundry §8]`

**Practitioner sentiment corroborates:** r/mcp's "Code Mode Architecture: Gateway, Sandbox, OAuth" thread
asks our exact question; multiple threads report token blow-up at 10+ servers solved by a shared gateway +
code execution; "managed MCP deployments" beat "API keys on every machine"; E2B + Docker is a common
safe-tools recipe. `[SENTIMENT: r/mcp, r/AI_Agents]`

## 6. Sources

- truefoundry.com/blog/mcp-stdio-vs-streamable-http-enterprise — stdio=local default, HTTP=scale; auth/audit/latency; mcp-proxy wrapping `[SECONDARY]`
- github.com/cased/e2b-mcp — E2B runs the MCP server *inside* the Firecracker sandbox per call `[PRIMARY-adj]`
- blog.cloudflare.com/code-mode — sandbox isolated from internet; tools via RPC callback `[PRIMARY]`
- blog.cloudflare.com/enterprise-mcp — remote MCP + portals + Code Mode + Access OAuth reference arch `[PRIMARY]`
- anthropic.com/engineering/code-execution-with-mcp — tools-as-code-API; PII tokenization; ~98.7 % token cut `[PRIMARY]`
- deepwiki.com/daytonaio/docs — Daytona MCP = external agent controls the sandbox (inverse direction) `[PRIMARY]`
- mcpproxy.app/blog/2026-03-31-three-sandboxes-ai-isolation — V8 vs OS-native vs Docker; which sandbox at which layer `[SECONDARY]`
- lunar.dev/post/best-practices-for-mcp-secret-management-at-enterprise-scale — vault-resolve-at-runtime, scoped-by-identity, OAuth refresh `[SECONDARY]`
- github.com/docker/mcp-gateway — shared gateway runs servers as containers + central secrets `[PRIMARY]`
- mcp.directory (gateway-2026 / sandbox-2026 comparisons) — Composio/Docker/Obot/MCPJungle decision tree `[SECONDARY]`
- github.com/ars-system/mcp-credentials-broker; apistronghold.com/blog/mcp-server-session-scoped-credentials — short-lived scoped credential broker `[SECONDARY]`
- r/mcp "MCP Code Mode Architecture: Gateway, Sandbox, and OAuth Best Practices?" (+ r/AI_Agents) — practitioners building gateway+sandbox+OAuth `[SENTIMENT]`
- r/mcp "We cut MCP token costs by 92%…" / "token costs exploded at 10+ servers" / "Managed vs Local deployments" / "Safer AI Agents with E2B + Docker" / seatbelt+bubblewrap thread `[SENTIMENT]`

**UNVERIFIED:** Modal's specific recommended tool-call pattern (no primary source surfaced this pass).
