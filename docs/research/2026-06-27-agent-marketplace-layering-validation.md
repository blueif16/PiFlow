# Agent-marketplace layering — external validation (2025–2026)

> 2026-06-27 · research (Exa sweep, sub-agent) validating the **worker-type** design in
> `docs/design/expert-representations-worker-types.md` against the most-adopted platforms.
> Mandate was to *challenge* our loadout/posture model, not just confirm it.

## Dominant pattern

The 2025–2026 industry standard is a **two-layer architecture that separates tool connectivity
from procedural knowledge, and transacts them as distinct sub-agent units.** The marketplace unit
is *not* the full agent persona — it's the atom below it: a **skill** (procedural knowledge), an
**MCP server** (tool connectivity), or Salesforce's **topic+action** (the same idea in their
vocabulary). Full agent templates exist but are treated as *convenience bundles*, not the
compositional primitive. Composition is additive (combine capability components + choose execution
config separately). Naming converges on **task / job-to-be-done**, not human job titles (CrewAI is
the lone holdout). Verification is trending to a **tiered stack** — deterministic/execution tests →
LLM-as-judge → human spot-check — which maps almost directly onto our executor / designer / producer.

## Per-platform

| Platform | Market unit | Capability ⟂ posture? | Skill→tool coupling | Naming | Source |
|---|---|---|---|---|---|
| **Anthropic Agent Skills** | Skill (SKILL.md) + MCP server | **YES** — skills (knowledge) / MCP (connectivity) / model+sandbox (runtime) are 3 layers | **YES** — `allowed-tools` in SKILL.md frontmatter | task ("pdf-processing", "competitive-analysis") | anthropic.com/news/skills |
| **OpenAI Apps / GPT Store** | App (MCP) + GPT (persona) | PARTIAL — Apps split connectivity, but model+prompt fused | NO | task-flavored (legacy GPTs role-named) | openai.com/index/introducing-apps-in-chatgpt |
| **CrewAI** | Agent (role+goal+backstory+tools) | **NO** — all fused in one Agent | partial (agent-led) | **role/job-title** ("Senior Data Researcher") | docs.crewai.com/en/concepts/agents |
| **Salesforce Agentforce / AgentExchange** | Action · Topic · Prompt-Template · Agent-Template | YES — topics (capability) vs reasoning+guardrails (posture) | partial (topic-led) | job-to-be-done ("Order Management") | salesforce.com/news/.../agentexchange |
| **Microsoft Copilot / Agent Store** | Agent (whole persona) | PARTIAL — builder separates knowledge/instructions/actions; store sells the fused agent | NO | task/domain ("IT Support Agent") | learn.microsoft.com/.../copilot-agent-store |
| **LangChain / LangGraph** | Tool + template; Assistant = graph + config | **YES** — Assistants separate graph logic from config (model+tools+prompt); middleware = posture | YES (config-led `selected_tools`) | task-oriented templates | github.com/jameskanyiri/langgraph_assistants |
| **MCP registries (Smithery / PulseMCP / official)** | **MCP server** (named tool bundle) | N/A (discovery only) | N/A | task/domain nouns | modelcontextprotocol.org/registry/about |
| **Relevance AI** | Agent (clone; prompt+tools) | PARTIAL — tools are shared canvas nodes; prompt per-agent | NO | task-purpose ("research-agent") | relevanceai.com/docs/build/agents/create-an-agent |

## Verdict on our design

- **Loadout ⟂ posture split — STRONGLY SUPPORTED.** Anthropic (skills+MCP vs runtime), Salesforce
  (topics vs reasoning+trust), LangGraph (graph vs config) all adopt it. Only CrewAI fuses, by
  choice (simplicity over composability). *Adjustment:* the posture's capability-gating needs
  **two levels** — *availability* (what the model sees) vs *permission* (what runs without
  approval) — finer than a single `sandbox` field (cf. Anthropic `allowedTools`/`disallowedTools`,
  wildcard `mcp__server__*`).
- **Skill-led composition — SUPPORTED.** The single most important data point: Anthropic's SKILL.md
  YAML carries **`allowed-tools`** (e.g. `Bash(python:*) Bash(npm:*) WebFetch`) — skills DO declare
  their tool surface, and picking a skill implicitly determines the MCP servers it coordinates.
  This is a *published open standard*, so building skill-led is ahead of most platforms but on the
  named trajectory. *Adjustment:* put `allowed-tools` **on the skill object itself** (portable,
  self-documenting), not only on the worker/loadout.
- **Three postures (executor/designer/producer) — SUPPORTED.** Maps to the 3-tier verification
  stack. *Gap:* **no platform ships "designer" (LLM-judge + retry) as a named posture** — it's
  hand-assembled. So our designer is architecturally novel and must be **fully specified**: judge
  model (a posture-level field, separate from the generation model), rubric/criteria source, retry
  budget, pass/fail threshold, escalation. Salesforce adds a useful axis we lacked: an **approval
  mode** (auto-run / approval-required / agent-decides) layered on top of capability.
- **Task-not-job naming — SUPPORTED.** Majority convention; CrewAI the deliberate exception (role
  framing as a *prompt-engineering* lever for LLM reasoning, not a marketplace name). No change to
  our rule; keep role/backstory as an internal prompt concern, never the worker's external name.

## Implications folded into the design

1. `allowed-tools` is the skill→tool manifest field (open decision #4 resolved — adopt the
   published convention; resolve it through our catalog).
2. Posture gains a **two-level capability gate** (availability vs permission) + an **autonomy/approval
   axis** — both of which piflow already has primitives for (`checkpoint`/G5, `rerouteGate`/G12).
3. The **designer posture needs a first-class spec** (judge-model field + rubric + retry budget +
   threshold) because we're inventing a named abstraction the market only assembles ad hoc.

## Sources

Anthropic Skills launch + engineering (anthropic.com/news/skills · claude.com/blog/building-agents-with-skills
· claude.com/blog/extending-claude-capabilities-with-skills-mcp-servers · resources.anthropic.com/.../The-Complete-Guide-to-Building-Skill-for-Claude.pdf
· code.claude.com/docs/en/agent-sdk/custom-tools · anthropic.com/engineering/demystifying-evals-for-ai-agents) ·
OpenAI (openai.com/index/introducing-apps-in-chatgpt · introducing-the-gpt-store · developers.openai.com/apps-sdk/plan/tools) ·
CrewAI (docs.crewai.com/en/concepts/agents · /guides/agents/crafting-effective-agents) ·
Salesforce (salesforce.com/news/.../agentexchange-announcement · developer.salesforce.com/docs/ai/agentforce/guide/agent-script.html) ·
Microsoft (learn.microsoft.com/.../copilot-agent-store · devblogs.microsoft.com/.../introducing-the-agent-store) ·
LangChain (docs.langchain.com/oss/javascript/langchain/agents · langchain.com/blog/introducing-agent-builder-template-library · github.com/jameskanyiri/langgraph_assistants) ·
MCP registries (modelcontextprotocol.org/registry/about · smithery.ai/docs/concepts/registry_search_servers) ·
Relevance AI (relevanceai.com/docs/build/agents/create-an-agent · /workforces/.../add-tools) · AEMA eval (arxiv.org/pdf/2601.11903)
