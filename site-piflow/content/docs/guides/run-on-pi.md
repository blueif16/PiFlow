---
title: "Run on Pi"
summary: "Kick off a workflow on the pi fleet with piflowctl run, and scope it with --from / --until."
read_when:
  - You have a built template and want a live run
order: 2
---

Running a workflow is the `piflow-start` skill. The canonical invocation is the npm-linked global
`piflow` bin pointed at a template directory:

```bash
piflowctl run .piflow/<workflow>/template \
  --provider <gateway> \
  --thinking low \
  --sandbox local
```

## Always: dry-run first

The canonical run is: pull the next prompt → **dry-run (free)** → live background run → poll.

```bash
piflowctl run .piflow/<workflow>/template --provider <gateway> --thinking low --sandbox local --dry-run
```

## Scope a run

Run only part of the DAG:

```bash
piflowctl run … --from <node> --until <node>
```

See the full flag list in the [CLI reference](/docs/reference/cli), and follow the run in
[Monitor a run](/docs/guides/monitor-a-run).
