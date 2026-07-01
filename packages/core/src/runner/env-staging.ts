// MCP config staging (env/secret porting — see docs/research/tool-bridge-env-2026-06-21.md) — the
// per-node env-allowlist additions (the secret-broker seam). Extracted verbatim from runner.ts (the
// §2.1 cluster E split); re-exported there so the barrel and the internal-importing tests
// (runner.test.ts → selectedBridgedTool, cloud-provider-cred.test.ts → cloudCredEnvAdditions) keep
// resolving these from runner.ts.
//
// When a node selected bridge tools (mcp./oc.) AND a run-level `mcpConfig` is present, the runner stages
// the server map to `_pi/mcp.json` (verbatim — the map carries `$VAR` refs, NEVER literal secrets) and
// injects, via the `CreateOpts.env` seam, `PIFLOW_MCP_CONFIG` (the ABSOLUTE in-sandbox path of that file)
// + the referenced secret env vars. The bridge inside the pi child expands the refs at resolution time.
// An `oc.*` selection stages identically: the host supplies the reserved `openclaw` server in
// `mcpConfig.servers` exactly like any MCP server, and the runner writes/forwards it verbatim.

import type { SandboxProvider, NodeSpec, SecretResolver } from '../types.js';
import { defaultSecretResolver } from '../types.js';

/**
 * Provider kinds with no host trust boundary — the host env must NOT be spread into the VM/container
 * (allowlist only). `docker` is included even though it runs LOCALLY: a container inherits no host env, so
 * a node's declared creds must cross via the allowlist and the provider config is staged into its home,
 * exactly like the cloud VMs (it is the local mirror of the cloud path, not an in-place backend).
 */
export const CLOUD_KINDS = new Set<SandboxProvider['kind']>(['daytona', 'e2b', 'docker']);

/**
 * IN-PLACE provider kinds — the node runs DIRECTLY in the real workspace (no throwaway copy), so its
 * deliverable already lives at its host location and there is NOTHING to collect: `downloadDir` would be a
 * GUARDED-IDENTITY no-op when `sandbox.output` resolves to `outDir`, but the compile default `out/<id>` is
 * a WORKSPACE-root subdir ≠ the run dir, so the SAME guard THROWS "identity-only" (local.ts:208). The throw
 * is the CORRECT guard; the runner is the violating caller — so for an in-place provider we SKIP the
 * download entirely. Every OTHER kind (inmemory/seatbelt/worktree mkdtemp throwaways, daytona/e2b VMs)
 * writes to a separate `out/<id>` and MUST copy back, byte-unchanged. (`local`'s `kind` lives on the
 * instance; reading it off the recording-wrapped sandbox is unreliable — `ctx.providerKind` is the
 * already-threaded backend-policy seam, the same one CLOUD_KINDS uses.)
 */
export const IN_PLACE_KINDS = new Set<SandboxProvider['kind']>(['local']);

/**
 * The effective exec LOCATION for a node, by provider kind — the ONE seam that makes an in-place provider
 * run IN the run dir. An IN-PLACE node (no throwaway copy) must run with its cwd = the run dir (`outDir`),
 * so a RELATIVE artifact write (`findings/survey.md`, as a real `pi` agent emits) lands at
 * `{{RUN}}/findings/survey.md` — exactly where the contract host-stat-verifies it AND where the next node
 * `inject`s it — and its `output` resolves to the run dir too, making the in-place `downloadDir` a true
 * guarded-identity no-op (the premise the IN_PLACE_KINDS doc above assumes but the compile default
 * `workspace:'.'`/`output:'out/<id>'` never satisfied → the deliverable used to land beside the LAUNCH cwd
 * and the node blocked "artifact missing"). Every ISOLATED kind keeps the compile defaults verbatim: a
 * throwaway `workspace` + an `out/<id>` output `downloadDir` collects back byte-for-byte. Pure (testable
 * in isolation).
 */
export function effectiveSandboxLocation(
  providerKind: SandboxProvider['kind'],
  outDir: string,
  sandbox: { workspace: string; output: string },
): { workdir: string; outputDir: string } {
  if (IN_PLACE_KINDS.has(providerKind)) return { workdir: outDir, outputDir: '.' };
  return { workdir: sandbox.workspace, outputDir: sandbox.output };
}

/**
 * Did this node select at least one BRIDGE tool (mcp./oc.)? True iff an `mcp.<server>:<tool>` OR an
 * `oc.<plugin>:<tool>` address survives `allow` minus `deny`. Both families execute through the bridge,
 * which resolves its server config from the staged `_pi/mcp.json` — so either kind triggers staging.
 * Exported for direct unit testing of the staging-trigger predicate.
 */
export function selectedBridgedTool(node: NodeSpec): boolean {
  const deny = new Set(node.tools.deny ?? []);
  return (node.tools.allow ?? []).some((a) => (a.startsWith('mcp.') || a.startsWith('oc.')) && !deny.has(a));
}

/** The SET of `$VAR`/`${VAR}` names referenced anywhere in the config's string values (deep walk). */
export function referencedEnvVars(config: { servers: Record<string, unknown> }): Set<string> {
  const names = new Set<string>();
  // matchAll is stateless per call (no shared lastIndex), so a fresh regex literal per string is correct.
  const ref = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(ref)) names.add(m[1] ?? m[2]);
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x);
    } else if (v && typeof v === 'object') {
      for (const x of Object.values(v)) walk(x);
    }
  };
  walk(config.servers);
  return names;
}

/**
 * Build the env additions for a node that staged `_pi/mcp.json`: `PIFLOW_MCP_CONFIG` (the absolute path)
 * plus EACH REFERENCED var resolved through the `SecretResolver` SEAM. This is a DECLARED ALLOWLIST —
 * only the `$VAR` names the config actually references cross into the node; the host env is NEVER spread
 * wholesale.
 *
 * The resolver is the broker seam. By default it reads `process.env` (today's behavior), but a host can
 * plug a scoped-token / sealing broker: it MINTS a SHORT-LIVED, SCOPED token HOST-SIDE and returns THAT
 * here, so the runner injects the scoped token as the env value and the bridge expands `$VAR` to it
 * exactly as today — the real long-lived credential NEVER crosses into the cloud VM. (A sealing/egress
 * proxy that swaps the scoped reference for the real credential at the gateway is the alternative the
 * same seam supports.) The resolver gets `{ nodeId, isCloud }` so it can mint a per-node, cloud-only token.
 *
 * The allowlist is enforced identically for every backend, but it is LOAD-BEARING on cloud: a cloud VM
 * (daytona/e2b) does NOT inherit `process.env` (the provider's exec merges only `{...this.env,...opts.env}`),
 * so these additions are the ONLY way a secret reaches the VM — and they must be exactly the referenced
 * set, nothing else, so an unrelated host secret can't ride along. On local backends the child already
 * inherits `process.env` via the provider's exec merge; forwarding the referenced (resolved) set here is
 * harmless (and correct if a var lives only in the parent process), and we still never blast the rest.
 */
export async function mcpEnvAdditions(
  configPathAbs: string,
  referenced: Set<string>,
  isCloud: boolean,
  nodeId: string,
  resolver: SecretResolver = defaultSecretResolver,
): Promise<Record<string, string>> {
  const env: Record<string, string> = { PIFLOW_MCP_CONFIG: configPathAbs };
  for (const name of referenced) {
    const value = await resolver(name, { nodeId, isCloud });
    if (value !== undefined) env[name] = value;
  }
  // Defense-in-depth against drift: on cloud the additions MUST be exactly PIFLOW_MCP_CONFIG + the
  // referenced (allowlisted) names — any other key here would be a host-env leak into the VM.
  if (isCloud) {
    for (const key of Object.keys(env)) {
      if (key !== 'PIFLOW_MCP_CONFIG' && !referenced.has(key)) delete env[key];
    }
  }
  return env;
}

/**
 * (M1 — provider-credential parity) Build the cloud env additions for the pi agent's OWN provider/gateway
 * credential — the SAME shape `mcpEnvAdditions` builds for MCP `$VAR`s, on the SAME `SecretResolver`+allowlist
 * seam. `defaultPiCommand` stamps `--provider`/`--model` but NO key; pi reads the key from its env. A local
 * child inherits `process.env`, but a cloud VM (daytona/e2b) does NOT — so the declared provider var(s) must
 * cross via the `CreateOpts.env` allowlist or pi boots with no model credential.
 *
 * Resolves EACH declared name through the resolver (which gets `{nodeId, isCloud}` so a host can mint a
 * per-node, cloud-only SCOPED token, never the raw long-lived key). Returns ONLY the resolved declared set —
 * an unknown name is simply absent, never injected as `undefined`. Empty/undefined ⇒ no additions.
 *
 * Gated to `isCloud`: on a LOCAL backend the child already inherits the parent `process.env`, so forwarding
 * here is redundant — and skipping it keeps the additive promise (a local run is byte-identical). The
 * allowlist nature is intrinsic: the returned set IS the declared names, nothing else, so an unrelated host
 * secret can never ride along into the VM.
 */
export async function cloudCredEnvAdditions(
  cloudSecrets: string[] | undefined,
  isCloud: boolean,
  nodeId: string,
  resolver: SecretResolver = defaultSecretResolver,
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  if (!isCloud || !cloudSecrets?.length) return env;
  for (const name of cloudSecrets) {
    const value = await resolver(name, { nodeId, isCloud });
    if (value !== undefined) env[name] = value;
  }
  return env;
}
