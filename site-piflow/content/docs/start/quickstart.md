---
title: "Quickstart"
summary: "The shortest path from zero to a live run on the pi fleet."
read_when:
  - You want to see Pi Flow run with the least ceremony
order: 2
---

The canonical run is always: pull the next prompt from the bank, dry-run it (free), then a live
background run, then poll.

```bash
# 1. dry-run — free, validates the template and the wiring
piflowctl run .piflow/<workflow>/template --provider <gateway> --thinking low --sandbox local --dry-run

# 2. live run — one pi per node, parallel stages, filesystem state
piflowctl run .piflow/<workflow>/template --provider <gateway> --thinking low --sandbox local
```

Scope a run to part of the DAG with `--from <node>` and `--until <node>`.

Watch it with the GUI, the TUI, or the `watch` sentinel — all three are monitor-only twins of the
one `@piflow/core/observe` stream. See [Monitor a run](/docs/guides/monitor-a-run).
