# Declarative DAG Authoring for Pi Flow — research brief

**Date:** 2026-06-21
**Question:** How should the Pi Flow Level-2 "design agent" EMIT a workflow DAG? Should it
draw EDGES explicitly, or should the SDK INFER the DAG from each node's declared
inputs/outputs (data-flow)? What is the right sparse-authored / dense-defaulted
`workflow.json` schema, and the validate→repair loop around it?
**Legs run:** Exa web search (primary) + Reddit practitioner scrape (r/dataengineering,
r/LangChain, r/AI_Agents, r/LocalLLaMA via macrocosmos/reddit-scraper). **No YouTube.**
Reddit returned cleanly (120 posts across two scrapes); the broad "DAG declarative vs code"
keyword skewed to generic data-eng content, but the targeted "LLM fills JSON schema /
workflow reliability" scrape hit the practitioner vein directly. Web leg is the spine; Reddit
corroborates sentiment.

---

## 0. Bottom line (verdict up front)

**Adopt data-flow edge inference as the PRIMARY model, with an explicit-edge ESCAPE HATCH.**
The agent authors a FLAT BAG of node envelopes; each node declares the files it READS and the
files it PRODUCES (its intent). The SDK derives edges by matching producer→consumer file
paths — exactly the inference Pi Flow's viz layer already does — then defaults all mechanical
fields, validates the resulting graph (acyclicity, every input has a producer, no ambiguous
producers), and runs a bounded validate→repair loop with the design agent when validation
fails. This is the convergent design across the strongest references (dbt, Bazel/Pants,
Dagster SDAs, Hera, Airflow 2 TaskFlow, Prefect 2) AND the documented failure-avoidance
pattern for LLM-emitted graphs (LLMCompiler / plan-and-execute hallucinated edges & cycles).

---

## 1. Declarative workflow/DAG formats — how the graph is expressed

The field splits cleanly into **explicit-edge** and **inferred-from-deps** camps.

**Explicit adjacency (author writes the edges):**
- **n8n** — workflow JSON is `{ nodes:[...], connections:{ <sourceNode>: { main: [[{node,type,index}]] } } }`. Edges are a separate, source-indexed adjacency map; to find parents you invert it (`mapConnectionsByDestination`). Internally n8n even keeps a second `DirectedGraph` adjacency-list representation for graph editing because the nested JSON "does not lend itself to editing the graph." Source: https://docs.n8n.io/workflows/export-import/ , https://github.com/n8n-io/n8n/blob/6dd2980e/packages/workflow/src/workflow.ts , https://github.com/n8n-io/n8n/blob/6dd2980e/packages/core/src/execution-engine/partial-execution-utils/directed-graph.ts
- **Argo Workflows** — DAG template: each task carries `dependencies: [A, B]` (or richer `depends: "(A && (C.Succeeded || C.Failed))"` boolean logic over task RESULTS). Author writes the edges by name; DAGs "fail fast" by default. Source: https://argo-workflows.readthedocs.io/en/stable/walk-through/dag/ , https://argo-workflows.readthedocs.io/en/latest/enhanced-depends-logic/
- **GitHub Actions** — `needs: [job]` per job; explicit.
- **Flowise / Langflow** — ReactFlow-style `{ nodes:[...], edges:[...] }`; each edge is a `{source, sourceHandle, target, targetHandle}` with typed handles (`output_types` must match `inputTypes`). The runtime then `constructGraphs(nodes, edges)` and computes ending nodes. Source: https://docs.langflow.org/concepts-flows-import , https://www.mintlify.com/yocxy2/Flowise/concepts/chatflows , https://github.com/FlowiseAI/Flowise/blob/main/packages/server/src/services/chatflows/index.ts
- **LangGraph** — `StateGraph` with explicit `add_edge(a,b)` / `add_conditional_edges`; "you explicitly wire transitions." Best when you NEED branching/loops/parallel-merge; overkill for linear flows. Source: https://docs.langchain.com/oss/python/langgraph/use-graph-api , https://docs.langchain.com/oss/python/langgraph/choosing-apis

**Inferred from dependencies (author declares I/O, system builds edges):**
- **Airflow** — classic `>>` operator is explicit, BUT **Airflow 2.0 TaskFlow** "abstracted away the construction of the DAG by using the outputs passed between tasks to derive the dependencies." Airflow 3 adds asset-based / data-aware scheduling. Source: https://github.com/argoproj-labs/hera/blob/main/proposals/heps/0001-decorators.md , https://narcismiclaus.com/programming/python/41-orchestration/
- **Prefect 2** — "Tasks are decorated functions. The flow is a regular Python function that calls them — and the dependency graph is whatever the calls imply… No `>>` operators, no `set_upstream`. It just reads." `DAG-free`; deps implicit via data passing. Source: https://www.prefect.io/v3/how-to-guides/migrate/airflow , https://prefect-284-docs.netlify.app/migration-guide/
- **Temporal** — durable execution, workflow-as-code; deps implicit in control flow. Different niche (long-running business processes, not batch DAGs). Source: https://llms.astronomer.io/managed-airflow-vs-dagster-vs-temporal
- **CrewAI Flows** — topology "emerges from decorator annotations" (`@start`, `@listen(x)`, `@router`) "rather than explicit graph construction." Migrating from LangGraph = replace `add_edge` with `@listen`. Source: https://docs.crewai.com/en/guides/migration/migrating-from-langgraph

**Takeaway:** every modern orchestrator that targets developer ergonomics has moved AWAY from
hand-authored edges toward "declare what each step consumes/produces, infer the rest." The
explicit-edge formats (n8n, Flowise) are GUI-first — edges are drawn by a human dragging
wires, not authored by a model.

---

## 2. Edge inference from data-flow — the gold standard + pitfalls

This is the load-bearing section for Pi Flow.

- **dbt `ref()`** — THE canonical example. A model says `from {{ ref('stg_orders') }}`; dbt
  "automatically infers the dependencies between models." Zero explicit edges. During the
  **parse phase** dbt statically extracts every `ref()`/`source()` (fast static parser ~0.3ms;
  falls back to full Jinja render for complex models) and builds `parent_map`/`child_map`
  (backward/forward edge dicts) on the Manifest from each node's `depends_on.nodes`. Before
  execution it verifies the graph is a DAG via `networkx.find_cycle` and raises a
  `CompilationError` on cycles. **Pitfall to copy the fix for:** a `ref()` hidden inside an
  unevaluated `{% if execute %}` branch is missed at parse time → dbt has a runtime check that
  ERRORS if it sees an unexpected `ref()`, because "there's a risk we're running the DAG out
  of order." Lesson: inference must see ALL declared I/O statically; anything dynamic/hidden
  must be rejected or surfaced. Source: https://docs.getdbt.com/reference/dbt-jinja-functions/ref , https://docs.getdbt.com/faqs/Models/create-dependencies , https://deepwiki.com/dbt-labs/dbt-core/4.6-dependency-graph-and-lookups , https://github.com/dbt-labs/dbt-core/blob/1.latest/docs/guides/parsing-vs-compilation-vs-runtime.md

- **Bazel / Make** — targets declare `srcs`/`deps`/`data` (inputs) and a fixed set of outputs;
  Bazel "parses every BUILD file to create a graph of dependencies among artifacts," then
  topologically builds. Each action "declares its inputs and outputs and can be connected to
  other actions via its inputs and outputs." Key warning: Bazel distinguishes the graph of
  *declared* vs *actual* dependencies and REQUIRES authors declare "all of the actual direct
  dependencies… and no more" — undeclared deps cause "undefined behavior." Source: https://bazel.build/concepts/dependencies , https://bazel.build/versions/9.0.0/basics/artifact-based-builds

- **Pants dependency inference** — the most directly relevant precedent for the "best of both
  worlds." Pants does static analysis AT RUNTIME ("dependency information doesn't — usually —
  live in BUILD files at all"), at fine file-level granularity, but lets you ADD manual deps
  for the non-inferrable cases (e.g. a data-file dependency) and `!`/`!!` ignores to override.
  Their explicit position: **explicit deps function as OVERRIDES; inference should defer to
  them, not try to merge.** Source: https://www.pantsbuild.org/blog/2022/10/27/why-dependency-inference , https://github.com/pantsbuild/pants/pull/20853

- **Dagster software-defined assets** — "each asset knows how to compute its contents from
  upstream assets"; deps are "inferred from the names of the arguments to the decorated
  function" (like pytest fixtures), or stated explicitly via `deps=`/`AssetKey`. "Dagster can
  automatically infer the asset graph, eliminating the need to manually define explicit DAGs
  that often become outdated or misaligned with actual dependencies." A dbt model *is* a
  software-defined asset (asset key = model name, upstreams = its `ref`s). Source: https://dagster.io/blog/software-defined-assets , https://docs.dagster.io/guides/build/assets/defining-assets-with-asset-dependencies , https://github.com/dagster-io/dagster/discussions/5024

- **Hera HEP-0001 (Argo's Python SDK)** — explicitly proposes Pi Flow's exact model on top of
  Argo: *"we will automatically construct the dependency graph based on the input/output
  relationship between tasks, so Hera will infer the DAG as: setup_task >> [task_a, task_b] >>
  final_task. Users will still be able to explicitly add dependencies… using the rshift
  operator… for tasks that don't share variables directly."* This is the **flat-bag +
  data-flow-inference + explicit escape hatch** design, validated by the Argo ecosystem.
  Source: https://github.com/argoproj-labs/hera/blob/main/proposals/heps/0001-decorators.md

### Pitfalls of data-flow inference (and the standard mitigations)
1. **Ambiguous producer (>1 node produces the same path).** Pants' single most common gotcha:
   when >1 target exports the same module, Pants REFUSES to infer and emits a help message
   telling you to explicitly include the one you want or `!`-ignore the rest. → Pi Flow: if two
   nodes declare the same produced path, FAIL validation with a targeted repair message; never
   silently pick. Source: https://github.com/pantsbuild/pants/pull/11792
2. **Unspecified / missing dependency (a consumed path nobody produces).** In Make-based
   systems, unspecified deps cause "inconsistencies or bugs," break parallelism, and yield
   non-deterministic results; the industry hack is full rebuilds. Ninja `dyndep` "silently
   ignores" missing implicit deps — a documented bug. → Pi Flow: every input path must either
   (a) have a producer node or (b) be declared a pre-existing external/source input. Anything
   else = validation error. Source: https://rebels.cs.uwaterloo.ca/papers/emse2017_bezemer.pdf , https://github.com/ninja-build/ninja/issues/2573
3. **Cycles.** dbt detects with `networkx.find_cycle` and halts. For LLM-authored graphs the
   named failure is "hallucinated cycles" (Task A needs B, B needs A → executor deadlock); the
   universal fix is "validate the JSON for cycles via DFS BEFORE execution; if a cycle is
   found, send the plan back to the LLM for correction." Source: https://www.arunbaby.com/ai-agents/0049-dependency-graphs-for-agents/ , https://tianpan.co/blog/2026-04-23-circular-tool-dependencies-agent-plan-deadlock
4. **Fan-in / hidden back-edges.** LLMCompiler-style planners "stream a DAG with explicit
   `dependencies` fields" but "planners hallucinate dependencies the same way they hallucinate
   citations"; a back-edge can live only inside a node's natural-language argument template and
   be invisible to the runtime until that node executes — a "deadlock the agent can't see."
   This is the strongest argument AGAINST trusting agent-drawn edges and FOR deriving edges
   from machine-checkable I/O declarations. Source: https://tianpan.co/blog/2026-04-23-circular-tool-dependencies-agent-plan-deadlock

---

## 3. Agents emitting graphs — how an LLM produces a workflow

- **LLMCompiler** (ICLR/ICML 2024) — Function Calling Planner "generates a DAG of tasks with
  their inter-dependencies"; dependent tasks carry **placeholder variables** (`$1`, `$2`) that
  are substituted with upstream outputs at dispatch. So even when the LLM emits "edges," it
  does so as DATA-FLOW placeholders (output of task 1 → input of task 3), not abstract
  adjacency — i.e. the edges ARE the I/O wiring. Source: https://proceedings.mlr.press/v235/kim24y.html , https://openreview.net/pdf?id=uQ2FUoFjnF , https://github.com/squeezeailab/llmcompiler
- **ADAS / Meta Agent Search** (ICLR 2025, Outstanding Paper) — the agent emits the workflow
  as **CODE** (a `forward()` function); Turing-complete search space; evaluated against an
  acceptance metric and archived. Argument FOR code: maximal expressiveness. Argument AGAINST
  for Pi Flow: code is un-validatable structurally and un-defaultable; you can't statically
  derive edges/stages/sandbox from arbitrary Python. Source: https://github.com/ShengranHu/ADAS , https://arxiv.org/abs/2408.08435
- **AFlow** (ICLR 2025 Oral) — workflows = "nodes connected by code-represented edges";
  searched via MCTS with execution feedback; **Operators** (Ensemble/Review/Revise) are
  reusable node+edge bundles that shrink the search space. Smaller models beat GPT-4o at ~4.5%
  cost. Relevance: "Operators" ≈ Pi Flow's reusable node templates; code-edges chosen for
  search expressiveness, not authoring ergonomics. Source: https://openreview.net/forum?id=z5uVAKwmjf , https://proceedings.iclr.cc/paper_files/paper/2025/file/5492ecbce4439401798dcd2c90be94cd-Paper-Conference.pdf
- **Plan-and-execute / "Graph Harness"** literature — explicitly recommends: extract the plan
  into a graph, check acyclicity before dispatch; add **contract-based output validation** per
  node (because LLM nodes are non-deterministic, type-checking at compile time is impossible);
  three-level recovery (transient vs reasoning failure). Source: https://www.arxiv.org/pdf/2604.11378 , https://medium.com/@anindyasinghobi/why-agent-workflows-fail-before-they-even-begin-b0d36dbfe57f
- **Google A2A Agent Card** — agents advertise capability via a JSON manifest at
  `/.well-known/agent-card.json`: required `name/description/version/url/skills[]`, recommended
  `capabilities{}` with sensible defaults (`streaming:false`, …). A clean precedent for
  "minimal required surface + dense defaults" in an agent-authored JSON doc. Source: https://github.com/google/A2A/blob/main/docs/specification.md , https://stacka2a.dev/blog/a2a-agent-card-json-schema , https://docs.cloud.google.com/agent-registry/json-schemas

**Synthesis for §3:** the research frontier that searches for *novel* workflows uses CODE
(ADAS/AFlow) for expressiveness. But for *authoring a known-shape pipeline reliably* — Pi
Flow's actual job — the reliable production pattern is **structured-output / JSON-Schema fill
with placeholder-style data-flow wiring** (LLMCompiler), guarded by pre-dispatch graph
validation. Pi Flow should fill a schema, not emit code (see §6d for keeping a code front-end
for HUMANS only).

---

## 4. Sparse-authored + dense-defaulted schema design

The pattern: keep the author's REQUIRED surface tiny; the system fills mechanics with defaults
and validation.

- **JSON Schema `default`** + provider structured-output. OpenAI strict mode compiles schema to
  an FSM (constrained decoding, <0.1% schema-violation); "Missing required fields are populated
  with defaults. Unexpected fields are stripped." Anthropic structured output GA (Claude
  4.5/4.6/4.7) + `strict:true` on tool defs. Source: https://collinwilkins.com/articles/structured-output , https://fordelstudios.com/research/structured-outputs-production-systems , https://towardsdatascience.com/structured-outputs-with-llms-json-mode-function-calling-and-when-to-use-each/
- **Kubernetes** — CRD structural-schema `default` fields applied "during request payload
  deserialization, after mutating-webhook admission, and during read from storage"; mutating
  admission webhooks add custom defaults and MUST be idempotent. The pipeline = sparse user
  manifest → defaulting → validation → store. Source: https://kubernetes.io/docs/reference/access-authn-authz/extensible-admission-controllers/ , https://github.com/kubernetes/enhancements/tree/master/keps/sig-api-machinery/575-crd-defaulting
- **Terraform** — `optional(type, default)` object attributes: omitted attrs get the default
  (and `null` is replaced by the default), applied top-down through nested types; `validation`
  blocks enforce constraints with custom `error_message`. Defaults are lowest precedence.
  Source: https://developer.hashicorp.com/terraform/language/expressions/type-constraints , https://developer.hashicorp.com/terraform/language/block/variable

### Two schema-design constraints specific to LLM-filled schemas (must obey)
- **Field ordering: reasoning BEFORE conclusion.** Constrained decoding forces the model to
  commit to an early field before later ones; putting `answer` before `reasoning` causes
  10–15% degradation on complex tasks. → In each node envelope, order fields so any
  rationale/decomposition the agent writes comes before the committed `produces`/`tools`.
- **Required fields cause hallucination.** "When a required field has no good answer, the model
  hallucinates one… a confident lie in valid syntax." → Make truly-optional intent fields
  optional (defaulted by SDK), so the agent never fabricates a value to satisfy `required`.
  Source: https://tianpan.co/blog/2026-04-20-structured-output-reliability-production

---

## 5. Validate → repair loop

Both the structured-output literature and Reddit practitioners converge on the SAME loop:

> 1. Generate candidate JSON (constrained decode if available)
> 2. Validate against schema (+ semantic/graph checks)
> 3. If invalid, send the SPECIFIC errors back and retry
> 4. Cap retries, then fail safely

Key details:
- JSON mode "is not a contract" — it guarantees syntax only; prompt-only JSON extraction fails
  8–15% in production. Even constrained decoding shifts failures to **refusals** (a refusal
  object, not schema JSON) — so a naive retry loop "retries forever on a safety-blocked input";
  the loop MUST detect refusals and treat them as terminal. Source: https://tianpan.co/blog/2026-04-20-structured-output-reliability-production , https://collinwilkins.com/articles/structured-output
- The retry prompt must say *exactly* what went wrong (which fields missing, which types wrong,
  what the schema expects). Tooling like `outputguard` packages this: validate → repair (15
  strategies) → retry-with-feedback → return all attempts for observability; "if a prompt
  consistently needs 2+ retries, the prompt or schema needs work, not more retries." Source: https://github.com/ndcorder/outputguard
- **Graph-level validation is part of the loop, not just schema validation.** For Pi Flow the
  validator runs: (a) JSON-Schema conformance; (b) derive edges from I/O; (c) every input has a
  producer-or-source; (d) no ambiguous producers; (e) acyclic (DFS/`find_cycle`); (f) reachable
  from a root and to a sink. Any failure → structured repair message naming the offending node
  and the violated rule (mirrors Pants' and dbt's messages).

**Reddit corroboration (practitioner leg):**
- r/LocalLLaMA "Handling invalid JSON / broken outputs in agent workflows?" describes the exact
  three-way decision `pass / retry(fixable) / fail(stop)` plus wasted-cost estimation — the
  loop, invented independently in the field. https://www.reddit.com/r/LocalLLaMA/comments/1s3kkjq/handling_invalid_json_broken_outputs_in_agent/
- r/LangChain has a steady stream of "agent that FILLS a JSON schema" requests
  ("Langchain agent that fills a json schema", "build an LLM agent specialized on producing
  JSON documents with a certain schema", "How to make LLM generate logical JSON constraints")
  — confirming "LLM fills a validated schema" is a real, demanded pattern, and that the pain is
  reliability of the FILL (e.g. "LLM generates random values instead of reasoning"), which is
  the field-ordering / repair-loop problem above. https://www.reddit.com/r/LangChain/comments/1lvoeij/langchain_agent_that_fills_a_json_schema/ , https://www.reddit.com/r/LangChain/comments/1jjsp5h/how_to_make_llm_generate_logical_json_constraints/
- r/LangChain "Why structured outputs / strict JSON schema became non-negotiable in production
  agents." https://www.reddit.com/r/LangChain/comments/1qpfo7b/

---

## 6. Practitioner sentiment (Reddit) — declarative config vs code, and reliability at scale

- **"Most things shipped as agents should be a workflow with one LLM call."** Highly-upvoted
  r/AI_Agents post: litmus test = *"can you draw the flowchart before the bill arrives?"* — if
  yes, it's a deterministic pipeline, not an agent. Strongly pro-declarative-structure,
  anti-open-loop. https://www.reddit.com/r/AI_Agents/comments/1tfjxrb/most_things_people_ship_as_agents_should_be_a/
- **One node = one job.** r/AI_Agents "How we 10×'d the speed & accuracy of an AI agent": the #1
  fix was "One LLM call, too many jobs — asking the model to plan, call tools, validate, and
  summarize all at once… made outputs inconsistent and debugging impossible." Directly supports
  Pi Flow's per-node envelope (each node has ONE prompt/skill + a tight tool allow-list).
  https://www.reddit.com/r/AI_Agents/comments/1nerrp2/
- **How do n8n/Botpress turn NL → reliable node workflows?** r/AI_Agents asks exactly this and
  the proposed answer is "planner/executor split, schema-constrained generation, retrieval,
  validation loops" — the community's own model matches §3+§5. https://www.reddit.com/r/AI_Agents/comments/1skaw47/
- **LangGraph production reality:** validate routing with `Literal`/whitelist to "catch
  hallucinated node names at parse time, not at runtime"; "LLMs hallucinate completion, your
  counter does not" (circuit breakers / max-iteration guards). Pro-explicit-structure,
  pro-validation. https://www.lifetideshub.com/langgraph-multi-agent-workflows-2026/
- **Hybrid programmatic + agent** is the pragmatic default: r/LangChain "Hybrid workflow with
  LLM calls + programmatic steps" and "chat-with-data agent… the LLM never writes SQL; it
  chooses from a typed set of operations and proposes parameters; the query is built and
  executed by code." → endorse: agent authors INTENT (which node, which params), the SDK/code
  owns structure and execution. https://www.reddit.com/r/LangChain/comments/1p5lchr/ , https://www.reddit.com/r/LangChain/comments/1r05q9n/
- **Skepticism about open-ended agents** is loud (multiple high-comment "stop building agents",
  "losing trust in the agents space" threads) — reinforces a constrained, declarative,
  validated DAG over a free-roaming agent.

Net sentiment: practitioners prefer **constrained, declarative, schema-validated structure
with code owning execution**, and treat LLM-authored graph structure as something to VALIDATE
before trusting. No evidence anyone wants the agent to free-hand abstract edges.

---

## 7. Recommended `workflow.json` schema for Pi Flow

### (a) Flat node-bag vs explicit adjacency — VERDICT
**Flat node-bag.** The agent emits `{"nodes": [ <envelope>, ... ]}` — an unordered list,
no top-level `edges` array. Rationale: (1) every ergonomic orchestrator infers (dbt, Pants,
Dagster, Hera, Airflow2, Prefect2); (2) agent-drawn edges are a documented failure source
(hallucinated/cyclic/back-edge deadlocks — LLMCompiler, plan-and-execute); (3) Pi Flow ALREADY
infers edges in the viz layer by producer→consumer path matching, so the runtime and the viz
share ONE derivation and can't disagree; (4) a flat bag is the smallest authored surface and
the easiest to default/validate/repair. Explicit adjacency formats (n8n, Flowise) are GUI-drag
artifacts, not model-authoring formats.

### (b) Agent-authored (intent) vs SDK-filled (mechanical) field split

**AGENT-AUTHORED per node (intent only):**
- `name` — short human-readable handle (also used in repair messages).
- `goal` / `prompt` (or `skill` ref) — what this node does. *(Put any free-text
  rationale/decomposition FIRST in field order — §4.)*
- `reads` — array of input file paths/globs (declared inputs → drives edge inference).
- `produces` — array of output file paths this node writes (declared outputs → drives edge
  inference). **The producer/consumer match on these two arrays IS the edge model.**
- `tools` — `allow` / `deny` lists of `namespace:name` (the node's needed capability surface;
  intent, not mechanism — sandbox internals owned by another agent).
- optional `externalInputs` — paths that are pre-existing/source (consumed but produced by no
  node), so the validator doesn't flag them as missing producers (cf. dbt `source()`,
  Bazel `data`).
- optional `dependsOn` — explicit upstream node names: the **escape hatch** for ordering deps
  that DON'T flow through a shared file (cf. Hera's `rshift`, Dagster `deps=`, Pants manual
  dep). Treated as an ADDITIVE override; never used to *remove* an inferred edge.
- optional `hooks` (pre/post) — author intent; SDK normalizes.

**SDK-FILLED (mechanical, defaulted — agent never writes these):**
- `id` — stable node id (slug/hash of name).
- `edges` — DERIVED: for each node, for each `reads` path, find the node(s) whose `produces`
  contains it → add edge. Plus any `dependsOn`. This is the whole graph.
- `stage` / `lane` — derived from topological rank (stage = longest-path depth; lane = a
  parallel-group index among nodes sharing a stage), purely for grouping/viz.
- `sandbox` profile / `outputDir` — defaulted from a project profile (owned elsewhere; the
  schema just carries a slot with a default).
- run-mechanics defaults (retries, timeout, concurrency) — JSON-Schema `default`s à la
  Terraform/K8s; overridable but never required.

### (c) The validate→repair loop (concrete)
1. Constrained-decode the agent's `workflow.json` against the JSON Schema (Anthropic
   structured output / `strict:true` tool; OpenAI strict mode). Detect **refusals** → terminal,
   don't retry-loop.
2. Schema-valid? Then run GRAPH validation:
   - derive edges from `reads`/`produces` (+`dependsOn`);
   - every `reads` path resolves to a producer node OR is in `externalInputs` (else: missing
     producer — cf. Make/Ninja);
   - no path in two nodes' `produces` (else: ambiguous producer — cf. Pants; refuse, name both
     nodes);
   - acyclic (DFS / `find_cycle`; cf. dbt) — on cycle, name the back-edge;
   - every node reachable from a root and reaching a sink.
3. On any failure, emit a TARGETED repair message ("node `score`: input `clean.csv` has no
   producer and is not declared external"; "nodes `a` and `b` both produce `out.json`") and
   re-prompt the design agent. **Cap retries (≈2–3); if a node repeatedly fails, the schema or
   the decomposition is wrong, not the retry count.** Persist every attempt for observability.
4. On success, apply SDK defaults (ids, stages/lanes, sandbox, run-mechanics) and freeze the
   internal DAG.

### (d) Keep an imperative-code front-end too? — VERDICT: yes, for HUMANS only; converge to one DAG.
Keep the existing imperative Pi Flow Workflow script (`agent()`/`parallel()`/`pipeline()`/
`phase()`) as a HUMAN authoring surface, but have it COMPILE DOWN to the same internal DAG the
agent's `workflow.json` produces — exactly as Hera compiles Python decorators to Argo YAML and
LangGraph's Graph/Functional APIs "share the same underlying runtime." Do NOT make the AGENT
emit code (ADAS/AFlow chose code only to maximize a SEARCH space; it's un-validatable and
un-defaultable — the opposite of what reliable authoring needs). So: two front-ends (human
code; agent-filled JSON), ONE internal DAG, ONE edge-derivation, ONE validate/default/execute
path. The code front-end can itself use call-implies-dependency inference (Prefect/Airflow2
style) so both surfaces share the data-flow edge model.

---

## 8. Uncertainty / caveats
- The **Hera HEP-0001** is a *proposal* doc; verify how much shipped, but it confirms the
  Argo-ecosystem appetite for exactly this inference + `rshift` escape hatch — directional, not
  load-bearing on its own.
- Several Reddit posts cite future/unreleased models (Gemma 4, DeepSeek V4, "Qwen3.6") and one
  references a "Claude Code source leak" framework — treat model-name specifics as unverified
  forum chatter; the *sentiment/pattern* signal (one-node-one-job, validate-before-trust,
  schema-fill demand, hybrid code+agent) is what's load-bearing and is corroborated by the web
  leg.
- Provider structured-output guarantees are strongest with constrained decoding (OpenAI strict;
  Anthropic GA on 4.5+); if Pi Flow's design agent runs on a weaker/non-Claude coding model
  (the project's stated target), assume schema conformance is ~95–99%, NOT 100% — the
  validate→repair loop is mandatory, not optional, in that regime.
- "Stage/lane from longest-path depth" is a reasonable default but ambiguous when multiple
  valid topological layerings exist; it's a VIZ/grouping concern, not correctness — fine to
  default and let the human re-group.
