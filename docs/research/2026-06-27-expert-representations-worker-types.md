# Expert Representations — why divide AI work into "worker types"

> 2026-06-27 · research grounding (Exa sweep) for the **Expert Representations** track.
> Question: what is the actual benefit of *strictly* telling a user what each AI worker
> is — its type (designer / executor / coder …) — and how should piflow represent a node?

## TL;DR

There are **two independent benefit families**, and a **trap** sitting between them.

1. **Human-side (legibility):** an explicit worker-type makes *who-does-what* legible, which
   is what produces trust, situational awareness, governance, and a buy/budget story. This is
   why the whole market repackaged "AI agent" as "**AI employee / AI worker**" — same tech,
   different packaging that maps to a headcount line instead of an IT procurement line.
2. **Machine-side (specialization):** role-separated, **heterogeneous** agent teams sit on the
   cost–accuracy Pareto frontier — *each role paired with the model that is best at that role*.
   This is direct academic validation of piflow's one-real-pi-per-node + per-node-model thesis.
3. **The trap:** the gain is **not in the label**. Naming a worker after a *job title*
   over-promises (the human role includes messy edge cases the agent can't do → trust crisis),
   and prompt-only "you are the Verifier" role play barely beats a single agent. The win comes
   from **real heterogeneity (model / tools / sandbox per type) + a feedback loop**, not a costume.

**Implication for piflow:** represent a node by its **work shape (an operating contract)**, keep
the taxonomy **small and behavior-defined**, and make the type *mean* the per-node heterogeneity
that piflow uniquely has. The user's own intuition — mostly **executors**, plus **designers** —
is the research-supported shape, distinguished by *what grounds their feedback loop*.

---

## 1. The market converged on "worker type" packaging

By mid-2026 the dominant framing is the **named, role-shaped worker** sold against a headcount
budget. "An AI employee is an AI agent packaged as a role-shaped teammate — a name, a job
description, a manager, KPIs, scoped tool access, and a salary-like monthly fee. The tech
underneath is the same; the packaging is what differs." (AI Agent Rank, *What is an AI employee*)

| Vendor / agent | Type framing | Note |
| --- | --- | --- |
| 11x **Alice**, Artisan **Ava** | the canonical **AI SDR** | 20+ copycats by mid-2026 |
| Cognition **Devin** | the canonical **AI software engineer** | takes a ticket → opens a PR |
| Sierra / Decagon | **AI support agent** | outcome-priced |
| Sista AI | **14 ready-to-hire roles + 2 teams** | each ships persona + skills + tools, "review like a résumé" |
| Agently | 6 named agents (Apex/Nova/Echo/Pulse/Lens/Nexus) | one per business function, role-specific tools |
| EverWorker / Sandbots / Arahi | **catalog of specialized "AI workers"** (60+) | "onboarded, not logged into" |

Two structural moves repeat everywhere: (a) the type ships **pre-wired** (persona + skills +
tools assigned *by role*), and (b) once you have 5+ types you have a "**workforce**" that needs
workforce-level controls (governance, audit, cost ceilings, identity). The packaging is a
**buy-side** decision as much as a UX one — it maps to a budget category that already exists.

## 2. Two benefit families

### A. Human-side — legibility, trust, governance

- **Role clarity drives team performance & trust.** In human–multi-agent teams, "role clarity
  is where each agent knows its job *and the human knows the role of the agents too*. Role
  ambiguity leads to duplicated effort or tasks falling through the cracks." A visible
  who-does-what + an inspectable delegation chain (Human → A → B) is what lets a human keep
  situational awareness and take over when a worker stalls. (Karan Chandra Dey, *Agentic
  Collaboration in Multi-Agent Human–AI Teams*)
- **A bounded role is a governance object, not decoration.** "Defining an agent's role is a
  governance choice — it determines who owns outcomes, who reviews failures, who is
  accountable." Clear roles **localize failure** ("was it the classifier or the router?") and
  make a worker **replaceable** when the model/vendor changes. (Inbar Rose, *Why Agents Need
  Authority, Not Vibes*)
- **The type should compile to an operating contract.** "An agent persona is a product
  specification for a non-human participant — what it reads, decides, routes, acts on,
  escalates, proves, and can no longer do when access is revoked. Name the verbs (read,
  retrieve, classify, route, draft, update, execute, escalate) and then name what it explicitly
  does *not* do." This is exactly piflow's node contract. (estebanf.com, *Operating contracts
  for AI agent personas*)

### B. Machine-side — specialization & heterogeneity

- **Role specialization improves multi-agent code quality.** MetaGPT (PM/architect/engineer/
  tester), ChatDev (CEO/CTO/programmer/reviewer/tester), AgentCoder (programmer + test-designer
  + test-executor) all show role-decomposed teams beating single agents; Self-Collaboration's
  analyst+coder+tester beats its own single-agent baseline by **~30–47% pass@1**. The two
  recurring ingredients in *top* frameworks: **clear role specialization + a strong feedback
  loop**. (*Code in Harmony*; *How Generation Architecture Shapes Code Complexity*)
- **Heterogeneous role assignment is the real Pareto win — this is piflow's thesis, on paper.**
  "Across five benchmarks the Pareto frontier is occupied by **heterogeneous** role assignments,
  not homogeneous self-play teams, with pairwise synergy up to **+44%** when each model fills its
  better role. The **per-role best model differs from the per-task best model in 4 of 5
  benchmarks**, so role-aware pairing reaches cost-accuracy points no single-model team reaches."
  The executor reads ~200× more tokens than the planner emits, so routing *execution* to a
  cheap-but-role-competent model cuts cost. (*Specialize Roles, Mix Deployments*, arXiv 2606.20629)
  → This is the academic statement of piflow's "one real pi per node → per-node model / tools /
  sandbox" bet (see memory: `competitive-gaps-pdw`, `per-node-routing-fusion`).
- **Context hygiene is a reason to split, too.** CodeDelegator separates a persistent planner
  from ephemeral coders precisely so debugging traces don't pollute the planner's context — role
  separation as a *context-isolation* mechanism, not just a labor-division one. (arXiv 2601.14914)

## 3. The trap — the label is not the win

- **Don't name a worker after a job title.** "When you name your agent after a job title you're
  making an implicit promise that it can do everything that person does, including everything
  that never appears in the job description." Devin/Cursor succeeded by scoping the promise to a
  **task** ("generate code") not a **role** ("software engineer") — engineers felt faster at the
  part they liked least, not replaced, and trust compounded. Humans are *deep & vertical*; agents
  are *shallow & wide* (good at the learnable slice of many adjacent roles). (Frontier AI, *AI
  agents shouldn't have a job title*)
- **Prompt-only role play barely helps.** TeamBench enforced Planner/Executor/Verifier with OS
  permissions and found teams "rarely outperform single agents on average," Verifiers falsely
  accept many failing submissions, and **prompt-only role assignment is statistically
  indistinguishable from enforced** — it just produces 3.6× more wasted Verifier edits. Anthropic's
  own multi-agent retrospective: subagents spend more tokens coordinating than working. (arXiv
  2605.07073)
- **More conversational roles ≠ more care.** Adding analyst/critic *conversational* roles inflated
  code without a correctness gain; the role that paid off was the **execution-grounded debugger**
  (run the code, feed back the failure). "Architectural elaboration should be justified by a
  measured benefit, not assumed." (arXiv 2606.00308; AlphaCodium: GPT-4 pass@5 19%→44% from
  flow, not from more personas)
- **MAS is task-contingent.** Multi-agent wins where the task genuinely decomposes (Finance Agent
  D=0.41 → +80.9%) and degrades on tight sequential tasks; "coordination benefits arise from
  matching topology to task structure, not from more agents." (*Towards a Science of Scaling
  Agent Systems*; *When Do Multi-Agent LLM Systems Outperform*)

**Synthesis of the trap:** the type label earns its keep on the *human* side (legibility,
governance, buy story) but **the performance only shows up when the type carries real difference**
— a different model, a different toolset, a different sandbox, a different feedback ground. A type
that's only a system-prompt costume buys you the legibility and none of the lift.

## 4. Implications for piflow "Expert Representations"

1. **Keep the taxonomy small and behavior-defined, not an org chart.** The user's instinct —
   *most nodes are executors, plus designers* — is the supported shape. Resist a 14-role
   marketplace; resist job-title names that over-promise. Name the **work shape**.

2. **The cleanest axis is *what grounds the feedback loop*** — this falls straight out of the
   evidence (execution-grounded debugger beats conversational critics):
   - **Executor / Coder** — feedback grounded in **execution**: writes/edits files, runs code &
     tests, repairs on failure. Cheap-but-competent model is fine (it reads the most tokens).
   - **Designer** — feedback grounded in **judgment**: produces an artifact (markdown / a prompt /
     a generated image), then an **LLM-judge (Claude) looks at it and decides retry** — a
     generate→judge→retry loop. This is the user's exact "visual designer" description, and it's a
     genuinely *different* node archetype (judge-in-the-loop ≠ run-the-code-in-the-loop), not a
     relabeled coder. It maps onto piflow's existing **fusion / judge node** (memory:
     `swarm-consensus-deferred` — "the real win is already the static fusion/judge node").

3. **Make the type *be* the heterogeneity, because piflow can.** piflow's differentiator is one
   real pi per node → per-node model / tools / sandbox. So a worker type should *select* those:
   `executor` → execution sandbox + run/test tools + cheap coding model; `designer` → image/render
   tool + an LLM-judge gate + a stronger judging model. The "Specialize Roles, Mix Deployments"
   result says this per-role pairing is exactly where the cost-accuracy frontier lives — so the
   representation isn't cosmetic, it's the thing that produces the lift.

4. **Represent it as an operating contract, surfaced for human SA.** Per node, show the verbs
   (reads / produces / decides / escalates), the model/tools/sandbox it carries, and an
   inspectable delegation chain — so the human always has a who-does-what snapshot and can take
   over a stalled node. This is the observe/HUD layer's job (memory: `observe-single-data-path`,
   `gui-nodehud-redesign`), now with a **type badge** that means the contract above.

5. **Scope promises to the task, not the title.** Label/describe a node as *"writes & runs the
   code"* / *"drafts the spec, Claude judges, retries"* — not *"Senior Engineer."* Same reason
   Cursor beat Devin's framing: under-claim the role, over-deliver the task, let trust compound.

## Sources

- AI Agent Rank — *What is an AI employee (2026)* · *15 best AI agents 2026*
- Sista AI marketplace · Agently *Meet Your Workforce* · EverWorker · Sandbots · Arahi (landscape)
- Frontier AI (Sreekanti) — **AI agents shouldn't have a job title** (the trust-crisis argument)
- estebanf.com — *Design operating contracts for AI agent personas*
- Inbar Rose — *Why Agents Need Authority, Not Vibes* (bounded roles = governance)
- Karan Chandra Dey — *Agentic Collaboration in Multi-Agent Human–AI Teams* (role clarity / SA)
- **Specialize Roles, Mix Deployments** — arXiv 2606.20629 (heterogeneous role assignment = Pareto frontier, +44%)
- *Code in Harmony* · *How Generation Architecture Shapes Code Complexity* (HumanEval) — role + feedback loop
- **TeamBench** — arXiv 2605.07073 (enforced vs prompt-only roles; label ≠ win)
- CodeDelegator — arXiv 2601.14914 (role separation as context isolation)
- *Towards a Science of Scaling Agent Systems* · *When Do Multi-Agent LLM Systems Outperform* (task-contingent)
- *Simple Role Assignment is Extraordinarily Effective for Safety Alignment* (roles encode schemas)
