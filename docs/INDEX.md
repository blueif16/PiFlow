# Pi Flow — documentation map

Pi Flow is a **self-designing, durable, self-improving orchestration substrate**: a graph of
full-agent (`pi`) nodes that a planner *designs*, an efficient fleet *runs*, and a learning loop
*improves* — all coordinated through the filesystem. It generalizes the proven `pi-runner` +
`game-omni` + Hermes stack into a horizontal product.

This folder is the **design canon + the buildable spec**. Read in this order.

## Read order

1. **[`../README.md`](../README.md)** — the product pitch + the two layers (vision vs the shipping skill/harness).
2. **[`ARCHITECTURE.md`](ARCHITECTURE.md)** — the *buildable mechanism* at contributor altitude: the two node
   kinds, three modes, three loops, the seam/control plane, and **what is built today vs the gaps**. Start here
   to write code.
3. **[`design/l1-node-envelope.md`](design/l1-node-envelope.md)** — the **L1 schema canon** (the frozen spine):
   everything about a single agent node — work · sandbox · tools · hooks · contract — plus the flat `WorkflowSpec`
   the design agent fills. Start here to write `@piflow/core`.
4. **[`design/orchestration-substrate.md`](design/orchestration-substrate.md)** — the **deep design + strategy
   canon** (the *why*): positioning, the competitive landscape, borrow-vs-build decisions, the defensible
   white-space, the strategic fork. Read for rationale behind every choice in ARCHITECTURE.
5. **[`research/`](research/)** — the **evidence base** (Exa + Reddit legs): the multi-agent-vs-monolith runtime
   brief plus the four 2026-06-21 L1 briefs (tools/OpenClaw · sandbox providers · node hooks · declarative DAG).
6. **[`../ROADMAP.md`](../ROADMAP.md)** — the forward plan: the strategic fork as resolved, the build order, the
   framework/library shape, and the guardrails.
7. **[`pi-agent-notes.md`](pi-agent-notes.md)** — the durable knowledge record about `pi` as a headless executor
   (capabilities, invocation mechanics, sharp edges, the codex-vs-pi comparison, backlog). Reference, not narrative.
8. **[`../reference/observability.md`](../reference/observability.md)** — **`docker logs` for a run**: the
   run-status + event-archive contract, the `piflow logs` CLI (`-f` follow · `--summary` diagnosis · `--node` ·
   `--raw`), the pre-run tool audit, the `RunOptions` observability knobs, and the failure signatures. Lives in
   `reference/` (the harness layer, in the skill's discovery path); read when a run misbehaves.

## The vocabulary (one-line each — full treatment in the canon)

| Term | One line | Canon |
|---|---|---|
| **Node envelope** | The declarative spec of one agent node — work · sandbox · tools · hooks · contract. | design/l1-node-envelope |
| **Producer node** | A full autonomous `pi` agent that does the task (not a thin LLM call). | substrate §2 |
| **Control node / seam** | Holds intelligence *about the workflow*: plan / optimize / debug / gate. | substrate §2, §5 |
| **The three modes** | COMPOSE (build the workflow) · RUN+LEARN (execute + grade + improve) · CHAIN (splice workflows at a seam). | substrate §3 |
| **The three loops** | Inner (within a run) · middle (across runs of one task) · outer (Hermes, across tasks). | substrate §6 |
| **Three wiring modes** | A control node emits a deterministic hook · a callable tool · or a full producer node — always *at a seam*. | substrate §5 |
| **Credit assignment** | Route a failure to the node that owns it; quality is capped by per-node oracles. | substrate §6 |
| **Borrow-vs-build** | Borrow durability + structure-search + GEPA credit-assignment; **own** full-agent nodes + efficient-fleet economics + online-durable self-optimization. | substrate §10 |
| **The white-space** | A control agent that **generates → verifies → human-approves → durably registers** a new tool/node/hook in production. Nobody occupies it. | substrate §11.5 |
| **The fork** | Substrate-as-product vs means-to-better-games. **Resolved: product** (see ROADMAP). | substrate §12 |

## Provenance

Both canon notes originated in `game-omni` on 2026-06-21 and are **canonical here**; game-omni holds a
symlink back so the two projects share one source. Edit them here.
