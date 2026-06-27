---
title: "Getting started"
summary: "Install @piflow/core and the piflow CLI, then create and run your first workflow."
read_when:
  - You are setting up Pi Flow for the first time
order: 1
---

This is the full path from a clean machine to your first live run. For the shortest version, see
the [Quickstart](/docs/start/quickstart).

## Prerequisites

- Node.js >= 20
- A provider/gateway the fleet can call (set per run with `--provider`)

## Install

See [Installation](/docs/start/installation) for the supported install paths.

## Create a workflow

Use the `piflow-init` skill to scaffold a workflow template. The source of truth is a structured
template at `.piflow/<workflow>/template/`, which `@piflow/core` loads into a `WorkflowSpec` and runs
one `pi` per node.

See [Author a workflow](/docs/guides/author-a-workflow).

## Run it

```bash
piflowctl run .piflow/<workflow>/template --provider <gateway> --thinking low --sandbox local
```

Then follow it live — see [Run on Pi](/docs/guides/run-on-pi) and
[Monitor a run](/docs/guides/monitor-a-run).

## Next steps

- [Architecture](/docs/concepts/architecture) — how the substrate fits together
- [CLI reference](/docs/reference/cli) — every `piflowctl run` flag
