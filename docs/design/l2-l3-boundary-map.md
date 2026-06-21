# Pi Flow — L2 / L3 boundary map (a sketch, deliberately not rigorous)

> **Status:** SKETCH, not a frozen spine. L1 is the frozen schema ([`l1-node-envelope.md`](l1-node-envelope.md));
> this just maps the *boundaries and expectations* of L2 (COMPOSE) and L3 (the control plane) so we know where
> the seams are before we build them. Deep treatment lives in [`orchestration-substrate.md`](orchestration-substrate.md)
> §3–6 and [`../ARCHITECTURE.md`](../ARCHITECTURE.md); this is the one-page map over them.

## The three levels, one line each

| Level | What it is | When it runs | Built? |
|---|---|---|---|
| **L1 — the node** | a single agent fully described by the envelope (work · sandbox · tools · hooks · contract) | per node | ✅ spine; runner (M1) in progress |
| **L2 — COMPOSE** | an agent *designs* the flow: emits a flat `WorkflowSpec`, the SDK `compile`s it to a DAG | once, before the fleet runs ("init") | ◑ boundary built (`WorkflowSpec`/`compile`); planner = M6 (research in flight) |
| **L3 — control plane** | *run + observe + intervene + learn*: control nodes on seams (debug → Hermes ladder · stuck-node governor · background supervisor) | during a run + **between** runs | ○ deferred (post-M6); reuses L1/L2 primitives |

## L2 — COMPOSE (concepts + expectations)

- **The design agent** (frontier model, may fan out to sub-agents): *decompose task → investigate each part →
  discover tools/credentials → emit `WorkflowSpec`.* Runs **once, build-time**; it produces a flow, never executes it.
- **Output = a ready-to-run, provisioned `Workflow`** + a **provisioning list** (the credentials/services the human
  must supply). Tool choice comes from searching the registry (M4).
- **Reliability loop:** structured-output emit → `tryCompile` (validates: missing/dup producer, cycle) → **repair**
  (feed errors back, capped iterations). Borrow AFlow/ADAS rigor but **start simple** (single-pass + repair before MCTS).
- **Two front-ends, one DAG:** the agent-authored `WorkflowSpec` *or* a human-authored imperative Workflow script
  both compile to the same internal `Workflow`.

## L3 — the control plane (concepts + expectations)

- **Control node = the same primitive as a producer node, but it holds intelligence *about the workflow*** (plan /
  optimize / debug / gate) and lives **on a seam** (a node boundary), not inside a node.
- **The escalation ladder:** **debug block** (diagnose → rerun / stop / patch *this* node at its trigger line) →
  **Hermes block** (durable, *generalize* the fix to the owning skill/chain — "optimize"). Debug fixes the instance;
  Hermes fixes the class.
- **Stuck-node governor:** when a flow can't complete, decide *skip / re-plan / redesign* — **only on error-out;
  generally don't change the flow.**
- **Background supervisor:** a long-lived listener that health-checks on triggers/timings and acts **at a node
  boundary**, *never mutating a live run.*
- **The three loops:** inner (within a run, data-adaptive) · **middle** (across runs of one task — re-compose the
  next phase after seeing this one) · outer (**Hermes** — credit-assign across tasks; the "gradient").
- **Hard constraint:** hot-edits happen **at seams, between runs** (then `--from` relaunch the affected suffix),
  never mid-run. The self-improving edge (generate → verify → **human-approve** → durably register → next run uses
  it) is the white-space.

## The boundaries (the actual ask)

- **L1 ↔ L2** — `NodeIntent` / `WorkflowSpec`: the flat bag the design agent fills, the SDK `compile`s. *L2
  assembles L1 atoms; L1 executes them.* **Already concrete in the spine.**
- **L1 ↔ L3** — `run-status.json`: the runner (L1 execution, M1) emits it; L3's supervisor **watches** it and
  intervenes at node boundaries (splice a debug node, relaunch a suffix via `--from`). L3's learning loop edits a
  node's **skill/prompt** — i.e. it writes back into **L1**.
- **L2 ↔ L3** — the **seam**: COMPOSE designs the *initial* flow; L3 may **re-compose** (the middle loop) at a seam
  *between runs* — invoking L2 again to redesign the affected suffix. So L3 can call L2, but only at a boundary.
- **The closed loop:** `COMPOSE (L2) → run (L1) → observe + debug/Hermes (L3) → edit skill (back to L1) OR
  re-compose (back to L2) → rerun.` That cycle *is* the substrate.

## Where L3 sits in the roadmap

The current horizontal roadmap (M1–M6) is mostly **L1 + L2** (runner, sandbox/tool providers, catalog, viz/CLI,
COMPOSE planner). **L3 is the next horizon, post-M6** — and it does **not** introduce new primitives: a control
node is a node with LLM intelligence on a seam; its input is the runner's `run-status.json`; its outputs wire in
via the three modes already in the spine (deterministic **hook** · callable **tool** · full **producer node**).
So building L1 + L2 well is what makes L3 mostly *composition*, not new machinery.
