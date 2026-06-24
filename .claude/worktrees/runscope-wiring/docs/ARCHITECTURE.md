# Pi Flow — architecture (the buildable mechanism)

> Contributor-altitude reference: *how the substrate is shaped and what exists today.* The **why** (positioning,
> competitive map, borrow-vs-build, alternatives considered) lives in [`design/orchestration-substrate.md`](design/orchestration-substrate.md);
> this file points into it by section (e.g. *substrate §6*) rather than restating it.

## 1. One sentence

A workflow is a **graph of full-agent nodes coordinated through the filesystem**, spliced by **control nodes**
that plan / optimize / debug / gate at node boundaries. Efficient `pi` processes run the nodes; a deterministic
Node driver owns the graph; a learning loop improves it. *(substrate §1, §2)*

## 2. Two node kinds — the core abstraction (substrate §2)

- **Producer node** — does the task. A full autonomous `pi` agent (read/bash/edit/write + tools + a loaded
  skill + its own environment), **not** a thin LLM call. This is what `pi-runner` already spawns: one headless
  `pi` per node. *Intelligence about the work* lives here.
- **Control node (a "seam")** — holds *intelligence about the workflow itself*: it reads upstream results and
  decides what happens next — **plan / optimize / debug / gate**. The planner, the Hermes block, the debug
  block, and the health supervisor are all the *same primitive* on a seam.

Keep them separate — it is the producer/verify-node law, generalized. **Coordination is the filesystem**
(artifacts by path, never re-emitted prose), which is also the high-fidelity handoff the literature says decides
whether a mesh works at all *(research brief, Q1; substrate §6)*.

## 3. The three modes (substrate §3)

| Mode | What it does | Status |
|---|---|---|
| **COMPOSE** | Build the workflow: decompose the task, discover the tools/services each part needs, emit a `workflow.json` (structure + per-node tools + credentials), hand the user a provisioning list. | **Gap** — DAGs are hand-authored today; the per-node tool/seed primitive exists, *auto-discovery* does not (§4 below). |
| **RUN + LEARN** | Execute on the `pi` fleet; grade each node against its oracle; the learning loop edits the node's **skill** or the chain's **architecture**. | **Partial** — `pi-runner` runs; Hermes is the learn loop; per-node criteria + verify gates are the oracle. |
| **CHAIN** | Connect workflow→workflow through a **control node (seam)**. Same workflow ⇒ optimize the skill system; different workflow ⇒ edit the *structure* (the long-horizon case). | **Gap as a first-class seam** — `--from` suffix-rerun is the primitive. |

## 4. COMPOSE — what exists, what's missing (substrate §4)

The tool-composition primitive is **~80% built**, because *OpenClaw's embedded runtime is `pi`* and pi-runner
already does the **per-node** version:

- `contract({tools:[...]})` → `DRIVER-TOOLS` marker → `pi --tools <allowlist>` at spawn (per-node, not global).
- `DRIVER-SEED: <dest> <= <src>` pre-stages a node's files/templates into its working dir before spawn.
- `--worktree` (per-run git worktree) + `--sandbox` (per-node Seatbelt `.sb` from `DRIVER-READ-SCOPE`) isolate runtime.
- Bespoke per-node tools: `DRIVER-SEED` a node's `.pi/extensions/*.ts` `registerTool` and load with `-e`.

So *"each node born with exactly the tools+files its design calls for, in DAG order"* exists. **The only real
COMPOSE gap is auto-discovery**: nothing introspects a node's skill to *infer* its tools/credentials; they are
hand-authored. Borrow ADAS/AFlow's search rigor for the planner (substrate §9.A, §10).

## 5. Seams / the control plane (substrate §5)

- A **background supervisor** runs health checks on configurable triggers; on a trigger it acts **at a node
  boundary (a seam)**, never by mutating a live run.
- **Pluggable control blocks** form an escalation ladder: a **debug block** (diagnose → rerun / stop / patch)
  in front, a **Hermes block** (durable, generalizing fix to the owning skill/chain) behind it.
- **HARD CONSTRAINT — hot-edits happen at seams, not mid-run.** "Insert a debug node on a trigger" =
  stop at a node boundary, splice the control node, **relaunch the affected suffix** (`--from`), reuse unchanged
  upstream. (This mirrors LangGraph's own "recompile between runs" rule.)
- **Three wiring modes for a generated unit:** (1) a pre/post **deterministic hook** (`DRIVER-SEED` pre ·
  `DRIVER-MERGE`/`DRIVER-PROJECT` post — the "code node between agents"); (2) a callable **tool** exposed to a
  node's `pi` agent; (3) a full **producer node** in the DAG. Generation always happens *at a seam*, then
  `--from` relaunch — never a mid-run mutation. *(This is the mechanism behind the §11.5 white-space.)*

> **Durability caveat (substrate §5, §10).** The Claude-Code Workflow script is genuinely journaled
> (`Date.now`/`Math.random` throw, so resume replays identically); **the pi-runner driver is NOT** — its resume
> is *artifact-stat-based* (`--from` checks which on-disk artifacts exist), a weaker guarantee. Real
> journaled-replay durability is a **BORROW** item (Temporal/Restate/DBOS-class), not something to hand-roll.

## 6. The three loops — where "the gradient" lives (substrate §6)

1. **Inner (within a run):** fixed structure, data varies — `loop-until-dry` / `loop-until-green`. *Have.*
2. **Middle (within one task, across runs):** progressive structure elaboration — scout → run a phase → read
   results → author the next phase. *The new middle loop; mostly absent.*
3. **Outer (across tasks):** Hermes — grade per-node, route the failure to the owning node, edit the **skill**
   (improve a wave) or the **workflow** (improve the chain). *Have; it is the "gradient."*

**Credit assignment is the hard part** and the analogy strains: the "gradient" is a *discrete diagnosis* (which
node owns this failure?). The thing that makes it tractable is a **per-node oracle** — the frontier agrees
(GEPA degrades to blind search on uninformative feedback; Optimas shows per-module local rewards beat global).
**Oracle quality is the ceiling.** Contain error amplification with the §6 checklist: centralized DAG · blocking
clean-context verify at the handoff · per-node ground-truth oracle · by-reference handoff · circuit-breaker
(single agent = 1.0×, centralized = 4.4×, independent mesh = **17.2×**; detection without blocking/rollback ≈ 3%).

## 7. What is built today (reuse — do not rebuild) (substrate §7)

| Piece | Where (`templates/pi-runner/`) | Role in the substrate |
|---|---|---|
| Full-agent node | `run.mjs` (one `pi` per node) | the producer primitive |
| Static DAG from one source of truth | `extract.mjs` (record prompts+DAG, no codegen) | the workflow representation |
| Per-node oracle | per-node criteria + verify gates + artifact-contract-vs-filesystem | credit-assignment signal |
| Outer learning loop | Hermes (route to canonical owner; skill vs chain edit) | the "gradient" |
| Escalation ladder | escalation gate (retry → cross-family consult) + watchdogs | the seam/debug→Hermes ladder |
| Cross-restart resume | `--from` + resume preflight (artifact stat) | the seam relaunch mechanic |
| Viz **data layer** | `viz-model.mjs` (DAG ⋈ run-status → stages/lanes/Gantt/pathways) | feeds a box-and-arrow view |
| Write isolation / read scope | `--worktree` + `--sandbox` (Seatbelt) | per-node environment isolation |

## 8. The gaps to build (ordered in [`../ROADMAP.md`](../ROADMAP.md))

- **Box-and-arrow DAG renderer** over `viz-model.buildModel()` — data layer exists, renderer is absent in this
  repo (`tui/` is template-only). Efficient, high-value, useful regardless of the fork. *(substrate §8)*
- **COMPOSE auto-discovery** — infer per-node tools/credentials from a node's skill; emit `workflow.json`. *(§4)*
- **The middle loop** — progressive structure elaboration across runs of one task. *(§6)*
- **Typed schema validation at every handoff** + **claim-provenance tags** (verified/inferred/inherited) —
  schema drift is the single largest multi-agent failure category. *(substrate §6, research Addendum B)*
- **Journaled durability** — replace artifact-stat resume with a borrowed journaled-replay layer. *(§5, §10)*
- **The self-generating control node** — generate → verify → human-approve → durably register → next run uses
  it. The defensible white-space. *(substrate §11.5)*

> Every implementation runs through Hermes (capture → route → edit → verify → **approve** → commit → record) and
> must **generalize across all future runs** — never hard-code one case, never write a reward-hackable test.
