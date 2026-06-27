# Pi Flow — L1: the node envelope (the single-agent spec)

> **Canon home:** Pi Flow repo `docs/design/`. This is the **buildable schema canon** for L1 — *everything about a
> single agent node*. The *why/positioning* lives in [`orchestration-substrate.md`](orchestration-substrate.md);
> the contributor-altitude mechanism in [`../ARCHITECTURE.md`](../ARCHITECTURE.md). The implementation lands in
> `packages/core` (`@piflow/core`). Authored 2026-06-21.
>
> **Status:** FROZEN SPINE. The schema below is the fixed main spine; *horizontal* fill (each sandbox provider,
> the MCP bridge, the OpenClaw/community tool population, the COMPOSE planner, the full runner) is implemented
> later, one seam at a time, without changing the spine.
>
> **Evidence:** four 2026-06-21 research briefs (Exa + Reddit, no YouTube) in [`../research/`](../research/):
> `pi-tools-extensions-openclaw-2026-06-21.md` · `sandbox-providers-2026-06-21.md` ·
> `node-hooks-best-practices-2026-06-21.md` · `declarative-dag-authoring-2026-06-21.md`.

## What this is

Pi Flow's three levels are **L1** the single capable agent (a producer node — one headless `pi`), **L2** COMPOSE
(an agent *designs* the DAG), **L3** the control plane (supervisor · debug · governor on seams). This note freezes
**L1 and the L1∩L2 boundary**: the declarative *envelope* that fully describes one agent node, and the flat
`WorkflowSpec` the design agent fills. "The width" of a mature node is five concerns — **work · sandbox · tools ·
hooks · contract** — and each compiles down to a `pi` invocation.

## Philosophies (the load-bearing principles)

1. **The filesystem is the contract.** Nodes coordinate *only* through declared files (by reference, never
   re-emitted prose) — the high-fidelity handoff the literature says decides whether a mesh works.
2. **A node is a declarative envelope.** One object fully describes a node; the runner *compiles* it into a `pi`
   invocation — sandbox profile, `--tools` allowlist, generated `-e` extension, pre/post hooks, and the output
   contract all *fall out of* the envelope. Authoring is data, not control-flow code.
3. **Sparse-authored, dense-defaulted.** The design agent authors only *intent*; the SDK fills every *mechanical*
   field (ids, edges, stage/lane grouping, sandbox profile, flag compilation) by default (k8s / Terraform pattern).
4. **Edges are inferred from data-flow — never drawn.** A node that `reads` a file another `produces` ⇒ an edge;
   topo-sort ⇒ stages; unrelated nodes ⇒ parallel lanes. Convergent across dbt `ref()`, Bazel/Pants, Dagster SDAs,
   and Hera **HEP-0001** (this exact model on Argo); explicit `dependsOn` is the escape hatch. *We already do it*
   (`templates/pi-runner/viz-model.mjs` derives `io.inputs[].fromNode`; `tui/dag.mjs` does forward-only +
   transitive reduction) — runtime and viz share one graph.
5. **Producer vs. control separation.** *Intelligence about the work* lives in producer nodes; *intelligence about
   the workflow* lives in control nodes on seams. **Hooks are deterministic plumbing** on a node boundary — *if a
   candidate hook needs a model, promote it to a pi node* (its own sandbox + tools + contract).
6. **One provider-agnostic lifecycle, identical local or cloud:** `create → stage → exec → collect → dispose`;
   only the `provider` swaps. Read-scope is **subtractive locally** (Seatbelt deny-all-then-allow), **additive in
   the cloud** (empty VM, upload exactly the read set) — so `read[]` is always *declared*, OS-enforced only where
   supported. **`output` dir + `downloadDir` is the portable contract**, not read scope.
7. **`namespace:name` tool addressing is an SDK abstraction over pi's flat allowlist.** pi only ever sees bare
   `piName`s; the registry resolves `ns:name` → bare names (conflict-guarded) → `--tools` + an optional generated
   `-e` extension. Three sources — builtin · sdk · mcp — resolve through one namespace.
8. **Verified, not trusted.** Every node ends with a contract; required artifacts are `stat()`d + schema-validated;
   **declared ⊇ actual** reads/writes (Bazel-style; undeclared access is a breach). The same gate runs *before*
   a node too: a **tool bind pre-check** confirms every address the node declared resolves to a unique bare pi
   name — a missing tool or a flat-namespace collision (which pi silently drops) `blocks` the node before any
   sandbox/`pi` spawn, so a node never runs lacking a capability it declared (`@piflow/core/tools/verify.ts`).
9. **Idempotent + resumable.** Hooks and nodes **skip-when-fresh** (artifact-stat / hash); `--from` resume. A
   hook's declared `inputs`/`outputs` *are* both its DAG edge and its resume key.
10. **Borrow, don't rebuild; own the intersection.** The spine is fixed; **providers, tool sources, and hook kinds
    are pluggable horizontal seams.**

## The schema (`@piflow/core/src/types.ts`)

```ts
// ── THE AGENT NODE (dense, executable) ──────────────────────────────────────
interface NodeSpec {
  id: string;                       // SDK-filled (slug of label)
  label: string;
  prompt: string;                   // WORK — realized wave prompt (extract records it / COMPOSE emits it)
  skill?: string;
  agentType?: string;
  sandbox: SandboxSpec;             // 1. where it runs
  tools: ToolSelection;             // 2. what it can call
  hooks?: { pre?: Hook[]; post?: Hook[] };   // 3. deterministic plumbing
  io: NodeIO;                       // 4. the filesystem contract (also the edges)
}

interface SandboxSpec {             // 1
  provider: 'inmemory' | 'seatbelt' | 'worktree' | 'daytona' | 'e2b';   // default filled by SDK
  workspace: string;                // cwd
  read:   string[];                 // OS-enforced (seatbelt) | staging contract (cloud)
  write:  string[];                 // owned write paths (DRIVER-OWNS); contract assertion on cloud
  output: string;                   // dedicated owned output dir — collected via downloadDir (portable contract)
  image?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

interface ToolSelection {           // 2
  allow?: string[];                 // 'fs:read', 'web:search', 'mcp.github:create_issue'
  deny?:  string[];
}

interface NodeIO {                  // 4 — edges are inferred from this
  reads:    string[];               // input files  → edge FROM whoever produces them
  produces: string[];               // output files → edge TO whoever reads them
  externalInputs?: string[];        // declared sources with no producer (suppress "missing producer")
  dependsOn?: string[];             // explicit-edge ESCAPE HATCH (node ids) — rarely needed
  artifacts: ArtifactReq[];         // REQUIRED outputs the runner stat()s + schema-validates
}
interface ArtifactReq { path: string; schema?: string; }   // → DRIVER-ARTIFACTS (+ DRIVER-SCHEMA)

interface Hook {                    // 3 — deterministic; never an LLM
  id: string;
  phase: 'pre' | 'post';
  inputs:  string[];                // files READ  (pre: gates · post: the node's artifacts)
  outputs: string[];                // files WRITTEN (pre: feed node · post: derived) — edge + resume key
  when: 'always' | 'on-success' | 'on-failure';   // EXPLICIT (dbt's implicit "post on success only" = #1 pain)
  run: string | ((ctx: HookContext) => Promise<void>);
  idempotent?: boolean;             // default true  → skip when outputs fresh vs inputs
  runOnReuse?: boolean;             // default false (dbt execute_hooks_on_any_reuse)
  failure?: 'block' | 'warn';       // default 'block'
  timeoutMs?: number;
}
interface HookContext { workspace: string; inputs: string[]; outputs: string[]; }

// ── SANDBOX PROVIDER (horizontal seam — one impl per backend) ────────────────
interface SandboxProvider { create(opts: CreateOpts): Promise<Sandbox>; }
interface CreateOpts {
  readScope: string[]; outputDir: string; workdir: string;
  image?: string; env?: Record<string, string>; timeoutMs?: number;
}
interface Sandbox {
  putFiles(files: { path: string; data: Uint8Array | string }[]): Promise<void>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  exec(cmd: string, opts?: ExecOpts): Promise<ExecResult>;
  spawn?(cmd: string, opts?: ExecOpts): Promise<ProcessHandle>;   // OPTIONAL: background support uneven
  readFile(path: string, opts?: { encoding?: 'utf8' }): Promise<Uint8Array | string>;
  downloadDir(remote: string, local: string): Promise<void>;
  dispose(): Promise<void>;
}
interface ExecOpts { cwd?: string; env?: Record<string, string>; signal?: AbortSignal; onStdout?: (s: string) => void; onStderr?: (s: string) => void; }
// signal: the runner's watchdog aborts it on node-timeout/stall; a provider MUST then kill the command's
// whole process group (SIGTERM→SIGKILL). Providers also close stdin (an open stdin hangs a headless CLI).
interface ExecResult { stdout: string; stderr: string; code: number; }
interface ProcessHandle { pid: number; wait(): Promise<ExecResult>; kill(sig?: string): void; }

// ── TOOL REGISTRY (horizontal seam — the searchable catalog) ─────────────────
interface ToolEntry {
  address: string;                  // 'ns:name' — SDK-facing id
  source: 'builtin' | 'sdk' | 'mcp';
  piName: string;                   // BARE name pi sees (conflict-guarded; sdk/mcp get a prefix)
  description: string;
  tags?: string[];
  parameters?: unknown;             // TypeBox schema (sdk/mcp); StringEnum from @earendil-works/pi-ai
  origin?: { kind: 'native' | 'openclaw-plugin' | 'mcp-server'; ref?: string };   // the borrow story
}
interface ResolveResult { piTools: string[]; extension?: string; }   // → --tools (+ generated -e)
interface ToolRegistry {
  register(e: ToolEntry): void;
  resolve(sel: ToolSelection): ResolveResult;
  search(query: string, opts?: { source?: ToolEntry['source']; limit?: number }): ToolEntry[];
}

// ── L1∩L2 BOUNDARY: the flat node bag the design agent fills ─────────────────
type NodeIntent = Pick<NodeSpec, 'label' | 'prompt' | 'skill' | 'agentType' | 'tools'>
  & { io: NodeIO; sandbox?: Partial<SandboxSpec>; hooks?: NodeSpec['hooks'] };
interface WorkflowSpec { meta: { name: string; description: string }; nodes: NodeIntent[]; }   // NO edges

// ── COMPILED DAG (what the runner + viz consume) ─────────────────────────────
interface Workflow {
  meta: WorkflowSpec['meta'];
  nodes: Record<string, NodeSpec>;
  stages: { index: number; phase: string | null; parallel: boolean; nodeIds: string[] }[];
  edges: { from: string; to: string; files: string[] }[];
}
// compile(spec): Workflow — infers edges from io.reads ⋈ io.produces, defaults mechanics, validates.
```

## Authored-intent vs SDK-filled

| Authored by the design agent (intent) | Filled by the SDK (mechanics — "he doesn't care") |
|---|---|
| `prompt` / `skill` / `agentType` | `id` (slug of `label`) |
| `tools.allow` / `tools.deny` (`ns:name`) | `edges`, `stages`, `lanes` (inferred from `io`) |
| `io.reads` / `io.produces` / `io.artifacts` | Seatbelt `.sb` profile (derived from `sandbox.read`) |
| `sandbox.read` / `write` / `output` | `sandbox.provider` default + `workspace` default |
| `hooks` (when needed) | `--tools` compilation + `piName` conflict-prefixing |
| `io.dependsOn` (rare escape hatch) | `runOnReuse`/`idempotent`/`failure`/`when` defaults |

## The provider-agnostic node lifecycle

```
verifyToolBinding(tools, registry)                       // PRE-NODE bind check — block on miss/collision
create(readScope, outputDir, workdir, env, timeoutMs)   // pick impl by sandbox.provider
  → putFiles(stage io.reads + pre-hook seeds)            // pre-hooks run here  (today: DRIVER-SEED)
  → writeFile(_pi/tools.ts, resolve().extension)         // stage the GENERATED -e (binds sdk/mcp tools)
  → exec("pi … --tools <resolved> -e _pi/tools.ts @prompt")  → { stdout, stderr, code }
  → downloadDir(outputDir) + readFile(artifacts)         // collect; verify io.artifacts (DRIVER-ARTIFACTS/SCHEMA)
                                                         // post-hooks run here (today: DRIVER-MERGE/PROJECT)
  → dispose()
```

## Frozen now vs. deferred horizontal

**Frozen (this spine):** the schema above · `compile`/edge-inference/validation · the contract-marker codec · an
`InMemorySandbox` reference impl · a builtin `ToolRegistry` (+ `resolve`/`search`) · a deterministic hook runner.

**Landed since freeze (2026-06-21, horizontal fill on the frozen spine):**
- **Tools.** The **generated-`-e` compiler** (`tools/compile.ts` — `resolve()` emits real `registerTool` source
  per `sdk`/`mcp` tool; execute routes to a bridge BY ADDRESS) · **MCP→`ToolEntry` ingestion** (`tools/ingest.ts`
  — `tools/list`/`server.json` mapped 1:1, the "effortless catalog fill") · the **per-node bind pre-check**
  (`tools/verify.ts`, wired into the runner) · runner staging of the generated extension · the **`@piflow/tool-bridge`
  MCP transport RUNTIME** (`callTool(address, params)` the generated `-e` imports: connection / lifecycle / JSON-RPC).
  The colon-namespace addressing, conflict-prefixing, and the `--tools`/`-e` compile target all hold unchanged.
- **OpenClaw tools — population + execution.** A **persisted, searchable catalog** (`tools/catalog.ts` +
  `tools/openclaw-community.ts`): the executable `oc.calc:add` seed (pure, native-bound) plus a curated, pinned
  crawl of REAL OpenClaw community tools (`openclaw@2026.6.9`, discoverable, marked `gateway-coupled`). The
  **`oc.*` execution lane** — a gateway-coupled tool (`oc.<plugin>:<tool>`) routes through the bridge to a
  reserved `openclaw` MCP gateway (`@piflow/tool-bridge` `OPENCLAW_SERVER`), sending the BARE tool name; proven
  end-to-end (stdio + Streamable-HTTP+bearer) against OpenClaw's `plugin-tools-serve`. **Reuse, not rebuild:**
  OpenClaw is MIT and serves its plugin tools over MCP, so coupled tools execute in OpenClaw, reached over our
  existing MCP lane (`docs/research/sandbox-tool-wiring-2026-06-22.md`).
- **OpenClaw plugin host — NATIVE in-process execution (S0–S3, 2026-06-22).** A second lane beyond the MCP
  gateway: an in-process host (`tools/openclaw-host.ts`) runs OpenClaw plugins *natively on pi*. It drives a real
  tool's `register(api)` → captured factory → `execute` (**S0** — `memory_get` reads a real on-disk file; the
  registry only *stores* factories, so we drive `factory(ctx)`+`execute` ourselves), registers **all 10 bundled
  tool-bearing plugins** with their tool-sets cross-checked against each manifest (**S1**), routes
  `SecretResolver`-resolved keys to key-gated tools (**S2** — `tavily`'s key observed in the real auth header;
  live call env-gated), and binds the one deep-runtime seam `runtime.agent.runEmbeddedAgent` to the **same `pi`
  CLI the runner uses** (**S3** — a live nested-pi run drove `llm-task` end-to-end). **No second runtime added** —
  pi supplies the agent loop; we host the tool substrate + provider-wire and translate at one seam (OpenClaw's
  internalized `agent-core` loop is dropped, not ported). Design + findings: `openclaw-substrate-adoption.md`.
  The long-running `canvas`/`browser` HTTP daemon (`registerHttpRoute` + lifecycle) = **S4, deferred**.
- **Runner.** The full per-node lifecycle (`runner/` — create→stage `io.reads`→exec the built command→`downloadDir`
  collect→host-stat `io.artifacts` verify→hooks→dispose) · node-timeout + silent-stall **watchdogs** routed through
  one kill seam (SIGTERM→SIGKILL grace, real process-group reap via `ExecOpts.signal`) · **halt-on-failure** ·
  `--from`/`--until` **resume** (artifact-stat preflight) · **lane isolation** (a lane throw can't fail-fast the run) ·
  serialized + atomic `run-status.json` · the **scoped-token `SecretResolver` seam** (a host plugs a broker so a
  cloud VM gets a short-lived SCOPED token, never the raw long-lived credential; default reads `process.env`).
- **Sandbox.** The **`RunScope`/`openRun` run-scoped lifecycle** seam (`types.ts`; wired in the runner — providers that
  share ONE resource across a run boot it once / tear it down once, with a trivial per-node forwarder for those that
  don't) · the **Seatbelt read-scope `SandboxProvider`** (`sandbox/seatbelt.ts` — per-exec `sandbox-exec` profile from
  the declared `read[]`, kernel-enforced EPERM on darwin; unsandboxed + warn-once off darwin) · the **Daytona cloud
  `SandboxProvider`** (`sandbox/daytona.ts`) against the RunScope seam — **LIVE-WIRED via an adapter**: the provider
  stays dependency-free against a `DaytonaSdk` seam, and `sandbox/daytona-sdk.ts` (the ONLY module importing
  `@daytona/sdk@0.185.0`) maps the real client on via `realDaytonaSdk()` + the `createDaytonaProvider()` factory
  (signatures grounded in `../research/daytona-sdk-2026-06-21.md`). Still **contract-parity tested** against
  `InMemorySandbox` via a fake, real-fs-backed SDK (`test/sandbox-cloud-parity.test.ts`) so local↔cloud share the
  same lifecycle/contract. (One live API-key smoke-test stays deliberately uncovered by the offline harness.) · the
  **Worktree** `SandboxProvider` (`sandbox/worktree.ts`) against the same RunScope seam — per-run git WRITE isolation: a
  fresh worktree on branch `pi/<run>` in a sibling `.pi-worktrees/<run>` (port of `run.mjs` `setupWorktree`/
  `finishWorktree`), every node runs INSIDE it, `dispose` commits the branch (durable for a human-gated merge) and
  removes the checkout; tested against a throwaway temp git repo (`test/sandbox-worktree.test.ts`).

**Deferred (horizontal fill):** the **E2B** provider (the Daytona adapter is the template) · catalog
**freshness/trust** (M4; the catalog itself landed above — see `../research/tool-registry-maintenance-2026-06-21.md`) ·
**Code Mode** (collapse a large tool catalog to `exec`/`wait` for a 94–99% tool-token cut — deferred; NOT importable
from OpenClaw, see the `tools/compile.ts` note) · the COMPOSE planner (structured-output
+ validate→repair; weak-model schema-fill rules: *rationale-before-committed fields*, *keep optionals optional*) ·
runner **escalation ladder** + stuck-delta/tool-thrash kills · the `@piflow/viz` renderer · the `piflowctl` CLI ·
**a live `pi` smoke-test** (below) — the one thing the offline test harness deliberately cannot cover.

> **One open question for the bridge step (needs a live `pi` smoke-test, deliberately not run here):** the
> generated `-e` embeds each tool's JSON-Schema `parameters` wrapped in TypeBox `Type.Unsafe(...)` — verify pi
> accepts it and advertises the shape to the model as expected; if strict TypeBox is required, swap the single
> `renderTool` parameters line (the compiler is isolated for exactly this).

> **Reconciliation (RESOLVED 2026-06-22):** OpenClaw is **MIT open-source** — verified from the repo `LICENSE` +
> `package.json` (Copyright © 2026 OpenClaw Foundation). Amend the canon's "closed-core" note
> (`orchestration-substrate.md` §4). It also corrects the prior assumption that OpenClaw *embeds pi*: OpenClaw owns
> its own agent runtime (`@openclaw/agent-core`); the only pi dependency is `@earendil-works/pi-tui`. Neither
> affects this spine — we reuse OpenClaw two ways, never adopting its agent runtime: **(a)** the MCP
> tool-transport lane (gateway-coupled tools execute in OpenClaw), and **(b)** native in-process plugin hosting
> (`tools/openclaw-host.ts`, S0–S3 — see above) where OpenClaw's one agent seam `runEmbeddedAgent` is bound to
> **pi** and its internalized `agent-core` loop is dropped, not ported. *Update (2026-06-22): forensics show
> OpenClaw's `agent-core` is a re-internalized copy of what was pi's own loop (OpenClaw ran on pi's SDK before
> migrating off), which is exactly why binding the seam to `pi.createAgentSession`-equivalent is low-impedance.*
