---
title: "CLI reference"
summary: "The piflowctl run command and its flags: provider, thinking, sandbox, and DAG scoping."
read_when:
  - You need the exact piflowctl run flags
order: 1
draft: true
---

> Draft — this page is the canonical public home for CLI flags. Keep it generated from / verified
> against the CLI source in `packages/cli`; do not let it drift from the implementation.

## `piflowctl run <templateDir>`

Run a workflow template on the pi fleet.

```bash
piflowctl run .piflow/<workflow>/template --provider <gateway> --thinking low --sandbox local
```

| Flag | Meaning |
|---|---|
| `--provider <gateway>` | the provider/gateway the fleet calls |
| `--thinking <level>` | reasoning effort (e.g. `low`) |
| `--sandbox <mode>` | sandbox mode (e.g. `local`) |
| `--dry-run` | validate the template and wiring without spending tokens |
| `--from <node>` | start the run at this node |
| `--until <node>` | stop the run after this node |

<!-- TODO: confirm the complete flag set against packages/cli and fill in remaining options. -->
