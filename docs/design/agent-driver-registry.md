<!-- Authored by the agent-driver-registry-design workflow (13 agents: 4 understand + 4 design + synthesize + 3 adversarial critics + refine; 16 findings surfaced, 3 blockers, all resolved against real code). This is a DESIGN doc — Thrust 3 of the telemetry-legibility program. -->

# The AgentDriver Registry — piflow's executors as first-class, composable, discoverable LEGO

**Thesis.** Today piflow runs exactly two executors — `pi` and `claude-code` — and every difference between them is a *hardcoded `node.executor === 'claude-code'` ternary* scattered across four seams (command build, model resolution, credential staging, verdict/telemetry parse). This is not a registry; it is four independent branches that a third executor cannot be expressed through, because the type is a closed `'pi' | 'claude-code'` union (`types.ts:51`, `run-context.ts:45`). This document formalizes those four branches into ONE `AgentDriver` object — a per-node runtime strategy keyed in an open `Record<driverId, AgentDriver>` — and adds the ONE thing the vision demands that no proposal delivers alone: a **telemetry-parity contract** (`parseResult` + a streaming event-decoder + `modelCaps`) that makes any registered executor light up cost, context, anomalies, and cross-run metrics as far as its stream allows — which is the precondition for the optimizer to score, improve, and swap any agent without being blind. The driver is strictly orthogonal to the agent-*identity* systems already shipped (`AgentBase`/presets = **what** an agent is; the driver = **how** an executor runs it); the whole design is additive, and a node that names no driver runs byte-identically on pi.

The spine is the **lifecycle-first** proposal — because parity-as-a-typed-contract is the load-bearing obligation the whole thrust exists to satisfy. From the other three lenses I graft *exactly one* idea each, **and I scope it to this thrust**: contract-first's byte-identical phased extraction (the whole build plan), composition-first's fit-preflight (narrowed to the one axis a driver actually adds — §2.4), and discovery-first's `describe()` capability card (a per-driver static manifest — §2.5). The larger self-assembly/discovery-index/lifecycle-versioning apparatus that the discovery and lifecycle lenses also wanted is **explicitly deferred to a separate discovery/overlord track** (§6, §8 Q5) — this thrust is a lookup-table-plus-parity landing, not a framework.

---

## 1. Problem & today's seam (anchored)

### 1.1 The four hardcoded branches (the "registry" that isn't)

A node's executor is chosen once by `resolveExecutor` (`node-lifecycle.ts:90`): `executorOverride[node.id] ?? executorDefault ?? node.executor`, then stamped onto a node clone so every downstream seam sees one uniform value. But there is no driver object — instead, four places each re-branch on the same string:

| Seam | The branch today | path:line |
|---|---|---|
| **Command build** | `dispatchCommand = (node.executor === 'claude-code' ? claudeCommand : defaultPiCommand)(...)` | `command.ts:154` |
| **Model resolution** | `effectiveModel = node.executor === 'claude-code' ? resolveClaudeModel : resolveNodeModel` | `model-routing.ts:153` |
| **Credential/env staging** | `claudeExecutorEnvAdditions` returns `{}` for non-claude; else injects `CLAUDE_CODE_OAUTH_TOKEN`, strips `ANTHROPIC_API_KEY` | `claude-executor.ts:116/124` |
| **Verdict + telemetry parse** | `const isClaude = node.executor === 'claude-code'`; `claudeVerdict = parseClaudeResult(...)`; then `if (claudeVerdict) rec.usage = nodeUsageFromClaude(...)` | `node-lifecycle.ts:612-620` |

The ONE clean injection seam that *does* exist is `CommandBuilder` (`command.ts:20`) — `RunOptions.buildCommand` defaulted to `dispatchCommand` at `runner.ts:369`. It is exactly the right shape; the problem is that the *other three* differences are not routed through an equivalent object. And the type itself forbids a third executor: `NodeSpec.executor?: 'pi' | 'claude-code'` (`types.ts:51`), `RunContext.executorDefault?: 'pi' | 'claude-code'` (`run-context.ts:45`).

### 1.2 The observe seam already names the registry

On the telemetry side the fork is *already factored* into one shared, pure function whose own comment pre-declares this work: `nodeTokenSpine` (`runView.ts:240`) picks `usage`-first (Claude — the `result`-event rollup) vs event-replay (`rich`, the pi `events.jsonl` fold), gated purely on `usage` presence so pi stays byte-identical. Its docstring (`runView.ts:238`): *"the AgentDriver registry (Thrust 3) slots in here (pick the driver for `rec`) with no rework."* This is the plug-in point, and it is deliberately shared by both the batch builder (`buildRunView`) and the live SSE fold (`watchRun`) via `assembleNode`.

### 1.3 What is missing (grep-confirmed absent)

- **No `AgentDriver` object, no registry** — only the seam comment mentions it; the interface is designed (`docs/design/agent-executor-interface.md §2`, status "PROPOSED (nothing built yet)") but unbuilt.
- **No per-tool telemetry for Claude** — `createNodeAccumulator` (`distill.ts:140`) switches on only pi's event vocabulary (`message_end`/`tool_execution_start`/`tool_execution_end`/`thinking_delta`/`auto_retry_start`, `distill.ts:199-259`), so a Claude node has a blank tool timeline and `maxToolRepeat: 0`.
- **No cross-run cost/loop metrics** — `buildHistory` (`runView.ts:182-199`) folds `durationMs` ONLY; `cost-spike` and `loopScore` do not exist.

### 1.4 Chosen spine — and why not the other three

I evaluated all four lenses against the bar's hardest, un-hand-waveable requirement: **observe parity must be a typed contract, not a convention, because the optimizer's whole reason to care about the registry is to stop scoring a Claude fixer node blind.**

- **Lifecycle-first (CHOSEN as spine)** — treats parity as *the* non-negotiable driver obligation, ties a driver + version stamp through register→run→observe→improve→retire so a sealed node stays reproducible, and its P0 (freeze the parity conformance test) is the smallest real thing that de-risks everything after. It is the only lens that makes "a third agent lights up as far as its stream allows" a *test*, not a hope.
- **Contract-first** — cleanest phased extraction (its P0/P1 "wrap the existing functions, byte-identical" is the right way to start). **Grafted whole:** its extraction discipline is my entire P0–P3 build plan.
- **Composition-first** — the fit-preflight is the genuine mechanization of "does this LEGO snap onto that one." **Grafted narrowly:** a `driverFits` preflight scoped to the ONE axis a driver adds (sandbox provider + tier-vs-model-pin), *delegating* loadout/skill fit to the already-shipped `preflightSkills` (§2.4).
- **Discovery-first** — `describe()` as a *static per-driver manifest* is the sharpest answer to "what does this executor bring." **Grafted narrowly:** the manifest ships in core; the catalog-join/query surface does NOT (§2.5, deferred §8 Q5).

I did **not** average them: I took lifecycle's parity-as-contract as the organizing principle, then bolted on exactly one *scoped* idea from each other lens. Where they conflict — or where a lens over-reaches into a system that already ships the capability — I cut it and say so inline (§2.4, §3).

---

## 2. The design

### 2.1 Where it lives (the SDK-boundary split)

Two strictly separated layers, matching the enforced boundary law (`CLAUDE.md`: *"NEVER store product-specific info… inside `packages/*`… global index lives in `~/.piflow/`"*):

| Concern | Kind | Location |
|---|---|---|
| `AgentDriver` interface + `piDriver` + `claudeCodeDriver` + `describe()` | logic | `packages/core/src/runner/drivers/{types,pi,claude-code}.ts` (NEW dir) |
| `DriverTable` (a `Map<string, AgentDriver>`) built per run | logic | `packages/core/src/runner/drivers/table.ts` |
| Which agents exist + branding | data | `~/.piflow/agents/*.md` — **reuse** `loadAgentPreset` (`agent-preset.ts:218`); NO parallel `~/.piflow/drivers/` |
| The agents × drivers × measured-profile JOIN + any cross-run cost/loop profile | data | assembled in the **server/CLI layer** (where `/__piflow/agents.json` already lives, `handlers.ts:392`) and persisted under `~/.piflow/` — **never** built by a core function (§9 boundary; §2.5) |

A driver is *code* (it must ship a `buildCommand` function), so the table is a pure in-memory Map built at run construction — **code-as-truth**. It is NOT a `.md` a user hand-edits.

> **Naming.** The new table is `DriverTable`, deliberately **not** `DriverRegistry` — the word "registry" already denotes two distinct shipped things in this codebase (the global product/fleet `Registry`, `observe/registry.ts`; and the tool `DefaultToolRegistry`, `tools/registry.ts`). A third "registry" noun would be exactly the vocabulary collision the reconciliation axis catches (§3, §9-adjacent). `DriverTable` is the executor→strategy lookup and nothing more.

### 2.2 The table

```ts
// packages/core/src/runner/drivers/table.ts  (LOGIC only — no data files, no module-level mutable singleton)
export class DriverTable {
  private m = new Map<string, AgentDriver>();
  register(d: AgentDriver): this {
    if (this.m.has(d.id)) throw new DriverConflictError(d.id);
    this.m.set(d.id, d);
    return this;
  }
  get(id: string | undefined): AgentDriver {
    const d = this.m.get(id ?? 'pi');
    if (!d) throw new UnknownDriverError(id!, [...this.m.keys()]); // fail-closed, lists known ids
    return d;
  }
  ids(): string[] { return [...this.m.keys()]; }
  list(): AgentDriver[] { return [...this.m.values()]; }
}

/** A FRESH table of the two built-ins — a FACTORY, not a shared mutable singleton (hermeticity; §7 Risk 6). */
export function builtinDrivers(): DriverTable {
  return new DriverTable().register(piDriver).register(claudeCodeDriver);
}
```

**No module-level mutable singleton.** The two built-ins are produced by a `builtinDrivers()` *factory*, and the runner takes `RunOptions.drivers?: DriverTable` — defaulted to `builtinDrivers()`, exactly like `buildCommand: opts.buildCommand ?? dispatchCommand` at `runner.ts:369`. A shared exported `Map` that side-effecting imports mutate would (a) make the run's driver set import-order-dependent global state rather than the run's config — in tension with config-is-truth; (b) break the run-hermeticity the codebase protects (PIFLOW_HOME test seams; a test that registers a fake `echoDriver` would pollute every later run in the process). A third-party extension composes at the call site, per-run:

```ts
import { builtinDrivers } from '@piflow/core';
const drivers = builtinDrivers().register(codexDriver);
await runFromTemplate(dir, { drivers, /* … */ }); // per-run, hermetic — NOT a global mutation
```

**The one type change that opens the table:** `NodeSpec.executor`, `RunContext.executorDefault`, and `executorOverride` widen from `'pi' | 'claude-code'` to `string`, validated at DAG-compile time against `drivers.ids()` (fail-closed with the known-id list). This preserves the author-time guarantee the closed union gave, without the type-system rigidity.

### 2.3 The driver contract

The interface is the designed `AgentDriver` (`agent-executor-interface.md:78`) plus the methods the four ternaries + the parity gap prove are required. Each method is per-node and inherits the agnostic runtime below `ExecRunner`.

The **per-node call order the runner fixes** (making P1's byte-identical claim hold — the runner already resolves the model *before* building the command, `node-lifecycle.ts:424` then `:439`): `resolveModel → augmentSandbox → buildCommand → exec → parseResult → decode`.

```ts
// packages/core/src/runner/drivers/types.ts
export interface AgentDriver {
  readonly id: string;                         // OPEN string, the table key: 'pi' | 'claude-code' | 'codex' | …
  readonly version: number;                    // bumped when buildCommand/decode output shape CHANGES (§2.6 sealing)

  // ── DISCOVERY (the static per-driver card — a-priori, node-independent) ──
  describe(): AgentDriverDescriptor;

  // ── RUN-SIDE (runner calls; lives under packages/core/src/runner/) ──
  /** SELECTS the resolver; NEVER re-encodes precedence. pi→resolveNodeModel, claude→resolveClaudeModel.
   *  Precedence stays owned by model-routing.ts (the one home). Runner calls this FIRST, feeds the result
   *  into ctx.model/ctx.provider exactly as effectiveModel does today (node-lifecycle.ts:434-439). */
  resolveModel(node: NodeRouting, run: RunRouting): { model?: string; provider?: string };
  /** The sandbox/cred coupling BEFORE spawn. pi: {} (byte-identical). claude: inject CLAUDE_CODE_OAUTH_TOKEN,
   *  strip ANTHROPIC_API_KEY, isolate CLAUDE_CONFIG_DIR. Async (token resolution is host I/O). */
  augmentSandbox?(spec: AugmentSpec): Promise<{ read?: string[]; write?: string[]; env?: Record<string, string | undefined> }>;
  /** The CommandBuilder seam (command.ts:20). pi: `pi -p --mode json … @file`; claude: `claude -p … < stdin`.
   *  Consumes the ALREADY-resolved ctx.model/ctx.provider. Owns THIS executor's tool-name grammar in-builder:
   *  the pi-name→Claude-name map (CLAUDE_TOOL_BY_PI_NAME, command.ts:101) STAYS the claude builder's concern —
   *  the catalog produces bare pi names and the driver translates HERE (one map, one home; §3). */
  buildCommand(node: NodeSpec, resolved: ResolveResult, ctx: CommandContext, opts?: PiCommandOptions): string;
  /** Parse THIS executor's stdout → the agent-neutral verdict + the NodeUsage token/cost/context SPINE.
   *  Reads result.stdout at the runner spawn seam (node-lifecycle.ts:613 — FULL, un-slimmed stdout).
   *  pi: lastJsonBlock self-report, usage undefined (event replay wins). claude: parseClaudeResult → nodeUsageFromClaude. */
  parseResult(raw: RawRun): { verdict: AgentVerdict; usage?: NodeUsage };

  // ── OBSERVE-SIDE (the parity obligation — §4) ──
  /** A STREAMING decoder of the PERSISTED, SLIMMED events.jsonl → the same NodeAccumulator push/snapshot/
   *  finalize surface (distill.ts:123-137) both buildRunView's replay and watchRun's incremental tail drive
   *  one line at a time. pi returns createNodeAccumulator; claude returns a stream-json accumulator (§4).
   *  Absent ⇒ no event decode (tokens still flow via parseResult.usage; spine falls to Lane A). */
  eventAccumulator?(): NodeAccumulator | undefined;
  /** The context-window denominator when the run didn't self-report one. pi: contextWindowFor(model, ~/.pi
   *  models.json). claude: rides usage.contextWindow, falls to a static claude cap table. */
  modelCaps(model: string | null, catalog: ModelCatalog): number | null;
}

export interface RawRun { stdout: string; eventsPath?: string; exitCode: number; killed: 'timeout' | 'stall' | null; }
export interface AgentVerdict { ok: boolean; selfReport: { status: string; summary?: string; issues?: string[] } | null; sessionId?: string; }

/** The static "what this driver brings" card — a per-driver manifest, product-agnostic. */
export interface AgentDriverDescriptor {
  id: string; label: string; version: number;
  runtime: 'cli' | 'sdk';                       // v1 both 'cli'; the SDK-driver run() override is future
  binary: string;                               // 'pi' | 'claude'
  model: { tierAware: boolean; providerRouting: boolean; aliases?: string[]; resolvesThrows: boolean };
  tools: {
    grammar: 'pi-bare' | 'claude-builtin' | string;
    supportsCustom: boolean; supportsMcp: boolean; supportsSkills: boolean;
    builtinMap(): Record<string, string>;       // a GETTER over the ONE CLAUDE_TOOL_BY_PI_NAME const (command.ts:101) — never a copy (§3)
    dropped?: string[];                         // e.g. ['ls'] for claude
  };
  sandbox: { providers: string[]; authInjectEnv?: string[]; stripEnv?: string[]; configDir?: string };
  telemetry: {
    usageRollup: boolean;                       // parseResult writes NodeUsage
    perToolTimeline: 'full' | 'count-only' | 'none'; // claude = 'count-only' — durMs unrecoverable (§4, §7 Risk 1)
    loopSignal: boolean;
    costReported: boolean;
  };
  costModel: 'per-token' | 'subscription-flat' | 'unknown';
}
```

**`parseResult` returns `{ verdict, usage }`** so the runner gets both the verdict-ladder input (replacing the `isClaude` fork at `node-lifecycle.ts:612`) and the `NodeUsage` spine (replacing the hardcoded stamp at `:619-620`) from one call. `NodeUsage` is the exact shipped shape (`status.ts`), so a driver that omits fields degrades gracefully (undefined ⇒ Lane B), but a driver that *lies about the shape* fails the parity conformance test (§6, P0).

**Cuts justified.** No `run()` override in v1 — both drivers are command-emitting, so `buildCommand` + the shared `ExecRunner` cover them; `run()` (in-process tools, `canUseTool`) stays a documented future member fenced by `describe().runtime: 'cli'`. No measured `cost` on `describe()` — that is a-posteriori per-run data (`NodeUsage.cost`), folded outside core; conflating it with the static card would bake product data into SDK code (§9).

### 2.4 Composition — the ONE new fit axis (loadout fit is already shipped)

The load-bearing distinction: **`AgentBase`/preset = WHAT (author-time loadout); `AgentDriver` = HOW (run-time motor).** They meet at the executor label the node already carries — and the fit-check covers ONLY the axis the driver genuinely adds.

> **Reviewer note — loadout/skill fit is NOT re-mechanized here.** An earlier draft proposed a `checkFit` that re-answered "can this loadout actually run" with `describe().tools.supportsSkills` booleans. That duplicates shipped, id-precise code: `skill-manifest.ts` already enforces `requires ⊆ allowed` at compile (`parseSkillManifest`, throws at `:176`), auto-wires the loadout (`resolveSkillLoadout`, `:221`), and fail-fasts `requires ⊆ catalog` against the live `ToolRegistry` **before a pi is spawned** (`preflightSkills`, `:248`). A second, coarser boolean gate would be a weaker copy that can *disagree* with the id-level one (say "skills would be ignored" while `preflightSkills` already bound them). So the driver's preflight is scoped to the ONLY dimension `skill-manifest.ts` does not cover — the executor's own capability envelope:

```ts
// packages/core/src/runner/drivers/driver-fits.ts  (NEW — pure, unit-testable; NARROW)
export function driverFits(node: NodeRouting & { sandbox?: Partial<SandboxSpec>; tier?: string }, driver: AgentDriver): FitResult {
  const cap = driver.describe();
  const problems: string[] = [];
  // Axis 1 — sandbox provider the executor can actually run on (net-new; not covered by skill-manifest).
  if (node.sandbox?.provider && !cap.sandbox.providers.includes(node.sandbox.provider))
    problems.push(`driver '${cap.id}' only runs on [${cap.sandbox.providers}], not '${node.sandbox.provider}'`);
  // Axis 2 — tier-vs-model-pin (net-new; a driver that pins a model can't honor a tier class).
  if (node.tier && cap.model.tierAware === false)
    problems.push(`driver '${cap.id}' pins a model, not a tier — node.tier '${node.tier}' would be ignored`);
  return { ok: problems.length === 0, problems };
}
```

Loadout/tool/skill fit continues to flow through the **shipped** `resolveSkillLoadout` + `preflightSkills`. When a node names a Claude driver whose builtin envelope drops an MCP loadout, the *right* signal is already produced at run construction by `preflightSkills` (an mcp `requires` id absent from a builtins-only catalog fails fast) — `driverFits` does not re-derive it. This is "connect/gather made safe" at the ONE altitude a driver owns; the rest is already owned upstream.

**The composition field.** The node already carries `executor` on `NodeSpec` (`types.ts:51`) — that IS the driver label, and `mergePreset` already carries a node through with its `executor` intact (the node's own field survives the `...node` spread, `agent-preset.ts:79`). So **no new schema field is added.**

> **Reviewer note — rejected: adding `driver` to `AgentBase`.** The draft proposed a new `AgentBase.driver` alongside `NodeSpec.executor`, resolved `driver ?? executor ?? 'pi'`. Rejected for three verified reasons. (1) *Two names for one concept.* That is exactly the "two ways to do the same thing" trap the reconciliation axis exists to catch, with a `??` precedence every seam (scaffold, `mergePreset`, loader, schema, GUI) must coalesce indefinitely — an alias is never removed without a breaking change, so "no breakage" hides permanent dual-maintenance. (2) *Wrong type.* The `.md` catalog deserializes to `AgentPreset` (`agent-preset.ts:23`), NOT `AgentBase` (`types.ts:811`) — they are distinct types, and `mergePreset` operates on `AgentPreset`/`PresetMergeable`, so "add the field to `AgentBase` and `mergePreset` carries it" would not wire the `.md` path at all. (3) *Violates decision #3.* `AgentPreset.model`/`tier` are deliberately forward-compat slots `mergePreset` **never sources** (`agent-preset.ts:28-31,61`, because G1 owns per-node model) — baking a resolution-time property onto an author-time branding card is precisely the mistake decision #3 fenced off. **Resolution:** keep the executor label on `NodeSpec.executor` (already there); the preset does not carry it. If a preset must *suggest* an executor as author-time branding, that is a separate, later decision (§8 Q1) requiring an explicit `mergePreset` carry-through and its own justification for why it differs from `tier` — not a silent alias.

Composition itself stays `mergePreset` (`agent-preset.ts:64`, additive tools, deny-wins, role+task prompt) — **reused unchanged**; the node's `executor` rides through untouched.

**A composed node, end to end (config-is-truth):**

```jsonc
// a node adopting the shipped preset — node.json (mergePreset flattens preset → concrete tools/prompt at author time)
{ "id": "repair", "agentType": "claude-fixer", "executor": "claude-code",
  "prompt": "Fix the failing test in {{file}}",
  "tools": { "allow": ["read","edit","bash"] },
  "sandbox": { "provider": "local", "write": ["src/**"] },
  "op": [ { "gate": { "run": "npm test", "failure": "block" } } ] }
```

At compile, `driverFits(repair, claudeCodeDriver)` passes on its two axes (`local ∈ ['local']`; `claude` is model-alias-aware so the node carries no unresolvable tier). `preflightSkills` (shipped) independently binds/validates the loadout: `read/edit/bash` all map through `CLAUDE_TOOL_BY_PI_NAME`. The node runs byte-identically to today's `claude-code` path — the driver *is* the shipped `claudeCommand`/`parseClaudeResult`, addressed through the table instead of a ternary.

### 2.5 Discovery — the static card, joined OUTSIDE core

Discovery has two layers, and only the first lives in `@piflow/core`:

- **Static (a-priori) — `describe()`:** the per-driver capability card, product-agnostic, in core. `describe().tools.builtinMap()` is a **getter over** the one `CLAUDE_TOOL_BY_PI_NAME` const (`command.ts:101`), never a copy — so a human can see "claude maps read→Read and drops ls" without a second source that drifts. `describe().model.aliases` likewise references the alias table rather than duplicating it.
- **Dynamic (a-posteriori) — the JOIN, assembled in the server/CLI layer:** the agents-catalog enumeration + the driver×metrics join lives where `/__piflow/agents.json` already lives (`handlers.ts:392`), **not** in a core function.

> **Reviewer note — rejected: `describeAgents`/`matchAgents`/`AgentCard` in core.** The draft put a `describeAgents(opts).AgentCard[]` join and `matchAgents` in `packages/core/src/runner/drivers/describe.ts`, and defined a new `AgentCard` shape carrying `tier/loadout/sandbox/gates/costProfile`. Three verified problems, all rejected-as-designed and re-homed:
> - *Boundary violation (blocker).* `describeAgents` would enumerate the whole `~/.piflow/agents` catalog, join each onto a driver descriptor AND a measured cost/loop profile read from `~/.piflow/metrics`, and rank them — that assembled `AgentCard[]` **is** a global index/snapshot, exactly the artifact the boundary law says the SDK must READ-from/WRITE-to `~/.piflow`, never construct as a core function returning product-shaped rows. The shipped pattern is dispositive: `loadAgentPreset(id, dir)` reads ONE preset and is documented "the CATALOG itself is PRODUCT DATA living outside `packages/*`; only this LOGIC lives in core" (`agent-preset.ts:9-11`); it deliberately does **not** enumerate the dir. The catalog enumeration already lives in the server (`handlers.ts:392`). **Resolution:** core exports only the per-driver `describe()` (pure, static) and the per-id `loadAgentPreset` (shipped). The enumeration + join + any `costProfile` happen in the server/CLI layer, passing `loadAgentPreset` + an injected metrics reader in (mirroring the `optimize/driver.ts:79` `readFixCycles` injection).
> - *Duplicate "what this agent brings" shape (major).* `AgentCard.{tier,loadout,sandbox,gates}` re-describes fields `buildNodeConfig` already mirrors (`node-lifecycle.ts:903` — model/provider/tier/tools/sandbox.readScope/owns/agentType, plus `summarizeGates` at `:934`). **Resolution:** discovery is a THIN projection that adds ONLY the two net-new axes — `driver: AgentDriverDescriptor` and a `costProfile` — onto the existing `NodeConfig`/`AgentCatalog` shape, reusing `summarizeGates` verbatim. No parallel `AgentCard` record; if an agent-keyed (vs node-keyed) view is needed, key the SAME `NodeConfig`-derived record by agent id.
> - *Third discovery noun (major).* A new `agents`/`describeAgents` surface collides with the shipped fleet discovery (`observe/registry.ts`, `observe/discover.ts` — the product/fleet `Registry` + `buildSnapshot`) and the shipped `/__piflow/agents.json` catalog path. **Resolution:** §3 now names `observe/registry.ts` + `observe/discover.ts` explicitly and states the altitude split; the driver table is `DriverTable` (not a third "registry"); the GUI **extends** the existing `/__piflow/agents.json` handler rather than standing up a parallel endpoint.

**What ships in this thrust (read-only, thin):** the server's `/__piflow/agents.json` handler widens from display-only rows to also carry, per agent, the `driver: AgentDriverDescriptor` (via core `describe()`) alongside the existing `NodeConfig`-derived fields. The GUI badge reads that widened row. A `piflowctl schema agent` verb emits the `AgentDriverDescriptor` JSON Schema so an init agent can author against it. **`matchAgents` / swap-the-occupant / an `agents list|show|match` verb family are deferred to the discovery/overlord track (§6, §8 Q5)** — this thrust adds the *card*, not the query engine.

### 2.6 Lifecycle hooks

Every stage maps to a real existing seam; the table threads a *driver + version stamp* through them.

| Stage | Existing seam (path:line) | What the table adds | Sealing |
|---|---|---|---|
| **register** | `~/.piflow/agents/*.md` (`loadAgentPreset`, `agent-preset.ts:218`) + `builtinDrivers()` | driver self-registers as code into a per-run table | each driver carries `version:number` |
| **resolve/select** | `resolveExecutor` (`node-lifecycle.ts:90`) | the 4 ternaries collapse to `drivers.get(resolveExecutor(node,ctx))`; precedence unchanged | resolved `{driverId, version}` STAMPED on the run record |
| **compose** | `mergePreset` (`agent-preset.ts:64`) | node's `executor` rides through (already does); `driverFits` preflight on 2 axes (§2.4); loadout fit stays on `preflightSkills` | — |
| **run** | `runNode` + `ExecRunner` — executor-blind below the seam; order `resolveModel → augmentSandbox → buildCommand → exec → parseResult → decode` | a new driver inherits jail/verdict/retry free | — |
| **observe** | `nodeTokenSpine`/`assembleNode` (`runView.ts:240`) → `deriveNode` → `projectRunDigest` | `driver.parseResult`→`rec.usage`; `driver.eventAccumulator()`→the streaming fold; `executor`/`agentType` onto SSE wire (§4) | re-derive at the stamped version |
| **improve** | `runFixGate` (`optimize/driver.ts:154`); Fixer = a `claude-code` deep-tier | swap-the-occupant (changing `node.executor`) is an OVERLORD-track fix action (§8 Q5), gated like any edit | fix records the executor change |
| **retire** | *(honest gap — none today)* | soft: `deprecated: true` on the preset `.md` → the server catalog skips it, existing runs keep working. Driver code is deprecate-not-delete (versioned) | decoupled: retiring an agent ≠ removing its driver |

**Versioning without breaking sealed nodes.** Config is truth, so a run record persists `{driverId, driverVersion}` per node. A sealed node stays reproducible because (a) drivers deprecate-not-delete; (b) `assembleNode` re-derives from the run's *stamped* `NodeUsage` (already persisted at `rec.usage`), with raw stream as best-effort, so a decoder shape change in v2 never corrupts a v1 run's view; (c) the executor change is recorded in the fix trace. Retiring an *agent* (`.md`) never touches the *driver* (code) — the two lifecycles are decoupled. Per §8 Q3, the `{driverId, version}` STAMP lands in this thrust (cheap, one field); the `decodeAt(version)` shim machinery is deferred until a driver actually ships a v2.

---

## 3. Reconciliation with existing systems (the honest layering)

The table sits **under** the agent-identity systems as the runtime motor, **beside** the tool catalog, reuses the preset catalog + the fleet discovery as substrate, and — critically — **does not re-mechanize four capabilities that already ship** (skill/loadout preflight, the catalog resolve, the fleet registry/discovery, the tool-name map). The load-bearing rule: it adds only the *executor dimension* + the *parity contract*; it never re-describes tools/tier/sandbox/loadout-fit that already live elsewhere.

| System | Layering verdict | What I REUSE (verbatim) | What is NET-NEW |
|---|---|---|---|
| **expert-representations** (`AgentBase` `types.ts:811`, `AgentPreset` `agent-preset.ts:23`, `mergePreset` `:64`, `buildNodeConfig` `node-lifecycle.ts:903`) | **SITS UNDER it.** `AgentBase`/`AgentPreset` stay THE identity records; the driver is the motor the node picks by its existing `executor` label. **No new schema field.** | `AgentPreset`/`AgentBase` unchanged (no `driver` field — §2.4 reviewer note); `mergePreset` carries `executor` through as it already does; `buildNodeConfig` mirror + `summarizeGates` for the widened card; decision #3 (tier not sourced from preset) honored. | the `describe()`↔`NodeConfig` join in the SERVER; the 2-axis `driverFits`. |
| **skill-manifest / loadout preflight** (`skill-manifest.ts` — `parseSkillManifest` `:159`, `resolveSkillLoadout` `:221`, `preflightSkills` `:248`) | **DELEGATES TO it.** Loadout/skill/tool fit is ALREADY id-precise, compile-enforced, and fail-fast-before-spawn. | The whole `requires ⊆ allowed ⊆ catalog` preflight verbatim — `driverFits` does NOT re-answer it (§2.4 reviewer note). | nothing — this row exists to record that the driver does NOT duplicate it. |
| **capability-catalog** (`assembleRunTools` `tool-config.ts`, `DefaultToolRegistry.resolve` `registry.ts:69`→piTools, `catalogForSpec`) | **BESIDE it (orthogonal axis).** Catalog = "what can a node call" (produces bare pi names); driver = "which binary runs it." The catalog stays **driver-blind.** | `resolve(sel)→piTools` unchanged; NOT a second tool registry; **no `resolve(selection, driverId)`** — that would pull executor-awareness UP into the catalog (rejected, §2.4). | the pi-name→Claude-name translation stays the claude `buildCommand` concern (`toClaudeTools`, `command.ts:109`); `describe().tools.builtinMap()` is a GETTER over that ONE const, not a copy. |
| **agentType presets (g6)** (`AgentPreset`, `loadAgentPreset`, `/__piflow/agents.json` `handlers.ts:392`, `agentType` passthrough) | **REUSES it as the register+discover substrate.** No `~/.piflow/drivers/`. | `~/.piflow/agents/*.md` + `loadAgentPreset` + the `mergePreset` flatten + the `agentType`→GUI passthrough + the existing `/__piflow/agents.json` handler (WIDENED, not replaced). | the driver/telemetry dimension the icon-label doesn't carry. |
| **fleet registry + discovery** (`observe/registry.ts` product `Registry`; `observe/discover.ts` `buildSnapshot`) | **BESIDE it (different noun, different altitude).** Product/fleet discovery (repos→workflows→runs) ⟂ executor lookup. The new table is `DriverTable`, NOT a third "registry." | nothing structural — named here to make the vocabulary split explicit (product `Registry` ≠ tool `DefaultToolRegistry` ≠ `DriverTable`). | — |
| **blueprints** (`blueprint list\|show`, `~/.piflow/blueprints/`) | **LEAVES IT ALONE (different altitude).** Nodes-into-a-DAG ⟂ executors-under-a-node. | the GOVERNANCE pattern only: code-as-truth + a thin verb. | a blueprint SLOT could later name an `executor` (future, not v1). |

**Also subsumes:** the four scattered ternaries (`command.ts:154`, `model-routing.ts:153`, `claude-executor.ts:124`, `node-lifecycle.ts:612`) — these *become* the two built-in drivers. **Sits under:** `nodeTokenSpine`/`buildHistory` — unchanged in shape; the driver just decides `rec.usage` and (§5) the cost fold gets a sibling field. **Leaves alone:** the whole agnostic runtime below `ExecRunner` (sandbox jails, artifact-stat verdict, op[] gating, retry FSM, watchdog).

---

## 4. Observe / telemetry parity

Parity is the spine's central obligation, so it is a **typed contract with a conformance test**, never a convention. The contract: *a driver produces numbers of the exact shape `nodeTokenSpine`/`assembleNode` already read, so every downstream projection (deriveNode zones, projectRunDigest anomalies, OTel export, GUI/TUI/CLI) lights up with zero per-surface code — to the extent the executor's stream carries the signal.* Where a stream cannot carry a signal (Claude tool durations), the driver **declares that honestly** on `describe().telemetry` so no surface renders a fake number.

**Three obligations, on the correct sides of the seam** (the parse/decode split is real: parse reads FULL live stdout at the runner; decode reads the SLIMMED persisted `events.jsonl` in observe — different artifacts, §4.4):

**1. Run-side → `parseResult` writes `NodeUsage` (Lane A).** Today `node-lifecycle.ts:619-620` hardcodes `if (claudeVerdict) rec.usage = nodeUsageFromClaude(...)`. It becomes:
```ts
const { verdict, usage } = drivers.get(node.executor).parseResult(raw);
if (usage) rec.usage = usage;
```
pi returns `usage: undefined` → event replay wins → **pi byte-identical**; Claude returns the `result`-event rollup (`parseClaudeResult` already extracts `contextWindow` from `modelUsage[model].contextWindow`, `claude-result.ts:56`). `nodeTokenSpine` (`runView.ts:240`) is unchanged — it already keys purely on `usage` presence; the fork is now "which driver wrote `rec`," made explicit.

**2. Observe-side → a STREAMING `eventAccumulator()` feeds the reducer (Lane B parity).** This is the correction that makes the seam *buildable*, and it replaces the draft's batch `decodeEvents(raw)→Partial<RichNode>`:

> **Reviewer note — the live fold is INCREMENTAL, not batch (blocker, fixed).** A batch `decodeEvents(raw)` returning a finished `RichNode` cannot be the live source. `watchRun` holds one long-lived `NodeAccumulator` per node (`accs`, `watch.ts:208`), seeds it from byte 0 once (`seedNode`→`acc.push(e)`, `:245`), then feeds ONLY the new byte-offset tail per poll (`for (const event of events) acc.push(event)`, `:300`), reading a mid-run frozen view via `acc.snapshot(rec)` (`:217`) — it NEVER re-decodes from zero (that "re-fold from byte zero every tick" is exactly what the SSE work deleted, telemetry.md §8). Parity therefore lives in the STREAMING `NodeAccumulator` contract (`push`/`snapshot`/`finalize`, `distill.ts:123-137`), which a batch function does not satisfy. **Fix:** the driver exposes `eventAccumulator(): NodeAccumulator` — the pi driver returns `createNodeAccumulator` (`distill.ts:140`); the Claude driver returns a stream-json accumulator with the SAME `push`/`snapshot`/`finalize` surface. Both the batch replay (`buildRunView`'s `reduceNode`) and the live tail (`watch.ts:300`) drive the driver's accumulator ONE line at a time. `assembleNode` is still the ONE shared assembler both call — the decoder never assembles, never forks.

Today `assembleNode` gets `rich` ONLY from `createNodeAccumulator` replaying pi's `events.jsonl`, so a Claude node has a **blank tool timeline and zero loop signal**. The fix makes the accumulator driver-selected; pi's is byte-identical; Claude's decodes stream-json into the same `RichNode` shape. This is also where `executor`/`agentType` fold onto the enriched SSE wire node (closing telemetry.md §6, the default-glyph-under-`?live=sse` gap).

**3. `modelCaps` → the denominator.** `nodeTokenSpine`'s context-window branch becomes `driver.modelCaps(model, catalog)` — pi reads `contextWindowFor` off `~/.pi/agent/models.json`; Claude rides `usage.contextWindow` from the result event; a third driver supplies its own, so a non-pi model gets a real denominator instead of `null`.

### 4.1 The Claude decoder is a net-new parser with a DECLARED parity ceiling

> **Reviewer note — P5 is the secretly-huge phase, and tool-duration parity is impossible (blocker, scoped honestly).** The Claude decoder is NOT a "wrap" — nothing existing decodes `tool_use`/`tool_result`. Two hard facts, verified:
> - **Different vocabulary.** Claude's `--output-format stream-json` NDJSON is `type: 'system'|'assistant'|'user'|'result'`, with tool calls nested as `tool_use`/`tool_result` *content blocks*. The reducer switches on `message_end`/`tool_execution_start`/`tool_execution_end`/`thinking_delta`/`auto_retry_start` (`distill.ts:199-259`) — NONE of which Claude emits. A from-scratch parser is required: `assistant.content[].type==='tool_use'` opens a span; the matching `user.content[].tool_result` closes it.
> - **Tool durations are unrecoverable.** pi's per-tool `durMs` comes from `tool_execution_end._t − span.tStartMs` (`distill.ts:245-247`). Claude's stream has NO per-tool end-timestamp event, so every span's `durMs` is 0. The timeline can list tools *in order* but not their durations.
>
> **Fix:** P5 acceptance is scoped to **count-parity, not duration-parity.** The Claude decoder yields `toolBreakdown`, tool *order/sequence*, and `maxToolRepeat` (all recoverable from the tool_use/tool_result pairing), with `durMs: 0` spans. `describe().telemetry.perToolTimeline` reports `'count-only'` for Claude so the GUI renders a tool *list/sequence*, never fake 0 ms duration bars. The acceptance test hand-counts from a REAL `claude -p --output-format stream-json` fixture, not a synthetic one.

**A driver that under-reports = a node scored blind** (the point of Thrust 1: "the optimizer's Claude fixer node is no longer scored blind"). The P0 conformance test asserts the exact `NodeUsage` shape; a driver may legitimately return `undefined` from `eventAccumulator()` (tokens still flow via `parseResult`), but a driver that claims `usageRollup: true` and then drops `cost`/`contextWindow` fails the test.

### 4.2 The parse/decode artifact split (buildability)

> **Reviewer note — parse and decode read DIFFERENT bytes (fixed).** `parseResult` runs at the runner spawn seam over the FULL `result.stdout` (`node-lifecycle.ts:613`). The streaming decoder runs in observe over the PERSISTED, SLIMMED `events.jsonl` — which truncates each archived line to `MAX_LINE: 8192` and tool-result payloads to `MAX_RESULT: 2048` (`events.ts:24-26,133`). A driver must NOT assume the two inputs are the same bytes. Consequence for the Claude driver: token/cost/context (the authoritative `NodeUsage`) come from `parseResult` over full stdout — the load-bearing path — so slimming cannot corrupt them. The decoder over `events.jsonl` produces only the tool sequence/counts, which survive slimming (tool NAMES and args-prefixes are small). The `result` event's `usage` block is **not** relied upon by the decoder (it is already captured by `parseResult`), so the 8192-byte cap on the archived `result` line is a non-issue for the numbers that matter. `KEEP_MSG_FIELDS` (`events.ts:35`) already preserves `usage` on the archived message for pi; the Claude decoder does not depend on it.

---

## 5. Thrust-3 cross-run metrics

Both metrics are lifecycle-observe outputs — the measured feedback the *improve* stage consumes — and both **extend, never reinvent.**

### 5.1 cost-spike — extend `buildHistory` in place (NO new persistence file)

`buildHistory` (`runView.ts:182-199`) folds `durationMs` ONLY today (`dur[id].push(rec.durationMs)`, `:190`), reading the existing `historyDirs` run.json set. Extend it to ALSO fold per-node `usage.cost` + `billable` tokens from the SAME run.json fold; add a `cost-spike` anomaly in `detectAnomalies` **as a sibling of the existing `slow`** — same "needs the cross-run fold" shape. **Tokens-first**, because `cost = 0` on Max-subscription providers (`status.ts`): spike on `billable` tokens when `$` is 0, cost as the secondary signal.

> **Reviewer note — rejected: a new `~/.piflow/metrics/agent-history.json` in this thrust.** The draft stood up a second cross-run persistence file keyed by `driverId+agentType`. Rejected: `buildHistory` already IS the cross-run store (it reads `historyDirs` run.json), and per §5.1 we extend it in place. A per-*agent-type* rollup (for a future `matchAgents`) can be derived by re-keying the existing fold at read time; a dedicated file is added ONLY if/when the discovery/overlord track proves a cross-workflow rollup the run.json fold cannot serve (§8 Q4, deferred with `matchAgents` per Q5). No new file in P6.

### 5.2 loopScore — a DISTINCT signal, reconciled with (not replacing) `maxToolRepeat`

The shipped `maxToolRepeat`/`repeatedTool` (`distill.ts:231-235`) is a **global, full-args** fingerprint: `fp = name|JSON.stringify(args)`, run-wide peak count → `tool-loop` anomaly at ≥3. `loopScore` (telemetry.md §7) is deliberately different on two axes:
1. **consecutive** (back-to-back repeats) vs global peak — catches a *stuck* loop, not incidental re-use.
2. **first-100-chars** of args vs full-args — coarser, catches near-identical retries.

They **coexist** (stuck-consecutive-fuzzy vs global-exact); loopScore does not replace `maxToolRepeat`. It computes in the reducer alongside `fpCounts`, tracking a consecutive counter keyed `name|args.slice(0,100)`.

> **Reviewer note — loopScore parity is GATED on P5, and the fingerprint grammar differs cross-executor (fixed).** Both `loopScore` and `maxToolRepeat` compute inside the reducer off the pi tool-event fingerprint. For Claude they are structurally blocked until the P5 stream-json accumulator exists AND emits args-bearing tool events — and Claude's `tool_use` args are shaped differently (`{file_path}` vs pi's `{path}`), so raw `name|args.slice(0,100)` would not fold to the same key across executors. **Fix:** (a) P6's Claude loopScore is sequenced strictly AFTER P5 (drop the "identical" framing — it is pi-first, Claude-after); (b) normalize the fingerprint at the driver's accumulator boundary — the accumulator emits a canonical `{name, argsFingerprint}` so pi's `read|{path}` and Claude's `Read|{file_path}` fold to the same key; (c) acceptance-test loopScore per-executor, not cross-executor-identical.

**Already riding (no new work):** TTFT (`ttftMs` on `NodeUsage`) and thinking (`thinkingChars`) — captured; surfacing them as anomalies is out of scope here.

---

## 6. Phased build plan

Each phase compiles, tests green, is independently mergeable, and pi stays byte-identical throughout. **This thrust is P0–P6.** The self-assembly/query surface (`matchAgents`, `agents list|show|match`, swap-the-occupant write-back, driver-version shims) is **NOT in this thrust** — it is filed as a separate discovery/overlord track (§8 Q5), because the actual Thrust-3 need is the seam comment (`runView.ts:238`) + the derivable metrics, i.e. collapse the 4 ternaries + close the Claude telemetry gap.

- **P0 — Freeze the parity contract + conformance test (zero behavior change).** Define `AgentDriver`/`AgentDriverDescriptor`/`RawRun`/`AgentVerdict`; write the `NodeUsage` conformance test: a fixture Claude `result` event → `parseResult` → exact `NodeUsage` shape (input/output/cache/cost/contextWindow/numTurns/stopReason present); a pi node → `parseResult().usage === undefined`. **Acceptance:** the conformance test FAILS if a driver claims `usageRollup:true` but drops `cost` or `contextWindow` (test-the-test: mutate the parser to null `cost`, assert red). No runtime wired.

- **P1 — Extract `piDriver`, wrap existing functions, pi-only, no behavior change.** Implement `piDriver` wrapping `defaultPiCommand`, `resolveNodeModel` (as a THIN selector — precedence stays in model-routing.ts), `createNodeAccumulator` (via `eventAccumulator`), `lastJsonBlock`, `contextWindowFor`; `DriverTable` + `builtinDrivers()` factory; `RunOptions.drivers` defaulted. Runner still uses old paths. **Acceptance:** `piDriver.buildCommand(...) === defaultPiCommand(...)` byte-for-byte (fed the SAME already-resolved `ctx.model`/`ctx.provider` the runner produces at `node-lifecycle.ts:434-439`); `builtinDrivers().get('pi')` returns it; `get('x')` throws with the known-id list. Test-the-test: mutate a flag, assert the equality test fails.

- **P2 — Wrap `claudeCodeDriver`; collapse `dispatchCommand` + `effectiveModel`.** Implement `claudeCodeDriver` wrapping `claudeCommand`/`resolveClaudeModel`/`parseClaudeResult`/`claudeExecutorEnvAdditions`. The pi-name→Claude-name map STAYS in the claude `buildCommand` (`toClaudeTools`); `describe().tools.builtinMap()` is a getter over that const. Rewrite `dispatchCommand` (`command.ts:154`) and `effectiveModel` (`model-routing.ts:153`) to `drivers.get(id).resolveModel/…` — **a rename of the dispatch, not a new precedence surface** (model-routing.ts stays the one home). **Acceptance:** existing claude command/model tests pass unchanged; a golden `claude -p` command-string test still asserts the exact string.

- **P3 — Collapse the run/verdict fork; open the type; stamp the version.** Route `node-lifecycle.ts` augmentSandbox and `:612/:619` (parseResult → verdict + `rec.usage`) through the driver in the fixed call order; widen `executor` to `string` with DAG-compile validation against `drivers.ids()`; stamp `{driverId, version}` on the run record. **Acceptance:** a pi run and a claude run produce byte-identical `run.json` to pre-P3 (snapshot, modulo the new stamp field); an unknown executor fails at compile with the known-id list; a **fake `echoDriver`** (test-only) runs a node end-to-end via `RunOptions.drivers` — the "third agent works" proof, hermetic (no global mutation).

- **P4 — `driverFits` (2 axes) + `schema agent`.** Add `describe()` to both drivers; implement pure `driverFits` (sandbox provider + tier-vs-model-pin ONLY — loadout fit stays on the shipped `preflightSkills`); wire `driverFits` into author-time preflight (advisory-warn default, block under `--strict`); emit `AgentDriverDescriptor` JSON Schema via `schema agent`. **Acceptance:** table test — `daytona`+claude ⇒ fails on `sandbox.providers`; a tier-pinning driver + `node.tier` ⇒ fails; a builtin-loadout+claude node ⇒ ok AND the existing `preflightSkills` still owns the mcp-loadout rejection (assert `driverFits` does NOT fire on it); mutation-check flips it.

- **P5 — Observe parity: streaming Claude `eventAccumulator` + `executor`/`agentType` on the SSE wire.** `assembleNode` sources its accumulator from `driver.eventAccumulator()`; implement the Claude stream-json → `RichNode` accumulator (`tool_use`/`tool_result` pairing → `toolBreakdown`/sequence/`maxToolRepeat`, `durMs:0` spans; `perToolTimeline:'count-only'`); fold `executor`/`agentType` onto the enriched wire node. **Acceptance:** a Claude fixture (from a REAL `claude -p --output-format stream-json` capture) now shows a per-tool *sequence* (was blank) + a `maxToolRepeat` matching a hand-counted fixture; the GUI shows a tool list, NOT 0 ms duration bars; pi byte-identical; SSE-fold node deep-equals batch-built node (the streaming-parity invariant); `executor` present on the live wire.

- **P6 — Cross-run cost-spike + loopScore (pi, then Claude).** Extend `buildHistory` in place to fold `usage.cost`+`billable`; add `cost-spike` (tokens-first) as a `slow` sibling; add `loopScore` (consecutive/first-100, canonical fingerprint) in the reducer + its anomaly. **Acceptance:** a fixture with a 3× cost jump fires `cost-spike`; a flat history does not; `loopScore` fires on a consecutive-repeat fixture that `maxToolRepeat` (full-args) *misses* — proving they're distinct; Claude loopScore lands only after the P5 accumulator, per-executor-tested (not cross-executor-identical). **No new persistence file.**

---

## 7. Risks & the moat check

**Risks**
1. **Claude tool-timeline parity is count-only, not duration.** Claude's stream has no `tool_execution_end` timestamp. *Mitigation:* declared, not hidden — `describe().telemetry.perToolTimeline: 'count-only'`; the decoder yields sequence/counts with `durMs:0`; the GUI renders a list, never fake bars (§4.1).
2. **Opening the `executor` union loses exhaustiveness.** `string` drops `never`-exhaustiveness. *Mitigation:* validate at DAG-compile against `drivers.ids()` (fail-closed with known ids) + a `KNOWN_EXECUTORS` const for author-time checks — the guarantee moves to compile time.
3. **cost-spike + subscription $=0.** *Mitigation:* tokens-first (`billable`), $ secondary — designed in (§5.1).
4. **Boundary leak.** *Mitigation:* driver LOGIC + `describe()` in core; the agents×drivers×metrics JOIN and any `costProfile` in the server/CLI layer via an injected reader; a CI grep asserts no catalog-enumeration/stats file under `packages/core` (§9).
5. **Scope creep to the SDK driver.** *Mitigation:* `describe().runtime: 'cli'` fences v1; `run()` is a documented future member, out of P0–P6.
6. **Global-state / hermeticity.** A shared mutable `defaultDrivers` singleton would make the driver set import-order-dependent and pollute concurrent/test runs. *Mitigation:* `builtinDrivers()` is a FACTORY; third-party drivers compose per-run via `RunOptions.drivers`, never by mutating a core global (§2.2).
7. **Over-reification undoing "recipes-not-types."** *Mitigation:* `id` is an open `string`; the driver is a *piece*, the agent stays a composition of config; no `driver` schema field is added (§2.4).

**Moat check (all pass)**
- **One-real-pi-per-node** — the driver is per-node, picked at resolve time from a per-run table; never pooled or shared across nodes. It registers *kinds*, runs one per node, preserving heterogeneous per-node model/tools/sandbox. A driver never reaches around `ExecRunner`.
- **Config-is-truth, view-is-projection** — a composed agent is only config (`node.executor`, `node.json`); `executor` is additive-optional, absent ⇒ byte-identical pi; every surface (`describe()`, the widened catalog row, the GUI badge) is a projection of that config + the persisted run record. The driver set is the run's config (`RunOptions.drivers`), not import-order global state. No presentation state threads upstream.
- **Product-agnostic SDK** — driver *logic* + `describe()` are product-agnostic code in `packages/core/src/runner/drivers/`; agent *identity* stays in `~/.piflow/agents/`; the catalog enumeration + driver×metrics JOIN + any measured profile are assembled in the server/CLI layer, never as a core function returning product-shaped rows (§9). Nothing product-specific enters `packages/core`.

---

## 8. Open questions for the human

The real remaining forks (several draft "questions" are now resolved in-doc: field name → keep `executor` on `NodeSpec`, no new field, §2.4; profile home → extend `buildHistory` in place, §5.1; discovery-index home → server not core, §9).

1. **Should a preset be able to *suggest* an executor (author-time branding), or does the executor stay node-only?** Resolved for v1 as node-only (`NodeSpec.executor`; no preset field — §2.4). *Open:* if presets should brand an executor later, it needs an explicit `mergePreset` carry-through + a justification for why it differs from `tier` (which decision #3 deliberately does NOT source). *Recommendation:* stay node-only until a real preset needs it; revisit as a deliberate `mergePreset` change, never a silent alias.

2. **`driverFits` posture: advisory-warn or fail-closed?** *Recommendation:* advisory-warn by default, blocking only under opt-in `--strict` — degrade, don't fail-closed (matches the CI fail-closed-vs-degrade tension). Note the id-precise loadout gate (`preflightSkills`) already fail-fasts hard, so `driverFits` warning-only is safe.

3. **Driver versioning depth.** *Recommendation:* stamp `{driverId, version}` on the run record from P3 (cheap, one field), but DEFER the `decodeAt(version)` shim machinery until a driver actually ships a v2 — persist derived `NodeUsage` now (already done), treat raw as best-effort.

4. **Per-agent-type cost/loop rollup: derive-at-read or dedicated file?** *Recommendation:* derive by re-keying the extended `buildHistory` run.json fold at read time; add a dedicated `~/.piflow/metrics/*.json` ONLY if the discovery/overlord track proves a cross-workflow rollup the run.json fold cannot serve (ties to Q5). No new file in this thrust.

5. **The self-assembly surface — this thrust or the overlord track?** `matchAgents`, an `agents list|show|match` verb family, and swap-the-occupant write-back all couple to the optimizer's escalation. *Recommendation (firmer than the draft):* land ONLY the read-only static card in this thrust (the widened `/__piflow/agents.json` + `schema agent`); land `matchAgents` + the `agents` verbs + swap-the-occupant in the OVERLORD track. This thrust is the registry+parity landing, not the query engine.

```handoff
DECISIONS:
- Spine = lifecycle-first (parity as a TYPED CONTRACT with a P0 conformance test), grafted NARROWLY with: contract's byte-identical phased extraction (the whole build plan); composition's fit-preflight SCOPED to the 2 axes a driver actually adds (driverFits: sandbox provider + tier-vs-model-pin) — loadout/skill fit DELEGATES to the shipped preflightSkills, not re-mechanized; discovery's per-driver describe() card (in core), NOT a catalog-join surface.
- One open table: DriverTable (Map<string, AgentDriver>) built per-run via a builtinDrivers() FACTORY (NO module-level mutable singleton — hermeticity); third-party drivers compose via RunOptions.drivers per run. Named DriverTable, NOT DriverRegistry (avoid colliding with observe/registry.ts's product Registry and tools/registry.ts's DefaultToolRegistry). Widen NodeSpec.executor/RunContext unions 'pi'|'claude-code'→string, validated at DAG-compile against drivers.ids().
- NO new schema field: the executor label stays on NodeSpec.executor (already there; mergePreset carries it through). REJECTED adding AgentBase.driver — wrong type (the .md → AgentPreset, not AgentBase), a two-names-one-concept alias, and it violates decision #3 (preset model/tier are forward-compat slots mergePreset never sources).
- The four ternaries (command.ts:154, model-routing.ts:153, claude-executor.ts:124, node-lifecycle.ts:612) BECOME the two built-in drivers; nodeTokenSpine/buildHistory reused unchanged in shape. resolveModel SELECTS the resolver (precedence stays in model-routing.ts, the one home); the pi-name→Claude-name map STAYS in claude buildCommand (describe().tools.builtinMap() is a GETTER, not a copy); the catalog stays driver-blind (no resolve(selection,driverId)).
- Parity is a streaming contract: parseResult→NodeUsage over FULL stdout (Lane A) + a STREAMING eventAccumulator()→NodeAccumulator (push/snapshot/finalize) that the incremental watchRun tail AND the batch replay both drive one line at a time (NOT a batch decodeEvents) + modelCaps denominator. Claude timeline is COUNT-ONLY (no tool_execution_end ⇒ durMs unrecoverable; declared on describe().telemetry.perToolTimeline). cost-spike (tokens-first) extends buildHistory IN PLACE (no new file); loopScore (consecutive/first-100, canonical cross-executor fingerprint) is pi-first, Claude-after-P5.
- Layering: SITS UNDER expert-representations (no new field); DELEGATES loadout/skill fit to the shipped skill-manifest.ts (preflightSkills); BESIDE capability-catalog (consumes piTools, driver-blind); REUSES g6 presets + the EXISTING /__piflow/agents.json handler (widened, not replaced); BESIDE the fleet observe/registry.ts + observe/discover.ts (named explicitly, different noun/altitude); LEAVES blueprints alone.
- Data-boundary: driver logic + describe() in packages/core/src/runner/drivers/; the agents×drivers×metrics JOIN + any costProfile assembled in the SERVER/CLI layer (where /__piflow/agents.json lives) via an injected metrics reader — NEVER a core function returning product-shaped rows (rejected describeAgents/matchAgents/AgentCard-in-core as a boundary blocker).
- Scope: THIS thrust is P0–P6 (driver object, 2 built-ins collapsing the 4 ternaries, parity contract, count-only Claude decode, cost-spike/loopScore). The self-assembly/query surface (matchAgents, agents list|show|match, swap-the-occupant, version-shims) is DEFERRED to a discovery/overlord track.

OPEN_QUESTIONS:
- Preset-suggests-executor: stay node-only (NodeSpec.executor; my rec) OR later add an explicit mergePreset carry-through (needs its own justification vs decision #3)?
- driverFits posture: advisory-warn by default with opt-in --strict (my rec; preflightSkills already hard-fails loadout) OR fail-closed at compile?
- Driver versioning: stamp {driverId, version} on the run record from P3 but DEFER decodeAt(version) shims until a real v2 (my rec) OR build the version-shim machinery now?
- Per-agent-type rollup: derive by re-keying the extended buildHistory run.json fold at read time (my rec) OR add a dedicated ~/.piflow/metrics file (defer to the overlord track with matchAgents)?
- Self-assembly surface: read-only static card here (widened /__piflow/agents.json + schema agent), matchAgents + agents verbs + swap-the-occupant in the OVERLORD track (my rec, firmer than the draft) OR build the query engine in this thrust?
```

## Changelog vs draft

**Fixed (blocker/major):**
- **F1 (reinvention — checkFit vs shipped skill preflight):** Deleted checkFit's skills/tools branch. Renamed to `driverFits`, scoped to the ONLY 2 net-new axes (sandbox provider + tier-vs-model-pin); loadout/skill fit explicitly DELEGATES to the shipped `preflightSkills`/`resolveSkillLoadout` (`skill-manifest.ts:221/248`). Added a dedicated §3 row + reviewer note. P4 acceptance now asserts `driverFits` does NOT fire on the mcp-loadout case (`preflightSkills` owns it).
- **F2 (reinvention — new AgentBase.driver field):** Rejected. Keep the executor label on the existing `NodeSpec.executor`; no new field, no `??` alias. Reviewer note gives the three verified reasons (two-names-one-concept; `.md`→`AgentPreset`≠`AgentBase`; decision #3 violation). §8 Q1 reframed as the genuine open fork.
- **F3 (reinvention — parallel AgentCard):** Rejected the new `AgentCard`; discovery is now a THIN projection adding only `driver` + `costProfile` onto the existing `NodeConfig`/`AgentCatalog`, reusing `summarizeGates` verbatim.
- **F4 (reinvention — third discovery noun):** Named `observe/registry.ts` + `observe/discover.ts` in §3 with the altitude split; renamed `DriverRegistry`→`DriverTable`; GUI EXTENDS the existing `/__piflow/agents.json` handler instead of a parallel `describeAgents`.
- **F5 (reinvention — builtinMap copy + resolve(selection,driverId)):** `describe().tools.builtinMap()` is now a GETTER over the one `CLAUDE_TOOL_BY_PI_NAME` const, not a copy; dropped `resolve(selection, driverId)` — catalog stays driver-blind, translation stays in claude `buildCommand`.
- **F6 (reinvention — resolveModel owns precedence):** `resolveModel` is now a THIN selector; §2.3 + P2 state precedence stays owned by `model-routing.ts`; P2 is "a rename of the dispatch, not a new precedence surface."
- **F7 (reinvention — new agent-history.json):** Rejected in this thrust; `buildHistory` extended IN PLACE; per-agent-type rollup derived at read time; dedicated file deferred to the overlord track (§8 Q4).
- **F8 (scope — 7-phase framework for a lookup need):** Cut the thrust to P0–P6. `matchAgents`, the `agents list|show|match` verbs, swap-the-occupant write-back, and version-shims are moved to a separate discovery/overlord track (§6 preamble, §8 Q5, §1.4).
- **F9 (moat/boundary — describeAgents/matchAgents/costProfile in core):** Rejected as a boundary blocker; the catalog enumeration + driver×metrics JOIN move to the server/CLI layer via an injected reader; core exports only per-driver `describe()` + the shipped per-id `loadAgentPreset`. §2.1/§2.5/§7 Risk 4/§9 note updated; CI grep asserts no enumeration/stats under `packages/core`.
- **F10 (thesis — AgentBase/AgentPreset conflation + phantom preset.tier):** Reconciled with F2. Reviewer note distinguishes the two types, notes `mergePreset` operates on `AgentPreset`, and honors decision #3 (preset `tier`/`model` never sourced). Removed the frontmatter example that set `tier: deep` on the agent `.md` and had `checkFit` read it.
- **F11 (scope — module-level mutable singleton):** Replaced the exported mutable `defaultDrivers` with a `builtinDrivers()` FACTORY; third-party drivers compose per-run via `RunOptions.drivers`. §2.2 + §7 Risk 6 + moat check updated.
- **F12 (buildability — batch decodeEvents vs incremental fold, blocker):** Replaced `decodeEvents(raw)→Partial<RichNode>` with a STREAMING `eventAccumulator(): NodeAccumulator` (push/snapshot/finalize) that both the incremental `watchRun` tail (`watch.ts:300`) and the batch replay drive one line at a time. Reviewer note anchors `watch.ts:208/217/245/300` + `distill.ts:123-137`.
- **F13 (buildability — Claude decoder impossible tool durations, blocker):** P5 scoped to COUNT-parity not duration-parity; `describe().telemetry.perToolTimeline: 'count-only'`; GUI renders a list, not 0 ms bars; acceptance test uses a REAL `claude -p` fixture. §4.1 added.
- **F14 (buildability — loopScore parity gated + fingerprint mismatch):** P6 loopScore is pi-first, Claude-after-P5; the accumulator emits a canonical `{name, argsFingerprint}` so `read|{path}` and `Read|{file_path}` fold together; per-executor acceptance. §5.2 reviewer note.
- **F15 (buildability — parse vs decode read different artifacts):** §4.2 added: `parseResult` reads FULL stdout at the runner; the decoder reads the SLIMMED persisted `events.jsonl` (`MAX_LINE 8192`/`MAX_RESULT 2048`, `events.ts:24-26`). The authoritative `NodeUsage` comes from `parseResult` (full stdout), so slimming cannot corrupt the load-bearing numbers.
- **F16 (buildability — driver call order for byte-identical P1):** §2.3 + §2.6 run row + P1 acceptance now fix the per-node order `resolveModel → augmentSandbox → buildCommand → exec → parseResult → decode`, with `resolveModel` feeding `ctx.model`/`ctx.provider` exactly as today (`node-lifecycle.ts:434-439`).

**Rejected (with reason):** F2, F3-shape, F7, F9-shape are rejected-and-rehomed rather than adopted verbatim, each via a reviewer note grounded in verified code (`agent-preset.ts:9-11,28-31,61,79`; `node-lifecycle.ts:903/934`; `handlers.ts:392`; `buildHistory` `runView.ts:182-199`). No finding was silently ignored.

---

**Self-check — each blocker/major finding:**
- F1 major PASS (fixed: driverFits narrowed + delegates to preflightSkills)
- F2 major PASS (rejected-with-reason: no AgentBase.driver; keep NodeSpec.executor)
- F3 major PASS (fixed: thin projection, no AgentCard)
- F4 major PASS (fixed: DriverTable rename, observe/registry+discover named, /__piflow/agents.json extended)
- F5 major PASS (fixed: builtinMap getter, no resolve(selection,driverId))
- F6 minor PASS (fixed: resolveModel is a selector, precedence stays in model-routing.ts)
- F7 minor PASS (rejected-with-reason: extend buildHistory in place, no new file)
- F8 blocker PASS (fixed: thrust cut to P0–P6, self-assembly deferred)
- F9 major/moat PASS (fixed: join moves to server/CLI, core exports only describe()+loadAgentPreset)
- F10 major/thesis PASS (fixed: type reconciliation + removed phantom preset.tier example)
- F11 minor PASS (fixed: builtinDrivers() factory, no mutable singleton)
- F12 blocker PASS (fixed: streaming eventAccumulator, not batch)
- F13 blocker PASS (fixed: count-only parity, declared, real fixture)
- F14 major PASS (fixed: pi-first/Claude-after, canonical fingerprint)
- F15 minor PASS (fixed: §4.2 parse/decode artifact split)
- F16 minor PASS (fixed: driver call order pinned)

All 3 blockers fixed (F8, F12, F13); all majors fixed or rejected-with-verified-reason. Doc structure preserved; reconciliation (§3) and observe-parity (§4) sections strengthened with the streaming contract, the delegation-not-reinvention rows, and the boundary re-homing.