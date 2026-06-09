# Architecture — why a Claude Code Workflow runs unchanged on pi

The whole transform rests on one observation: **a Claude Code Workflow script is already a
precise, executable specification of a multi-agent DAG.** It declares — in plain JS — every
agent prompt, every parallel lane, every phase, and how nodes hand work to each other (through
the filesystem). The expensive part is *running* those prompts on Claude. The cheap part is the
*structure*. pi-runner keeps the structure on Claude Code's side and ships only the per-node
execution to a cheap model.

So you do not "port" anything. You **extract** the realized prompts from the same `.js` the
Claude Code Workflow tool runs, and replay them one `pi` process per node.

```
Claude Code (orchestrator) ── spawns 1 driver per instance ─► run.mjs   (DETERMINISTIC graph)
                                                               │ extract.mjs runs the workflow.js
                                                               │   under recording stubs
                                                               │ → exact prompts + stages (DAG)
                                                               │ spawns one `pi` per node
                                                               ▼
                                              pi (per-node executor: read/bash/edit/write,
                                                  non-Claude coding-plan model)
                                                               │ reads/writes
                                                               ▼
                       <repo>/* artifacts  +  out/<id>/run-status.json   (Claude Code polls)
```

## The four invariants that make this sound

### 1. Single source of truth — the workflow `.js`, nothing else
You author and **prove** the pipeline the normal way: by spawning the real Claude Code Workflow
(`Workflow({name: ...})` or via a skill). pi-runner does **not** re-declare the waves. It reads
the *same file*. Edit the workflow → re-prove it on Claude → pi runs the identical prompts on the
next invocation. There is no second copy of the prompt text to hand-sync, so there is no drift —
by construction. (Skill/spec *content* the prompts reference also stays in sync automatically,
because each node reads those files by path at runtime.)

### 2. Execute-and-record — extraction, not codegen
`extract.mjs` reads the workflow source, makes one mechanical edit (`export const meta` →
`const meta`), wraps the body in an `AsyncFunction`, and runs it with **stubbed hooks**:

- `agent(prompt, opts)` — does not call a model. It **records** `{phase, label, group, prompt}`
  and returns a generic success-shaped object.
- `parallel(thunks)` — runs the thunks (so their `agent()` calls register) and tags them with a
  shared group id → these become one parallel **stage**.
- `pipeline`, `phase`, `log`, `budget` — faithful no-op/recording stubs.

Because the returned object is success-shaped, every data-dependent branch (`if (preflight.ok)`,
`if (voice.accepted)`, …) takes its happy path, so **all** nodes are recorded. Consecutive
same-group records collapse into stages; serial records are their own stage. The result is the
exact DAG the Workflow tool would execute — recovered for free, for *any* number of waves, with
new/removed/reordered waves and skill refs propagating automatically.

> This is why the Workflow runtime's own conventions matter: the script may use top-level
> `return`/`await` precisely because both the runtime and the extractor wrap it in an
> `AsyncFunction`. Keep the script a pure body (no `import`/`export` except `export const meta`).

### 3. Driver owns the graph; pi owns the node
Split of responsibility is fixed because the graph is deterministic:

- **`run.mjs` (plain code) owns determinism** — stage order, parallel-lane fan-out
  (`Promise.all` over a stage's nodes), status aggregation, the watchdog/heartbeat, and the
  halt-on-failure rule. No model decides control flow.
- **`pi` owns one node** — it gets that node's exact prompt as a file (`@prompt.md`), works with
  read/bash/edit/write tools, and writes its output artifacts. One `pi -p` per node.

Nodes coordinate through the **filesystem**, exactly as the Workflow's agents do: wave N writes
`foo.md`, wave N+1 reads it. Nothing about coordination changes between Claude and pi — the
contract was always "files on disk," never in-memory return values.

### 4. Verified, not trusted
pi has no schema-forced return, so each node ends its message with one fenced ```json``` block
(`{node, status, outputArtifacts, summary, issues, pipelineFindings}`) that the driver parses.
But the driver does **not** trust `status: ok`: it `stat()`s every `outputArtifact` on disk. A
node is `ok` only if the files it claims to have written actually exist and are non-empty.
Missing artifact ⇒ `blocked`, regardless of what the model said. (Same "measure, don't assume"
discipline the Workflow's schema validation gives you for free on Claude.)

## Observability — three tiers, cheapest first
1. **`run-status.json`** (the digest) — per-node `{status, durationMs, toolCalls, toolBreakdown,
   thinking{deltas,chars,spanMs}, tokens{input,output,billable,contextPeak,cost}, eventCount,
   summary, issues, pipelineFindings, artifacts[]}`, refreshed continuously. The whole run at a
   glance. This is what the Claude Code orchestrator polls. All of it is distilled live from the
   stream, so it is present in BOTH debug and production mode (cheap — no big files involved).
2. **Per-node prompt** (`out/<id>/_pi/<node>.prompt.md`, always) + the **heavy forensic archive**
   (`<node>.events.jsonl` + `<node>.debug.log`, **`--debug` only**) — drop here when a node looks wrong.
3. **`events.jsonl`** (ground truth) — every pi event for exact reproduction. **DEBUG-ONLY**: the raw
   stream is cumulative (pi re-embeds the whole accumulated message on each delta), so one node can
   reach 100s of MB; production skips it and relies on tier 1. Re-run a node with `--debug` to get it
   back. The single `--debug` flip is the toggle between lean-production and full-forensic.

The union of all nodes' `pipelineFindings` is the workflow-improvement backlog — the same role
it plays in the Claude Code Workflow.

## Dynamic workflows (the one caveat)
Extraction captures the **happy-path expansion**: it runs the script once with success-shaped
stubs. If a workflow decides *which* or *how many* agents to spawn based on a previous agent's
**result** (e.g. loop-until-dry, or `parallel(findings.map(...))` where `findings` came back from
a prior `agent()`), the recording reflects only the stubbed expansion — typically zero or one
iteration. Two ways to handle it:

- **Prefer static fan-out for pi targets.** Most pipeline-shaped workflows (fixed waves over one
  input) are fully static and need nothing.
- **If you need data-driven fan-out**, shape the stub return in `extract.mjs`'s `GENERIC` object
  to produce a representative expansion, or split the dynamic phase into its own driver pass that
  reads the prior phase's on-disk output to compute the item list. Document the choice; don't let
  a silent single-iteration recording masquerade as full coverage.
