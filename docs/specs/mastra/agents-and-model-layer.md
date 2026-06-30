# Mastra teardown — Agents & model layer

> Per-aspect source brief for [`../competitive-analysis-vs-mastra.md`](../competitive-analysis-vs-mastra.md)
> (§1c, §2, §4). Evidence cited `file:line` relative to `vendor/mastra/`. Produced 2026-06-29 from a
> focused read of `packages/core/src/agent/`, `/llm/`, `/loop/` at HEAD `12af22b`. Honest by construction.

## Agent definition — how an Agent is constructed

An `Agent` is a single TypeScript class instance (`export class Agent ... extends MastraBase implements
SubAgent`, `agent/agent.ts:389-398`). Constructor takes one `AgentConfig` object (`agent.ts:487`). Fields
and their static-vs-dynamic status:

- **name / id**: static strings (`agent.ts:492-493`).
- **instructions**: `#instructions: DynamicArgument<AgentInstructions>` (`agent.ts:402`; config type `agent/types.ts:544`); resolved per call via `getInstructions()`, invoked with `{ requestContext, mastra }` (`agent.ts:2181-2208`). **Can be DYNAMIC.**
- **model**: `DynamicArgument<MastraModelConfig | ModelWithRetries[]>` (`agent.ts:405`; config `types.ts:627`); normalized to a fallback array at `agent.ts:516-535`. **Required** — throws `AGENT_CONSTRUCTOR_MODEL_REQUIRED` if absent (`agent.ts:502-514`). **Can be DYNAMIC** (`({requestContext}) => MastraModelConfig`, `types.ts:590-627`).
- **tools**: `#tools: DynamicArgument<TTools>` (`agent.ts:429`, `:551`; config `types.ts:636`). **DYNAMIC.**
- **memory**: `#memory?: DynamicArgument<MastraMemory>` (`agent.ts:421`, `:566`), resolved via `getMemory()` (`agent.ts:1815`). **DYNAMIC.**
- **workflows**: `#workflows?: DynamicArgument<Record<string, AnyWorkflow>>` (`agent.ts:424`, `:539`). **DYNAMIC.**
- **scorers**: `#scorers: DynamicArgument<MastraScorers>` (`agent.ts:431`, `:562`; config `types.ts:700`). **DYNAMIC** (evals hook).
- **agents** (sub-agents): `#agents: DynamicArgument<Record<string, SubAgent>>` (`agent.ts:432`, `:564`). **DYNAMIC.**
- **defaultGenerateOptions / defaultStreamOptions / defaultOptions / defaultNetworkOptions**: all `DynamicArgument` (`agent.ts:425-428`, `:543-546`).
- Also dynamic/optional: voice, inputProcessors, outputProcessors, errorProcessors, skills, backgroundTasks, goal, browser, workspace, channels (`agent.ts:433-448`, `:570-667`).

So nearly every capability slot is either a static value **or** a `({requestContext, mastra}) => value`
function evaluated per invocation.

## Tools wiring

Tools attach via the `tools` map (`agent.ts:551`). Tool shape comes from `createTool` (`tools/tool.ts`):
`id`, `description`, `inputSchema?`, `outputSchema?`, `execute?(inputData, context)` (`tool.ts:97-120`,
`:280-305`). Per-call resolution is `listTools()` (`agent.ts:2533-2562`); the full execution-time merge is
`convertTools()` (`agent.ts:5635`), which unions **many** tool sources into one `Record<string, CoreTool>`
(`agent.ts:5805+`): assigned tools, memory tools, per-call `toolsets`/`clientTools`, agent-as-tools,
workflow-as-tools, workspace, skills, channel, browser, and input-processor-loaded tools.

**Heterogeneity is explicit and per-agent**: each `Agent` instance carries its own `#tools` and its own
`#model`, both independently static-or-dynamic. The config JSDoc mixes providers across one agent's
fallback list — `model: [{ model: 'openai/gpt-4' }, { model: 'anthropic/claude-3-opus' }]`
(`types.ts:564-566`). Per-execution overrides also exist: `stream()` accepts a `model?` override
(`agent.ts:7602`, `:7648`) and `activeTools`/`toolsets`/`clientTools`/`toolChoice` per call
(`agent.types.ts:507-533`).

## The agentic loop

`agent.stream()` (`agent.ts:7598`) merges defaults (`:7611-7617`), resolves the LLM via `getLLM({model})`
(`:7646`), validates the model spec version (`:7653-7672`), then calls `#execute()` (`:7711`). `#execute()`
(`agent.ts:6318`) builds an internal **"execution-workflow"** and runs it on Mastra's own workflow engine —
either the evented engine (`MASTRA_EVENTED_EXECUTION==='true'`) or the default direct path
(`agent.ts:6669-6696`). The actual model→tool→continue loop is `loop()` (`loop/loop.ts:11`) →
`workflowLoopStream` → `agentic-loop/index.ts`, which is a `.dowhile(agenticExecutionWorkflow, …)`
(`agentic-loop/index.ts:87`). Each iteration accumulates a `StepResult` (`index.ts:127-157`); continuation
is gated by `maxSteps` (`index.ts:180,235,245`) and user `stopWhen` conditions evaluated on accumulated
steps (`index.ts:160-168`). The execution sub-steps live in `loop/workflows/agentic-execution/`
(`llm-execution-step.ts`, `tool-call-step.ts`, `tool-call-concurrency.ts`, `is-task-complete-step.ts`,
`goal-step.ts`, `background-task-check-step.ts`). Streaming is first-class (`MastraModelOutput` in
`loop.ts:144`); structured output is threaded as `structuredOutput` (`loop.ts:159`) and converted to a
standard schema at the API boundary (`agent.ts:7696-7702`).

## Model layer

Models are **Vercel AI SDK** models. `MastraModelConfig` is a union of AI SDK `LanguageModelV1–V4`, an
`OpenAICompatibleConfig` object, a `MastraLanguageModel`, **or a provider string** `ModelRouterModelId`
(`llm/model/shared.types.ts:86-93`). Provider strings like `"openai/gpt-5"` (`agent.ts:480`) are
parsed/routed by `ModelRouterLanguageModel` / `parseModelString` (`llm/index.ts:79,85`; `router.ts`),
which builds `@ai-sdk/openai` etc. clients (`router.ts:2-11`). Per-call resolution is `getModel()` →
`resolveModelSelection` → `resolveModelConfig` (`agent.ts:2814-2841`); fallback arrays support
load-balancing/retry with the first `enabled` entry chosen (`agent.ts:2826-2839`). Gateways (Netlify,
Azure, Mastra, models.dev) are supported (`llm/index.ts:168-181`). Per-agent model and per-call `model?`
override (`agent.ts:7648`) are both supported; model selection itself can be a `({requestContext}) => …`
function (`types.ts:590-627`).

## Multi-agent / networks / subagents

Three mechanisms, all in-process:
1. **agents-as-tools**: `listAgentTools()` wraps each entry of `#agents` as a `createTool({ id:
   'agent-<name>', … execute })` calling the sub-agent (`agent.ts:4395-4490`). `DelegationConfig` hooks
   (`onDelegationStart`/`onDelegationComplete`/`messageFilter`) intercept these calls
   (`agent.types.ts:273-313`). The `SubAgent` interface (`subagent.ts:43-99`) is the contract; `Agent
   implements SubAgent` (`agent.ts:397`).
2. **workflows-as-tools**: `listWorkflowTools()` wraps `#workflows` similarly (`agent.ts:5301-5371`).
3. **`agent.network()`**: the agent acts as a **routing agent** delegating to primitives over
   `maxIterations`, run by `networkLoop` (`loop/network/index.ts`) with completion scorers and routing
   config (`agent.ts:6954-7006`; options `agent.types.ts:343-443`). `loop/network/run-command-tool.ts` is
   the only place that shells out (`exec` from `node:child_process`, `:14`).

## Edges & limits (vs a per-node separate-process fleet)

**Capabilities:** (1) **True per-agent heterogeneity** — each agent carries its own model+toolset, both
static or `requestContext`-dynamic (`agent.ts:402,405,429`; `types.ts:564-627`). (2) **Per-call overrides**
of model, activeTools, toolsets, clientTools, toolChoice (`agent.types.ts:507-533`, `agent.ts:7648`). (3)
**Rich loop control** — `maxSteps`, user `stopWhen`, `prepareStep`, `onIterationComplete`,
`isTaskComplete` scorers, tool-call concurrency, approval gates (`agent.types.ts:486-588`;
`agentic-loop/index.ts:160-245`). (4) **Composable multi-agent** via agents/workflows-as-tools +
`network()` routing with delegation hooks. (5) **Input/output/error processors as guardrails**, streaming,
structured output, background-tasks/untilIdle continuations (`agent.types.ts:513-682`).

**Limits for the comparison:** (1) **Agents are in-process objects sharing one Node process** — no
`child_process`/`worker_threads`/`Worker` spawning anywhere in `agent/` or `loop/` (verified by grep; the
lone `exec` is a network run-command *tool*, not the agent boundary). `__fork()` (`agent.ts:3090`) clones
the JS object, not a process. (2) **No per-agent OS sandbox / filesystem jail / per-agent resource
limits** — heterogeneity is over model+tools+prompt, not OS isolation; a sub-agent runs in the
supervisor's process and memory space. (3) **"Tools" are JS `execute` closures**, so an agent's
"capability" is a function call, not an independently-tooled headless OS process. (4) **Sub-agent
coordination is shared-memory message passing** (`messageFilter`, `DelegationContext.messages`,
`subagent.ts`), not IPC across isolated runtimes. (5) **One crash/blocking call in a tool or sub-agent can
stall the shared event loop**; there is no per-node process boundary to contain a runaway agent. This is
the precise axis where piflow's one-real-pi-per-node model differs: Mastra gets cheap, fast, heterogeneous
in-process agents; it does not get per-agent OS-level isolation, sandboxing, or independent process
lifecycles.

*(uncertain: `durable/` and `goal/` internals beyond `goal-step.ts` references were not deep-read — out of
agent-layer scope.)*
