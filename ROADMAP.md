# Pi Flow — roadmap

> Forward plan for shaping the substrate into a **product / framework / library**. Grounded in
> [`docs/design/orchestration-substrate.md`](docs/design/orchestration-substrate.md) §10/§11/§14 and the gaps in
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §8. Each item is a *direction*, not a committed sprint.

## The strategic fork — RESOLVED (2026-06-21)

substrate §12 posed the load-bearing fork: **is the substrate the product, or a means to better games?**

**Decision: substrate-as-product.** Pi Flow is now developed as a horizontal, self-designing, durable,
self-improving orchestration framework/library — not only a lever for game-omni. This is the higher-risk path
(it competes with Temporal + LangGraph + CrewAI + the ADAS/GEPA line + Factory + Devin), so it is **only viable
if we hold the §11 intersection tightly and borrow everything else** (§10). The borrow-vs-build table is the
contract; do not out-engineer a solved primitive.

The corollary discipline from §12 still binds: **do not drift into the horizontal build without choosing each
piece against §10.** Build order below is sequenced so the most efficient, fork-independent wins land first.

## The defensible center we are building toward (substrate §11)

1. **Joint structure + node-skill optimization in one credit-assignment pass** — from a single failure, route
   *bad node SKILL (edit skill)* vs *bad chain SHAPE (rewire)*. Nobody routes both axes from one trace.
2. **Online + durable + full-agent-node optimization** — the empty intersection (§10): every optimizer is
   offline/ephemeral/frontier; every durable runtime doesn't self-optimize.
3. **Efficient-fleet economics as a design *objective*** — find the structure that wins on an efficient fleet.
4. **A persisted, versioned, git-logged archive of *discovered structures*** ("what worked for task-class X").
5. **A control agent that generates → verifies → human-approves → durably registers a new tool/node/hook** — the
   §11.5 white-space. Guardrails keep it off the 17.2× path: seam-only, sandboxed, bounded fan-out + circuit
   breaker, registry-as-code-truth.

## Build order

### Near-term — efficient, high-value, fork-independent
- [ ] **Box-and-arrow DAG renderer** over `viz-model.buildModel()` (substrate §8, §14.1). The data layer
      (stages, lanes, phases, Gantt, pathways) already exists; this is *a renderer away, not a data-model away*.
      The operator surface the funded competitors already ship. Surfaces as `piflowctl viz <run>`.
- [ ] **Instrument orchestrator-overhead vs in-pi time** in `run.mjs` (research brief, Next moves). If overhead
      is <2–3%, the "rewrite in Rust" question is settled empirically and stays off the table (§10 language row).

### Mid-term — the COMPOSE and middle-loop prototypes
- [ ] **COMPOSE prototype** (substrate §4, §14.2): a planner phase (in Claude Code, frontier reasoning) that
      decomposes a task, discovers per-part tools/services, and emits a `workflow.json` (DAG + per-node tools +
      credential list). **Borrow AFlow's MCTS / Trace's OPTO** as the search operator + acceptance test (§10).
- [ ] **The middle loop** (substrate §6): progressive structure elaboration across runs of one task
      (scout → run a phase → read results → author the next phase). The long-horizon, "design stage N+1 after
      seeing stage N" case.
- [ ] **Typed schema validation at every handoff** + **claim-provenance tags** (verified/inferred/inherited)
      (substrate §6 gaps, research Addendum B). Schema drift is the single largest multi-agent failure category;
      a "rejected approaches" field is the highest-value/lowest-cost single handoff change.

### Longer-term — the moat pieces
- [ ] **Hermes ⟶ GEPA alignment** (substrate §14.3): reframe the Hermes loop in GEPA's module-credit-assignment
      terms; adopt per-module local rewards (Optimas); pick a shared benchmark and **measure against `dspy.GEPA`**.
      If full-agent-node complexity can't beat prompt-only GEPA, the complexity isn't paying for itself.
- [ ] **Durability decision** (substrate §10, §14.4): prototype journaled-replay semantics or **sit on a durable
      layer** (Temporal/Restate/DBOS-class). Retire "filesystem-artifact resume is our durability story." Note:
      "write it in Rust?" ≡ "build our own durable core?" — and §10 says **borrow** it.
- [ ] **The self-generating control node** (substrate §11.5): on a recurring gap, Hermes *synthesizes* the
      missing unit, wires it in one of the three modes, gates it (verify + **human approve**), registers it to
      the capability/node catalog; the next run uses it. The unclaimed production slot.
- [ ] **A git-logged archive of discovered structures** (substrate §11.4) — "structures that worked for
      task-class X," versioned, à la our Hermes `git`-as-log convention (not facts à la Letta).

## Framework / library shape (forward — not built in Foundation)

When code lands, the target layout splits the engine into a consumable library + a CLI, without disturbing the
verbatim harness that ships today:

```
packages/
  core/     ← run.mjs / extract.mjs surfaced as a library (the producer primitive + DAG)
  compose/  ← the COMPOSE planner (workflow.json emitter)
  viz/      ← the DAG renderer over viz-model.buildModel()
  seam/     ← the control-node primitive (debug / Hermes / supervisor blocks)
apps/cli/   ← the `piflow` entrypoint (viz / compose / run)
```

Until then, the engine stays in [`templates/pi-runner/`](templates/pi-runner/) **byte-identical** (the harness
law) and the product surfaces through the [`SKILL.md`](SKILL.md) + docs.

## Guardrails (the §6 / §13 "don'ts" — non-negotiable)

- **Never pitch this as a swarm.** The moat is *centralized, code-defined orchestration of non-Claude full-agent
  nodes with per-node oracles* — **not** agent count. Peer-to-peer mesh is "mostly a distraction" and the
  measured difference between working and not (17.2× vs 4.4× error amplification). *(substrate §11, research TL;DR)*
- **Adaptive structure lives at seams (between runs), never inside a journaled run.** Resist self-rewriting live
  runs. *(substrate §13)*
- **Don't polyglot the glue.** The orchestrator is IO-bound; a Rust/Go layer earns its keep *only* as a
  crash-isolated sidecar (newline-JSON stdio, never napi-rs FFI) for a hardened always-on supervisor, and only on
  a *measured* Node-stability problem — prefer Go there. *(substrate §10 language row, §13)*
- **Cost is the number to keep beating.** Multi-agent ≈ 4–15× tokens; the efficient fleet + node-timeout/watchdogs
  is the floor — keep it. *(research brief)*
- **Cap sub-orchestrator depth deliberately.** "One layer works, two might help, three is bureaucracy." *(substrate §13)*
- **Credit-assignment quality is the ceiling.** Every new node-type needs its oracle authored at creation time. *(substrate §13)*
