# pi agent — capabilities, advantages & how we use it (knowledge record)

The durable record of what we've learned about **pi** ([pi.dev](https://pi.dev) /
[`earendil-works/pi`](https://github.com/earendil-works/pi)) as a headless executor driven from
Claude Code — so future iterations have the context, not just the mechanics. Facts below are
**verified** against the working `pi-runner` + the installed CLI; design directions are marked
**`PROPOSAL`** (not yet built).

> Moved out of the front-page README on 2026-06-21 to keep the README a product page; this is the
> reference record. In substrate terms (`design/orchestration-substrate.md`), `pi` is the **producer
> node** primitive.

## What pi is, in our stack
- A **headless coding-agent CLI** (read / bash / edit / write tools) that works against the files
  in its cwd. We invoke it non-interactively, **one process per unit of work**.
- We run it on **non-Claude, OpenAI-compatible "coding-plan" models** (DashScope qwen, GLM, Kimi,
  DeepSeek, OpenRouter, local vLLM, …) — efficient subscription inference, not Claude.
- In `pi-runner` it is the **per-node executor**: the deterministic driver owns the graph; pi runs
  one node (one wave prompt) and coordinates with other nodes purely through the **filesystem**. It
  is a drop-in replacement for a Claude Workflow `agent()` at the *execution* layer.

## Verified invocation + mechanics
The exact headless command (from `run.mjs` `piArgs()`):
```
pi -p --mode json -a --no-session --offline --no-extensions \
   --provider cp @<prompt-file>          # creds/model from pi's global ~/.pi/agent/models.json
```
- **`-p`** print / non-interactive · **`--mode json`** line-delimited JSON event stream · **`-a`**
  auto-approve tool use · **`--no-session`** ephemeral · **`--offline`** suppress pi's *own* startup
  network ops (the model API call still works) · **`--no-extensions`** disable auto-loaded
  extensions — *but an explicit `-e` still loads*.
- **Prompt as a file (`@<path>`)** — robust for multi-KB prompts (our wave prompts are ~4.4–7.9 KB).
- **Custom provider via pi's native `~/.pi/agent/models.json`** (set once per machine): a
  `{ providers: { cp: { baseUrl, api: "openai-completions", apiKey, models } } }` block. pi resolves
  it for every project, so `--provider cp` needs no `-e`, no env, no per-repo key. Swap providers by
  editing that one file; `pi --list-models cp` verifies.
- **JSON events we parse:** `message_update` → `assistantMessageEvent.type === "text_delta"`
  (delta text we accumulate into the node's final message); `tool_execution_start` /
  `tool_execution_end` (carry the tool name → tool count + live "current tool"). Every line is a
  liveness tick driving the stall detector.
- **No schema-forced structured output** (unlike Claude Workflow's `schema`). So we impose a
  **return protocol**: the node ends with one fenced ` ```json ` block
  (`{node,status,outputArtifacts,summary,issues,pipelineFindings}`) and the driver **`stat()`s the
  reported artifacts on disk** — `ok` is granted only if the files exist (**verified, not trusted**).

## Advantages (why pi for this)
- **Cost** — runs on efficient non-Claude coding-plan inference. The whole point: keep the
  *orchestration* on Claude (one efficient driver) and ship the *execution* (the expensive token mass —
  N multi-KB wave prompts) to a coding-plan model at ~plan cost.
- **Model-swappable with zero drift** — identical prompts + identical DAG across any model; switch
  by editing `.env`. A clean A/B of model ids where the only variable is the model.
- **Headless + scriptable** — a pure child process with a JSON stream lets a plain-Node driver own
  determinism (stage order, parallel lanes, halt-on-failure, watchdog) and stream live status.
- **Filesystem-coordinated** — pi nodes hand off through files exactly as Claude Workflow agents do,
  so pi is a *drop-in* executor; the coordination contract never changes between Claude and pi.
- **Reasoning toggle per model** (`PI_CP_REASONING`) — run efficient/non-reasoning to shake out
  mechanics, flip on (or move to a stronger id) for quality once graph + prompts are proven.

## Limitations / sharp edges
- **No schema-forced return** → must use the return-protocol block + on-disk verification; a model
  that forgets the block yields `parsed=null` (driver flags "no return JSON block").
- **Quality is model-dependent** — non-Claude coding-plan models are weaker than Claude (more protocol
  misses, weaker adherence to long discipline preambles). Ladder up for hard waves.
- **Headless hang class** — an **open stdin pipe** (no TTY) blocks forever waiting for EOF; this
  caused a silent **~10-minute startup hang**. Mitigation is mandatory:
  `stdio:["ignore","pipe","pipe"]` + `--offline` + `--no-extensions`. The watchdog treats
  **silence as the signal** (stall flag >45 s, hard kill at `--node-timeout` 600 s,
  SIGTERM→SIGKILL) so a hang is visible in seconds.
- **Context window** is per provider model (default 131072 in our extension) — wave prompts fit
  easily; large repo context must be managed by the node prompt, not assumed.
- **No native cross-session job registry** (codex-companion has one). We have per-run
  `out/<id>/run-status.json` + `_pi/<node>.{events.jsonl,debug.log}`, and `--from`/`--only`
  node-range **resume** (skip+reuse a frozen prefix, preflight-gated), but no auto-cancel yet.
- **Dynamic (data-dependent) fan-out isn't captured by extraction** — `extract.mjs` records the
  happy-path expansion; result-driven `parallel()` / loop-until-dry records only the stubbed
  iteration. Use static fan-out for pi targets (see `../reference/architecture.md` "Dynamic workflows").

## How we tackle work with pi — two faces of one primitive
The deep observation: **`codex-companion.mjs` and `pi-runner/run.mjs` are the same primitive** — a
"headless-CLI job broker" (spawn an external coding CLI, stream events, track a job, support fg/bg +
timeout, return a verified result). They differ only in the *face* presented.

- **Face A — DAG executor (BUILT: `pi-runner/`).** Driver extracts the Workflow's prompts+DAG
  (execute-and-record), spawns one pi per node, owns stage order / parallel lanes / halt / watchdog,
  verifies status on disk. The **efficient path for a whole pipeline** — orchestration cost stays on
  one efficient Node driver, not N Claude agents.
- **Face B — single-task subagent (`PROPOSAL`).** A thin Claude subagent (`agents/pi-task.md`,
  `tools: Bash`) forwarding one bounded task → `pi-task.mjs` broker → one headless pi. The efficient
  counterpart to `codex:codex-rescue` (premium GPT-5-codex second pass). ~90% of the code exists:
  the broker is `run.mjs`'s `runNode()` minus the DAG. Extract a shared `spawnPiNode()` core and
  give it both faces.

## codex vs pi (the spawn-a-subagent comparison)
The codex plugin (`openai-codex` v1.0.4) spawns a subagent off its runtime in **three layers**:
(1) `agents/codex-rescue.md` — a Claude subagent (`tools: Bash`, `model: sonnet`), a **thin
forwarder** whose only job is one Bash call (no repo work, no follow-up); (2)
`scripts/codex-companion.mjs` — the **job broker** (fg/bg, `--write`, `--resume-last`,
status/result/cancel, hooks) that `spawn()`s the `codex` CLI; (3) the `codex` CLI (GPT-5-codex).

| | codex-rescue | pi (today) | pi-task (`PROPOSAL`) |
| --- | --- | --- | --- |
| Vehicle | Claude **subagent** (Agent-native) | external **driver**, bypasses Agent tool | Claude subagent (Bash forwarder) |
| Scope | one bounded task | whole multi-node DAG | one bounded task |
| Model | premium GPT-5-codex | non-Claude coding-plan | non-Claude coding-plan |
| Lifecycle | bg/fg, resume, status, cancel, hooks | per-run status + watchdog | slim bg/status/result (`PROPOSAL`) |
| Role | premium second pass / rescue | non-Claude pipeline fleet | non-Claude second pass / handoff |

**The efficiency rule this yields:** do **not** route a DAG through Claude subagents (e.g. a
workflow node `agent(prompt, {agentType:'pi-task'})`). Each node would still spin up a sonnet
forwarder just to shell out to pi — re-incurring exactly the Claude cost pi-runner exists to avoid
(N forwarders for an N-node run). The subagent face is for **single** handoffs; the DAG stays on
the external driver.

## Future-iteration backlog
- **Shared core** — extract `spawnPiNode()` (headless spawn + JSON-stream parse + return-protocol +
  artifact verify) so the DAG driver and a future `pi-task` share one implementation.
- **`pi-task` subagent (Face B)** — `pi-task.mjs` + `agents/pi-task.md`: pi as an efficient codex-rescue.
- **Slim job registry** — optional bg + status + result + resume for `pi-task`, à la codex-companion.
- **Per-node model routing** — the Workflow already supports a per-`agent` `model`; map node
  label/agentType → a model id (most efficient for mechanical waves, stronger for pedagogy/compose).
- **Dynamic fan-out in extraction** — shape the `GENERIC` stub or a two-pass driver that reads a
  prior phase's on-disk output to compute the item list, so result-driven pipelines run faithfully.
- **DAG resume** — the MANUAL half shipped: `--from`/`--only` skip a frozen prefix and reuse its
  artifacts (preflight-gated). Remaining: make the skip AUTOMATIC — content-hash each node's declared
  inputs+prompt and reuse on match (mirror the Workflow journal's "longest unchanged prefix").
