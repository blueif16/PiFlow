# Uniform, multi-pathway hosting for the piflow control plane

**Status:** design + implementation plan (ready to build)
**Scope:** issue #22 — make `piflowctl cloud up|down` stand up the SAME control plane over any of four host pathways (`fly`, `railway`, `selfhost`+cloudflared, `docker`) from ONE image, ONE secret projection, ONE smoke, with only minimal per-provider config.
**Serves:** `packages/cli/src/cloud.ts`

---

## 0. The decision (merge of Angle A + Angle B)

Both angles independently landed on the SAME seam, because the MAP proved almost all of `cloud.ts` is already
provider-agnostic. The only Fly nouns are four leaks:

1. the `.fly.dev` URL shape (`flyAppUrl`, `cloud.ts:75-77`),
2. the argv of the three `kind:'fly'` steps + `apps-destroy` (`cloud.ts:270/279/287/463`),
3. the `'fly·$$'` render tag (`cloud.ts:332`),
4. the Fly defaults (`DEFAULT_APP`/`DEFAULT_FLY_CONFIG`, `cloud.ts:57/63`).

**We take the LOWEST-CHURN core from Angle A and the CLEANER interface + file layout from Angle B:**

| Question | Choice | From |
|---|---|---|
| Where does the abstraction live? | A new `packages/cli/src/hosts/` dir (interface + registry + 4 adapters); `cloud.ts` keeps the shared core | B (keeps `cloud.ts` lean, self-documenting per-adapter) |
| Back-compat for `buildFlyDeployPlan`? | KEEP it as a 1-line wrapper `= buildDeployPlan(flyAdapter, …)` so the existing 13 tests stay green untouched | A |
| Who owns the `.dockerignore` copy/rm steps? | The ADAPTER contributes them in `upSteps` (fly/railway/docker need them, selfhost-via-serve doesn't). `buildDeployPlan` = `[...adapter.upSteps(ctx), smokeStep()]` — no `needsBuildContext` flag | A (cleaner than B's flag; kills the last "generic-but-Docker-coupled" wart) |
| `StepKind`? | `'fly'` → `'host'` (only breaking rename; tests assert step `id`/`command`, never the kind literal) | A + B (identical) |
| `mintCloudSecrets` change? | Exactly one line: `appUrl` becomes an input, not `flyAppUrl(app)` internally | A + B (identical) |
| SSOT image fold-in? | OUT OF SCOPE — noted as a follow-up, not a prerequisite | A + B (identical) |
| Test seam? | Adapters are PURE `DeployStep[]` builders; `runStep`/mint/context all stay injected fakes | A + B (identical) |

The result: `mintCloudSecrets`, the `DeployPlan`/`DeployStep` model, redaction, `renderPlan` body, the PLAN-vs-`--execute`
gate, the context store, the SSOT `deploy/control-vm` image, and `smoke-live.mjs` are all **reused unchanged in mechanism**.
Adding a 5th host later = one adapter object + one registry row.

---

## 1. ONE image, four pathways

**No image change.** All four pathways run the identical `deploy/control-vm/Dockerfile` — the full-workspace superset
(built @piflow checkout + `pi` + `claude` + `bubblewrap`; CMD = fail-closed token guard → stage `PIFLOW_PI_MODELS_JSON`
into `~/.pi/agent/models.json` → `piflowctl serve :8080`). Nothing in the image references Fly; the host only supplies
secrets + routing. The pathways differ ONLY in how the image is built/run and how a stable HTTPS origin is obtained —
which is exactly what the `HostAdapter` abstracts.

| pathway | how the image runs | stable HTTPS origin | `--execute` cost |
|---|---|---|---|
| **fly** | `fly deploy --dockerfile deploy/control-vm/Dockerfile` (builds server-side) | `https://<app>.fly.dev` (auto) | **paid** |
| **railway** | `railway up --detach` builds the SAME Dockerfile server-side | `https://<app>.up.railway.app` or `--public-url` from `railway domain` | **paid** |
| **selfhost** | `piflowctl serve` on the always-on host (no container), fronted by `cloudflared` | the `cloudflared` HTTPS URL → `--public-url` | **free** |
| **docker** | `docker build -f deploy/control-vm/Dockerfile … && docker run -p 8080:8080` | user-supplied `--public-url` (their reverse proxy) | **free** |

**SSOT follow-up (NOT on the critical path):** `deploy/control-vm` still hand-duplicates the `deploy/pi-runtime/runtime.mjs`
recipe rather than deriving from it. Folding it back (add a `backends['control-vm']` entry + a `superset` flag for
bubblewrap + claude-code, then render + wire `--check` into CI) is a separate, recommended change. This design does NOT
require it — all four adapters point `--dockerfile` at the same file today.

---

## 2. Shared collaborators reused by every adapter

**(a) `mintCloudSecrets`** — reused verbatim except its single Fly leak (`appUrl = flyAppUrl(opts.app)`) is lifted out
(§3.2). Bearer mint, `parsePiProvider` gateway decomposition, ANTHROPIC billing guard, `cloudCredEnvAdditions` cloud
allowlist (mint-not-forward), OAuth resolution, `missing[]`, and the `secrets[]`/`MintedSecrets` shapes are byte-identical.
A Railway env var, a `docker run -e`, and a `fly secrets set` all take the same `{name,value}` secret shape.

**(b) `smoke-live.mjs`** — UNTOUCHED. It consumes only `{PIFLOW_CLOUD_URL, PIFLOW_TOKEN}` (`smoke-live.mjs:17-18`) — pure
application-layer HTTP, zero Fly nouns. It is the SHARED acceptance gate: an adapter is conformant iff
`PIFLOW_CLOUD_URL=<its origin> PIFLOW_TOKEN=<minted> node deploy/control-vm/smoke-live.mjs` passes A→E. Every adapter's
plan ends with the identical `smokeStep(appUrl, token)`.

**(c) The SSOT image** (`deploy/control-vm/Dockerfile`), the `DeployPlan`/`DeployStep`/`StepKind` data model, the
secret-inlining + `***` redaction pattern, the `renderPlan` body, the PLAN-vs-`--execute` gate, and the context store
(`registerContext`/`switchContext`/`removeContextFn` over `~/.piflow/contexts.json`) are all reused unchanged.

---

## 3. The interface (code-ready)

### 3.1 `StepKind` — one token generalized (`cloud.ts`)

```ts
// was: export type StepKind = 'local' | 'fly' | 'smoke';
export type StepKind = 'local' | 'host' | 'smoke';   // 'fly' → host-neutral 'host'
```

`'host'` = any provider-CLI-touching step (fly/railway/docker/cloudflared/serve). `'local'` and `'smoke'` were never
Fly-specific. The `outward`/`paid`/`idempotent` flags already carry the blast semantics the render tag and execute-loop
key on, so nothing downstream depends on the literal `'fly'`.

### 3.2 `mintCloudSecrets` — `app` → `appUrl` (one line, `cloud.ts:147,157`)

```ts
// signature: opts.app  →  opts.appUrl  (the adapter now owns the URL shape)
export async function mintCloudSecrets(
  opts: { appUrl: string; provider?: string; providerSecret: string },
  deps: MintDeps = {},
): Promise<MintedSecrets> {
  // body unchanged EXCEPT:  const appUrl = opts.appUrl;   // was flyAppUrl(opts.app)
}
```

`flyAppUrl` moves into `hosts/fly.ts` as `flyAdapter.appUrl`. It stays EXPORTED from `cloud.ts` (re-export) so
`cloud.test.ts:8` and `:31` keep passing.

### 3.3 `HostAdapter` — the ONLY new interface (`packages/cli/src/hosts/adapter.ts`)

```ts
import type { CloudSecret, DeployStep, DeployPlan } from '../cloud.js';

/** Everything a plan needs from the caller: mint output + resolved config paths + the computed origin. */
export interface HostPlanContext {
  app: string;              // logical app/service/container name (--app)
  appUrl: string;           // the public HTTPS origin (adapter-shaped OR user-supplied via --public-url)
  config: string;           // fly.toml path ('' for railway/docker/selfhost)
  dockerfile: string;       // control-vm Dockerfile ('' for selfhost-via-serve)
  port: number;             // host port to publish (docker/selfhost); 8080 default
  secrets: CloudSecret[];   // from mintCloudSecrets — PIFLOW_TOKEN first, real values
  token: string;            // the minted bearer (for the smoke env + serve --token)
  modelsJson?: string;      // secret-free gateway config, staged as MODELS_JSON_ENV
  provider?: string;        // gateway name, for the display label
}

/**
 * A hosting pathway = a URL shaper + the provider-CLI steps. All methods are PURE — they return data
 * (DeployStep[] / string), never spawn. They plug into the existing plan/render/gate/runStep pipeline
 * with zero new execution path.
 */
export interface HostAdapter {
  /** Registry key + value of --host + render tag: 'fly' | 'railway' | 'selfhost' | 'docker'. */
  readonly id: string;
  /** Human label for the paid render tag (replaces the hardcoded 'fly·$$'). Usually === id. */
  readonly label: string;
  /** True when the origin is host-derived (fly/railway); false when the operator must supply --public-url
   *  (docker/selfhost) — used to fail --execute fast if the URL is missing. */
  readonly urlIsHostDerived: boolean;

  /** The stable public HTTPS origin for an app. fly → https://<app>.fly.dev; selfhost/docker → publicUrl. */
  appUrl(app: string, opts: { publicUrl?: string; port: number }): string;

  /** The FULL ordered `up` runbook for this host (including any .dockerignore copy/rm it needs).
   *  buildDeployPlan appends ONLY the invariant smoke after these. */
  upSteps(ctx: HostPlanContext): DeployStep[];

  /** The teardown step(s) for `down` (may be empty for selfhost → the plan prints a manual note). */
  downSteps(opts: { app: string; port: number }): DeployStep[];
}
```

### 3.4 `buildDeployPlan` — the generic builder (`cloud.ts`, replaces `buildFlyDeployPlan`'s body)

```ts
export function buildDeployPlan(adapter: HostAdapter, ctx: HostPlanContext): DeployPlan {
  return {
    app: ctx.app,
    appUrl: ctx.appUrl,
    hostId: adapter.id,                                   // NEW field on DeployPlan (for the render tag)
    steps: [...adapter.upSteps(ctx), smokeStep(ctx.appUrl, ctx.token)],
  };
}

/** Back-compat: keeps cloud.test.ts:88-140 green unchanged. */
export function buildFlyDeployPlan(opts: {
  app: string; appUrl: string; config: string; dockerfile: string;
  secrets: CloudSecret[]; token: string; modelsJson?: string; provider?: string;
}): DeployPlan {
  return buildDeployPlan(flyAdapter, { ...opts, port: 8080 });
}
```

`DeployPlan` gains `hostId: string`. `renderPlan`'s one leak becomes:

```ts
// was: const tag = s.paid ? 'fly·$$' : s.kind;
const tag = s.paid ? `${plan.hostId}·$$` : s.kind;   // 'fly·$$' | 'railway·$$' | 'docker·$$'
```

### 3.5 Shared step factories (extracted ONCE from today's `buildFlyDeployPlan` body → `cloud.ts`, exported for adapters)

- `secretsSetStep(ctx, argv)` — builds `setPairs` (incl. the labeled non-secret `MODELS_JSON_ENV`, exactly
  `cloud.ts:253-256`), then `argv(secretArgs)` for the command + the `***`-redacted display. THE one place redaction lives.
- `envRunStep(id, ctx, argv, opts)` — for docker/selfhost: inlines `-e NAME=VALUE`/`--env-file` real values in `command`,
  `***` in `display`, via the same redaction helper.
- `copyDockerignoreStep()` / `rmDockerignoreStep()` — the two unchanged `kind:'local'` steps (`cloud.ts:258-266,293-301`).
- `smokeStep(appUrl, token)` — the unchanged smoke step (`cloud.ts:302-311`).

### 3.6 The registry (`packages/cli/src/hosts/registry.ts`)

```ts
import { flyAdapter } from './fly.js';
import { railwayAdapter } from './railway.js';
import { selfhostAdapter } from './selfhost.js';
import { dockerAdapter } from './docker.js';

export const ADAPTERS: Record<string, HostAdapter> = {
  fly: flyAdapter, railway: railwayAdapter, selfhost: selfhostAdapter, docker: dockerAdapter,
};
export function resolveAdapter(host: string): HostAdapter {
  const a = ADAPTERS[host];
  if (!a) throw new Error(`unknown --host "${host}" (known: ${Object.keys(ADAPTERS).sort().join(', ')})`);
  return a;
}
```

---

## 4. The four adapters (`packages/cli/src/hosts/{fly,railway,selfhost,docker}.ts`)

### `flyAdapter` (refactor of the existing path — argvs lifted verbatim)

```ts
export const flyAdapter: HostAdapter = {
  id: 'fly', label: 'fly', urlIsHostDerived: true,
  appUrl: (app) => `https://${app}.fly.dev`,                       // the old flyAppUrl
  upSteps: (c) => [
    copyDockerignoreStep(),
    { id:'apps-create', kind:'host', command:['fly','apps','create',c.app], display:`fly apps create ${c.app}`,
      outward:true, idempotent:true, note:'first deploy only.' },
    secretsSetStep(c, (pairs) => ['fly','secrets','set',...pairs,'-a',c.app]),
    { id:'deploy', kind:'host', command:['fly','deploy','--config',c.config,'--dockerfile',c.dockerfile,'-a',c.app,'.'],
      display:`fly deploy --config ${c.config} --dockerfile ${c.dockerfile} -a ${c.app} .`,
      outward:true, paid:true, note:'paid — builds + ships the control-VM image.' },
    rmDockerignoreStep(),
  ],
  downSteps: ({app}) => [{ id:'apps-destroy', kind:'host', command:['fly','apps','destroy',app,'--yes'],
    display:`fly apps destroy ${app} --yes`, outward:true, note:'DESTRUCTIVE.' }],
};
```

### `railwayAdapter` (railway CLI, SAME Dockerfile)

```ts
export const railwayAdapter: HostAdapter = {
  id: 'railway', label: 'railway', urlIsHostDerived: true,
  appUrl: (app, {publicUrl}) => publicUrl ?? `https://${app}.up.railway.app`,   // guess; railway domain confirms
  upSteps: (c) => [
    copyDockerignoreStep(),                                          // railway up reads a repo-root Dockerfile+.dockerignore
    // railway variables --set K=V stages each secret as env (same {name,value} shape as fly secrets set)
    secretsSetStep(c, (pairs) => ['railway','variables',...pairs.flatMap(p=>['--set',p])]),
    { id:'deploy', kind:'host', command:['railway','up','--detach','--service',c.app],
      display:`railway up --detach --service ${c.app}`, outward:true, paid:true,
      env:{ RAILWAY_DOCKERFILE_PATH: c.dockerfile },                 // point railway at deploy/control-vm/Dockerfile
      note:'builds the SAME deploy/control-vm/Dockerfile on Railway + deploys (paid).' },
    { id:'domain', kind:'host', command:['railway','domain'], display:'railway domain', outward:true, idempotent:true,
      note:'ensures a public https domain; copy it into --public-url if the smoke URL was a guess.' },
    rmDockerignoreStep(),
  ],
  downSteps: ({app}) => [{ id:'railway-down', kind:'host', command:['railway','down','--yes'],
    display:'railway down --yes', outward:true, note:'DESTRUCTIVE — removes the service deployment.' }],
};
```

**One-click alt** (no CLI): a `railway.json` + a "Deploy on Railway" template button in `deploy/control-vm/README.md`
pointing at the repo; the operator sets the same 3 secrets in the Railway UI. Documented, not code.

### `selfhostAdapter` (NO cloud account — always-on host + cloudflared)

```ts
export const selfhostAdapter: HostAdapter = {
  id: 'selfhost', label: 'selfhost', urlIsHostDerived: false,
  appUrl: (_app, {publicUrl}) => publicUrl ?? 'http://127.0.0.1:8080',   // the cloudflared https origin, supplied via --public-url
  upSteps: (c) => [
    // secrets never leave the host: write a 0600 env file the supervisor sources (mint-not-forward, no remote API)
    envRunStep('env-write', c, () => ['sh','-c','umask 077; cat > ./piflow-control.env <<EOF ... EOF'],
      { note:'writes ./piflow-control.env (chmod 600) with PIFLOW_TOKEN + provider var(s) + optional models.json.' }),
    { id:'serve', kind:'host',
      command:['piflowctl','serve','--host','0.0.0.0','--port',String(c.port),'--token',c.token],
      display:`piflowctl serve --host 0.0.0.0 --port ${c.port} --token ***`, outward:true,
      note:'run under a supervisor (systemd/pm2/tmux) so it survives logout — this is the always-on plane.' },
    { id:'tunnel', kind:'host', command:['cloudflared','tunnel','--url',`http://localhost:${c.port}`],
      display:`cloudflared tunnel --url http://localhost:${c.port}`, outward:true,
      note:'free stable HTTPS; copy the printed https URL into --public-url so the context baseUrl + smoke match.' },
  ],
  downSteps: () => [],   // nothing remote; the plan prints "stop the supervisor + tunnel".
};
```

**selfhost specifics (the pathway the MAP flagged):** secrets resolve LOCALLY via mint, are written to a `0600`
`./piflow-control.env` sourced by the supervisor; the serve process + `cloudflared` read them. Because a **quick**
cloudflared tunnel's URL is known only AFTER it starts, context registration is a two-phase operator flow: PLAN mode
prints the runbook with a `<your-https-origin>` placeholder; the operator brings up serve+tunnel, reads the printed
`*.trycloudflare.com` URL, and re-runs with `--public-url <that>` before `--execute` (which registers the context +
runs the smoke against the real origin). A **named** tunnel (stable custom hostname) lets `--public-url` be passed up
front so registration is immediate.

### `dockerAdapter` (generic `docker run` anywhere; user brings the URL)

```ts
export const dockerAdapter: HostAdapter = {
  id: 'docker', label: 'docker', urlIsHostDerived: false,
  appUrl: (_app, {publicUrl, port}) => publicUrl ?? `http://127.0.0.1:${port}`,   // user brings the public origin via --public-url
  upSteps: (c) => [
    { id:'build', kind:'host', command:['docker','build','-f',c.dockerfile,'-t',`${c.app}:latest`,'.'],
      display:`docker build -f ${c.dockerfile} -t ${c.app}:latest .`, outward:false,
      note:'builds the SAME control-vm image locally.' },
    // secrets as -e VAR=VALUE (real in command, *** in display via the shared helper); publish the port the operator proxies
    envRunStep('run', c, (envArgs) =>
      ['docker','run','-d','--name',c.app,...envArgs,'-p',`${c.port}:8080`,`${c.app}:latest`],
      { outward:true, note:'runs the image; the operator fronts it with TLS + passes the origin as --public-url.' }),
  ],
  downSteps: ({app}) => [{ id:'docker-rm', kind:'host', command:['docker','rm','-f',app],
    display:`docker rm -f ${app}`, outward:true, idempotent:true, note:'stops + removes the container.' }],
};
```

**docker specifics:** the user brings TLS/routing (reverse proxy) and passes the resulting origin as `--public-url` →
becomes the context `baseUrl` + the smoke's `PIFLOW_CLOUD_URL`. Without it, PLAN mode uses `http://127.0.0.1:<port>` and
`--execute` fails fast (see §5 guard).

---

## 5. CLI surface

```
piflowctl cloud up   --host <fly|railway|selfhost|docker>
                     [--app <name>] [--public-url <https://…>]      # required for selfhost/docker before --execute
                     [--provider <gw>] [--provider-secret <VAR>]
                     [--context <name>] [--config <path>] [--dockerfile <path>] [--port <n>] [--execute]

piflowctl cloud down --host <fly|railway|selfhost|docker> [--app <name>] [--context <name>] [--port <n>] [--execute]
```

- `--host` defaults to `railway` (a managed builder — no local provider CLI or tunnel, ~$5/mo w/ a free first
  month). Pass `--host fly` (or `selfhost`/`docker`) to switch; the fly pathway is byte-for-byte unchanged.
- Parser (`runCloudCli`, `cloud.ts:500-552`): add `--host`, `--public-url`, `--port` to the shared flag loop; validate
  `host` via `resolveAdapter(host)` (→ `fail(...)` on unknown). Keep Fly defaults for `config`/`dockerfile`/`app`.
- `runCloudUp`: resolve the adapter, `appUrl = adapter.appUrl(app, {publicUrl, port})`, pass `appUrl` into
  `mintCloudSecrets`, call `buildDeployPlan(adapter, ctx)`. The PLAN-vs-`--execute` gate, the up-front
  `registerContext`, and the green-smoke→`switchContext` handoff (`cloud.ts:407-449`) are STRUCTURALLY UNCHANGED.
  `CloudUpOpts` gains `host: string; publicUrl?: string; port: number`.
- **Fail-fast guard:** when `!adapter.urlIsHostDerived` and `--public-url` is absent, PLAN mode still prints the runbook
  (with the `127.0.0.1` placeholder + instructions), but `--execute` THROWS before any step — otherwise the context
  `baseUrl` + smoke would point at `127.0.0.1`, not the durable origin. Mirrors the existing fail-closed discipline.
- `runCloudDown`: replace the inlined `destroyStep` (`cloud.ts:460-467`) with `adapter.downSteps({app, port})`; if empty
  (selfhost), print the manual-teardown note instead of running a step, then `removeContextFn` as today.
- `cli.ts:83-85` help text gains `--host`.

**Context registration is IDENTICAL for all four** — `registerContext(contextName, {baseUrl: appUrl, token})` up front,
`switchContext` on a green smoke. The only per-host difference is where `appUrl` comes from (host-derived vs
`--public-url`). The GUI's `?token=`-seeded bearer propagation works unchanged (it keys off the context entry).

---

## 6. Minimal per-provider config

| Host | Prereq | Public origin | Secret injection | Extra config | `--execute` cost |
|---|---|---|---|---|---|
| **fly** | `fly` CLI + auth | `https://<app>.fly.dev` (auto) | `fly secrets set` | `--config` (default), `--dockerfile` (default), `--app` | **paid** |
| **railway** | `railway` CLI + linked project | `https://<app>.up.railway.app` or `--public-url` | `railway variables --set` | `--app` (service); optional `--public-url`; SAME Dockerfile via `RAILWAY_DOCKERFILE_PATH` | **paid** |
| **selfhost** | always-on host w/ checkout + `cloudflared` | the `cloudflared` URL → `--public-url` | `./piflow-control.env` (0600); NO cloud account | `--public-url`; run serve under systemd/pm2/tmux | **free** |
| **docker** | `docker` + a reverse proxy (user's) | `--public-url` (their proxy) | `docker run -e VAR=…` | `--public-url`; `--app` (container); `--dockerfile` (default) | **free** |

The minimal config is literally: **which CLI is installed + one identifier (`--app`/`--public-url`)**. Provider,
secrets, models.json staging, the Dockerfile, the smoke, and the context wiring are all shared and defaulted.

---

## 7. File-by-file plan

**CHANGE `packages/cli/src/cloud.ts`:**
1. `StepKind` `'fly'` → `'host'`.
2. `mintCloudSecrets` `opts.app` → `opts.appUrl`; body `const appUrl = opts.appUrl;`. Re-export `flyAppUrl` from
   `hosts/fly.ts` for test back-compat.
3. Add `hostId: string` to `DeployPlan`.
4. Extract `secretsSetStep`, `envRunStep`, `copyDockerignoreStep`, `rmDockerignoreStep`, `smokeStep` from the current
   `buildFlyDeployPlan` body (export them for adapters).
5. Add `buildDeployPlan(adapter, ctx)`; make `buildFlyDeployPlan` a 1-line wrapper `= buildDeployPlan(flyAdapter, …)`.
6. `renderPlan` tag → `` `${plan.hostId}·$$` ``.
7. `runCloudUp`/`runCloudDown`/`runCloudCli`: `--host`/`--public-url`/`--port`, `resolveAdapter`, `appUrl` via adapter,
   `buildDeployPlan`, `adapter.downSteps`, the fail-fast `--public-url` guard. `CloudUpOpts`/`CloudDownOpts` gain the new fields.

**NEW `packages/cli/src/hosts/adapter.ts`** — `HostAdapter` + `HostPlanContext` interfaces.
**NEW `packages/cli/src/hosts/registry.ts`** — `ADAPTERS` + `resolveAdapter`.
**NEW `packages/cli/src/hosts/{fly,railway,selfhost,docker}.ts`** — the 4 adapter objects.

**CHANGE `packages/cli/src/cli.ts`** — help text (`:83-85`) gains `--host`.
**CHANGE `packages/cli/test/cloud.test.ts`** — existing tests stay green; add per-adapter + per-host + guard tests (§8).
**CHANGE `deploy/control-vm/README.md`** — per-host runbooks (railway one-click + cloudflared selfhost + docker+proxy). Docs, not code.

**UNTOUCHED (reused as-is):** `deploy/control-vm/{Dockerfile,smoke-live.mjs}`, `deploy/pi-runtime/*`,
`packages/cli/src/context-store.ts`, `packages/server/src/serve-cli.ts`.

---

## 8. Test strategy (nothing spends money or shells to a real provider)

The fake-step-runner seam is PRESERVED exactly. Adapters are pure `DeployStep[]`/string builders — they NEVER spawn — so
unit tests assert argv/redaction with zero I/O, mirroring today's `buildFlyDeployPlan` tests (`cloud.test.ts:88-140`).

**Existing tests stay green unchanged:** `StepKind 'fly'→'host'` and `hostId` are additive/asserted-nowhere;
`buildFlyDeployPlan` still exists as a wrapper; `flyAppUrl` still exported; `mintCloudSecrets` still accepts an app-shaped
input via the wrapper path (its own test passes `appUrl` through the same `https://<app>.fly.dev`). One tiny edit: the
`mintCloudSecrets` test call sites pass `appUrl: flyAppUrl('my-app')` instead of `app: 'my-app'`.

**New offline tests (test-first):**
1. Per-adapter `upSteps`/`downSteps` argv + redaction: `railwayAdapter` emits `railway up --detach` as `paid:true`;
   `dockerAdapter` inlines `-e PIFLOW_TOKEN=<real>` in `command` but `***` in `display` and never leaks the value;
   `selfhostAdapter` emits no `downSteps` and its `serve` step redacts the token. Each is a "fails if wrong" test — a
   mutation that leaks a secret into `display` MUST fail (mirrors `cloud.test.ts:117-123`).
2. `appUrl` shaping: `flyAdapter.appUrl('a',{port:8080})` → `https://a.fly.dev`;
   `selfhostAdapter.appUrl('a',{publicUrl:'https://x',port:8080})` → `https://x`;
   `dockerAdapter.appUrl('a',{port:8080})` → `http://127.0.0.1:8080`.
3. `buildDeployPlan(adapter, ctx)` per host: step order ends in `smoke`; the smoke env is always
   `{PIFLOW_CLOUD_URL, PIFLOW_TOKEN}` regardless of host.
4. `runCloudUp({host:'railway', execute:true})` with a fake `runStep` runs the adapter's steps in order then switches
   context — parameterized over host, same assertions as `cloud.test.ts:196-209`.
5. `--execute` on selfhost/docker WITHOUT `--public-url` THROWS before any step (the fail-fast guard); PLAN mode does not.
6. `resolveAdapter('bogus')` throws / `runCloudCli(['up','--host','bogus'])` → `fail`.

`runStep`/`registerContext`/`switchContext`/`removeContextFn`/`mintCloudSecrets` deps stay faked exactly as
`cloud.test.ts:18-24,184-187,196-237`.

---

## 9. What stays LIVE-GATED (never in unit tests)

- The real `fly deploy` / `railway up` / `docker build+run` / `cloudflared tunnel` / `piflowctl serve` — each is
  `outward:true` (fly/railway deploy also `paid:true`), so an agent never auto-runs them; `--execute` is the human's
  money/spawn opt-in, exactly as today (`cloud.ts:13-15`).
- `smoke-live.mjs` against a live URL — the single shared health gate for all four hosts, run by a human/handoff.
- CI runs only the pure builders + orchestration-with-fakes.

---

## 10. Honest trade-offs

- **Keeps the shell-out runbook model** (not a typed provider SDK). "Provider not installed/authed" surfaces as a raw
  non-zero exit (tolerated only if `idempotent`). Deliberate — matches the existing `fly` path.
- **docker/selfhost push origin+TLS onto the user.** The adapter can't manufacture a stable HTTPS URL, so `--public-url`
  is a required manual hop before `--execute` (two-phase for quick-tunnel selfhost). Inherent to "user brings the URL."
- **Railway's public domain isn't deterministic** — the `up.railway.app` guess may be wrong on first deploy; handled via
  the `railway domain` step + `--public-url` re-run. Softer than Fly's guaranteed `<app>.fly.dev`.
- **selfhost/docker smoke is weaker against `localhost`** — proves auth + run-to-done but not real public HTTPS/TLS
  termination. Not the abstraction's fault; the operator supplies `--public-url` to certify fully.
- **Does NOT fold control-vm onto the pi-runtime SSOT** (§1 follow-up) — the image is reused across hosts but still
  hand-duplicates the recipe. Out of scope to keep the CLI refactor minimal.

---

## 11. Open decisions for the human

- **Default `--host`.** Kept `fly` for 100% back-compat. If the flagship story is now selfhost/docker (free), consider
  whether the default or the docs' lead example should change.
- **Is `selfhost` in scope for THIS change**, or ship `fly`+`railway`+`docker` first and add `selfhost` (with its
  two-phase tunnel flow + supervisor guidance) as a fast-follow? The tunnel URL-known-only-after-start seam is the one
  genuine wart.
- **Fold control-vm onto the `deploy/pi-runtime` SSOT now or later** (§1) — recommended follow-up, not a prerequisite.
- **Railway Dockerfile targeting** — `RAILWAY_DOCKERFILE_PATH` env vs copying the Dockerfile to repo root alongside the
  `.dockerignore` dance. Pick one when implementing the railway adapter.
