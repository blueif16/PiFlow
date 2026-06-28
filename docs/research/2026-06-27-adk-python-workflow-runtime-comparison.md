# EXE research — Google ADK 2.0 (`google/adk-python`) vs piflow

> Status: research brief. Created 2026-06-27. Source vendored at `vendor/adk-python`
> (shallow clone, `google/adk-python` `main`, ADK **2.0**; never committed — `.gitignore:4`).
> Mechanism cross-checked against Context7 `/google/adk-python/v2.0.0a1`. Evidence is cited
> `file:line` in BOTH repos. Honest by construction: where ADK is ahead it says so; where we are
> ahead it says so. Companion to `docs/specs/competitive-gaps-vs-pi-dynamic-workflows.md` (PDW =
> the *other* in-process competitor) and grounded in `docs/design/l1-node-envelope.md`,
> `docs/design/l2-l3-boundary-map.md`, `docs/design/node-action-protocol.md`.

## 0. TL;DR

ADK 2.0's headline is a **Workflow Runtime: a graph-based, in-process, durable execution engine**
for orchestrating agents — "routing, fan-out/fan-in, loops, retry, state management, dynamic nodes,
human-in-the-loop, nested workflows" (`vendor/adk-python/README.md:35`). Architecturally it is the
**same fork PDW sits on** — *in-process subagents sharing one runtime* — but far more mature: it
adds Temporal-grade retry/backoff, event-sourced replay-resume, a large first-party tool catalog,
an A2A wire protocol, a Task API, and eval/CLI/web tooling. It reads like **LangGraph + Temporal +
first-class agents**, Gemini-centric but model-pluggable.

piflow is the **other branch of the fork**: a workflow is *data* (a template on disk), compiled to
a DAG, run as **one real headless `pi` per node**, coordinated through the **filesystem**
(`l1-node-envelope.md:26,177`). ADK validates the DAG-of-agents direction at Google scale, but
nothing in it overturns our thesis: **one-real-pi-per-node** buys per-node OS/VM isolation,
per-node capability removal (the lethal-trifecta split, `node-action-protocol.md:320-334`), and
true per-node heterogeneity (model · tools · sandbox · skill) that an in-process graph
**structurally cannot** match. The two genuine "watch" items are *runtime dynamic-node loops*
(inner-loop ergonomics) and *A2A* (cross-service federation) — both are deliberate scope choices
for us, not debt.

---

## 1. How ADK's Workflow Runtime actually works (the EXE research)

**A `Workflow` IS a node, and its `_run_impl` IS the orchestration loop.** `Workflow(BaseNode)` runs
an in-process **asyncio** loop: SETUP (build graph, seed START triggers) → LOOP → FINALIZE
(`workflow/_workflow.py:140,241`). The loop is `while True: schedule_ready_nodes → asyncio.wait(…,
FIRST_COMPLETED) → handle completions` (`_workflow.py:314,320`). A completed node's output is
buffered as a `Trigger` onto its downstream edges (`_buffer_downstream_triggers :673`); ready nodes
run concurrently, capped by `max_concurrency` (`:156,442`).

**Nodes are Python objects, edges are drawn explicitly.** A node is any `BaseNode` — `LlmAgent`,
`FunctionNode` (a Python callable), `ToolNode`, `JoinNode`, or a nested `Workflow`
(`agents/`, `workflow/_function_node.py`, `_tool_node.py`, `_join_node.py`). You **author edges**
as chains/tuples/routing-maps: `edges=[("START", a, b)]`, `(a, (b, c))` for fan-out,
`{route: node}` for conditional routing (`README.md:93`, `_graph.py:44-97,232`). The graph is
validated up front: reachability from START, no duplicate edges, edge-time **static schema
compatibility** (`from.output_schema == to.input_schema`, `_graph.py:519`).

**Control flow primitives:**
- **Conditional routing** — a node emits a `route` value; edges tagged with a matching route fire,
  else `DEFAULT_ROUTE` (`_graph.py:73,342-392`).
- **Fan-out / fan-in** — fan-out = a tuple/route to many nodes; fan-in = `JoinNode`, which sets
  `_requires_all_predecessors=True` and waits for every predecessor before emitting
  (`_join_node.py:41-48`, gathered in `_buffer_downstream_triggers :692-715`).
- **Loops are RUNTIME cycles** — `_detect_unconditional_cycles` rejects only *pure-unconditional*
  cycles; **a cycle that contains ≥1 conditional (routed) edge is allowed** and loops at runtime
  (`_graph.py:394-421`). This is the LangGraph model.
- **Dynamic nodes** — a Python `orchestrate` node calls `await ctx.run_node(x)` inside a native
  `while True:` loop, deciding the next node/iteration count at runtime
  (`workflow/_dynamic_node_scheduler.py`; Context7 sample `contributing/workflow_samples/dynamic_nodes`).
- **Retry + timeout** — per-node `RetryConfig{max_attempts, initial_delay, max_delay,
  backoff_factor, jitter, exceptions}` (`_retry_config.py:26`) and per-node `timeout`
  (`_base_node.py:82`); retry fires on raised **exceptions**.
- **Human-in-the-loop** — a node yields `RequestInput` → becomes an interrupt Event → node goes
  `WAITING`; the run resumes with `resume_inputs` (`_base_node.py:64,224`, `_handle_completion :641`).
- **Nested workflows** — `Workflow` is a `BaseNode`, so a whole flow is a node in a bigger flow.

**Data + state are in-memory.** `node_input`/`output` are Python objects passed node→node; shared
mutable state is `ctx.state` validated against a Pydantic `state_schema` (`_base_node.py:115`);
per-run scratch lives in `_LoopState.node_outputs` (`_workflow.py:99`). There is **no filesystem
contract** between nodes.

**Durability = event-sourced replay.** Node state is *reconstructed from session events* on resume
(`_scan_child_events :734`), with a `ReplaySequenceBarrier` + replay interceptor making re-execution
deterministic (`_workflow.py:93,553`, `utils/_replay_interceptor.py`). Contrast piflow's
artifact-stat + journal `--from` preflight.

**Sandboxing is for generated CODE, not for the orchestration.** `code_executors/` isolates the code
an agent *writes* — `unsafe_local`, `container`, `gke`, `vertex_ai`, `agent_engine_sandbox`
(`code_executors/`). The **orchestration nodes themselves all share one Python process and memory**;
there is no per-node OS/VM jail around the agent. (This is the analogue of pi running code inside a
node, *not* of piflow's per-node sandbox.)

**Reach (parity surface, mature):** a large first-party tool catalog + MCP + LangChain/CrewAI
adapters (`tools/`); an **A2A** agent-to-agent wire protocol (`a2a/`) and a **Task API** for
structured agent→agent delegation (`README.md:40`); classic composite agents
(`SequentialAgent`/`ParallelAgent`/`LoopAgent`/`LangGraphAgent`, `agents/`); evaluation, CLI
(`adk run`), and a web UI.

**What it empowers:** deterministic multi-agent orchestration inside one code-first Python app —
routing/branching pipelines, map-reduce fan-out/fan-in, evaluator-optimizer loops,
supervisor-with-dynamic-subnodes, HITL approvals, reusable nested sub-flows, and A2A delegation
across services.

---

## 2. Feature-by-feature: what we already support

| ADK 2.0 capability (`file:line`) | piflow equivalent (`design ref`) | Verdict |
|---|---|---|
| Graph of nodes + edges (`_workflow.py:140`) | Compiled `Workflow` DAG, one `pi`/node (`l1:156,177`) | **Parity, different substrate** |
| Edges **drawn** explicitly (`_graph.py:232`) | Edges **inferred** from `io.reads ⋈ io.produces` (`l1:34`) | **We're ahead** (sparse-authored) |
| Conditional `route` edges (`_graph.py:342`) | `route`/profile + control-node seams (`l2-l3:29`) | Parity |
| Fan-out / fan-in `JoinNode` (`_join_node.py:41`) | Stages/lanes + fusion judge sub-DAG (`l1:36`, fusion) | Parity |
| **Runtime** loops (conditional cycles) (`_graph.py:394`) | **Compile-time UNROLL**, bounded `k`, no back-edge (`nap.md:273-291`) | **Deliberate fork** (see §3) |
| Dynamic nodes `ctx.run_node` while-loop (samples) | — (compile-time unroll only; runtime cycle is an explicit non-goal `nap.md:420`) | **Gap / deliberate** (see §4) |
| Per-node `RetryConfig` backoff/jitter (`_retry_config.py:26`) | `io.retry` by **failure-class** (stat files) (`nap.md:236-243`) | Parity (different trigger) |
| Per-node `timeout` (`_base_node.py:82`) | Node-timeout + silent-stall **watchdogs** (`l1:222`) | Parity |
| — (retry re-runs same node/model) | **escalate to a STRONGER model + verified evidence** (`nap.md:247`) | **We're ahead** |
| HITL interrupt/`WAITING`/resume (`_base_node.py:64`) | Journaled checkpoint (G5) + `--detach` (G7) (`competitive-gaps`) | Parity |
| Nested `Workflow` (`_workflow.py:140`) | `expandSubworkflow` dep-wired splice (G9) (`nap.md:284`) | Parity (v1) |
| `state_schema` / `input`/`output_schema` (`_base_node.py:93-115`) | `io.artifacts` schema + `returnMode` gate (`nap.md:191-192`) | Parity |
| In-memory `ctx.state` handoff (`_workflow.py:99`) | **Filesystem-as-contract** declared reads/produces (`l1:26`) | **We're ahead** (durable/inspectable) |
| Event-sourced replay-resume (`_scan_child_events:734`) | Artifact-stat + journal `--from`/`--until` (`l1:224`) | Parity (different model) |
| `max_concurrency` cap (`_workflow.py:156`) | Concurrency cap / pool (G2) | Parity |
| `code_executors/` sandbox the *generated code* | Per-node OS/VM jail around the **whole agent** (`nap.md:320-334`) | **We're ahead** (different axis) |
| Tool catalog + MCP + adapters (`tools/`) | Registry + MCP bridge + `oc.*` + skills (`l1:195-219`) | Parity |
| **A2A** protocol + **Task API** (`a2a/`, `README.md:40`) | — (filesystem mesh within a run; FEDERATE is MCP-first) | **Gap / out of scope** (see §4) |

---

## 3. The architectural fork (why most "gaps" are deliberate)

The fork is identical to the PDW analysis (`competitive-gaps…:46`): **ADK runs every node in one
Python process sharing memory; piflow runs each node as a separate real `pi`, coordinating only
through declared files.** Two consequences ADK *structurally cannot* reach, which are piflow's whole
reason to exist:

1. **Per-node capability isolation (the lethal-trifecta split).** Each piflow node gets its own
   OS-kernel read/write jail (seatbelt/bwrap) or cloud VM (daytona/e2b) **and** its own tool-scope,
   so no single node holds {private data · untrusted content · exfil channel}
   (`node-action-protocol.md:320-334`, demonstrated end-to-end on E2B 2026-06-27). ADK's nodes share
   one process; `code_executors/` jails the *code an agent writes*, never the agent/orchestration.
2. **Per-node heterogeneity.** Model + tools + sandbox + skill + agentType differ per node, each a
   real `pi` (`l1:166`). ADK can vary an agent's model and *narrow* its tools, but every node lives
   in the same runtime and memory.

**Loops are the cleanest illustration of the fork.** ADK permits a **runtime cycle** as long as it
has one conditional edge (`_graph.py:394-421`) — flexible, but a live back-edge in a shared process.
piflow **refuses the back-edge** and **unrolls** the bounded QA loop into acyclic compile-time clones
(`expandReroute`, `node-action-protocol.md:273-291`); `checkCycles` is never modified. Theirs is more
ergonomic for unknown iteration counts; ours is durable, resumable, and OS-isolatable per attempt.

---

## 4. Honest watch-list (the only two things worth tracking)

Most ADK features already map to a shipped or specced piflow equivalent (§2). Two are genuinely
absent and worth a conscious decision — **neither is recommended for adoption now**:

- **Runtime dynamic-node loops (`ctx.run_node` in a Python `while`).** ADK's data-adaptive
  *inner loop* (decide the next node / how many iterations at runtime) is more ergonomic than our
  compile-time bounded unroll for "iteration count unknown until runtime." We deliberately scoped
  this out (`node-action-protocol.md:420`, "a runtime cyclic / re-entry primitive — explicitly
  rejected"; nested/unbounded reroute deferred `:424`). It belongs to L3's **inner loop**
  (`l2-l3-boundary-map.md:39`). **Verdict: deliberate non-goal; revisit only if a real workflow
  needs unbounded data-adaptive iteration that bounded-`k` unroll can't express.**
- **A2A protocol + Task API (cross-service agent delegation).** ADK ships an agent-to-agent *wire
  protocol* for remote/multi-org federation (`a2a/`). piflow's coordination is the filesystem
  *within one run*; cross-process federation is MCP-first via the capability catalog (memory
  `capability-catalog-feed`), and mid-run agent-to-agent consensus was **evaluated and DEFERRED**
  (memory `swarm-consensus-deferred`). **Verdict: out of current scope; A2A is the reference design
  if/when piflow targets remote agent federation — adopt the protocol, not the in-process runtime.**

## 5. Bottom line

ADK 2.0 is the **most mature in-process agent-graph runtime** to date and a strong validation that
"orchestrate agents as a DAG with routing/loops/retry/HITL/nested flows" is the right shape. It is,
however, the *same architectural branch as PDW* — one process, shared memory, in-memory state,
generated-code sandboxing — just executed to a Temporal/LangGraph-grade finish. It changes **nothing**
about piflow's positioning: our gaps versus it are the **unfinished-strength** kind (and most are
already shipped), while our two structural advantages — **per-node capability isolation** and **true
per-node heterogeneity**, both impossible in one process — remain exactly the white-space ADK can't
occupy. Borrow ideas (the `RetryConfig` backoff/jitter shape; the A2A protocol *if* we federate; the
dynamic-node ergonomics *if* L3 needs an inner loop); do not adopt the in-process model.
