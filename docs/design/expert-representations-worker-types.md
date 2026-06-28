# Expert Representations — the worker-type system

> 2026-06-27 · DESIGN · branch `feat/expert-representations`
> Companion to the research grounding in
> `docs/research/2026-06-27-expert-representations-worker-types.md`.
> Goal: define what a **worker** *is* in piflow, how it composes, and how it maps onto the
> node schema + observe badge — before building any node.

## Thesis

A worker is **not a new runtime concept** — it is a thin, author-time composition over machinery
that already exists (preset merge, skill staging, the MCP/tool catalog, model tiers, sandbox
scopes, the gate lanes). The research conclusion (see the research doc) was: a type label earns
*legibility* on the human side, but the *performance lift* only appears when the type carries real
difference — a different model, toolset, sandbox, and **feedback ground**. A worker that's only a
system-prompt + an icon is the costume trap.

The unit decomposes into two orthogonal parts:

> **worker = loadout (what it can do) + posture (how it's run & verified)**

- **Loadout** — fat, many, market-fed, **job-agnostic**: a named bundle of skills (+ their tools).
- **Posture** — thin, few, fixed vocabulary: `feedback-ground + tier + sandbox` (+ the gate the
  feedback-ground implies).

Keeping these orthogonal is the whole payoff: you catalog *loadouts* by the dozen, keep *postures*
to three, and **swap the hat without rewriting the agent** (a research loadout can graduate from an
ungated `producer` to a judged `designer` by changing only its posture).

## The layer — one thin author-time layer, four strata

```
┌─ WORKER     = a loadout + a posture        (what you "hire" / drop on a node)
│
├─ POSTURE    (thin, FEW)  feedback-ground + tier + sandbox        ← how it's run & verified
│                          {execution | judgment | none}
│
├─ LOADOUT    (fat, MANY)  skills (+ their tools) + a name tag     ← what it can do (job-agnostic)
│                          skill-led: pick skills, tools follow
│
└─ MARKET     (bottom)     MCP catalog · OpenClaw · skills          ← where capabilities come from
                           (~/.piflow/catalog, ~/.piflow/agents)
```

**Zero new runtime.** `mergePreset` already expands a preset INTO the node's `node.json` at author
time (union tools/skills, node-`deny` wins, role-prompt prepended). The runner never learns the
word "worker" — it only ever sees a node with concrete tools/skills/model/sandbox/gate. So this
layer is **author-time sugar + a catalog + a badge**, not a new execution path.

## What exists today, and the gap

`mergePreset` (`packages/core/src/workflow/agent-preset.ts:64`) binds **four** dimensions and
**deliberately drops three** — and the three it drops are exactly the *posture*:

| Dimension | Part | Bound today? | Seam |
| --- | --- | --- | --- |
| Role prompt | loadout | ✅ `preset.prompt + "\n\n" + node.prompt` | `agent-preset.ts:64` |
| Tools | loadout | ✅ union allow, node `deny` wins | `agent-preset.ts:64` |
| Skill bundle | loadout | ✅ `node.skill ?? preset.skills?.[0]`, staged PRE | `ops/skill.ts`, `runner.ts:1429` |
| Display (icon/label/color) | loadout | ✅ retained as `agentType` label | `WorkflowNode.tsx:114`, `/__piflow/agents.json` |
| **Model / tier** | **posture** | ❌ forward-compat stub; `mergePreset` ignores it (decision #3) | `model-routing.ts:66` |
| **Sandbox envelope** | **posture** | ❌ preset never sets `read`/`write` | `loader.ts:163` (`contract.readScope`/`owns`) |
| **Feedback-ground gate** | **posture** | ❌ preset never injects a gate | `types.ts:159` `GateBody` / `op[]` lane; `types.ts:495` `Hook` |

So today's preset = **loadout only** (real on capability, cosmetic on everything that produces
lift). Closing the three ❌ posture rows is the whole of this design. (Note: there are **6** preset
files on disk — `explore`, `general-purpose`, `interview`, `market-research`, `paper-analyzer`,
`plan` — not "3 seeds"; earlier memory was stale.)

## Schema — `AgentPreset` → `WorkerType`

Keep the existing flat `AgentPreset` (`agent-preset.ts:23`) as the on-disk unit (so the 6 presets
stay valid); recognize its fields as two groups, and add the missing **posture** block. New fields
are optional and a missing posture defaults to `producer` (see below).

```typescript
export interface WorkerType extends AgentPreset {
  // ── LOADOUT group (exists today): id, display{label,icon,color}, skills[], tools, prompt ──

  // ── POSTURE group (NEW) — referenceable by id so loadouts ⟂ postures compose ──
  posture?: PostureId | Posture;        // 'executor' | 'designer' | 'producer' | inline
}

export interface Posture {
  id: PostureId | string;
  feedbackGround: 'execution' | 'judgment' | 'none';   // the defining axis
  tier?: string;            // model CLASS only — NEVER a model id (see invariant). Node override wins.
  sandbox?: { provider?: SandboxProviderKind; readScope?: string[]; owns?: string[] };  // defaults
  // The gate is IMPLIED by feedbackGround (not authored verbatim):
  //   execution → a post-Hook running a build/test command (author supplies the command)
  //   judgment  → a companion judge NODE + reroute loop (a DIFFERENT model than the producer)
  //   none      → the structural floor only
}
```

### Merge-contract changes (extend `mergePreset`)

Precedence rule throughout: **the type provides a DEFAULT; an explicit node value always wins** —
preserving author intent (the spirit of decision #3).

- **tier** — `node.model` → use it; else `node.tier` → use it; else `posture.tier`. Then
  `resolveNodeModel`'s existing precedence resolves tier→model. (See invariant.)
- **sandbox** — `node.contract.readScope`/`owns` if authored, else `posture.sandbox.*`;
  `posture.sandbox.provider` as the default provider.
- **gate** — derive from `feedbackGround` and append into the node's `op[]`/`hook` lane (see Gate
  taxonomy). The structural floor is always auto-injected; the heavy gate is parameterized by the
  author at init.

## Tier, not model — the invariant

Decision #3's real intent was never "types can't influence the model" — it was *"a preset must not
hard-code a concrete model, because model access is per-user/per-provider, so a baked-in model id
isn't portable."* Binding a **tier** satisfies that intent instead of relaxing it: the type
declares a semantic *requirement* ("needs a deliberate-tier model"), and each user's
`~/.piflow/model-tiers.json` fills in whatever model they actually have.

> **A worker-type MAY set `tier`. It MUST NEVER set `model`.**

Precedence (only when `tiers.active`):

```
node.model  >  node.tier  >  posture.tier  >  run.model  >  pi default
```

Two-level indirection, each owned by the right party: the **type** owns "what class this work
needs"; the **user** owns "tier → which model I pay for." Caveats to handle: (a) `model-tiers.json`
is **inert/absent today** → a posture's tier falls back to `run.model`; init must **seed a default
3-tier mapping**. (b) Postures may reference only the seeded tier vocabulary, or a dangling tier
→ fallback. Tier (= model class) is a separate axis from pi's `--thinking` level; keep them
distinct (a later posture field may bind thinking too).

## Gate taxonomy — three weights, each on an existing seam

The `Hook` doctrine settles the executor/designer split: *"if a candidate hook needs a model,
promote it to a pi node instead"* (`types.ts:493`). So:

| Gate | Seam | Truth source | Posture |
| --- | --- | --- | --- |
| **Structural floor** | `op[]` / `checks` (`fenced-tail`, `non-empty`, `json-parses`) — `types.ts:326`, `checks.ts` | the artifact's *shape* | every posture (auto-inject) |
| **Execution** | a post-`Hook` — `run:"<test/build cmd>"`, `when:'on-success'`, `failure:'block'` (`types.ts:495`) | **exit code** | **executor** |
| **Judgment** | a separate pi **node** (the judge) + `reroute` loop (`types.ts:769`) | a **different** model's verdict | **designer** |

Policy:
- **Auto-inject the structural floor** on every posture — ~free, always correct ("did it produce a
  well-formed envelope?").
- **Executor → execution gate** is the research's "execution-grounded debugger" done right
  (objective, ungameable). We can't guess the command, so the posture *declares it wants one* and
  the author supplies `npm test`/`pytest`/… at init.
- **Designer → judgment gate** must be a **separate node/model**, never the same pi judging itself
  (TeamBench: self-verifiers false-accept). So a designer with a judgment gate **expands into two
  nodes at author time** (producer at designer-tier → judge at deliberate-tier → `reroute` retry),
  the way fusion expands.
- **Prefer execution wherever the artifact is runnable**; reserve judgment for artifacts that
  aren't (markdown, prompt, image).

## The three base postures

One posture per value of the feedback-ground axis. This is the whole fixed vocabulary — resist a
14-role org chart.

| | **Executor** | **Designer** | **Producer** |
| --- | --- | --- | --- |
| `feedbackGround` | `execution` | `judgment` | `none` |
| Truth signal | run code · tests · build | a *different* model judges → retry | none (structural floor only) |
| `tier` (default) | cheap-competent **coding** (reads ~200× the tokens) | stronger **judging/reasoning** | deliberate |
| `sandbox` | owns the workspace, write-capable | owns its output dir; narrow | **read-leaning** |
| tools | file-edit · shell/run · test | render/image · web · *no destructive code tools* | web · search · read |
| gate | exec post-hook + floor | judge node + `reroute` + floor | floor only |
| typical work | coders | markdown / prompt / **visual** design (prompt→image→Claude judges→retry) | research · analysis · planning |

## Where the existing Claude-Code-style agents go

The 6 presets are **loadouts already**; their posture is **`producer`** (`feedbackGround: none`).
They're neither executors (nothing to run) nor designers (no judge-retry by default) — and that's
*correct*: add a gate only when there's a real feedback ground. Recognizing this **completes the
posture vocabulary** (the third value was hiding in your existing agents).

| Existing preset | Loadout | Posture | Note |
| --- | --- | --- | --- |
| `general-purpose` | minimal | `producer` | the **degenerate default** — what a node is when no type is assigned |
| `explore` | read-only search tools | `producer` + **read-only sandbox** | defining trait is a *posture* field, not the skill |
| `market-research`, `paper-analyzer`, `interview` | web / pdf / interview skills | `producer` | produce-a-doc research roles |
| `plan` | planning skill | `producer` | produces a plan artifact |

**Upgrade path = the payoff of loadout ⟂ posture.** Because they're orthogonal, a research loadout
can be promoted `producer → designer` (add a judge node) when output quality must be enforced —
e.g. `market-research` loadout + designer posture = the same bundle, now gated for sourcing &
completeness. `general-purpose` stays the ungated safety net.

## Skill-led loadouts

"Tools and skills are close" collapses cleanly if **a skill declares the tools it needs**
(Claude-skill `allowed-tools` style). Then the human-picked unit is a **skill**; its **tools
follow** (resolved from the catalog); a **loadout = a set of skills (+ any extra raw tools)**; the
**name tag** is the loadout label. Three things, one spine: *pick skills → tools come along →
label it.*

This is **new work** — `resolveSkillStage` (`ops/skill.ts`) just copies the dir today; it does not
read a tool manifest. Adding a `tools:`/`allowed-tools:` field to skill frontmatter (and resolving
it through the catalog) is what makes the market self-wiring.

## Market reality (what exists)

- **MCP / tool market — real.** `packages/core/src/catalog/{client,introspect,sync}.ts` +
  `tools/openclaw-{community,host,shim}.ts` feed `~/.piflow/catalog/`. Live introspection
  (`listServerTools` → entries → `mcp.*` binds) works; OpenClaw (the "claw market") is wired.
- **Skill market — half-built.** Skills bind & stage (`ops/skill.ts`, `--skill`), but
  `~/.piflow/skills/` is **not populated yet** — free-import-from-a-canonical-market is the open edge.
- **Worker catalog — exists, embryonic.** `~/.piflow/agents/` already holds the 6 presets; that
  *is* the worker catalog. It just lacks the posture depth this design adds.

## Dynamic representation

- **At init — a loadout editor.** Show the candidate worker's default skills/tools chips + its
  posture; let the user **add/remove** (the `mergePreset` union/`deny` you already have) before
  locking. This is your "template he can fill in more tools."
- **At observe — a loadout + posture badge.** The passthrough already flows
  (`agentType` → `run.json` `runner.ts:2165` → `RunViewNode` `runView.ts:284` → `FlowNodeData`
  → `AgentPresetIcon` `WorkflowNode.tsx:114`). Widen it to surface the **operating contract**:
  not just `Designer 🎨` but `Designer · judgment-gated · deliberate-tier · owns out/`. Every field
  is already computed (`resolveNodeModel`, `sandbox.provider`, the implied gate) — a passthrough
  widen, not new computation.

## Composition & the sprawl antidote

Composition at init is the existing `mergePreset` (union tools/skills, node-`deny` wins = your
"add or delete to cast full functionality"). The risk is sprawl (1000 near-identical workers).
Antidote, same shape as the research's "keep the taxonomy small": **few postures (fixed vocab),
many loadouts (curated marketplace), free-compose as the power-user escape hatch.** Most users
*hire a curated worker*; power users *assemble a custom loadout*; both compile through `mergePreset`.

## Out of scope (but adjacent)

The "self-critic node that reads all traces and optimizes the DAG between runs" is a
**meta-optimizer**, not a worker — it edits the *system*, not an output. That is Hermes OPTIMIZE /
`piflow-enhance` territory (capture → route → edit → verify → **human approve** → commit; every
edit must generalize). It rides on top of the worker layer but is governed separately. See research
doc §"three different nodes."

## Open decisions

1. **Decision #3 — RESOLVED.** Type binds **tier, never model** (invariant above). `model` stays
   node-authored-only; `tier` becomes posture-sourceable. Node override always wins.
2. **Gate injection — RESOLVED in shape.** Structural floor auto-injects on every posture; the
   heavy gate (execution post-hook / judge node) is *declared by the posture, parameterized by the
   author* at init. The 6 legacy presets default to `producer` (floor only) — no behavior change.
3. **Author-time expansion — keep.** Posture (tier/sandbox/gate) expands into
   `tier`/`contract`/`op[]`/`hook` at author time, like tools/skills today; the runner stays
   preset-agnostic.
4. **Skill→tool manifest — NEW WORK.** Decide the frontmatter field (`allowed-tools:`?) and the
   catalog resolution. Gates the "self-wiring market."
5. **Seed the tier vocabulary.** `init` must write a default `~/.piflow/model-tiers.json` (3 tiers)
   so postures' tiers aren't inert. Name the three tiers (model classes, not worker names).
6. **Designer expansion ergonomics.** A judgment gate = producer + judge + reroute (2–3 nodes).
   Decide whether init expands this automatically from `posture: designer` or asks the author to
   confirm the judge node.

## Next step

When we author the actual `executor.md` / `designer.md` (and the upgraded research) **role-prompts**,
load the `agentic-prompt-design` skill first — those are agent-facing prose with an acceptance bar.
This doc defines the *schema, layering, and contract*; the prompts are the next artifact.
