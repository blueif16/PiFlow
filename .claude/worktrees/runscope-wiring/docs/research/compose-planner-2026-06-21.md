# The COMPOSE Planner / Generation Loop for Pi Flow (M6) — research brief

**Date:** 2026-06-21
**Question:** How should Pi Flow's M6 "design agent" PLAN a workflow — decompose a task, research
each part, discover tools/credentials, and EMIT a `WorkflowSpec` (flat bag of `NodeIntent`s) that
the SDK `tryCompile`s in a validate→repair loop, ending in a provisioning list? This brief is about
the **planner/generation LOOP**, not the output schema (settled in the prior brief).
**Builds on (do NOT redo):** `docs/research/declarative-dag-authoring-2026-06-21.md` — flat-bag +
data-flow edge inference + validate→repair + weak-model schema-fill rules (reasoning-before-committed
field order; keep optionals optional).
**Legs run:** Exa web search (primary spine — research papers + practitioner blogs) **+ Reddit**
practitioner scrape (r/n8n, r/AI_Agents, r/LangChain, r/LocalLLaMA via macrocosmos/reddit-scraper;
190 posts across two scrapes). **No YouTube.** Both legs returned cleanly. The Reddit "AI workflow
builder" keyword surfaced a flood of *launch* posts (n8n native AI Builder, n8nBuilder.com, Yagr,
Osly/Pocketflow, LangConfig) plus the reliability vein; web leg carries the technique detail.

---

## 0. Bottom line (verdict up front)

**Start SIMPLE: single-pass planner, NO search.** Borrow the *structure* of ADAS/AFlow/GEPA (meta-agent
emits a candidate; an acceptance check gates it; reflection repairs it) but NOT their expensive search
loop. Pi Flow's COMPOSE job is **author a known-shape pipeline reliably ONCE**, not *discover a novel
agent architecture over hundreds of rollouts*. So the recommended loop is **plan-and-execute's planner
half** (ReWOO/LLMCompiler: one frontier planner emits the whole DAG up front with data-flow placeholders)
+ **`tryCompile` as the acceptance test** (efficient, deterministic, no execution needed) + **Reflexion-style
validate→repair** (validator errors fed back as verbal feedback) capped at **~3 iterations**. Sub-agent
fan-out for per-part research is **optional and conditional**, sized to task complexity. The AFlow-MCTS
search operator is the *upgrade path*, not the v1.

---

## 1. Automated agent/workflow design — what to borrow, what to drop

The frontier of *automated workflow design* searches for **novel** workflows; Pi Flow authors a
**known-shape** one. The transferable pattern is **{generate candidate → acceptance test → reflect/repair
→ archive}**; the part to DROP is the multi-hundred-rollout search.

- **ADAS / Meta Agent Search** (Hu, Lu, Clune; ICLR 2025 Outstanding Paper) — a **meta agent iteratively
  programs new agents in CODE**, tests them on tasks, adds strong ones to an **archive**, and conditions
  the next design on that archive; each design gets **two self-reflection passes** before evaluation.
  Code = Turing-complete = maximal search space. **Transfer:** the self-reflection-before-acceptance step
  and the archive-of-prior-designs idea. **Drop:** code emission (un-validatable, un-defaultable — the prior
  brief settled on schema-fill) and the open-ended search. https://openreview.net/pdf?id=Joc8ecV2im ,
  https://arxiv.org/abs/2408.08435
- **AFlow** (Zhang et al.; ICLR 2025 Oral) — workflows = "typed operator graphs" of **code-represented
  edges**, searched via **Monte Carlo Tree Search** with LLM-guided expansion + **executable evaluation
  and explicit dollar cost** as the reward; reusable **Operators** (Ensemble/Review/Revise) shrink the
  search space; smaller models beat GPT-4o at ~4.5% cost. **Transfer:** Operators ≈ Pi Flow reusable node
  templates; the *acceptance test should be efficient and automatic*. **Drop for v1:** MCTS — it needs an
  executable benchmark + many rollouts Pi Flow doesn't have at compose time.
  https://openreview.net/pdf?id=z5uVAKwmjf , survey table:
  "AFlow … MCTS … executable evaluation and explicit dollar cost" https://arxiv.org/pdf/2603.22386
- **GEPA** (Agrawal et al., UC Berkeley/Stanford/Databricks/MIT; 2025) — **reflective prompt evolution**:
  samples execution traces, **reflects in natural language to do module-level credit assignment**, makes
  targeted per-module updates, and combines lessons along a **Pareto frontier**; beats GRPO by 6–19pp using
  **up to 35× fewer rollouts**. **Transfer (the load-bearing one):** *natural-language reflection over a
  trace is a far richer learning signal than a scalar*, and it can assign blame to a **specific module
  (node)**. This is exactly the validate→repair feedback shape — feed the *specific failing node + violated
  rule* back, not a global "try again." https://openreview.net/pdf?id=RQm2KQTM5r ,
  https://arxiv.org/html/2507.19457v1
- **Trace / OptoPrime** (Cheng et al., NeurIPS 2024) — frames workflow optimization as **OPTO**: an
  execution trace is "akin to back-propagated gradients"; OptoPrime formats *trace + output feedback* as a
  pseudo-algorithm problem and asks an LLM for the parameter update. **Transfer:** the *compile-error report
  IS the gradient* — structure the repair prompt as "here is the spec, here is the violated constraint,
  propose the minimal edit." https://openreview.net/forum?id=rYs2Dmn9tD , https://arxiv.org/pdf/2406.16218

**§1 synthesis:** every system here is **generate → automatic-acceptance → reflect → (archive)**. Pi Flow's
`tryCompile` is a *zero-cost, zero-rollout* acceptance test (no benchmark execution), so it can run the
reflection loop AFLOW/ADAS run — minus the search. Verdict: **start simple, keep MCTS/archive as the v2
upgrade** if a quality bar ever needs search.

---

## 2. Planning loops — decompose, plan up-front, when to fan out

- **Plan-and-execute / ReWOO / LLMCompiler** are the right family: a **single planner emits the whole plan
  up front**, then a more efficient executor runs it. Benefits (LangChain): faster (no re-plan per step), **more efficient
  (sub-tasks go to smaller models)**, and *better* because the planner is forced to "think through all steps."
  https://www.langchain.com/blog/planning-agents
  - **LLMCompiler** (Kim et al., ICML 2024) — Planner "generates a **DAG of tasks with their
    interdependencies**"; dependent tasks carry **placeholder variables (`$1,$2`)** substituted at dispatch.
    The edges ARE the data-flow wiring — which is precisely Pi Flow's `reads`/`produces` model. **Its named
    failure mode = hallucinated dependencies** (prior brief §2.4): a back-edge hidden in an NL argument the
    runtime can't see → deadlock. **This is the core argument for Pi Flow INFERRING edges from declared I/O
    rather than trusting planner-drawn edges.** https://openreview.net/pdf?id=uQ2FUoFjnF ,
    https://github.com/SqueezeAILab/LLMCompiler
  - **ReWOO** — three nodes: **Planner → Worker → Solver**; "decouples reasoning from observation," cutting
    tokens and, per NVIDIA NeMo's writeup, **reducing hallucination** because the plan is committed before any
    tool output can sidetrack it. The planner emits a JSON array of steps with a tool, args, and deps.
    https://docs.nvidia.com/nemo/agent-toolkit/1.7/components/agents/rewoo-agent/rewoo-agent.html ,
    https://aipatternbook.com/plan-and-execute
- **The planner should be the largest model the budget supports**, run **once per task** (sometimes once per
  checkpoint): "The planner is typically a strong reasoning model (Claude Opus, GPT-5 reasoning mode, the
  largest model the budget supports)." https://aipatternbook.com/plan-and-execute
- **Decomposition granularity — there is an optimal, and over-decomposition HURTS.** An empirical phase
  diagram finds a **Decomposition Granularity Index (DGI)** with three regimes: under-decomposition (leaf
  tasks too big), an **optimal window**, and **Phase III over-decomposition where "coordination overhead
  dominates" and success rate DECREASES**. https://clawrxiv.io/abs/2604.00690 . The practitioner heuristic
  converges: decompose until each **leaf needs ≤1–3 tool calls**, and keep each node inside a **5–10
  logical-step "reasoning window."** https://engineersofai.com/docs/agentic-ai/long-horizon-planning/Task-Decomposition
  (Caveat: the DGI paper is a clawRxiv preprint — directional, not load-bearing; the *direction* "over-split =
  coordination tax" is corroborated by practitioner sentiment in §5.)
- **When to FAN OUT sub-agents to research each part:** only when a part is genuinely uncertain (tool choice,
  approach, or credentials unknown). Tree-of-Thoughts / graph planners show parallel exploration helps for
  *hard, branchy* sub-problems but adds coordination cost otherwise. **Size fan-out to complexity:** trivial
  parts → planner handles inline (no sub-agent); uncertain parts → one bounded research sub-agent each;
  reserve breadth for the few parts that need it. (Mirrors DGI: don't spawn a sub-agent per node.)

---

## 3. Repair — validate→repair iteration policy

The whole field converges on the **same loop**: generate → validate → feed the *specific* error back →
retry → cap → fail safely. Key parameters, with citations:

- **Iteration cap ≈ 3 (hard cap ~5).** Multiple independent results land here:
  - **Optimal-stopping** for self-refine: a calibrated stop rule hits **96–99% of an 8-iteration cap's
    quality using only 2.4–3.1 iterations** — i.e. most gains are captured by ~3.
    https://clawrxiv.io/abs/2604.02035 (preprint — flagged).
  - **Self-Refine** (Madaan et al., NeurIPS 2023): "marginal improvement naturally decreases with more
    iterations." https://proceedings.neurips.cc/paper_files/paper/2023/file/91edff07232fb1b55a505a9e9f6c0ff3-Paper-Conference.pdf
  - **Reflective SQL generation:** "a small refinement budget (**t≈3–4**) captures most of the available
    gains." https://arxiv.org/pdf/2601.06678
  - **Reflexion** practice: "Papers often allow **3–5 trials**. Production agents need hard caps plus backoff
    to humans. **If trial 3 repeats trial 2's mistake, escalate rather than loop forever.**"
    https://solana.garden/guides/llm-reflexion-explained/
- **Repair, don't resample, and make feedback module-specific.** Instructor's pattern: on validation
  failure, **feed the exact validation error back** and ask for a correction; "most validation failures
  resolve in one or two retries… converts hard failures into soft retries." https://fordelstudios.com/research/structured-outputs-production-systems
  Reflexion-prompting guidance: the reflection should **name the missing field / failed constraint** and stay
  to **two or three sentences** ("one-paragraph reflections degrade into vague self-critique").
  https://sureprompts.com/blog/reflexion-prompting-guide . GEPA's module-level credit assignment (§1) says
  the same: blame the *specific node*, re-prompt *that* part. → Pi Flow: a `tryCompile` error like *"node
  `score`: input `clean.csv` has no producer; declare it external or add a producing node"* is the ideal
  repair signal — name the node + the rule (mirrors dbt/Pants messages from the prior brief).
- **Detect terminal refusals vs retryable errors — do NOT loop on a refusal.** "JSON mode is not a
  contract": prompt-only JSON fails **8–15%** in production; constrained decoding pushes failures below 0.1%
  syntactically **but shifts them to refusals** — "a naive retry loop retries forever on a safety-blocked
  input." https://tianpan.co/blog/2026-04-20-structured-output-reliability-production . So Pi Flow's loop
  must classify each failure: **(a) schema/graph-invalid → retryable repair; (b) refusal / "I can't"
  object → terminal, escalate to human; (c) same error twice → terminal (oscillation), escalate.** Smart
  retry beats generic backoff: "A JSON parse failure and a schema validation failure have different root
  causes and different optimal retry strategies." (same Fordel source).
- **Structured output on weaker/non-frontier models** (Pi Flow's stated producer tier): conformance is
  **~95–99%, not 100%**, so validate→repair is **mandatory, not optional**. Caveat from BAML: constrained
  decoding **trades quality for conformance** ("structured outputs create false confidence… forcing format
  compliance over a high-quality response") — which is *another* reason the **planner (the spec author) must
  be the FRONTIER model**, not the efficient tier. https://boundaryml.com/blog/structured-outputs-create-false-confidence

---

## 4. Tool & credential discovery — building the provisioning list

The pattern that's crystallized in 2026 is **registry/gateway-mediated tool discovery with a search
primitive**, and **credential injection at the gateway, not in the spec**:

- **Search a tool catalog during planning (don't dump all tools into context).** Anthropic-style **deferred
  tools**: "register the full catalog but mark most as deferred… the model sees only a **search primitive**;
  when it needs a capability it calls search, which returns **3–5 `tool_reference` objects**, only those
  expanded into context." https://www.lunar.dev/post/why-dynamic-tool-discovery-solves-the-context-management-problem
  → Pi Flow's `registry.search(need)` should return a small ranked set per part, not the whole catalog.
- **Active, iterative tool discovery.** **MCP-Zero**: agents emit **structured capability requests** ("I
  need a tool that does X") and **iteratively refine** if returned tools are inadequate — "natural fault
  tolerance and self-correction." http://www.arxiv.org/pdf/2506.01056 . **AgentOS** exposes a
  `discover_capabilities` meta-tool (id = `${kind}:${name}`, e.g. `tool:…`/`skill:…`) — the same
  `namespace:name` shape the prior brief settled on for `tools.allow/deny`. https://docs.agentos.sh/features/discovery-guide
  **agent-discover**: single-call `find_tool` with **hybrid BM25 + semantic ranking**, returns top match +
  `required_args` + alternatives. https://github.com/keshrath/agent-discover
- **Discovery is identity/policy-mediated, and credentials inject at the gateway.** Lens Agents and
  TrueFoundry both route discovery through a **gateway**: the agent calls `tools/list`, the gateway returns
  *only* the tools that identity may use, and every call passes **authorization → sandbox → credential
  injection → audit**. https://docs.k8slens.dev/lens-agents/concepts/mcp/ ,
  https://www.truefoundry.com/blog/mcp-tool-discovery-for-enterprise-ai-agents
  → **Implication for Pi Flow:** the planner discovers *which capability each part needs* and records the
  **`tools.allow` namespace:name + the credential each tool requires**; the **provisioning list is the union
  of those required credentials minus what's already configured.** The spec carries the *requirement*; the
  runtime injects the *secret*. (Sandbox/credential-injection internals are out of scope — owned elsewhere.)

---

## 5. Practitioner sentiment (Reddit) — where LLM-authored plans break

The launch-post flood proves demand; the reliability vein proves the guardrails are non-negotiable.

- **Auto-generated workflows are NOT ready as-is — single-shot output needs repair.** A blind first-shot
  test of n8n's native AI builder vs an "n8n-as-code" agent: *"these workflows are not ready to use as-is…
  raw outputs from a single-shot prompt… would need tweaking, cleanup, and implementation work."*
  https://www.reddit.com/r/n8n/comments/1ssidyh/i_ran_a_blind_firstshot_test_n8n_native_ai/
- **"LLMs can't reliably generate" a DSL/YAML directly → that's *why* you constrain + validate.** A builder:
  *"custom DSLs or YAML-based formats have a fundamental problem: LLMs can't reliably generate [them]."*
  https://www.reddit.com/r/LangChain/comments/1pl8ll2/langconfig_open_source_no_code_multideep_agent/ — direct
  support for schema-constrained emission + a compile gate over free-form generation.
- **The #1 reliability failure is the agent declaring success falsely** + brittle chains: *"Sessions expire.
  Context drifts. One weird API response breaks the chain. Sometimes the agent says the task is done even
  though it [isn't]."* → Pi Flow's deterministic `tryCompile` gate is exactly the "counter the LLM can't
  hallucinate past" the community asks for. (r/AI_Agents, multiple threads.)
- **Human-in-the-loop checkpoints beat full autonomy.** *"Fully autonomous AI agents… often became difficult
  to control and produced unreliable results. Instead I focus on semi-automated workflows with small human
  checkpoints."* Several "anti-hallucination trust gate before merge" / "approval step before AI output goes
  out" posts. → endorse: **the provisioning list + the compiled DAG are the human checkpoint** before any
  run. (r/AI_Agents, r/n8n.)
- **Yagr ("Your Agent Grounded in Reality")** explicitly reframes "dreaming code" black boxes as
  auditable/versioned specs — the same thesis as Pi Flow's declarative spec.
  https://www.reddit.com/r/n8n/comments/1ssidyh/ (and Yagr launch threads).

**Net sentiment:** practitioners distrust single-shot LLM-authored workflows, want a **deterministic
validation gate** and a **human checkpoint**, and find **semi-automated + planner/executor split** more
reliable than autonomy. (Caveat: forum chatter cites unreleased models — treat *sentiment* as load-bearing,
specific model names as unverified.)

---

## 6. Synthesis — the recommended Pi Flow COMPOSE loop

**Pipeline (single-pass, search-free v1):**
1. **DECOMPOSE** (frontier planner, once): split the task into parts, each a leaf of **≤1–3 tool calls /
   inside a 5–10-step reasoning window**. Guard against over-decomposition (DGI Phase III) — fewer, fatter
   nodes beat many thin ones.
2. **RESEARCH per part — sized to complexity:** planner handles trivial parts inline; spawn **one bounded
   research sub-agent per UNCERTAIN part** (unknown approach/tool/credential). Do **not** fan out one
   sub-agent per node. Each sub-agent returns a CONDENSED finding (chosen approach + required capability),
   not a transcript.
3. **TOOL DISCOVERY:** for each part, `registry.search(need)` returns **3–5 ranked `namespace:name`
   candidates** (BM25 + semantic); planner picks, records `tools.allow` + each tool's required credential.
4. **EMIT `WorkflowSpec`** via structured output (reasoning-before-committed field order; optionals stay
   optional — prior brief). Flat bag of `NodeIntent`s; **no hand-drawn edges**.
5. **`tryCompile` = the acceptance test** (deterministic, zero-rollout): infer edges from `reads`/`produces`;
   check missing/duplicate producer, cycle, unknown `dependsOn`.
6. **VALIDATE→REPAIR loop, capped at 3 (hard 5):** on failure, feed back the **specific node + violated
   rule** (GEPA/Reflexion module-level credit). Classify: schema/graph error → repair; **refusal → terminal,
   escalate**; **same error twice → terminal (oscillation), escalate.**
7. **PROVISIONING LIST** = union of required credentials across compiled nodes minus already-configured →
   handed to the user as the human checkpoint, alongside the compiled DAG.

**Model tiers:** **planner = FRONTIER** (it reasons over the whole task, and constrained decoding degrades
quality so the *author* must be strong); **research sub-agents = frontier or mid**; **producer nodes =
efficient/non-frontier** (plan-and-execute's whole economic argument), guarded by per-node output validation.

**Fan-out sizing:** O(uncertain parts), not O(nodes); most tasks need 0–2 research sub-agents.

**Search operator / acceptance test — START SIMPLE:** use **`tryCompile` as an efficient deterministic acceptance
gate + single-pass planner + reflective repair**. Do **NOT** ship AFlow-MCTS or an ADAS archive in v1 — they
need an executable benchmark and many rollouts COMPOSE doesn't have. **Upgrade path (v2):** if a quality bar
demands it, add an **archive of past good specs** (ADAS) to condition the planner, and/or MCTS over
spec variants scored by an executable acceptance test (AFlow) — reusing the *same* compile gate as the reward.

**Top-3 failure modes + guardrails:**
1. **Hallucinated dependencies** (LLMCompiler's named failure; deadlock from an invisible back-edge) →
   **mitigated structurally by data-flow edge inference** (prior brief): the planner never draws edges, so it
   can't draw a wrong one; `tryCompile` catches cycles/missing producers.
2. **Over-decomposition** (DGI Phase III coordination tax; Reddit "one weird response breaks the chain") →
   **guardrail:** leaf = ≤1–3 tool calls; prefer fewer fatter nodes; cap total node count and warn the human
   if exceeded.
3. **Schema non-conformance / false success** ("JSON mode is not a contract"; "agent says it's done when it
   isn't") → **guardrail:** constrained decoding on a frontier planner + **mandatory `tryCompile` gate** +
   refusal/oscillation detection so the loop fails safely to a human, never silently ships an invalid spec.

---

## 7. Uncertainty / caveats
- **clawRxiv preprints** (optimal-stopping ~2.4–3.1 iters; DGI phase diagram) are directional, not
  peer-reviewed — but each is corroborated by an established result (Self-Refine diminishing returns; the
  ≤1–3-tool-call leaf heuristic; the 3–5-trial Reflexion convention).
- The **3-iteration cap** is a strong central estimate from 4+ independent sources; treat 3 as default, 5 as
  hard ceiling, and instrument the loop — "if a prompt consistently needs 2+ retries, the schema or the
  decomposition is wrong, not the retry count" (prior brief §5).
- **MCP-Zero / agent-discover / AgentOS** confirm the *active-search-primitive* discovery pattern, but
  registry internals are **out of scope** (another agent owns the tool-registry/sandbox).
- **Reddit** cites unreleased models and self-promotional launches; the **sentiment/pattern** (single-shot
  unreliable, validate-before-trust, human checkpoint, planner/executor split) is load-bearing and matches
  the web leg; specific product/model claims are secondhand.
