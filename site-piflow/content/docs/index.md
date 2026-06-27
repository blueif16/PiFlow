---
title: "Pi Flow"
summary: "A self-designing, durable, self-improving orchestration substrate: a graph of full-agent (pi) nodes an agent designs, an efficient fleet runs, and a control plane observes and improves."
read_when:
  - You are new to Pi Flow and want the one-paragraph picture
order: 0
---

Pi Flow lets you prove a workflow once on Claude Code, then run the **identical DAG** on a fleet of
efficient, non-Claude models — no rewrite, no codegen, no drift.

A workflow is **data, not a UI**. A Claude Code agent owns the whole loop through the `@piflow/core`
SDK and the `piflowctl` CLI: it designs the DAG, spawns the fleet, monitors every node, and improves
the flow between runs. You steer by talking to the agents in the terminal — never by wiring nodes on
a canvas.

## Start here

- [Getting started](/docs/start/getting-started) — install and run your first workflow
- [Quickstart](/docs/start/quickstart) — the shortest path to a live run
- [Architecture](/docs/concepts/architecture) — the substrate and the three levels

## The three levels

| Level | What it is |
|---|---|
| **L1 — the node** | one agent fully described by a declarative envelope (work · sandbox · tools · hooks · contract). One headless `pi`. |
| **L2 — COMPOSE** | an agent *designs* the flow and emits a flat `WorkflowSpec`; the SDK compiles it to a DAG. |
| **L3 — control plane** | run · observe · intervene · learn — control nodes that live on the seams between nodes. |

## The three skills

Pi Flow surfaces as three Claude Code skills:

- **`piflow-init`** — create a workflow, or port one from Claude `.js` / n8n / a fresh design.
- **`piflow-start`** — run and monitor a workflow on the pi fleet.
- **`piflow-enhance`** — improve a node, or the chain between nodes, between runs.
