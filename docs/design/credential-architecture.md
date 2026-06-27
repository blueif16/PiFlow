# Credential Architecture — one `SecretResolver`, two homes, reference-by-`$VAR`

> **Status:** DESIGN (2026-06-26). The mechanism (`$VAR` reference + `SecretResolver` seam + allowlist
> forwarding) is ALREADY SHIPPED in core; this doc records the credential-ORGANIZATION layer on top of it
> (store, typed schema, DAG-surfacing, GUI input, cloud injection) and pins the M1 cloud wiring. Provenance:
> the pi-credential placement was read from pi's OWN docs (not assumed); the orchestrator patterns from n8n +
> Windmill docs/source (Exa, 2026-06-26). Cross-ref: `docs/design/node-action-protocol.md` §4 (the secret
> allowlist + provider-credential parity check), `docs/design/daytona-cloud-integration.md` (M0–M4),
> `docs/design/cloud-tool-gateway-architecture.md` (gateway topology). Memory: `daytona-cloud-path`.

---

## 1. Where credentials live TODAY (verified, not assumed)

**pi's provider credential** (read from pi `docs/providers.md` + `docs/containerization.md`, pi `0.80.2`).
Resolution priority: **`auth.json` → env var**.
- **`~/.pi/agent/auth.json`** (mode `0600`), per-provider record: `{"anthropic":{"type":"api_key","key":"sk-..."}}`.
  Subscriptions (Claude Pro/Max, Codex, Copilot) store auto-refreshed OAuth tokens here too. *(On this host the
  file is empty `{}` — auth is via env vars.)*
- **Provider env var** — `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `NEBIUS_API_KEY` (present in this host's env),
  etc. Full map: pi's `packages/ai/src/env-api-keys.ts`.
- **Custom gateways** (the `--provider tokenrouter/nebius/cp` piflow passes) are defined in **`~/.pi/agent/models.json`**
  with `apiKey:"$PROXY_API_KEY"`-style `$VAR` refs + a provider-scoped `env` block.
- **Container (= the Daytona VM)** — pi's doc prescribes exactly two ways: `docker run -e ANTHROPIC_API_KEY`
  (forward the provider env var) **or** mount `~/.pi/agent` (the auth file). The "keys never enter the sandbox,
  a gateway injects upstream" variant is OpenShell/`inference.local`.

**piflow's tool/MCP credential** — `node.json.mcp.servers` carries `$VAR`/`${VAR}` REFERENCES only (literal
secrets are rejected by `checkMcpSecrets`, `workflow/template/checks.ts:266`); the runner resolves the
referenced set through the `SecretResolver` and forwards ONLY that allowlist (`mcpEnvAdditions` `runner.ts:481`,
`referencedEnvVars` `:444`, cloud-allowlist delete `:495-499`).

**The existing seam (the load-bearing primitive — DO NOT reinvent).** `SecretResolver` (`types.ts:626`,
default `process.env` `:632`) is the single host seam: core owns the `$VAR` vocabulary + the allowlist
contract; the host owns the binding. The resolver receives `{nodeId, isCloud}` (`:472,490`) so it can mint a
per-node, cloud-only SCOPED token. `CLOUD_KINDS={daytona,e2b}` (`runner.ts:430`) drives the cloud allowlist.

---

## 2. How the orchestrators do it (n8n · Windmill — the convergent model)

| Principle | n8n | Windmill |
|---|---|---|
| Creds are SEPARATE records, never inlined in the workflow | `credentials_entity`; workflow refs by id | Variables / Resources; flow refs by path |
| Encrypted at rest, ONE instance master key | AES-256, `N8N_ENCRYPTION_KEY` (env/config, auto-gen on first boot); EE adds a 2-layer ROTATABLE data key | workspace-specific symmetric key |
| Reference-by-token, resolved at exec with the CALLER's perms | (refs by id) | `$var:<path>` / `$res:<path>` / `$WM_*`; worker fetches via an EPHEMERAL token, fails if caller lacks read |
| Typed credential schemas (drive the UI form + "what's needed") | credential types | Resource Types (JSON Schema per integration) |
| Scoping / sharing | personal-by-default; share-to-project; `credential:shareGlobally` scope; RBAC | workspace + folder perms; global vs project vaults |
| External vault escape hatch | External Secrets (Vault…), global/project | EE delegates storage to an external secret manager |
| Never echo key material; mask in logs | API returns only metadata | masks secret values in job stdout/stderr |

**The single shared idea:** one encrypted store of TYPED credential records, referenced by a `$token`,
resolved at job time with the runner's permissions. That is *already* piflow's `$VAR` + `SecretResolver`. The
gap is purely the **store + typed schema + GUI input + DAG-surfacing** layers above the seam.

---

## 3. The piflow design — two homes, ONE resolver

**Decision (2026-06-26): two homes, one resolver.**
- **Provider keys → pi's native `~/.pi/agent/auth.json`** (or the provider env var). pi already owns these,
  `0600`, with subscription auto-refresh — do not duplicate them into a piflow store.
- **Tool/MCP `$VAR`s → a new `~/.piflow/credentials.json`** — encrypted at rest, `0600`, master key
  `PIFLOW_ENCRYPTION_KEY` (env, else an auto-generated key file in `~/.piflow/`, mirroring n8n's first-boot
  key). Lives in the home global dir per the SDK data-boundary rule (`CLAUDE.md`: global secrets/index live in
  `~/.piflow/`, NEVER in `packages/`, the repo, or `gui/`).
- **`SecretResolver` is the single seam** that reads from whichever home (or mints a scoped cloud token) and
  returns the value for a referenced `$VAR`. The SDK stays product-agnostic: it sees only the resolver; the
  store + master key live in the host/CLI/GUI layer.

**Reference-only in the DAG.** node.json / the template carry `$VAR` references ONLY — already enforced
(`checkMcpSecrets`). The DAG never stores a secret; the run-view never serializes one.

**DAG surfaces the required credentials.** Derive the per-node required-cred SET statically:
`referencedEnvVars(node.mcp)` ∪ the node's provider key (provider → env-var via pi's env-map, resolved by
`model-routing.ts`). The GUI renders a pre-run preflight — each cred present / MISSING (probed through the
resolver; the value is NEVER revealed) — an extension of today's dry-run plan, mirroring n8n's "credential
needed" gate. *(V1: the provider→env-var requirement may be declared explicitly per run; V2: parse the
selected provider's `models.json` entry for its `$VAR` refs, the same deep-walk `referencedEnvVars` already
does for `mcp.servers`.)*

**GUI input → global store.** The GUI collects a typed credential (Windmill resource-type style: provider key,
MCP header token, …), writes it encrypted to the right home (`auth.json` for a provider key, else
`~/.piflow/credentials.json`), masked in the UI, never committed, never echoed back. Read happens only through
the resolver at run time.

**Cloud injection = mint-scoped-token / forward-one-var, NEVER the raw long-lived key.** The cloud
`SecretResolver` returns a short-lived scoped token (or forwards exactly the one provider env var into the VM
exec env via the existing allowlist) — matching Windmill's ephemeral `WM_TOKEN` and pi's OpenShell
"keys stay outside the sandbox" pattern. A cloud VM never inherits host `process.env` (`daytona.ts:261` merges
only `{...this.env,...opts.env}`; VM env `{PI_RUN}` `:518`), so the allowlist additions are the ONLY path in —
and must be exactly the referenced set.

**Deferred (not built now):** RBAC / credential sharing / project-vs-global vaults (single-user local needs
none — adopt n8n's scope model when multi-user/cloud lands); an external-vault backend (the resolver seam
already admits one — a host can plug Vault/AWS-SM later without a core change).

---

## 4. M1 — the cloud wiring this design pins

The pi gateway credential is NOT yet on the resolver seam for cloud (the `node-action-protocol.md` §4
provider-credential parity gap). M1 closes it, matching §3:
1. **`--sandbox daytona` CLI branch** — `packages/cli/src/run.ts:355-394` handles `local`/`danger-full-access`/
   `inmemory` only; add the `daytona` case constructing `createDaytonaProvider({ image: process.env.DAYTONA_IMAGE,
   apiKey: process.env.DAYTONA_API_KEY })` (factory in `sandbox/daytona-sdk.ts`).
2. **Thread a cloud `SecretResolver`** from the CLI into `runFromTemplate` (`RunOptions.secretResolver`
   `runner.ts:242`, already spread through `entry.ts`), defaulting to `process.env` read host-side.
3. **Forward the provider gateway credential into the VM** — extend the cloud env additions so the selected
   provider's required env var(s) join the same allowlist `mcpEnvAdditions` forwards (V1: a declared
   provider-cred var name; the resolver mints/reads it host-side). Determine whether the VM's pi also needs the
   matching `models.json` provider entry staged (custom gateways are defined there) — if a full in-VM
   model-config staging proves to need its own design, HALT and report rather than over-build.
4. **Gates:** a unit test (no creds) proving the `daytona` branch builds the provider AND the cloud additions
   include the forwarded provider var (must FAIL if either is absent); a credential-gated e2e
   (`skipIf(!DAYTONA_API_KEY)`) running ONE node in a real VM that asserts the node produced its artifact via a
   real model call.
