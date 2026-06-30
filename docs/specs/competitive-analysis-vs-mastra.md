# Competitive analysis — piflow vs `mastra-ai/mastra`

> Status: living analysis. Created 2026-06-29. Source under `vendor/mastra` (shallow clone, HEAD
> `12af22b`, cloned 2026-06-29). Mastra evidence cited `file:line` relative to `vendor/mastra/`; piflow
> evidence cited relative to repo root (most piflow citations carried from
> `competitive-gaps-vs-pi-dynamic-workflows.md`, last verified against the code 2026-06-25 — re-verify
> before acting). Honest by construction: where Mastra is AHEAD it says so; where the two are simply
> *different categories* it says so rather than inventing a gap.

## Source briefs (per-aspect teardown)

This doc is the **synthesis**. The deep, per-subsystem evidence (full `file:line` teardown of each aspect)
lives in `docs/specs/mastra/`; each section below references its brief rather than absorbing it:

| Aspect | Brief | Feeds |
|---|---|---|
| Workflow orchestration engine | [`mastra/workflows-engine.md`](mastra/workflows-engine.md) | §1a–1b, §2, §4 |
| Agents & model layer | [`mastra/agents-and-model-layer.md`](mastra/agents-and-model-layer.md) | §1c, §2, §4 |
| Memory & RAG | [`mastra/memory-and-rag.md`](mastra/memory-and-rag.md) | §1e–1f, §3 M1/M2, §5 |
| Tools, MCP & integrations | [`mastra/tools-and-mcp.md`](mastra/tools-and-mcp.md) | §1d, §2, §3 M5 |
| Deployment, server & runtime | [`mastra/deploy-server-runtime.md`](mastra/deploy-server-runtime.md) | §1h, §3 M4/M6, §4 |
| Observability & evals/scorers | [`mastra/observability-and-evals.md`](mastra/observability-and-evals.md) | §1g, §3 M3/M7, §4 |

## 0. TL;DR — Mastra is a different *kind* of competitor than PDW

`pi-dynamic-workflows` (PDW) was **our own thesis, finished more completely on the in-process axis** — a
code-mode subagent runtime. **Mastra is not that.** Mastra (YC W25, `@mastra/core`, ~29 packages) is a
**batteries-included TypeScript application framework** — "everything you need to go from prototype to
production-ready" (`README.md:11-13`). Its own pitch lists Agents, graph Workflows, Human-in-the-loop,
Memory, RAG, MCP servers, Evals, Observability, and Deployment (`README.md:19-35`).

The relationship is therefore **two different points on the stack**, with a shared core:

- **piflow** is an **orchestration substrate / runtime**: a workflow is *data* (a template on disk),
  compiled to a DAG, run as **one real headless OS `pi` process per node**, coordinated through the
  filesystem; durable, sandboxed, multi-process.
- **Mastra** is an **app framework + deployable service**: agents and a graph workflow engine, plus the
  whole **product surface** piflow has no equivalent for — stateful memory, RAG, a quality-scoring eval
  suite, an HTTP server + serverless deployers + a dev playground, a symmetric MCP server, and
  observability fan-out — all running **in a single Node process** you `new Mastra({…})` and host.

So the gaps split cleanly into two buckets:

1. **Same architectural family as PDW → every structural argument from the PDW doc transfers.** Mastra's
   workflow engine is a single-Node-process `for`-loop (`packages/core/src/workflows/default.ts:54,774-813`);
   its agents are in-process objects, **no `child_process`/`worker_threads` anywhere in `agent/` or
   `loop/`** (verified by the agent reader). It has **no OS-process isolation, no per-node sandbox, no
   "survives the controller dying"** — exactly piflow's structural moat (§4).
2. **Capability *classes* piflow lacks entirely (the real answer to "what does it let us do that we
   can't").** Memory, RAG, a 20-scorer live-sampling eval suite, deploy-as-a-service, MCP-server
   exposure, pluggable persistence, vendor observability. These are **not** "do it the in-process way" —
   they are missing product surface we'd either **port, borrow, or compose with** (§3, §5).

Ranked backlog of the **specific** gaps that are real for us: **M1** memory · **M2** RAG · **M3**
live quality scoring/eval vocabulary · **M4** deploy-as-a-service surface · **M5** MCP-server exposure
(+ A2A) · **M6** pluggable persistence abstraction · **M7** observability vendor fan-out · **M8**
in-process ergonomics (dynamic per-call tools, processors/guardrails, code-mode) · **M9** finer
suspend/resume (named labels, time-travel) · **M10** scheduler/cron + event-driven engine. Detail in §3.

---

## 1. What Mastra is — functionality inventory & the edges

Everything below is what the six-subsystem teardown actually proved in the source. Each subsection is a
condensed lead — the full `file:line` evidence is in the linked brief.

### 1a. Workflow engine (the direct analog to our DAG) · brief: [`mastra/workflows-engine.md`](mastra/workflows-engine.md)
- `createWorkflow({ id, inputSchema, outputSchema, stateSchema?, schedule? })` then fluent steps
  `.commit()` (`packages/core/src/workflows/create.ts:25`, `workflow.ts:2276`). Primitives:
  **`.then`** (`workflow.ts:1688`), **`.parallel`** (`:1992`, `Promise.all`), **`.branch`** (all truthy
  branches run, `:2055`), **`.dowhile`** (`:2111`), **`.dountil`** (`:2159`), **`.foreach`** with a
  **`{ concurrency }`** worker pool (`:2207`, `fastq` at `handlers/control-flow.ts:955-1120`), **`.map`**
  (data remap; `{step,path}`/`{value}`/`{initData}`/`{fn}`, `:1823`), **`.sleep` / `.sleepUntil`**
  (`:1733,:1772`), and **nested workflows** (`Workflow implements Step`, `:1561`). `.waitForEvent` was
  **removed** in favor of suspend/resume (`:1808`).
- **Step** = `{ id, inputSchema, outputSchema, resumeSchema?, suspendSchema?, execute }`
  (`step.ts:150-177`); `execute` gets `inputData`, `state`/`setState`, `getInitData`, `getStepResult`,
  `suspend`, `bail`, `abort`, `writer` (`step.ts:24-72`). Data flows **positionally** (prev output → next
  input), cross-step via `getStepResult`/`.map`.
- **Edge:** an expressive, fully type-checked DAG authored in one TS file, with two loop forms and
  concurrency-bounded fan-out. **Limit:** in-process single event loop; `.sleep` is literally
  `setTimeout` pinning a live process (`default.ts:110`).

### 1b. Suspend / resume & HITL · brief: [`mastra/workflows-engine.md`](mastra/workflows-engine.md)
- A step calls `suspend(payload, { resumeLabel? })`; the engine writes a **snapshot**
  (`WorkflowRunState`: status, state, all step results, `serializedStepGraph`, `suspendedPaths`,
  `resumeLabels`, `requestContext`, `timestamp` — `types.ts:380-405`) to the **storage adapter**
  (`handlers/entry.ts:172-195`). Resume = re-create the run by `runId`, `loadWorkflowSnapshot`, auto-detect
  the suspended step, re-run from `resumePath` (`workflow.ts:3843-4024`). **Named resume labels** and
  server-side **time-travel** routes exist.
- **Edge:** pause indefinitely, resume by `runId` in a fresh process — clean HITL. **This is the analog of
  our `checkpoint` node (G5).**

### 1c. Agents & the model layer · brief: [`mastra/agents-and-model-layer.md`](mastra/agents-and-model-layer.md)
- `Agent` is one in-process class (`agent/agent.ts:389`). **Every capability slot is static OR a
  `({requestContext, mastra}) => value` function**: instructions (`:402`), **model (required)** (`:405`),
  **tools** (`:429`), memory, workflows, scorers, sub-agents — all `DynamicArgument` (`:421-432`). Per-call
  overrides of `model`, `activeTools`, `toolsets`, `toolChoice` (`agent.types.ts:507-533`).
- Model = **Vercel AI SDK** models or a provider string `"openai/gpt-5"` routed by
  `ModelRouterLanguageModel` (`llm/index.ts:79`); **40+ providers**, gateways, and **fallback arrays**
  (load-balance/retry).
- The agentic loop is itself built on the workflow engine: `.dowhile(agenticExecutionWorkflow, …)` gated by
  `maxSteps` + user `stopWhen` (`loop/agentic-loop/index.ts:87,160-245`).
- **Multi-agent, all in-process:** agents-as-tools (`agent.ts:4395`), workflows-as-tools (`:5301`), and
  `agent.network()` routing with completion scorers (`loop/network/`). The only `child_process` in the
  whole agent layer is a network *run-command tool* — confirming agents are **shared-process objects**,
  not isolated runtimes.
- **Edge:** true per-agent heterogeneity (own model + own toolset, both dynamic) with rich loop control and
  guardrail **processors** (input/output/error). **Limit:** no OS isolation; one blocking tool stalls the
  shared event loop.

### 1d. Tools & MCP (symmetric) · brief: [`mastra/tools-and-mcp.md`](mastra/tools-and-mcp.md)
- `createTool({ id, description, inputSchema, outputSchema, execute, suspendSchema?, requireApproval? })`
  (`packages/core/src/tools/tool.ts:575`); first-class **Vercel AI SDK** tool compat; a **code-mode**
  factory runs model-written TS in a `WorkspaceSandbox` and bridges `external_*` calls back to real tools
  (`code-mode/code-mode.ts`).
- **MCP client** `MCPClient` (`packages/mcp/src/client/configuration.ts:71`): **stdio + Streamable-HTTP
  (SSE fallback)** transports; `listTools()` (namespaced, for agent def) vs **`listToolsets()`** (per-call
  dynamic injection); full **resources / prompts / elicitation / progress / OAuth** surface.
- **MCP server** `MCPServer` (`packages/mcp/src/server/server.ts:92`): **exposes Mastra agents as
  `ask_<agent>` tools and workflows as `run_<workflow>` tools** over stdio/SSE/HTTP. **Verdict: Mastra is
  BOTH a full MCP client and a full MCP server.**
- Plus `mcp-docs-server` (serves Mastra's own docs to IDEs) and `mcp-registry-registry` (a registry *of*
  MCP registries).
- **Edge:** symmetric MCP — a Mastra node consumes external servers *and* re-publishes its own
  agents/workflows as MCP tools.

### 1e. Memory (piflow has none) · brief: [`mastra/memory-and-rag.md`](mastra/memory-and-rag.md)
- `Memory` (`packages/memory/src/index.ts:227`) combines **four kinds** into one context window:
  conversation/thread history (`lastMessages` default 10, `memory.ts:83`); **semantic recall** (vector
  search over past messages, `topK`/`messageRange`/`threshold`/Mongo-style `filter`, `memory.ts:826`);
  **working memory** (agent-authored Markdown/JSON state rewritten via an `updateWorkingMemory` tool,
  `processors/memory/working-memory.ts:47`); and **observational memory** (an Observer→Reflector pipeline
  that compresses long histories within a token budget, `memory/types.ts:741-871`).
- `scope: 'thread' | 'resource'` — **`resource` shares memory across all of a user's threads/processes**
  (`memory/types.ts:184,357`); plus thread title generation, clone/delete.
- Persists through **~17 storage adapters** (libsql, pg, upstash, mysql, mssql, mongodb, dynamodb, redis,
  clickhouse, convex, duckdb, lance, spanner, cloudflare KV/DO, d1).

### 1f. RAG (piflow has none) · brief: [`mastra/memory-and-rag.md`](mastra/memory-and-rag.md)
- `MDocument` (`packages/rag/src/document/document.ts:38`) → **9 chunking strategies** (recursive,
  character, token, markdown, semantic-markdown, html, json, latex, sentence — `document.ts:171-181`; 27
  code languages) with optional metadata extractors.
- Embed via AI SDK (+ first-party VoyageAI); **`createVectorQueryTool`** (`rag/src/tools/vector-query.ts:22`),
  **rerank** (weighted semantic/vector/position, `rag/src/rerank/index.ts:197`; Cohere/Voyage/ZeroEntropy
  rerankers), **GraphRAG** (random-walk over semantic edges, `rag/src/graph-rag/index.ts:39`), Mongo-style
  **metadata filters** (`vector/filter/base.ts`).
- One `MastraVector` interface (`vector/vector.ts:72`) over **~18 vector backends** (astra, chroma,
  pinecone, qdrant, pg/pgvector, libsql, mongodb, elasticsearch, opensearch, turbopuffer, s3vectors,
  vectorize, …).

### 1g. Evals / scorers & observability (richer "quality" than our checks) · brief: [`mastra/observability-and-evals.md`](mastra/observability-and-evals.md)
- `createScorer` → `MastraScorer` (`packages/core/src/evals/base.ts:1030,304`): a 4-step pipeline
  `preprocess → analyze → generateScore → generateReason`, each step a JS fn **or** an LLM-judge
  `PromptObject` — so one scorer mixes rule-based + judge.
- **~13 LLM-judge built-ins** (`@mastra/evals`): answer-relevancy, faithfulness, hallucination, toxicity,
  bias, context-relevance, context-precision, noise-sensitivity, prompt-alignment, answer-similarity,
  tool-call-accuracy, trajectory, rubric — plus **~7 code scorers** (completeness, textual-difference,
  keyword-coverage, content-similarity, tone, tool-call-accuracy, trajectory) and assertion **checks**
  (`includes`/`calledTool`/`toolOrder`/`maxToolCalls`…).
- **LIVE in-production scoring is real:** each agent-attached scorer carries `sampling: { type:'ratio',
  rate }` (`evals/types.ts:14`), gated at runtime by `Math.random() < rate` (`evals/hooks.ts:42`); plus
  **retroactive `scoreTraces`** to re-judge stored runs when a new rubric lands.
- A typed **`SpanType`** tree (AGENT_RUN / MODEL_* / TOOL_CALL / WORKFLOW_* / SCORER_* / MEMORY / RAG /
  PROCESSOR — `observability/types/tracing.ts:35`) fans out through **one exporter interface** to **~13
  backends**: Console/Default/Cloud/Storage/Platform + Braintrust, Langfuse, LangSmith, Posthog, Sentry,
  Laminar, Arize, Arthur, generic OTLP (+ Datadog/OTel bridges; presets dash0/signoz/newrelic/traceloop).

### 1h. Deploy-as-a-service (piflow is a local CLI runner) · brief: [`mastra/deploy-server-runtime.md`](mastra/deploy-server-runtime.md)
- `new Mastra({ agents, workflows, storage, vectors, observability, deployer, server, mcpServers, scorers,
  memory })` is a resident **DI hub with background workers** (`packages/core/src/mastra/index.ts:228,1080`).
- A **Hono** HTTP service (`packages/server/.../server-adapter/index.ts:9`) exposes `/api/agents/*`
  (generate/stream/observe/approve-tool-call), `/api/workflows/*` (create-run/start/stream/resume/
  time-travel), `/api/memory/*` — plus **A2A** and **MCP** route surfaces, with per-route auth/RBAC.
- `mastra dev` bundles + spawns the app on **:4111** with hot-reload and a **playground/studio** SPA (chat
  with agents, run/resume workflows, inspect traces). `mastra build` (Rollup+esbuild) targets **4
  deployers**: cloudflare (Workers), vercel, netlify (serverless/edge), and managed **Mastra Cloud**.
- `@mastra/client-js` calls a deployed instance over HTTP with **SSE streaming**
  (`process-mastra-stream.ts`).

---

## 2. Similarities to our workflow (what maps 1:1)

| Concern | Mastra | piflow |
|---|---|---|
| Graph control flow | `.then/.parallel/.branch/.dowhile/.dountil/.foreach/.map` | `compile()` DAG from `io.reads/produces`; fusion + subworkflow expansion |
| Per-unit model routing | per-agent model + per-call override, tiers via gateways | `runner/model-routing.ts` (`node.model > node.tier > run > default`) — **G1 shipped** |
| Per-unit heterogeneous tools | per-agent `tools` (dynamic) + `listToolsets()` | per-node `ToolSelection` → compiled `pi -e` extension — **§1b PDW doc** |
| Human-in-the-loop | `suspend()/resume()` + snapshot, named labels | `checkpoint` node kind + journaled reply — **G5 shipped** |
| Resume after edit/crash | snapshot replay by `runId` | content-hash journal replay — **G4 shipped** |
| Sub-workflow composition | nested `Workflow implements Step` | `expandSubworkflow` compile-time splice — **G9 v1 shipped** |
| Concurrency bound | `.foreach({concurrency})`, internal limiter | `runner/limit.ts` semaphore — **G2 shipped** |
| Quality verbs | 20 scorers + judge rubric | fusion/judge node + `verify` sub-template — **G3 partial** |
| Streaming / live view | `.watch`/`.stream` over pubsub | `observe` run-view (SSE/poll) → GUI/TUI/CLI |
| Structured output | per-step schemas + validation | ajv artifact + return-schema gate |
| MCP **client** | `MCPClient` stdio/HTTP | `@piflow/tool-bridge` MCP ingest |

**Reading:** on the *shared orchestration core*, the two are at rough parity — and several axes piflow
treated as PDW backlog (G1/G2/G4/G5/G9) are now shipped, so we are not behind Mastra on the engine. The
divergence is entirely in §3/§4.

---

## 3. The gaps — generally, then specifically

**Generally:** the gap is **not** the workflow engine. It is that Mastra is a *complete application
framework* and piflow is an *orchestration runtime*. Mastra ships the whole "make an agent product"
surface — memory, retrieval, evaluation, hosting, protocol exposure, vendor observability — that piflow
deliberately doesn't have because piflow's bet is the **substrate** (durable, sandboxed, multi-process
fleet), not the app. So "the gaps" are capability *classes* we'd **port, borrow, or compose with**, not
in-process features to re-implement.

**Specifically**, ranked by leverage for piflow. Each: *what Mastra has* (evidence) · *what we have* ·
*delta* · *how we'd close it* · severity (impact on a real piflow user) · effort.

### M1 — Stateful memory (working / semantic-recall / observational) · severity: HIGH · effort: HIGH
**Mastra.** Four memory kinds, `thread|resource` scope, schema-templated working memory, token-budgeted
observational compression, 17 storage backends (§1e). **piflow.** Nodes are **stateless and
fs-coordinated** — intermediate data passes only through declared `produces`/`reads` files; there is **no
cross-run, cross-session, or per-actor memory**. **Delta.** No memory subsystem at all. **How we close
it.** This is **directly the work already in flight** — see `piflow-memory-system-v1` (per-node memory +
self-correction, `docs/research/memory/`). Mastra is the **most mature prior art** for that design:
working-memory-as-tool, semantic recall, and observational compression are exactly the surfaces our
two-legs (self/history + world/code) design needs. **Borrow the model; keep the fs-as-truth substrate**
(each node's `memory.md` + git, distilled into the run-view).

### M2 — RAG / retrieval · severity: MED–HIGH · effort: HIGH
**Mastra.** Turnkey ingest → 9-way chunk → embed → vector search → rerank → graph-walk, exposed as
agent-callable tools over 18 vector DBs (§1f). **piflow.** None. A node that needs retrieval must hand-roll
it inside its prompt/tools. **Delta.** No chunking, embedding, vector-store abstraction, or rerank.
**How we close it.** Don't rebuild it — **expose it as a per-node capability**: a `node.tools` entry that
mounts a retrieval tool (our MCP/OpenClaw seam, §1b PDW doc), or **run a Mastra RAG tool inside a `pi`
node** (§5 compose). The vector-store-interface-over-N-backends pattern is worth studying for our catalog.

### M3 — Live quality scoring / eval vocabulary · severity: MED–HIGH · effort: MED
**Mastra.** 20 scorers (13 LLM-judge + 7 code) + assertion checks; **live `ratio` sampling** of production
traffic; **retroactive `scoreTraces`**; rubric scorer; per-step scorer spans (§1g). **piflow.** Our
`checks.ts` header literally states a check **"NEVER judges GOODNESS"** (`checks.ts:6`); fusion/judge +
`verify` sub-template cover best-of-N/consensus (G3 partial) but there is **no graded-quality vocabulary,
no live sampling, no retroactive re-scoring**. **Delta.** No quality *scores* (only pass/fail integrity)
and no online quality signal. **How we close it.** This is the richer, productized version of G3. Ship
**scorer node templates** (faithfulness/relevance/rubric) as sub-DAGs (the G3/G9 pattern), and add an
**observe-layer scoring pass** that can re-judge a stored run-view (parallels `scoreTraces`). Note: piflow
keeps integrity-checks (hard gate) and would *add* scorers (advisory signal) — both layers, as Mastra has.

### M4 — Deploy-as-a-service surface · severity: MED · effort: HIGH
**Mastra.** A resident Hono HTTP service (`/api/agents|workflows|memory`), client SDK with SSE, 4
serverless deployers, dev playground (§1h). **piflow.** `piflowctl run` is a **local foreground CLI**
(G7 added `--detach`); the GUI is a **static viewer**, not a service; there is no network API to invoke a
workflow remotely, no client SDK, no serverless target. **Delta.** No hosted/invokable-over-HTTP product
surface. **How we close it.** *Mostly a deliberate divergence* (§4) — our console is Claude Code, not a
web service. But if piflow ever wants to be **consumed by other systems**, the minimal unlock is **M5**
(expose as MCP), not a full Hono app. A thin "run a template, stream the run-view over HTTP" server is the
80/20 if a hosted offering is ever in scope.

### M5 — MCP-server exposure (+ A2A) · severity: MED · effort: LOW–MED
**Mastra.** `MCPServer` re-publishes its agents as `ask_<agent>` and workflows as `run_<workflow>` MCP
tools over stdio/SSE/HTTP (§1d); plus an A2A route surface. **piflow.** We are an MCP **client** (ingest),
**not** an MCP server — there is no way for an external agent (Claude, another piflow, a Mastra agent) to
invoke a **piflow workflow as a tool**. **Delta.** No outward MCP/A2A exposure. **How we close it.** A
small `piflowctl mcp` server that lists templates as tools and runs one on call, streaming the run-view.
**High leverage, low cost** — it makes the durable fleet callable from any MCP-speaking agent, which is the
cleanest way to let Mastra (or Claude Code) *use* piflow rather than compete with it (§5).

### M6 — Pluggable persistence abstraction · severity: LOW–MED · effort: MED
**Mastra.** One storage interface over 16+ DB backends persists snapshots, memory, traces, scores
(§1e/1g). **piflow.** Persistence is **the filesystem** (`.pi/journal.json`, `.pi/state.json`, run-view
JSON) + `~/.piflow/` index — deliberate (it's the durability moat, §4) but **single-substrate**: no
swappable Postgres/Redis backend for teams that want shared/remote state. **Delta.** No storage adapter
seam. **How we close it.** Likely **don't** for the local fleet — fs *is* the design. Revisit only if a
hosted/multi-tenant offering (M4) needs shared state; then a storage seam behind the journal/state writers.

### M7 — Observability vendor fan-out · severity: LOW · effort: LOW–MED
**Mastra.** One exporter interface → ~13 vendors (Langfuse/Braintrust/LangSmith/Arize/Datadog/OTLP…)
(§1g). **piflow.** One **verified-not-trusted** observe layer distilling `.pi` telemetry into a run-view
for GUI/TUI/CLI (`observe/runView.ts:27`) — richer *per-run* detail, but **no OTEL/vendor export**. **Delta.**
No external-observability integration. **How we close it.** An optional OTLP exporter off the run-view (map
our nodes/usage onto OTEL spans). Low priority unless an enterprise user asks.

### M8 — In-process ergonomics (dynamic tools, processors, code-mode) · severity: LOW–MED · effort: MED
**Mastra.** Per-call dynamic toolsets (`listToolsets()`), input/output/error **processors** as guardrails,
a **code-mode** tool that runs model-written TS in a sandbox and bridges back to real tools (§1c/1d).
**piflow.** Per-node tools are resolved at author/compile time; we have deterministic pre/post-node hooks
(never an LLM) but **no in-loop guardrail processors and no code-mode**. **Delta.** Less dynamism *within*
a node's single run. **How we close it.** Partially a divergence (we get dynamism *across* nodes, not
within one). Worth borrowing: an optional **output-processor gate** on a node's return (PII/format/guard)
before the integrity check.

### M9 — Finer suspend/resume (named labels, time-travel) · severity: LOW · effort: LOW
**Mastra.** Resume by **named label**, server **time-travel** over a run's snapshot history. **piflow.**
Content-hash journal replay + `--from/--until` (G4) — resumes by node, not by an arbitrary labeled point
mid-node, and no time-travel UI. **Delta.** Coarser resume targeting. **How we close it.** Minor: optional
resume labels on checkpoint nodes; a run-view "rewind to node N" affordance.

### M10 — Scheduler/cron + event-driven engine · severity: LOW · effort: MED
**Mastra.** A cron `WorkflowScheduler` (storage-CAS leader election, `scheduler.ts:27`) and an
`EventedExecutionEngine` that drives one step per event for cross-process durability (`evented/`).
**piflow.** No scheduling; runs are launched, not triggered. **Delta.** No time/event triggers. **How we
close it.** A thin `piflowctl` cron wrapper (or the harness's own scheduling) is enough; we don't need an
in-engine scheduler because each run is already a durable process.

---

## 4. What piflow has that Mastra does NOT (the moat — don't lose it)

Every one of these is a *structural* property of "one real `pi` per node" that Mastra's single-process
framework **cannot** match without becoming a different system:

- **Durable multi-process fleet that survives the controller dying.** Mastra's default engine is a
  single-Node `for`-loop that snapshots **only between steps** — a crash mid-step **loses the run**, and
  cross-process durability requires bolting on the evented engine + a non-default PubSub broker + shared
  storage (workflow reader's explicit verdict, `default.ts:774-813`, `evented/`). piflow's nodes are real
  OS processes coordinated through the filesystem; the run is self-describing on disk and re-enterable.
- **Real OS-process isolation + sandbox backends.** piflow has `local`/`seatbelt` (macOS `sandbox-exec`,
  deny-then-allow reads+writes) / `worktree` / **`daytona` remote VM** per node (`sandbox/*`). Mastra has
  **no OS isolation at all** — agents are in-process objects; the only sandbox is the code-mode tool's
  `WorkspaceSandbox`. (Mastra's *deployment* even *removes* capability: edge targets stub Node builtins and
  forbid subprocess spawning, `deployers/cloudflare`, `netlify` edge.)
- **Per-node heterogeneous OS runtime.** Different env / network / machine / toolset / model **per
  process** — node A = GitHub-MCP + memory plugin; node B = `Read`/`Grep` only; node C = an OpenClaw
  scraper in a remote VM. Mastra's heterogeneity is over model+tools **inside one process/event loop**.
- **A workflow is *data* (a template on disk), not code.** piflow compiles a declarative template → DAG;
  it can be authored, diffed, generated, and ported without writing TS. Mastra workflows are **imperative
  TypeScript** (`.then().branch()…`) that must be bundled and hosted.
- **Verified-not-trusted single observe layer** feeding GUI (web) + TUI + CLI + `watch` from one reader,
  with declarative integrity **contracts** (`declared ⊇ actual` breach detection) — a different (harder)
  guarantee than advisory scores.

---

## 5. What Mastra enables us to do that we couldn't — the strategic read

The pointed question. Three honest answers, in order of leverage:

1. **It is the reference design for the memory work we're already doing (M1).** The single highest-value
   takeaway: Mastra's working-memory-as-a-tool + semantic-recall + observational-compression is mature,
   shipped prior art for `piflow-memory-system-v1`. We don't get a new capability *for free*, but we get a
   **validated blueprint** for the hardest piece of current work — borrow the surface, keep fs-as-truth.

2. **It makes "borrow the batteries, keep the isolation" real via composition (M2/M3 + M5).** piflow's
   thesis is *one real process per node* — and **that process can run a Mastra agent/workflow as its
   payload.** A `pi` node that shells a small Mastra app gets Mastra's **memory, RAG, 20 scorers, and 40+
   model providers** *inside* piflow's OS sandbox + fleet durability — the union neither system has alone.
   Symmetrically, exposing piflow as an **MCP server (M5)** lets a Mastra agent (or Claude) call a **durable,
   sandboxed piflow workflow as a single tool**. This is the cleanest "1 + 1 = 3": **Mastra for the
   in-process app surface, piflow for the isolated durable substrate.** It positions Mastra as a
   *complement / payload*, not a competitor.

3. **It hands us a productized vocabulary to port for quality and hosting (M3/M4/M7).** Concretely: a
   **scorer node-template** family (faithfulness/relevance/rubric) layered on G3/G9; an **observe-layer
   re-scoring pass** (à la `scoreTraces`); and — *if* a hosted offering is ever in scope — the **deploy +
   client-SDK + serverless** surface to study (M4). None of these require abandoning our architecture; they
   are sub-DAGs and observe-layer additions.

**Net:** Mastra is **not** a threat to piflow's niche (durable, sandboxed, multi-process `pi` fleet driven
by non-Claude coding models with Claude Code as the single console). It competes in the *TypeScript
agent-framework* lane (vs LangGraph/LlamaIndex). The right posture is **complement + borrow**: port its
memory/scorer vocabulary, expose piflow over MCP so Mastra can *consume* the fleet, and consider running
Mastra agents as node payloads — using piflow for exactly the OS-isolation + durability that Mastra,
by being a single-process framework, structurally cannot provide.

---

## 6. Sequencing (suggested)

1. **M5 MCP-server exposure** — LOW–MED effort, high leverage; makes the fleet callable from any
   MCP agent and reframes Mastra as a consumer, not a rival.
2. **M1 memory** — fold Mastra's working-memory/semantic-recall/observational model into the in-flight
   `piflow-memory-system-v1` design as the reference blueprint.
3. **M3 scorer node-templates + observe re-scoring** — extends the shipped G3/G9 pattern with graded
   quality + a `scoreTraces`-style retroactive pass.
4. **M2 RAG as a per-node tool / Mastra-payload compose** — borrow, don't rebuild.
5. **M8/M9/M7** — opportunistic (output-processor gate, resume labels, OTLP export).
6. **M4/M6 deploy + storage seam** — only if a hosted/multi-tenant offering enters scope.
