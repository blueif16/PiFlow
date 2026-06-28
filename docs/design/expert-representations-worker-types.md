# Expert Representations — workers, gates, and self-correction

> 2026-06-28 · DESIGN · branch `feat/expert-representations`
> Companion research: `2026-06-27-expert-representations-worker-types.md` (why divide work into
> types), `2026-06-27-agent-marketplace-layering-validation.md` (validation vs adopted platforms),
> `2026-06-28-loop-engineering-self-improving-systems.md` (the optimize layer).
> Goal: define what a **worker** is, how its **output is verified** (gates), and how the system
> **self-corrects** (the change-scope gradient) — all as author-time composition over existing runtime.

## Thesis

A worker is **not a new runtime concept** — it's thin, author-time composition over machinery that
already exists (preset merge, skill staging, the MCP/tool catalog, model tiers, sandbox scopes, the
gate/check lanes, reroute, checkpoint). The hard-won conclusions across the three research docs:

1. A type label earns *legibility*; the *performance lift* needs real difference — model, tools,
   sandbox, and a real **gate**. A label-only worker is the costume trap.
2. **Don't reify `executor` / `designer` / `producer` as types.** They're *names for common
   compositions*, not schema kinds. The market itself assembles them; reifying them re-introduces the
   rigid taxonomy we're avoiding.
3. **Gates are not part of a node's existence.** They're a separate, freely-composable *post-node*
   layer. What makes a node an "executor" is simply *that an execution gate is attached to it*.

So the model is three composable planes, none of which is a new runtime path:

> **node = loadout (what it can do) + intrinsics (tier · sandbox) + a gate pipeline (how its output
> is verified)** — and the system can **self-correct** at three scopes (artifact / node / workflow).

## Plane 1 — Capability (inside a node): skills are the atom

The **single skill** is the smallest composition unit (it carries its own tool manifest, below). A
**loadout/bundle is just a named set of skills** — sugar, not a new unit. Tools sit below skills but
aren't human-composed; they *follow* from a skill's `requires`. So: *pick skills → tools come along →
label it.* The market transacts skills + MCP servers; full "workers" are convenience bundles.

### Skill tool manifest — `requires` (floor) ≠ `allowed` (ceiling)

"Tools a skill needs" is NOT "tools a skill may use." Both live **on the skill object** (portable):

- **`requires`** — dependency FLOOR: tools/MCP/capabilities that MUST be bound or the skill can't run.
  Drives (a) **auto-wiring** the loadout and (b) a **preflight fail-fast** at init (abort before
  spending a pi if a required capability is missing). *The signal the self-wiring market runs on.*
- **`allowed`** — permission CEILING: what the *running* agent may touch (Anthropic SKILL.md
  `allowed-tools`). Scopes/restricts; does not provision.

Invariant: `requires ⊆ bound ⊆ allowed ⊆ catalog`; node-effective sets union over the node's skills.
`allowed` is the adopted agent convention; a machine-readable `requires` floor is
**novel-for-agents / standard-in-plugins** (VS Code `extensionDependencies`, RPM `Requires:`, npm
`dependencies`, Semantic Kernel `apiDependencies`). `resolveSkillStage` (`ops/skill.ts`) reads neither
today.

## Plane 2 — Intrinsics (of a node): tier + sandbox

What's *intrinsic* to a node (part of its identity) is only **how it runs**: its model **tier** and
its **sandbox**. Gates are NOT here.

### Tier, not model — the invariant

> **A worker MAY set `tier`. It MUST NEVER set `model`.**

A type declares a semantic *class* ("needs a deliberate-tier model"); the user's
`~/.piflow/model-tiers.json` maps tier→model. This satisfies the original decision #3 (a preset must
not hard-code a non-portable model id) instead of relaxing it. Precedence (when `tiers.active`):

```
node.model  >  node.tier  >  type.tier  >  run.model  >  pi default
```

Caveats: `model-tiers.json` is inert/absent today → init must **seed a default 3-tier vocabulary**;
types reference only seeded tiers (else fallback). Tier (model class) is separate from pi's
`--thinking` level.

### Sandbox

`node.contract.readScope`/`owns` → `sandbox.read`/`write` (`loader.ts:163`). Capability gating is
**two levels** (adopted practice): *availability* (what the model sees — loadout allow/deny) vs
*permission* (what runs without approval — see human gate + autonomy). Finer than one field.

## Plane 3 — Gates (after a node): kind + policy, freely composed

Gates are an ordered, freely-composable **post-node pipeline** — piflow's existing word is `GateBody`
(`types.ts:159`). Each:

> **gate = kind + policy**

### Gate kinds — what grounds the verdict

| Kind | Verdict source | Seam (all exist) |
| --- | --- | --- |
| **execution** | running the artifact — exit code | a post-`Hook` `run:"<cmd>"`, `failure:'block'` (`types.ts:495`) |
| **judge** (agentic) | a **different** model's verdict | a separate pi judge node + `reroute` (`types.ts:769`) |
| **human** (HITL) | a person approves / rejects | `checkpoint` / G5 |
| *auto* | — | the **empty pipeline** (zero gates = pure producer); not a 4th kind you attach |

A **structural floor** (`fenced-tail`/`non-empty`/`json-parses` — `checks.ts`) auto-injects on every
gate-bearing node ("did it produce a well-formed envelope?"). Compose freely in sequence — `execution
→ judge → human` — ordered as a **cost ladder**: deterministic first, LLM-judge next, human last, so
you fail fast and never spend a person on what tests already killed. The `Hook` doctrine draws the
line: *"if a check needs a model, promote it to a pi node"* — so judge/human are nodes, execution is a
hook. The judge model must differ from the producer (TeamBench: self-verifiers false-accept).

### Policy — what happens on the verdict (retry is here, not a kind)

**Retry is a policy, not a gate kind** — *any* non-auto gate can carry it (execution retries on
test-fail, judge on reject, human on "redo"). piflow already models this:
`PolicyAction = block | warn | stop | retry | escalate` (`checks.ts`). Full vocabulary:

| Policy | Action | piflow today |
| --- | --- | --- |
| **accept** | let it through (optionally note) | `warn` |
| **block** | reject, fail node, don't propagate | `block` |
| **retry** | re-run the producer **with the gate's feedback injected** (reflexion). Bounded budget. | `retry` + `reroute` max |
| **escalate** | change the *handler*: stronger tier / to human / stricter gate | `escalate` |
| **reroute** | take a *different downstream path* (classify failure → repair node) | `rerouteGate` |
| **stop** | abort the run | `stop` |
| **fallback** | emit a safe default / last-good output (graceful degradation) | *(new)* |

Notes: a policy is really a **ladder** — *retry-with-feedback ×N → escalate → block/fallback* (the
retry→escalate ladder already exists). Plain same-input retry is the degenerate case; **retry always
carries the gate's feedback**. Only `fallback` is genuinely new to piflow. *Literature caution
(loop-eng doc): pure-LLM self-critique is unreliable — prefer an **execution gate** as the retry
trigger where the artifact is runnable; a judge-only retry inherits self-verifier-false-accept.*

## `executor` / `designer` / `producer` are recipes, not types

They are just **named (intrinsics + gate-pipeline) compositions** kept in the catalog for legibility
("hire an executor"). Underneath there is only one base node + composition.

| Recipe | Intrinsics | Gate pipeline | Typical work |
| --- | --- | --- | --- |
| **producer** | deliberate tier · read-leaning sandbox | *auto* (none / floor only) | research · analysis · planning |
| **executor** | cheap-competent coding tier · write sandbox | execution gate (run/tests) | coders |
| **designer** | designer tier · narrow sandbox | judge gate + retry (prompt→image→judge→retry) | markdown / prompt / visual design |
| *(+HITL)* | any | append a human gate | anything needing sign-off |

The 6 existing presets (`explore`, `general-purpose`, `interview`, `market-research`,
`paper-analyzer`, `plan`) are **producer recipes** (no gate) — `general-purpose` is the degenerate
default (what a node is with no recipe), `explore` adds a read-only sandbox. **Upgrade path** = the
payoff of keeping the planes orthogonal: drag an execution/judge/human gate onto any producer to make
it gated, without rewriting the agent.

## Self-correction — the change-scope gradient

When a gate fails, the correction can edit one of three things, at increasing scope. This is the
optimize layer, grounded in the loop-engineering survey (prior art named per level):

| Level | What it edits | Mechanism | Lands in | Prior art |
| --- | --- | --- | --- | --- |
| **1 · retry-with-feedback** | the **artifact** | regenerate with the gate's critique injected | — (re-run) | Reflexion · Self-Refine · CRITIC |
| **2 · retry-with-fix** | the **node's system** (prompt / tool-wiring) | infer the problem + consult the **fix/issue memory** → patch this node → re-run. **Best-effort, no guarantee.** | the **run instance** (ephemeral, recorded) | ExpeL + DSPy/GEPA (novel *combination*) |
| **3 · per-DAG optimize** | the **whole workflow** (structure, edges, shared prompts/tools) | "loop engineering" — between-runs, must generalize | the **template** (durable) | ADAS · AFlow · DSPy · GEPA |

Levels 2 & 3 repair the **system**, not the artifact — differing only in *scope* (one node vs the
DAG) and *timing* (in-loop best-effort vs deliberate promotion). The scope gradient maps exactly onto
the **template/run edit fork**: a run-scoped auto-fix vs a durable template change.

**The promotion path is first-class** (loop-eng gap #2 — value leaks without it): run-scoped fix →
if it recurs and **passes a held-out check** → **human-gated promotion** to the template (Hermes
OPTIMIZE / `piflow-enhance`). The **fix/issue memory** is the shared substrate (piflow's
`file_bug`/`search_past_bugs` pattern, per-workflow); per loop-eng gap #3 it is **multi-artifact** —
it stores not only node prompt-fixes but reusable **gate-pipelines, loadouts, and proven sub-flows**
(AWM/Voyager).

**Guardrail (stated loudly).** A node auto-editing its own system to pass its own gate is
reward-hacking in its purest form — and the literature shows it's severe (a 2025 study: 73.8% of
optimizations were proxy gains without real gains; the gap *widens* with more steps). Therefore
retry-with-fix must be **bounded**, **recorded**, and **run-scoped** (never silently in the template),
and promotion to the template requires a **held-out check + human approval** (best-practice
mitigations: held-out validation distinct from the bootstrapping signal, human-in-the-loop promotion,
cross-domain transfer). This is *why* level 2 stays ephemeral until a human promotes it.

## GUI — drag-to-compose, with config as the single source of truth

Gates, skills, and recipes are composed in the GUI by **dragging a widget onto a node**: a palette of
gate chips (execution / judge / human) and skill/loadout chips; dropping one appends to that node's
pipeline (with an editable policy — retry budget, escalate target) or its loadout. Stacking chips =
the pipeline.

**Invariant: every GUI edit is a mutation to the JSON/config the run reads** — a dropped chip is not
GUI-local state, it's an edit to `node.json` (the gate/skill lane). Today the GUI is a **viewer**
(live info-IN over SSE; "pi talk-back" flagged as step 2, unbuilt); this requires building the
**write-back path**. Config is the single source of truth; the GUI is an *editor* over the per-repo
template (respecting the data-boundary rule — the GUI never owns data).

**Edit target — both, user chooses:** editing the **template** (`node.json`) is the superset (changes
the template *and* propagates to the active run); editing a **run instance** is ephemeral (this run
only). Mutating a *live, in-flight* run is the harder snapshot-consistency case — out of v1.

**Observe badge.** The `agentType` passthrough already flows (`runner.ts:2165` → `RunViewNode`
`runView.ts:284` → `WorkflowNode.tsx:114`). Widen it to surface the operating contract — the loadout
chips + the gate pipeline + tier/sandbox — not just an icon. Every field is already computed.

## Market reality (what exists)

- **MCP / tool market — real.** `catalog/{client,introspect,sync}.ts` + `tools/openclaw-*` feed
  `~/.piflow/catalog/`; live introspection + `mcp.*` binds work; OpenClaw wired.
- **Skill market — half-built.** Skills bind & stage (`ops/skill.ts`, `--skill`); `~/.piflow/skills/`
  not populated — free import is the open edge.
- **Worker catalog — embryonic.** `~/.piflow/agents/` holds the 6 presets; lacks the gate/recipe depth.

## Composition & the sprawl antidote

Composition at author time is the existing `mergePreset` (union tools/skills, node-`deny` wins).
Antidote to sprawl: **few gate kinds + a fixed policy vocabulary; many loadouts (curated market);
free-compose as the power-user escape hatch.** Most users hire a curated recipe; power users assemble.

## Open decisions

1. **Decision #3 — RESOLVED.** Worker binds **tier, never model**; node override wins.
2. **Skill manifest — RESOLVED as TWO fields.** `requires` (floor → auto-wire + preflight) vs
   `allowed` (ceiling → runtime scope); `requires ⊆ allowed`. Remaining: resolver impl.
3. **Author-time expansion — keep.** Gates/tier/sandbox expand into `op[]`/`hook`/`tier`/`contract`
   at author time; runner stays preset-agnostic.
4. **Seed the 3-tier vocabulary** in `~/.piflow/model-tiers.json` at init (model classes, not worker
   names) — name the three.
5. **Designer/judge gate ergonomics + spec.** A judge gate = producer + judge node + reroute; decide
   auto-expand vs author-confirm; pin `judgeTier`, rubric source, retry budget, threshold, escalation.
6. **`fallback` policy** — add to the `PolicyAction` vocabulary (the one genuinely new policy).
7. **GUI write-back path** — biggest new build: GUI edits → `node.json` mutations; template-vs-run
   target; out-of-scope = live mid-run mutation.
8. **Self-correction layer** — implement L1 (retry-with-feedback, via reroute) first; L2
   (retry-with-fix) needs the **fix/issue memory + run-scoped patching + held-out promotion gate**;
   L3 (per-DAG optimize) = Hermes/`piflow-enhance`, human-gated. The promotion path (L2→L3) and the
   multi-artifact memory are the two pieces the survey says we must not skip.

## Next step

When we author the actual gate/recipe **role-prompts** (e.g. the judge's rubric prompt, the
`executor`/`designer` recipe prompts), load the `agentic-prompt-design` skill first — those are
agent-facing prose with an acceptance bar. This doc defines the *schema, planes, and contracts*; the
prompts are the next artifact.
