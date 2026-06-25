# Pi Flow

> *Repo + plugin name: `piflow` (at `~/Desktop/piflow`). Surfaces as three Claude Code skills —
> `piflow-init` (create), `piflow-enhance` (improve), `piflow-start` (run) — plus the `@piflow/core`
> SDK and the `piflow` CLI.*

## Your next ultracode can be on a Pi fleet.

**Pi Flow is a self-designing, durable, self-improving orchestration substrate** — a graph of
**full-agent (`pi`) nodes** that an agent *designs*, a non-Claude fleet *runs*, and a control plane
*observes and improves*, all coordinated through the filesystem. Prove a workflow once on Claude Code
(ultracode); run the **identical DAG** on a fleet of **non-Claude / efficient** models — no rewrite, no
codegen, no drift.

## The core philosophy

**A workflow is data, not a UI.** A Claude Code agent owns the entire loop through the **`@piflow/core`
SDK + the `piflow` CLI**: it designs the DAG, spawns the fleet, monitors every node, and improves the
flow between runs. The human never wires nodes on a canvas, clicks *Run*, disconnects a node, or
configures a run on a screen — at most they drop in an API key. You steer by **talking to the agents in
the terminal**, never on the frontend.

**The GUI and the TUI are monitor-only twins.** Their one job is to give a clear picture of what is
running right now — which nodes are live, their context/cost, the warnings, the shape of the DAG. Both
views (and the `watch` sentinel) consume the **one** live stream, `@piflow/core/observe`'s
`watchRun` / `readRunModel`, re-derived **verified-not-trusted** from the on-disk run layout. There is
exactly one reader; the views never reimplement run state and never diverge.

## The three levels

| Level | What it is | When |
|---|---|---|
| **L1 — the node** | one agent fully described by a declarative **envelope** (work · sandbox · tools · hooks · contract). One headless `pi`. | per node |
| **L2 — COMPOSE** | an agent *designs* the flow, tool-aware — emits a flat `WorkflowSpec`, the SDK `compile`s it to a DAG. Author once; the fleet inherits it. A human-authored imperative workflow and an agent-authored spec compile to the **same** DAG. | once, at init |
| **L3 — control plane** | *run · observe · intervene · learn* — control nodes that live on the **seams** between nodes: the debug→Hermes ladder, the stuck-node governor, the background supervisor. | during a run + **between** runs |

```
  L2 COMPOSE ──designs──►  L1 RUN  (one `pi` per node · parallel stages · filesystem state)
       ▲                       │
       │ re-compose            ├─ observe ─► ONE stream ─► GUI · TUI · watch   (monitor-only)
       │ (middle loop)         │
       └──────────  L3 control plane  ◄── debug → Hermes ──► edit skill (→ L1)
                               (outer loop = credit-assign across runs = the gradient)
```

That closed loop — **COMPOSE → run → observe + debug/Hermes → edit skill OR re-compose → rerun** — *is*
the substrate.

## The node envelope (L1)

One declarative object describes a node; the prompt, sandbox, tool allow-list, hooks, and contract all
*fall out of* it. Authoring is data, not control-flow code.

- **Per-node sandbox isolation** — `local` · `seatbelt` · `worktree` · `daytona`. Each node gets a clean,
  bounded workspace; context and task stay isolated.
- **Declarative per-node tools** — a tight allow-list per node. Pi Flow is built **on top of `pi`**, so
  MCP servers and the **OpenClaw / Hermes** community catalog ingest as node tools, with real per-node
  **tool control** — not an all-or-nothing grant.
- **Pre/post-node hooks** — deterministic checks that run **before and after** each node. This is the
  production gate that makes the flow safe to run unattended.
- **Verified, not trusted** — each node ends with one fenced ` ```json ` block; the driver `stat()`s
  every output artifact and evaluates the node's **checks**. `ok` ⇒ the files exist on disk. Those checks
  double as the **per-node criteria** the learning loop optimizes against.

## Parallel + the three loops — long-horizon & self-improvement

- **True parallel stages.** Independent nodes run as one stage; the driver merges each node's *promoted*
  state into shared `RunState` at a deterministic **stage barrier** (LangGraph super-step semantics).
  Plain code owns stage order, parallel lanes, and halt-on-failure — the model never decides control flow.
- **Three loops.** *inner* (within a run, data-adaptive) · **middle** (across runs of one task —
  re-compose the next phase after seeing this one, chaining DAG after DAG for long-horizon work like a
  full library port) · **outer** (**Hermes** — credit-assign across runs and generalize a fix to the
  owning skill: the gradient over each node and over the whole flow).
- **Memory of fixes.** The debug block fixes *this* instance; the Hermes block durably registers the
  *generalized* fix so the next run starts ahead. Hot-edits land at **seams, between runs** (then `--from`
  relaunches the affected suffix), never mid-run. The self-improving edge is **generate → verify →
  human-approve → register → next run uses it.**

## Status

Running **today**: the L1 node envelope + runner, the one-stream observability (GUI · TUI · `watch` ·
`logs`), the tool/sandbox plane, and parallel stage-barrier promotion. The **L2** design planner and the
**L3** control plane (Hermes ladder · stuck-node governor · background supervisor · the middle/outer
loops) are the **next horizon** — and they introduce no new primitives: a control node is a node with
LLM intelligence on a seam, wired in via the same three modes already in the spine (deterministic
**hook** · callable **tool** · full **producer node**). So L3 is mostly *composition*. See
[`docs/INDEX.md`](docs/INDEX.md) and [`ROADMAP.md`](ROADMAP.md) for what is GA vs in flight.

## Documentation

- **[`docs/INDEX.md`](docs/INDEX.md)** — start here: reading map + the vocabulary.
- **[`docs/design/l1-node-envelope.md`](docs/design/l1-node-envelope.md)** — the L1 schema canon (the frozen spine).
- **[`docs/design/l2-l3-boundary-map.md`](docs/design/l2-l3-boundary-map.md)** — the three levels, the seams, the closed loop.
- **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** — the buildable mechanism + what is built today vs the gaps.
- **[`docs/design/orchestration-substrate.md`](docs/design/orchestration-substrate.md)** — the deep design canon.
- **[`ROADMAP.md`](ROADMAP.md)** — the build order, framework shape, and guardrails.

## The pieces

Four artifacts, one stack. The **engine** is the SDK; the **CLI** drives it; the **TUI + GUI** are the
single monitor layer; **`pi`** is the agent runtime each node spawns — installed once, *not* bundled.

| Piece | Package / bin | Role |
|---|---|---|
| **Engine (SDK)** | `@piflow/core` | the L1 node-envelope schema, the DAG compiler, the runner, the tool/sandbox plane, and the `observe` stream |
| **CLI** | `@piflow/cli` → `piflow` | the front door: `run` · `inspect` · `extract` · `status` · `watch` · `logs` · `gui` |
| **Monitor** (the viewer) | `@piflow/tui` → `piflow-tui`  +  the GUI canvas (`piflow gui`) | monitor-only twins on the **one** `observe` stream |
| **Runtime** (underneath) | `pi` — external prerequisite | the headless agent each node spawns. Installed and credentialed **once** via `~/.pi/` (parallels `~/.piflow/`); kept external so `@piflow/core` stays product-agnostic logic only |

## Install (skills · CLI · pi)

This repo is the **piflow** Claude Code plugin. Have **`pi`** on your PATH first (the agent runtime — Pi
Flow spawns it per node; it is not bundled). Then make the three skills globally discoverable and link the
bins:

```bash
# prerequisite: install `pi` (earendil-works/pi · pi.dev) and verify it runs:  pi --list-models cp
for s in piflow-init piflow-enhance piflow-start; do
  ln -sfn "$(pwd)/.claude/skills/$s" ~/.claude/skills/$s
done
npm --prefix packages/cli link        # the global `piflow` bin
npm --prefix tui link                 # the global `piflow-tui` monitor (optional)
```

Claude Code surfaces `piflow-init` to create/port a workflow, `piflow-start` to run/monitor one, and
`piflow-enhance` to improve one.

## Quickstart

> The canonical per-project layout + adopt steps live in [`reference/sdk-consumer.md`](reference/sdk-consumer.md).

1. **Source of truth = the workflow template** (`.piflow/<wf>/template/`). The SDK `loadTemplate`s it into
   a `WorkflowSpec`. *Porting a proven Claude `.js`?* `piflow extract` previews its DAG and the realized
   prompts replay on the fleet — no rewrite, no codegen.
2. **Set the credential ONCE in pi's own global config** — `cp templates/models.json.example
   ~/.pi/agent/models.json`, edit `apiKey`/`baseUrl`/model ids, `chmod 600`, verify `pi --list-models cp`.
3. **Dry-run (free), then live (background)**:
   ```bash
   piflow run <templateDir> --provider cp --thinking low --sandbox local --until <phase> --dry-run  # stages + per-node tools/hooks + pi cmd
   piflow run <templateDir> --provider cp --thinking low --sandbox local --until <phase>             # live; run in background
   ```
4. **Monitor as the console** — `piflow gui` (the canvas) · `piflow-tui <rundir>` (the terminal) ·
   `piflow watch <rundir>` (silent sentinel: one line on done/fail) · `piflow logs <run> -f`. Every view
   reads the **one** stream. State + behavior live on disk (`.pi/run.json` + per-node event archives).

## The laws

- **Single source of truth = the workflow template/spec.** Improve a node by editing its prompt/skill and
  re-proving it; the fleet runs the new prompts automatically.
- **The engine is the `@piflow/core` package, not a per-repo copy.** Per-repo specifics live in the
  template + config; an engine fix is a package bump.
- **Driver owns the graph; pi owns the node.** Plain code decides stage order + parallel lanes +
  halt-on-failure; the model never decides control flow. Nodes coordinate via the filesystem.
- **Verified, not trusted.** Each node ends with one fenced ` ```json ` block; the driver `stat()`s every
  `outputArtifact`. `ok` ⇒ files exist on disk.
- **Headless invariants are non-negotiable.** Close stdin, `--offline`, `--no-extensions` (the provider
  comes from pi's global `models.json`); capture each node's event stream so a silent hang is visible via
  `piflow logs`.

## Security

No secrets ship in this repo. `.env.example` and `models.json.example` contain only placeholders
(`sk-REPLACE_ME`, `your-provider.example.com`); the bundled `.gitignore` excludes the real files. Never
commit a filled-in credential.

## License

MIT
