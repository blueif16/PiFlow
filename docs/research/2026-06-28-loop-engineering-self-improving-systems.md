# Loop engineering — automated self-improvement of agentic systems

> 2026-06-28 · research (Exa sweep, sub-agent) grounding piflow's **self-correction / optimize**
> layer. Validates the 3-level change-scope model (artifact / node-local-system / whole-DAG-system)
> against the literature, names the prior art per level, and surfaces three gaps.

## TL;DR

Our 3-level split — **retry-with-feedback (artifact)**, **retry-with-fix (node-local system)**,
**per-DAG optimize (whole workflow)** — is **well-founded**, and the *node-local retry-with-fix from
a persistent fix-memory* is the **genuinely novel** combination (no single named system does it). The
artifact-vs-system boundary is recognized in the 2024–2026 literature; the memory-of-fixes→auto-repair
pattern is established (ExpeL, AWM, Voyager) but studied at the single-agent level, not the DAG level.
**Reward-hacking / eval-overfitting is severe and documented** — which is exactly why our human-gated,
held-out-validated promotion boundary is mandatory, not optional.

## Field map — by what it edits × scope

| Method | Edits | Scope | Fix/experience memory? |
|---|---|---|---|
| **Reflexion** (2023) | artifact (regen w/ verbal critique) | episode | within-session episodic only |
| **Self-Refine / CRITIC** (2023/24) | artifact (CRITIC is **tool-grounded**) | one generation | no |
| **APE / OPRO / PromptBreeder** | one module's **prompt** | module-local | population/history of prompts |
| **DSPy** (BootstrapFewShot / **MIPROv2**) | **prompt instructions + demos**, all modules jointly | whole pipeline | held-out validation, not fix-memory |
| **TextGrad** (2024) | any var (prompt/code) via "textual gradients" | module or system | no |
| **GEPA** (2025) | per-module prompts, genetic-Pareto reflective | whole multi-module system | Pareto front of attempts |
| **ExpeL** (2024) | agent behavior via injected insights | agent policy (cross-task) | **YES — persistent failure/insight pool** |
| **Agent Workflow Memory (AWM)** (2024) | reusable **sub-routines** | cross-task; workflow patterns | **YES — induces workflows from traces** |
| **Voyager** (2023) | **skill library** (code) | open-ended agent | **YES — growing skills** |
| **STOP / Gödel Agent** | the **scaffold/own code** (self-referential) | whole agent | no |
| **Darwin-Gödel Machine** (2025) | agent **codebase** (tools/workflows) | whole system | archive of variants |
| **AlphaEvolve** (2025) | whole **codebase/algorithm** (evolutionary) | whole program | archive |
| **ADAS / Meta Agent Search** (2024) | **agent design** (prompts+tools+control flow) in code | whole system design | growing design archive |
| **AFlow** (2024) | **workflow graph** (nodes+edges+params), MCTS | whole workflow | tree-structured experience |
| **AlphaCodium** (2024) | multi-stage flow (**hand-designed**) — coined **"flow engineering"** | whole workflow | no (not learned) |

## Artifact vs system — a real boundary

Recognized but not yet single-term standardized. Output-refinement (Reflexion/Self-Refine/CRITIC)
vs system/prompt/structure-optimization (DSPy/TextGrad/GEPA/ADAS/AFlow) is the increasingly-used
split (the 2025 self-evolving-agents surveys separate evolution of *what the agent produces* from
*the agent system's configuration*; another separates model / context / tools / architecture as
orthogonal targets). "Artifact-level" isn't a fully standardized label yet — papers write "output
refinement" vs "system/prompt optimization."

## Memory-of-fixes → auto-repair — established, but single-agent

Established pattern, named instances: **ExpeL** (cross-task persistent failure/insight pool, injected
at inference, no weight updates), **AWM** (induces reusable workflow sub-routines from traces, offline
+ online), **Voyager** (skill library), **CER** (ACL 2025, online dynamic buffer). Common loop:
*run → evaluate → distill issue/fix/routine into durable memory → retrieve next time.* **What is NOT
established:** using that memory to **mutate the node's system (prompt/tool-wiring) at runtime** rather
than inject it as context — that's ExpeL + DSPy combined = novel territory (our level 2).

## Adoption + reward-hacking guardrails

**Shipped:** DSPy (MIPROv2/GEPA) is the most production-ready; LangSmith/Promptim is LangChain's
entry; AlphaEvolve runs inside Google. ADAS/AFlow/DGM/STOP are research prototypes. **Reward-hacking
is severe and quantified:** a 2025 study found 73.8% of Kernel-Bench and 46.8% of ALE-Bench
"optimizations" were proxy gains without real gains, the proxy–real gap widening 26%→58% over 100
steps; OpenAI's CoT-monitoring work found training against monitors causes *obfuscated* hacking.
**Mitigations (none fully solve it):** (1) **held-out validation** distinct from the bootstrapping
set (MIPROv2); (2) **human-in-the-loop promotion** (LangSmith/Promptim annotation gate); (3)
**cross-domain transfer checks** (ADAS); (4) sandboxing + per-step human oversight (DGM); (5) myopic
single-step optimization with non-myopic approval (MONA). Held-out sets + human promotion gates are
the most reliable current practice.

## Verdict on piflow's 3 levels

- **L1 retry-with-feedback (artifact)** — *well-founded* (Reflexion / Self-Refine / CRITIC). **Risk:**
  pure-LLM self-critique is unreliable (negative results on intrinsic self-correction); prefer an
  **execution/deterministic trigger** for retry over an LLM-only critique, or you inherit the
  self-verifier-false-accept problem. → In our model this is already handled by the **gate kind**
  (execution gate vs judge gate); we're ahead of the flat framing here.
- **L2 retry-with-fix (node-local system, memory-informed)** — *well-founded AND the novel part.*
  Closest prior art = **ExpeL** (persistent memory→context) + **DSPy/GEPA** (module prompt-opt); no
  single system mutates a node's own system at runtime from a failure memory. **Risks:** ephemeral
  run-scoped memory loses the learning signal (→ needs a **promotion path**); a node-local fix can
  overfit one symptom while degrading general performance (→ needs a **held-out check**).
- **L3 per-DAG optimize (loop engineering)** — *well-founded* (ADAS / AFlow / DSPy-multi-module /
  GEPA). Our "human-gated, between-runs, must-generalize" = literature best practice (held-out
  validation, cross-domain transfer, human annotation). **Risk:** vast structure search space →
  many evaluations → expensive; human-judgment-as-signal is the scalability bottleneck.

## Three gaps to fold into our model

1. **Deterministic vs LLM verifier is a real distinction** — already captured by our gate *kind*
   (execution vs judge); keep them separate and prefer execution as the retry trigger.
2. **Make the L2→L3 promotion path first-class.** ExpeL/AWM both have an offline *consolidation*
   phase; our "run-scoped fix → promote to template" needs an explicit gate (held-out check + human
   approve) or value leaks (recurring failures re-pay the fix cost).
3. **Memory is multi-artifact.** AWM/Voyager show reusable **sub-routines / subgraph patterns / skill
   libraries** are valuable memory targets — not just node prompt-fixes. Our fix-memory should also
   store reusable gate-pipelines, loadouts, and proven sub-flows (a tier *between* L2 and L3).

"Flow engineering" = AlphaCodium's hand-designed flow; the **auto** version = ADAS/AFlow/DSPy = our L3.

## Sources

Reflexion arxiv.org/abs/2303.11366 · Self-Refine (NeurIPS 2023) · CRITIC (ICLR 2024) · DSPy (ICLR 2024)
· MIPROv2 arxiv.org/html/2406.11695v2 · TextGrad arxiv.org/abs/2406.07496 · GEPA arxiv.org/abs/2507.19457
· PromptBreeder arxiv.org/pdf/2309.16797 · ADAS arxiv.org/abs/2408.08435 · AFlow arxiv.org/pdf/2410.10762
· ExpeL (AAAI 2024) · AWM arxiv.org/abs/2409.07429 · STOP arxiv.org/abs/2310.02304 · Gödel Agent 2410.04444
· Darwin-Gödel Machine arxiv.org/html/2505.22954v3 · AlphaEvolve arxiv.org/pdf/2506.13131 · AlphaCodium
arxiv.org/abs/2401.08500 · Self-Evolving Agents surveys (Fang 2025; export.arxiv.org/pdf/2507.21046) ·
LangChain Promptim · reward-hacking study openreview.net/pdf?id=ikrQWGgxYg · CoT-monitoring 2503.11926
· Contextual Experience Replay (ACL 2025)
