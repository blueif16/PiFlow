---
"@piflow/cli": minor
---

`add-node` now scaffolds the FULL per-node SDK surface — gates, judge, checkpoint, control, and topology.

The scaffolder previously emitted only the derive hooks, a lossy `--check` (`kind:path` only), and
`policy.fail`, so authoring any richer gate meant hand-editing `node.json`. It now emits every per-node block
the loader already honors — **zero SDK/schema change**; `loadTemplate` stays the oracle and every flag
round-trips through it (the anti-drift gate):

- **Checks** — `--check <kind[:path[:severity[:param]]]>` (`param` JSON-parsed for count-floor's `{min,path}`),
  `--check-pre` (the pre lane over staged inputs), `--on-warn` (policy.warn). The terse `--check kind[:path]`
  form is unchanged.
- **Execution gate** — `--gate-run <cmd[:args][@cwd]>`: a POST `op.run` whose non-zero exit BLOCKS the node
  (distinct from `--merge-run`, a data-derive with no verdict).
- **Control** — `--escalate <tier|model>` (on failure → a stronger model, `io.escalate`) · `--reroute
  <node[:max]>` (bounded loop back to a strict-ancestor node).
- **Judge** — `--judge <judgeTier[:threshold]>` inlines the sibling `judge.md` rubric prose into `judgeGate`
  (materialized at load into a real `<id>__judge` node); the CLI rejects `judgeTier === --tier` (no
  self-judging). `--judge-on-fail`/`--judge-retry-max`/`--judge-retry-scope` set the gate policy.
- **HITL** — `--checkpoint <confirm|input|select:prompt>` (+ `--checkpoint-choice/-default/-headless/-timeout`):
  the G5 human gate.
- **Topology** — `--fusion <moa|best-of-n>` (+ `--fusion-n/-panel/-judge/-obligations/-no-verify`) ·
  `--subworkflow <ref>` (inline a sub-template as a sub-DAG).
- **Contract** — `--full-access` (per-node jail-off, local only) · `--fill-sentinel <s>`.

`piflowctl add-node --help` and the `piflow-init` skill document the full surface.
