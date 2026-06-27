---
title: "Nodes and envelopes (L1)"
summary: "A node is one agent fully described by a declarative envelope: work, sandbox, tools, hooks, and contract."
read_when:
  - You want to understand what a single node is
  - You are writing or editing a node envelope
  - You want to gate, retry, escalate, or reroute on a node
order: 2
---

> Conceptual page. The field-by-field schema is owned by `packages/core` (the template loader +
> node schema) and surfaced in the [WorkflowSpec reference](/docs/reference/workflow-spec); the design
> canon is `../../docs/design/l1-node-envelope.md` and `../../docs/design/node-action-protocol.md`.

A node is one agent described by a declarative **envelope**. It compiles to one headless `pi`, and
every part of its behavior is declared up front — nothing about control flow is decided at runtime by
the model.

## The five concerns

- **work** — what the node does (its prompt and task).
- **sandbox** — where it runs and which files it may read or write.
- **tools** — the callable surface it is granted (builtins, `oc.*`, `mcp.*`).
- **hooks** — the deterministic behavior wired at its edges (expressed as ops, below).
- **contract** — the output it must produce for the next node.

These five are stable. The node-action protocol changes how the **hooks** concern is *authored* — it
collapses several older grammars into one — without adding a sixth concern.

## The op envelope

A node carries an ordered list of **ops**. Every op declares *when* it fires, *what* it reads and
writes, and *one consequence* if it fails — then does exactly one of four things:

| Op class | Verb | What it does |
|---|---|---|
| **transform** | DERIVE | a declarative data transform — seed an input, project, merge, or promote state |
| **run** | ACT | a deterministic shell or function side-effect (never an LLM) |
| **gate** | DETECT | a pure predicate over its inputs that emits a pass / warn / fail verdict |
| **action** | CONTROL | a model-free control action — retry, escalate, reroute, or notify |

Each op also sets:

- **when** — `pre`, `post`, `on-success`, `on-failure`, or `always` (default `post`).
- **reads / writes** — the files it touches. These fold into the DAG's edge inference, and a `pre`
  op's reads are folded into the realized prompt.
- **onFailure** — the one consequence vocabulary, shared by every op: `block`, `warn`, `stop`,
  `retry`, or `escalate` (default `block`). This keeps **detection** (a gate's verdict) cleanly
  separate from **consequence** (what `onFailure` does about it).

The protocol is fully **additive**. The older `hooks`, `checks`, and `policy` keys still work — they
are lowered into ops when the template loads — so a node that declares none of the new fields runs
byte-for-byte identically.

```jsonc
"op": [
  { "when": "pre",  "gate": { "kind": "json-parses", "path": "spec/blueprint.json" }, "onFailure": "block" },
  { "when": "post", "writes": ["verify/report.json"],
    "run": { "cmd": "node", "args": ["scripts/lint.mjs"] }, "onFailure": "warn" },
  { "when": "post", "gate": { "kind": "fenced-tail", "param": { "minItems": 3 } }, "onFailure": "retry" },
  { "when": "on-failure", "action": { "kind": "rerouteTo", "node": "w4-execute", "max": 3 } }
]
```

## Failure and control flow

When a node fails a gate or its contract, its `on-failure` ops decide what happens next — all
model-free, all bounded:

- **retry** — re-run the node from a fresh attempt, filtered by the *failure class* the runner
  derives from the evidence (a missing artifact, a degenerate output), not by asking the model.
- **escalate** — re-run on a stronger model fed the *verified* failure facts (missing-artifact
  paths, gate verdicts, the stderr tail), never a self-score.
- **reroute** — send a failed verify back to an upstream node to try again. The DAG stays acyclic:
  the loop is **unrolled at compile time** into a bounded number of cloned stages, never a runtime
  back-edge. A passing attempt short-circuits the remaining clones.
- **notify** — emit a user-facing notification through the host's notification seam.
- **compensate** — run a cleanup or rollback side-effect on failure (an `on-failure` `run` op).

Because reroute is unrolled rather than cyclic, a node can drive a bounded quality loop — produce,
verify, re-produce with the failure evidence, re-verify — without the graph ever containing a cycle.
