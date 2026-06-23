# Condition: PORT — parse a Claude Code Workflow `.js` → `@piflow/core` WorkflowSpec

You have a proven Claude Code Workflow (`.claude/workflows/<name>.js`, the `agent()`/`parallel()`/
`pipeline()`/`phase()` form) and want it as a typed `WorkflowSpec` the SDK's `compile()` consumes. This is
the extract→WorkflowSpec bridge.

## Do this
```bash
node <skill>/scripts/parse-claude-workflow.mjs <path/to/workflow.js> [--arg k=v ...] -o out.spec.json
```
- `--arg k=v` passes workflow input args through (a STATIC input-arg branch realizes its DAG — e.g.
  `--arg mode=companion` drops the verify nodes), exactly as `extract.mjs` does.
- Exit **0** means the spec was emitted AND it `compile()`s with the recorded staging preserved (the oracle).
  Exit **non-zero** means extraction or the compile self-check failed — the spec is NOT trustworthy; fix the
  cause, do not hand-edit around it.

## What the script does (and why it's faithful, not a guess)
It does NOT re-parse the `.js` by hand. It REUSES two ground-truth pieces:
1. **`templates/pi-runner/extract.mjs`** — runs the workflow body under recording stubs and captures the
   EXACT realized prompts + the parallel/serial grouping (the same recording the pi driver replays). No codegen.
2. **`@piflow/core`'s own `parseMarkers` + `compile`/`tryCompile`** — so the marker grammar and the DAG
   compiler are the SDK's, never a fork.

Per recorded node it emits one `NodeIntent`:
- `prompt` = the realized text with the `DRIVER-*` marker lines **stripped** (the SDK re-emits markers from
  `io` via `markersFromNode`; leaving them in the prose would duplicate them in the spawned pi prompt).
- `io.artifacts` ← `DRIVER-ARTIFACTS` (with per-artifact `schema` from `DRIVER-SCHEMA`).
- `io.checks` / `io.policy` / `io.returnMode` / `io.fillSentinel` ← the matching markers (usually absent — see
  "the gap" below).
- `sandbox.read` ← `DRIVER-READ-SCOPE`, `sandbox.write` ← `DRIVER-OWNS`.
- `tools.allow` ← `DRIVER-TOOLS`, `tools.deny` ← `DRIVER-EXCLUDE-TOOLS`; `agentType` ← the recorded hint.
- **`io.dependsOn`** = every node id of the immediately-preceding recorded stage. This reproduces the EXACT
  recorded staging (serial order + parallel lanes) without needing data-flow inference. `io.reads`/`produces`
  are left empty in the mechanical port; the DAG rides on `dependsOn`.

The self-check then compiles the spec and asserts the compiled stage count and per-stage membership equal the
recording — so a 0 exit means "the DAG survived the translation," not merely "the script ran."

## What it CANNOT recover — the refinement pass (do this by hand, after)
The mechanical port is the floor. Three things the `.js` does not encode, that you upgrade afterward:

1. **True data-flow (`io.reads`/`io.produces`).** The SDK's native model INFERS edges from `reads ⋈ produces`;
   the port instead pins the recorded order via `dependsOn`. To get real data-flow (looser, parallelism-
   revealing), replace `dependsOn` with each node's actual `reads` (the upstream files it consumes) and set
   `produces` = its artifacts. Keep `dependsOn` until you do — never ship a spec with neither.

2. **Deterministic hooks.** `DRIVER-SEED` (pre) and `DRIVER-PROJECT`/`DRIVER-MERGE`/`DRIVER-SEED-CONTRACT`
   (post) are run.mjs's hook family; the SDK models them as typed `Hook` objects with a `run` function, which a
   text marker can't carry. The port drops them; re-add them as `hooks: { pre/post: [...] }` in code where the
   workflow relied on them.

3. **The new contract decisions (checks/policy/returnMode/fillSentinel) — THE GAP.** The current Claude
   `contract()` helper emits only `artifacts`/`owns`/`readScope`/tools. It has no field for the integrity
   checks, the verdict→action policy, the fill-sentinel, or an explicit return mode we added to the SDK. So a
   ported workflow is almost all-defaults here (empirically, game-omni-v1.6.js → 16/16 nodes with artifacts,
   1/16 with checks, 0/16 with returnMode). **What the SDK does with the absent fields (the safe defaults):**
   - `returnMode` defaults to **optional when the node declares artifacts** (the file proves the work),
     **required otherwise** (a zero-artifact gate node's return is its only proof). Correct for most nodes.
   - The **schema gate** runs only where an artifact declares a `schema` (opt-in; absent ⇒ skipped).
   - **No integrity checks** run unless declared; **`fillSentinel`** is off unless declared.
   So a port is SAFE by default (it cannot over-block), just not as STRICT as it could be. Enriching a node
   with checks/policy is a deliberate upgrade — see `enrich-contract.md` for whether to default it or generate
   it (the open decision: a few default policies vs. an LLM-authored per-node check set).

## Fixture
`fixtures/sample-workflow.js` is a 4-node (serial → parallel(2) → serial) workflow carrying the full marker
family. Porting it must yield 4 nodes / 3 stages that compile with the parallel lane preserved — the script's
own regression check.
