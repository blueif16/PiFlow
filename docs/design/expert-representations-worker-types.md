# Expert Representations — the worker-type system

> 2026-06-27 · DESIGN · branch `feat/expert-representations`
> Companion to the research grounding in
> `docs/research/2026-06-27-expert-representations-worker-types.md`.
> Goal: define what a **worker type** *is* in piflow and how it maps onto the node
> schema + observe badge — before building any node.

## Thesis

A worker type is **not a new concept** — it is the existing `AgentPreset`, *promoted from a
costume into a real binding*. The research conclusion (see the research doc) was: a type label
earns legibility on the human side, but the **performance lift only appears when the type carries
real difference** — a different model, a different toolset, a different sandbox, and a different
**feedback ground**. A type that's only a system-prompt + an icon is the trap.

> **worker type = skill bundle ("the résumé") + model + tools + sandbox + feedback-ground**

Today's `AgentPreset` binds only the first three loosely and **deliberately drops the rest**.
Expert Representations = close that gap on the seams that already exist.

## What exists today (and the gap)

`mergePreset` (`packages/core/src/workflow/agent-preset.ts:64`) merges a preset into a node:

| Dimension | Bound by preset today? | Seam |
| --- | --- | --- |
| Role prompt | ✅ `preset.prompt + "\n\n" + node.prompt` (role first) | `agent-preset.ts:64` |
| Tools | ✅ union allow, node `deny` wins | `agent-preset.ts:64` |
| Skill bundle | ✅ `node.skill ?? preset.skills?.[0]` | `ops/skill.ts`, staged as a PRE-step |
| Display (icon/label/color) | ✅ retained as `agentType` label | `WorkflowNode.tsx:114`, `/__piflow/agents.json` |
| **Model / tier** | ❌ **forward-compat stub; `mergePreset` ignores it (decision #3)** | `model-routing.ts:66` (`resolveNodeModel`) |
| **Sandbox / capability envelope** | ❌ preset never sets `read`/`write` | `loader.ts:163` (`contract.readScope`/`owns` → `sandbox.read`/`write`) |
| **Feedback ground (verify gate)** | ❌ preset never injects a gate | `types.ts:159` `GateBody` / `op[]` gate lane |

So a preset today = **prompt + tools + skill + icon**. That is precisely "costume + skill": real
on the skill axis, cosmetic on everything that the literature says produces the lift. The three ❌
rows are the whole of this design.

## The defining axis: feedback ground

The cleanest discriminator between types (and the one the research singled out — execution-grounded
debugger beats conversational critics) is **what grounds the node's feedback loop**:

- **`execution`** — the truth signal is *running the artifact* (build, tests, runtime error).
  Objective, cheap to trust. → the **Executor / Coder**.
- **`judgment`** — the truth signal is *an LLM reading the artifact* (Claude looks, decides retry).
  Subjective, gameable, but the only option for non-executable artifacts (markdown, prompt, image).
  → the **Designer**.
- **`none`** — no gate; pure producer (rare; e.g. a scratchpad node).

This axis is new metadata, but it does not need new runner machinery: it **selects which `op[]`
gate the type injects** (the gate lane already exists — `runner.ts:1006`, `lower.ts`, the
`fenced-tail`/`json-parses`/`count-floor`/… check vocabulary in `checks.ts`).

## Schema — promote `AgentPreset` to `WorkerType`

Extend the existing interface (`agent-preset.ts:23`) with the three missing bindings. Keep it a
superset so the 6 existing presets stay valid (the new fields are optional).

```typescript
export interface WorkerType extends AgentPreset {
  // legibility + capability (unchanged): id, display{label,icon,color}, skills[], tools, prompt

  // NEW — the bindings that make a type REAL:
  feedbackGround?: 'execution' | 'judgment' | 'none';   // the defining axis
  tier?: string;            // DEFAULT model class — node's own model/tier still wins
  sandbox?: {               // DEFAULT capability envelope
    provider?: SandboxProviderKind;
    readScope?: string[];   // default contract.readScope
    owns?: string[];        // default contract.owns (= sandbox.write)
  };
  gate?: GateBody | GateBody[];   // the feedback-ground gate, appended to the node's op[] lane
}
```

### Merge contract changes (extend `mergePreset`)

Precedence rule throughout: **the type provides a DEFAULT; an explicit node value always wins.**
This preserves the *spirit* of decision #3 (author intent is never silently overridden) while
letting the type carry a real model/sandbox/gate.

- `tier` — `node.model` set → use it; else `node.tier` set → use it; else `type.tier`. So the
  type's tier is a fallback, and `resolveNodeModel`'s existing precedence
  (`node.model > tiers[node.tier] > run.model`) does the rest. **This is the one reconciliation
  with decision #3** — see Open decisions.
- `sandbox.read/write` — `node.contract.readScope`/`owns` if authored, else `type.sandbox.readScope`/
  `owns`; `type.sandbox.provider` as the default provider when the node didn't pick one.
- `gate` — append `type.gate` into the node's `op[]` gate lane **unless** the node already declares
  an equivalent gate. Default the injected gate's `onFailure` to `retry` (designer) /
  policy-driven (executor); node can override.

## The two seed types, fully specified

These are the only two the user's own intuition converged on ("mostly executors, plus designers").
Resist a 14-role marketplace; add types only when a *work shape* genuinely differs.

| Dimension | **Executor / Coder** | **Designer** |
| --- | --- | --- |
| `feedbackGround` | **`execution`** | **`judgment`** |
| Truth signal | run code · tests · build | an LLM judges the artifact → retry |
| `tier` (default) | a cheap-competent **coding** tier (it reads ~200× the planner's tokens — route cheap) | a stronger **judging/reasoning** tier |
| `sandbox` | `seatbelt`/`local`, **owns the workspace** (write-capable), readScope = workspace + deps | narrower — owns its **output dir**; usually no write into code |
| `tools` | file-edit · shell/run · test | render/image · web · **no destructive code tools** |
| `gate` (injected `op[]`) | execution gate: `fenced-tail` + a "code runs / tests pass" check; on fail → policy `retry` | judgment gate: LLM-judge (or the `reroute`/`rerouteGate` generate→judge→retry loop, `types.ts:769`); on fail → `retry` up to `max` |
| `skills` (résumé) | coding skill bundle | writing / visual-design skill bundle |
| `display` | label "Executor", icon e.g. `hammer` | label "Designer", icon e.g. `palette` |

The user's "visual designer" (designs a prompt → generates an image → Claude looks and decides
retry) is the **designer** archetype with an image tool + a judgment gate; it maps directly onto
the existing `reroute` loop. It is **not** a relabeled executor — different feedback ground.

## Skills as the job market

The "job market" framing is the right mental model and it's already half-built: skills are real,
executable, catalog-distributed capabilities (`node.skill`, `--skill`, `~/.piflow/skills`,
the capability catalog). A worker type is a **résumé** = a curated `skills[]` bundle bound to a
model/tools/sandbox/feedback-ground. The catalog (GitHub specialist skills, `~/.piflow/agents/`)
is the market you hire from. This is the Sista-AI "review them like a résumé" move — except every
line on the résumé *does something*, which is exactly what keeps it out of the costume trap.

## Observe — the badge must show the binding, not just an icon

The passthrough already flows end-to-end: `agentType` → `run.json` node record (`runner.ts:2165`)
→ `RunViewNode.agentType` (`runView.ts:284`) → `FlowNodeData.agentIcon/Color/Label`
(`gui/.../runView.ts:218`) → `AgentPresetIcon` (`WorkflowNode.tsx:114`).

Extend the badge to surface the **operating contract** (the research's "human-side legibility"):
not just `Designer 🎨` but `Designer · judgment-gated · pro-tier · owns out/`. The runner already
computes every field needed — `resolveNodeModel` gives the resolved model/tier, `sandbox.provider`
is known, the injected `gate`'s `feedbackGround` is known. So this is a passthrough widen, not new
computation: add `{ tier, sandboxProvider, feedbackGround }` alongside `agentType` on the node
record and render them as sub-badges. That gives the human the who-does-what + can-it-be-trusted
snapshot the role-clarity research says drives situational awareness and takeover.

## Out of scope (but adjacent)

The user's "self-critic node that reads all traces and optimizes the DAG between runs" is a
**meta-optimizer**, not a worker type — it edits the *system*, not an output. That is Hermes
OPTIMIZE / `piflow-enhance` territory (capture → route → edit → verify → **human approve** →
commit, every edit must generalize). It rides on top of the type system but is governed
separately; keep it out of this schema. See the research doc §"three different nodes."

## Open decisions

1. **Reconcile with decision #3.** Today `mergePreset` *deliberately* never sources model/tier from
   a preset. This design relaxes that to "type provides a default tier, node override wins." Confirm
   that's acceptable, or keep model strictly node-authored and let the type only *recommend* a tier
   in `display` (documentation-only). Recommendation: relax it — a type that can't bind a model
   class isn't a real type, and node-override-wins preserves author intent.
2. **Gate injection vs explicit authoring.** Should the type *auto-inject* its gate, or only supply
   a default the author opts into? Auto-inject is the stronger product (the type *means* its
   feedback ground) but is a behavior change for the 6 existing presets (which have no gate today).
   Recommendation: auto-inject for the two new seed types; leave the 6 legacy presets gate-less
   (their `feedbackGround` defaults to `none`).
3. **Author-time vs run-time expansion.** `mergePreset` runs at **author time** (init bakes the
   preset into `node.json`); the runner never re-reads `~/.piflow/agents/`. The new bindings
   (sandbox/tier/gate) must therefore also expand at author time into `contract`/`tier`/`op[]`.
   Confirm we keep the author-time model (yes — it keeps the runner preset-agnostic).
4. **The 6 existing presets** (`explore`, `general-purpose`, `interview`, `market-research`,
   `paper-analyzer`, `plan`) are research/analysis roles, not executor/designer. Decide whether they
   become `feedbackGround: 'judgment'` (most are produce-a-doc roles) or stay `none`.

## Next step

When we author the actual `executor.md` / `designer.md` preset **role-prompts**, load the
`agentic-prompt-design` skill first (those are agent-facing prose with an acceptance bar). This
doc defines the *schema and contract*; the prompts are the next artifact.
