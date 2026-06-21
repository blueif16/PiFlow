# Orchestration Substrate — design note (self-designing, durable, self-improving pi-agent meshes)

> **Canon home:** Pi Flow repo `docs/design/` (originated in `game-omni`, 2026-06-21; symlinked back into game-omni). This is the design + strategy canon for the Pi Flow substrate — the *why/positioning*. The buildable mechanism summary lives in `docs/ARCHITECTURE.md`; the forward plan in `ROADMAP.md`.

> **Status:** DESIGN / THINKING NOTE ONLY (no code yet). Authored 2026-06-21. Changes no tracked artifact.
> **What it is:** the generalization of `pi-runner` + `game-omni` + `hermes-skill-system` into a horizontal
> orchestration substrate — a graph of full-agent (pi) nodes that a planner *designs*, a fleet *runs*, and a
> learning loop *improves*. This file is the *why/positioning*, the competitive map, and the borrow-vs-build
> decisions — so future choices anchor to "what do we borrow vs what do we own."
> **UNRESOLVED (human decision — see §10):** is the substrate the *product*, or a *means* to better games?
> That fork changes scope and what we borrow vs build. Do not start implementation before it is answered.
> **Governance:** any implementation spans the `game-omni` tracked system and runs through
> `hermes-skill-system` (capture→route→edit→verify→approve→commit) per `CLAUDE.md`.
> **Sources:** competitive claims below carry inline URLs; the underlying research is the 2026-06-20/21
> multi-source legs (Exa + Reddit + yt-rag) on ultracode, durable execution, and automated agent design,
> extended 2026-06-21 by `research/substrate-multiagent-and-runtime-2026-06-21.md` (multi-agent-vs-monolith
> practice + the implementation-language decision).

---

## 1. One-line positioning (the load-bearing sentence)

> **ADAS/AFlow's structure search + GEPA's reflective module-level credit assignment — but with
> *full-agent nodes* on a *durable cheap fleet*, running *online in production*.**

This names the three proven parents (so we are not reinventing) and the three genuine deltas (so we are not
merely cloning). No single system we found occupies that intersection (§9). Every individual piece is
published or shipping; the *fusion* is empty space — the strong, defensible position.

---

## 2. The core abstraction — two node kinds

A workflow is a graph of nodes coordinated through the filesystem. There are exactly **two kinds**:

- **PRODUCER node** — does the task. A full autonomous pi agent (read/bash/edit/write + tools + a loaded
  skill + its own environment), not a thin LLM call. This is what `pi-runner` already spawns: one headless
  `pi` per node.
- **CONTROL node (a "seam")** — holds *intelligence about the workflow itself*. It reads the upstream
  results and decides what happens next: **plan / optimize / debug / gate**. The planner, the Hermes block,
  the debug block, and the health/supervisor are all the *same primitive* — a control node on a seam.

Everything else falls out of this. The "intelligence about the work" lives in producers; the "intelligence
about the workflow" lives in control nodes. Keep them separate (it is the producer/verify-node law we already
enforce, generalized).

---

## 3. The three modes (the user's "stream modes", crystallized)

| Mode | Name | What it does | Status today |
|---|---|---|---|
| 1 | **COMPOSE** | Build the workflow: decompose the task, investigate the best way to do each part, **discover which tools/services each part needs**, emit a `workflow.json` (structure + per-node tools + required credentials), hand the user a provisioning list. | NOT built (game-omni's DAG is hand-authored). This is the new "init" stage. |
| 2 | **RUN + LEARN** | Execute the workflow on the pi fleet; grade per-node against its oracle; the learning loop edits the node's **skill** or the chain's **architecture**. | Partially built: `pi-runner` runs; `hermes-skill-system` is the learn loop; per-node criteria fixture is the oracle. |
| 3 | **CHAIN** | Connect workflow→workflow through a **control node (seam)** in between. | NOT built as a first-class seam; `--from` suffix-rerun is the primitive. |

**The key insight is in Mode 3.** The seam between two workflows is a control node, and its two cases unify the
whole system:
- **Seam connects the *same* workflow** → you are only optimizing the skill system (the RUN+LEARN loop again).
- **Seam connects a *different* workflow** → you are editing the *structure* — the long-horizon case where
  stage N+1 can only be designed after seeing stage N's output (the Rust-port shape, §5).

So this is **one machine**: a graph of producer nodes, spliced by control nodes, where a control node can
re-plan, optimize, debug, or gate.

---

## 4. COMPOSE in detail (the init stage)

The planner phase, run with frontier reasoning (in Claude Code), before any fleet runs:

1. **Decompose** the task into parts; for each part, **investigate the most effective/efficient way to do it**
   (optionally one sub-agent per part).
2. Each sub-agent can **search the available tool/integration ecosystem** (every MCP/tool/service pi or Claude
   Code can wire up) to find a pathway for its part.
3. When the parts come back, **decide whether more sub-agents are needed** (the fan-out is sized by how many
   parts the task has, not fixed).
4. **Record everything to `workflow.json`**: the constructed DAG (producers + seams + parallel lanes + gates),
   the per-node tool/skill bindings, and the **services/credentials the user must supply**.
5. **Hand the user a plan + provisioning list**; the user supplies credentials once (global node config).
6. The workflow is now **ready to run** on the fleet.

This is exactly ADAS's "Meta Agent Search" + a tool-discovery/credential-provisioning step (§9). Prior art is
strong here — **borrow the search rigor** (§9.B) rather than hand-roll.

**Reference model — borrow the *primitive*; we already implement the per-node version.** The tool-composition
pattern COMPOSE needs is shipping today, and its lineage is ours: **OpenClaw's embedded agent runtime IS pi**
(`@earendil-works/pi`), so "stack tools onto the agent" = pi's own mechanism — drop a TS module in
`~/.pi/agent/extensions/*.ts` (or project-local `.pi/extensions/`) that default-exports a factory calling
`pi.registerTool({name, parameters, execute})`, auto-discovered + hot-reloadable; per-agent toolset chosen via
`--tools`/`--exclude-tools` (OpenClaw layers per-agent allow/deny *profiles* + an MCP bridge on top, each agent
with its own workspace + optional sandbox). **Crucially, pi-runner ALREADY does the per-node version**: a
node's `contract({tools:[...]})` emits a `DRIVER-TOOLS` marker → `pi --tools <allowlist>` at spawn (per-node,
not global, `run.mjs:1427`); `DRIVER-SEED: <dest> <= <src>` pre-stages *that node's* files/templates into its
working dir before spawn (`run.mjs:1376-1418`); `--worktree` (per-run git worktree) + `--sandbox` (per-node
Seatbelt `.sb` from `DRIVER-READ-SCOPE`) give runtime isolation. So **"each node *born* with exactly the
tools+files its design calls for, in DAG order" is ~80% built** — the primitive exists. The ONLY real COMPOSE
gap is **auto-discovery**: today these per-node bindings are *hand-authored* in the workflow; nothing
introspects a node's skill to *infer* them. To author bespoke per-node tools (not just allowlist existing
ones), `DRIVER-SEED` the node's `.pi/extensions/*.ts` and load with `-e`. (Note: OpenClaw's *core* runtime is
closed-source; the pi primitive itself is the load-bearing, verifiable part. Ref:
`research/substrate-multiagent-and-runtime-2026-06-21.md`.)

---

## 5. Seam / supervisor mechanics (the control plane)

- **A background supervisor** runs health checks on configurable triggers/timings. On a trigger it acts at a
  **node boundary (a seam)** — never by mutating a live run.
- **Pluggable control blocks**: a **debug block** (diagnose → decide rerun / stop / patch) and a **Hermes
  block** (durable, generalizing fix to the owning skill/chain) form an **escalation ladder** — debug in
  front, Hermes behind it for the deep fix. This is the generalization of the escalation gate we already have
  (cheap retry → cross-family consult → watchdog kill).
- **HARD CONSTRAINT — hot-edits happen at seams, not mid-run.** A run cannot redesign itself mid-flight — but
  *two different mechanics* enforce this at the two layers, and the gap matters (audit, 2026-06-21): the
  **Claude-Code Workflow script** is genuinely journaled/deterministic (`Date.now`/`Math.random` literally
  throw, so a resume replays identically); the **pi-runner driver is NOT** — it uses wall-clock freely for
  watchdogs/timing, and its "resume" is **artifact-stat-based** (`--from` checks which on-disk artifacts
  exist), i.e. the *weaker* guarantee §10 already flags, not journaled replay. Either way, "insert a debug
  node on a trigger" means: stop at a node boundary, splice the control node, **relaunch the affected suffix**
  (`--from`), reuse unchanged upstream — preserving resumability and credit assignment instead of throwing
  them away. (This is the concrete reason §10 says **BORROW** durability: we do not actually have journaled
  replay today, only filesystem-artifact resume.)
- **Generated programmatic units land at the seam, in one of three wiring modes.** A control node can do more
  than route — it can *emit a new deterministic unit* and splice it. Three slots already exist: (1) a
  **pre/post DETERMINISTIC HOOK** (our `DRIVER-SEED` pre · `DRIVER-MERGE`/`DRIVER-PROJECT` post — the n8n
  "code node between agents"); (2) a **callable TOOL** exposed to a node's pi agent (seed a `.pi/extensions/*.ts`
  `registerTool` via `DRIVER-SEED`, load with `-e`); (3) a full **producer NODE** in the DAG. Per the HARD
  CONSTRAINT, generation happens **at a seam / between runs** (then `--from` relaunch) — which is exactly
  LangGraph's own "recompile between runs" rule, never a mid-journal mutation. This is the mechanism behind §11.5.

---

## 6. The three loops (where "gradient descent" actually lives)

The "trace failures to the source, like gradient descent" intuition resolves into three nested loops:

1. **Inner (within a run):** data-adaptive fixed structure — same DAG, data varies, `loop-until-dry` /
   `loop-until-green`. *We have this.*
2. **Middle (within one task, across runs):** progressive structure elaboration — scout → run a phase → read
   results → author the next phase. **This is how the Bun port actually worked** (one workflow mapped Rust
   lifetimes; *the next* ported every file; *a fix-loop* drove build+test to green — three chained workflows,
   not one monolith). *We mostly do NOT have this — it is the new middle loop.*
3. **Outer (across tasks):** Hermes — grade per-node performance, **route the failure to the node that owns
   it**, edit the **skill** (improve a wave) or the **workflow** (improve the chain). *We have this; it is the
   "gradient."*

**The hard part is credit assignment, and the analogy strains there.** There is no smooth differentiable
signal; the "gradient" is a *discrete diagnosis* — *which node owns this failure?* The deeper the chain, the
harder. **The thing that makes it tractable is a per-node oracle** — and the frontier agrees: GEPA notes its
credit assignment "degrades to blind genetic search when feedback is uninformative," and Optimas shows
**per-module local rewards beat global rewards**. That is the academic confirmation of our per-node criteria
fixture + verify gates. *Failure-trace/oracle quality is the whole ballgame* — we are aligned with SOTA here,
not behind it.

**Containing error amplification (the defensive complement to credit assignment).** The "Science of Scaling
Agent Systems" result is stark — *decentralized* meshes amplify trace-level errors **17.2×** vs a single agent;
a **centralized orchestrator** intercepting errors before aggregation contains it to **4.4×** (single-agent =
1.0×), and *detection without blocking/rollback collapses defense to ~3%* — flagging is theater. The
literature's fixes are almost exactly our existing laws, which is why we sit near the 4.4× regime, not 17.2×:
- **Centralized DAG, not a swarm** — the workflow owns all routing. *Have.*
- **Blocking, clean-context verify AT the handoff** — a verifier on a *separate* context (never the generator,
  which validates its own coherent-but-wrong output) with a hard FAILED verdict that halts. *Have* — the
  PRODUCE-then-VERIFY law (VERIFY-1/VERIFY-2 as distinct nodes) *is* this; it is also why a QA-agent sharing
  the producer's context (the field's most overrated fix) is the wrong shape, and why our verify nodes
  re-derive from artifacts.
- **Per-node deterministic/ground-truth oracle** (does the value literally appear / does the assertion hold on
  real `window.__GAME__` state) over LLM-judge. *Have* — verify harness + per-node criteria + anti-reward-hack.
- **By-reference handoff** (artifacts by path, not re-emitted prose that launders guesses into "facts"). *Have*
  — filesystem-is-the-contract (Cognition Principle 1: share full traces, not messages).
- **Circuit-breaker → escalate after N fails.** *Have* — escalation ladder + watchdogs.
- **Gaps worth closing:** (1) *typed schema validation at EVERY handoff*, not just the strict-JSON blueprint
  boundary — schema drift is the single largest MAST failure category; (2) *claim-provenance tags*
  (verified / inferred / inherited) so a guess can't become fact across hops; (3) *journaled checkpoints* (the
  §10 durability=BORROW item) vs today's artifact-stat resume. (Ref: 2026-06-21 research brief.)

---

## 7. What we already have (do not rebuild)

| Piece | Where | Reuse |
|---|---|---|
| Full-agent node | `pi-runner/run.mjs` (one `pi` per node) | the producer primitive |
| Static DAG from one source of truth | `extract.mjs` (record prompts+DAG, no codegen) | the workflow representation |
| Per-node oracle | `.agents/skill-system-criteria.md` + VERIFY-2 gates + artifact-contract-vs-filesystem | credit-assignment signal |
| Outer learning loop | `hermes-skill-system` (route to canonical owner; skill vs chain edit) | the "gradient" |
| Escalation ladder | escalation gate (retry → cross-family consult) + watchdogs | the seam/debug→Hermes ladder primitive |
| Cross-restart resume | `--from` + resume preflight (artifact stat) | the seam relaunch mechanic |
| Viz **data layer** | `pi-runner/viz-model.mjs` (DAG ⋈ run-status → stages/lanes/Gantt/pathways) | feeds the box-and-arrow view (renderer is the gap, §8) |
| Write isolation / read scope | `--worktree` + `--sandbox` (Seatbelt) | per-node environment isolation |

---

## 8. Visualization — what exists, what is missing

- **HAVE the data layer:** `viz-model.mjs` reconstructs **stages, parallel lanes, phases, a Gantt timeline,
  stage durations, and pathways** from the static DAG ⋈ `run-status.json` — zero new persisted fields.
- **MISSING the renderer in this repo:** the Ink TUI (`viz.mjs`) and `tui/` are template-only and absent here;
  there is **no graphical box-and-arrow DAG view**. `status.mjs` (text) + `watch.mjs` (sentinel) are wired.
- **Implication:** a live box-and-arrow view of the mesh (where seams/control-nodes light up) is **a renderer
  away, not a data-model away** — `buildModel()` already emits the boxes/lanes/edges/Gantt. This is a cheap,
  high-value build, and the operator surface the funded competitors already ship (§9.D).

---

## 9. Competitive landscape (study the field — be honest)

Your three phases map onto three mature **but separate** literatures. Condensed map (full table + quotes in the
2026-06-21 research leg):

**A. Automated DESIGN / OPTIMIZATION of agentic systems — the closest prior art.**
- **ADAS / Meta Agent Search** (Hu, Lu, Clune, ICLR 2025) — a meta-agent programs ever-better agents *in code*
  from a growing archive; invents "novel prompts, tool use, workflows, and combinations thereof." = your
  COMPOSE phase. https://www.shengranhu.com/ADAS/
- **AFlow** (ICLR 2025 Oral) — **MCTS over code-represented workflows**; **+5.7% avg, smaller model beats
  GPT-4o at 4.55% of cost.** = COMPOSE with a real search algorithm. arXiv:2410.10762
- **GEPA** (ICLR 2026 Oral) — reflective **module-level credit assignment** then targeted updates; **beats GRPO
  by 10–20% at 35× fewer rollouts**; beats MIPROv2 by >10%. **= Hermes, verbatim** — but prompt-only, fixed
  topology, compile-time. arXiv:2507.19457
- **Trace / OptoPrime** (NeurIPS 2024) — "the next AutoDiff": execution trace as a graph, generative optimizer
  updates prompts *and code*; **the closest formal framing to "gradient descent for agent graphs."**
  https://microsoft.github.io/Trace/
- **DSPy/MIPROv2, TextGrad, AlphaEvolve** — prompt/text optimization (fixed topology) and evolutionary code
  search; partial overlap.

**B. Production orchestration / durable execution — where we are weakest.**
- **Temporal / DBOS / Restate** — exactly-once *journaled replay* across arbitrary crashes; Temporal runs for
  years (continue-as-new). Static, hand-authored, no self-design. Years ahead on durability.
- **LangGraph 1.x** — typed state graph; nodes are **functions** (can wrap a full agent); checkpointer per
  super-step (weaker than journal replay); no self-design.
- **Inngest / Trigger.dev / Mastra** — managed durable steps, isolated containers; no self-design.

**C. Multi-agent frameworks.** CrewAI (role crews), AutoGen→MS Agent Framework / AG2 (conversational +
Magentic-One), OpenAI Agents SDK (handoffs), Google ADK (agent tree + A2A), Letta/MemGPT (memory-first,
self-edits memory). Nodes are agents, but orchestration is LLM/role-driven; weak durability; **no structured
self-improvement of the graph.**

**D. Long-horizon coding PRODUCTS — our architectural peers (full-agent nodes, durable, multi-day).**
- **Factory.ai Missions** — orchestrator → milestone → **fresh-context worker** → validation; **14% of
  missions >24h, longest 16 days**; "the system must improve over time by observing itself." Architecturally
  the nearest product. https://factory.ai/news/missions
- **Devin / Cognition** — coordinator + fleet of managed Devins in isolated VMs; **builds playbooks from past
  trajectories**; even "built itself tools it would later use" (Nubank: 12× efficiency). https://docs.devin.ai/
- **Claude Agent SDK / Managed Agents** — brain/hands decoupled; append-only session event log; "Dreaming"
  curates memory between sessions; checkpointed idle containers.
- **Imbue Sculptor** (parallel agents in isolated worktrees), **Manus**, **Cosine Genie** — partial overlap.

**E. Visual / code NODE-ORCHESTRATION platforms — the practitioner peer group (what to actually benchmark against).**
- **n8n** — nodes are TS classes on a canvas; the **AI Agent node** takes tools on an `ai_tool` socket; the
  composition primitive is **sub-workflow-as-tool** (`toolWorkflow`: "package any n8n node(s) as a tool") +
  **Custom Code Tool** (`toolCode`). Human-wired, design-time; cannot self-extend its catalogue.
- **Coze** (ByteDance) — bot = prompt + plugins + workflow + knowledge; a plugin/tool = one OpenAPI operation;
  you can **publish a workflow as a tool** and wire multi-agent jump conditions — but every unit is
  human-authored behind a **publish-and-approval** gate.
- **Dify / Flowise / Langflow** — same category: a DAG of typed nodes + OpenAPI/custom-code tool nodes, human-wired.
- **LangGraph** — the *code* peer: `StateGraph` of nodes-as-functions (each may wrap an agent), dynamic routing
  via `Command`/`Send`/conditional edges, checkpointer durability. But it is **static-after-`compile()`**: the
  dynamism routes among **pre-declared** nodes; **it executes a developer-defined graph, it does not generate
  nodes/tools.** "Add/remove nodes between runs" = the developer recompiling (≡ our seam discipline, §5) — a
  reason LangGraph is a real **§10-BORROW candidate** for the durable runtime, while §11.5 stays ours.
- **Takeaway:** every shipping orchestrator — visual or code — is human-wired/design-time. None has a control
  agent that *generates and registers* a node/tool. That gap is §11.5.

---

## 10. Borrow-vs-build decisions (the whole point of this doc)

**Don't out-engineer a solved primitive; borrow it. Own only the intersection nobody occupies.**

| Axis | Decision | Why |
|---|---|---|
| **Durability** | **BORROW** — sit on / adopt journaled-replay semantics (Temporal/DBOS/Restate-style); do **not** ship filesystem/same-session resume as the durability story for irreversible side effects. | Per-step checkpointing is "a weaker guarantee than exactly-once journaled replay"; for anything irreversible "you want a dedicated durable layer underneath." |
| **Structure search** | **BORROW** — adopt **AFlow's MCTS / Trace's OPTO** as the COMPOSE-loop search operator + acceptance test. | A planner that "designs the structure" with no principled search operator is weaker than these proven algorithms. |
| **Credit assignment** | **BORROW the mechanism, BENCHMARK against it** — Hermes should adopt GEPA's reflective module-level credit assignment + **per-module local rewards (Optimas)**, and measure against `dspy.GEPA`. | If full-agent-node complexity can't beat prompt-only GEPA on a shared benchmark, the complexity isn't paying for itself. |
| **Observability** | **BUILD (cheap)** — a box-and-arrow DAG renderer over `viz-model.buildModel()`. | Data layer already exists; the operator surface is table stakes the competitors ship. |
| **Full-agent nodes** | **OWN** — pi/Claude-Code-class nodes with their own env/tools/skill. | ADAS/AFlow/GEPA/Trace nodes are LLM calls or text variables, not full agents. |
| **Cheap-fleet economics** | **OWN** — make "win on a cheap-model fleet" a first-class *design objective*. | The academic line treats compute as free; this inverts the economics (the pi-runner thesis). |
| **Online + durable self-optimization** | **OWN** — improve the graph *while running durably in production*. | Every optimizer is offline/ephemeral/frontier; every durable runtime doesn't self-optimize. The intersection is empty. |
| **Implementation language** | **STAY TypeScript/Node** for the orchestrator + DAG; a **Rust/Go layer ONLY as a future crash-isolated sidecar** for the always-on supervisor (§5), never the glue, and only on a *measured* Node-stability problem (prefer Go there — intu/Temporal-server precedent). | The orchestrator is **IO-bound** (spawn pi · watch files · poll status); the LLM child dominates, so Rust's perf is wasted while compile-time + FFI crash-coupling + polyglot ops bite. The serious durable engines confirm the pattern: Temporal *server*=Go, Temporal *Core SDK*=Rust, Restate *engine*=Rust — Rust lives ONLY in a **shared correctness-critical core**, never the per-language glue. So "write it in Rust?" ≡ "build our own durable core?" — and the row above already says BORROW that. Evidence: the 2026-06-21 research brief. |

---

## 11. White space — the defensible center (the "futuristic but useful to others" answer)

> **2026 evidence sharpens the framing (research brief, 2026-06-21).** The field has converged on *"most
> multi-agent systems should be one agent — pull the orchestration into explicit code"* (milebits), with
> **single-threaded writes + clean-context verify nodes** the winning shape (Cognition's own reversal: Devin
> Review catches ~2 bugs/PR *because* coder and reviewer share no context) and peer-to-peer swarms *"mostly a
> distraction."* Centralized orchestration is the measured difference between working and not (decentralized
> meshes amplify errors **17.2×** vs **4.4×** centralized). **That convergence IS our design** — a centralized
> DAG, file-based high-fidelity handoff (Cognition Principle 1: "share full traces, not just messages"), a
> produce-then-verify law. So the moat is **centralized, code-defined orchestration of cheap full-agent nodes
> with per-node oracles — NOT agent count.** Never pitch this as a swarm; the "many small agents" intuition is
> a *means* (context isolation per node), not the value.

1. **Joint structure + node-skill optimization in ONE credit-assignment pass** — from a single failure, route
   *"bad node SKILL (edit skill) vs bad chain SHAPE (rewire)"*. Exactly Hermes' "route to the canonical source
   owner." GEPA is prompt-only; AFlow is topology-only; **nobody routes both axes from one trace.**
2. **Online + durable + full-agent-node optimization** — the empty intersection (§10). The defensible center.
3. **Cheap-fleet economics as a design *objective*** — find the structure that wins on a cheap fleet.
4. **A persisted, versioned, git-logged archive of *discovered structures*** (not facts, à la Letta) — ADAS's
   archive dies with the run; Devin's playbooks only gesture at it. "Structures that worked for task-class X"
   is a real moat, and `git`-as-log is already our Hermes convention.
5. **A control agent that GENERATES + verifies + (human-)approves + durably-registers a new tool/node/hook —
   the empty production intersection (the sharpened center).** Mainstream orchestrators (n8n, Coze, Dify,
   LangGraph; §9.E) are human-wired/design-time and never self-extend; the self-generating edge (AWP's runtime
   `DynamicToolFactory`, AgenticX's skill self-evolution, Voyager's skill library, ADAS's archive) *generates*
   but substitutes an autonomy-gate/sandbox/security-scan for a **human-approval** spine, and is mostly
   run-scoped or research-only. **Our Hermes loop — capture→route→edit→verify→APPROVE→commit→record, with
   generalize-or-don't-ship + an immutable oracle + a drift-gated registry — is precisely the unclaimed slot.**
   Concretely (the user's triage idea): when triage shows a recurring gap, Hermes *synthesizes* the missing
   unit, wires it in one of the three modes (§5), gates it (verify + human approve), registers it to the
   capability/node catalog, and the NEXT run uses it. Guardrails keep it off the 17.2× path (§6): seam-only
   (never mid-run), sandboxed (`--sandbox`/`DRIVER-READ-SCOPE`), bounded fan-out + circuit-breaker,
   registry-as-code-truth. This is Voyager's skill library + ADAS's archive + our durability/approval
   discipline — the intersection none of them occupy.

---

## 12. The strategic fork (must be answered before building)

**Is the substrate the product, or a means to better games?**

- **Means-to-games:** keep the substrate minimal; only build the COMPOSE/seam pieces that demonstrably make
  game-omni better; stay a vertical. Lower risk, narrower.
- **Substrate-as-product:** a horizontal, self-designing, durable, self-improving pi-agent platform —
  exciting, but it competes simultaneously with Temporal + LangGraph + CrewAI + the ADAS/GEPA line + Factory +
  Devin. Crowded, well-funded, hard. Only viable if we hold the §11 intersection tightly and borrow everything
  else (§10).

This is a human decision. It changes scope and every borrow-vs-build call. **Do not drift into the horizontal
build without choosing it.**

---

## 13. Open questions / risks

- **Sub-orchestrator depth.** Factory's own open question: "one layer works, two might help, three is
  bureaucracy." We hit the same question (pi sub-agents N levels deep). Cap depth deliberately.
- **Credit-assignment quality is the ceiling.** Without strong per-node oracles, the learning loop degrades to
  blind search. Every new node-type needs its oracle authored at creation time (already our discipline).
- **Determinism vs adaptivity.** Adaptive structure must live at seams (between runs), never inside a journaled
  run. Resist "self-rewriting live run."
- **Cost.** Multi-agent is ~15× tokens (Anthropic) and "no built-in cost floor" is ultracode's top complaint;
  the cheap fleet + node-timeout/watchdogs is our floor — keep it.
- **Second-system scope creep.** This note exists partly to prevent it (the fork in §12).
- **Polyglot temptation.** "Rewrite the hot loop in Rust" is the wrong instinct for IO-bound glue — the LLM
  child, not the orchestrator loop, is the bottleneck. A Rust/Go layer earns its keep ONLY as a crash-isolated
  **sidecar** (newline-JSON stdio, *not* napi-rs FFI — an uncaught Rust panic crashes the whole Node process),
  for a hardened always-on supervisor, and only on a *measured* Node-stability problem. Instrument
  orchestrator-overhead-vs-in-pi-time before ever considering it (§10 language row).

---

## 14. Suggested first steps (only after §12 is answered)

1. **Renderer over `viz-model.buildModel()`** — the box-and-arrow DAG view (cheap, useful regardless of fork).
2. **A COMPOSE prototype** — a planner phase (in Claude Code) that emits a `workflow.json` (DAG + per-node
   tools + credential list) for one task class; borrow AFlow's search shape.
3. **Hermes ⟶ GEPA alignment** — reframe the Hermes loop in GEPA's module-credit-assignment terms; pick a
   shared benchmark; measure.
4. **Durability decision** — prototype journaled-replay semantics or pick a durable layer to sit on; retire
   "filesystem resume is our durability story."

> This note changes no tracked artifact. Any implementation runs through `hermes-skill-system`.
