# Competitive gap analysis — piflow vs `QuintinShaw/pi-dynamic-workflows`

> Status: living backlog. Created 2026-06-25. Source under `vendors/pi-dynamic-workflows`
> (commit cloned 2026-06-25). Evidence is cited as `file:line` in BOTH repos. Honest by
> construction: where we are PARTIAL or ABSENT it says so; where we are AHEAD it says so.
>
> **Progress (2026-06-25):** ✅ **G2**, ✅ **G4**, ✅ **G5** shipped (10 commits, +46 tests, typecheck
> green; see `wiring-g{2,4,5}-*.md`). **G1** in progress (separate session — see
> `per-node-routing-and-fusion.md`). 📐 **G6** designed (`wiring-g6-agenttype.md` — thin presets +
> author-time expansion). Remaining: G3, G7–G10 (+ G6 impl).

## 0. TL;DR

`pi-dynamic-workflows` (PDW) is **"code mode for subagents" ported to Pi** — the same model as
Anthropic's dynamic workflows / the Claude Code `Workflow` tool, plus production extras. piflow is a
**durable, multi-process DAG fleet**: a workflow is *data* (a template on disk), compiled to a DAG,
run as **one real headless `pi` per node**, coordinated through the filesystem.

They have executed the *in-process orchestration runtime* far more completely than we have any
equivalent — because they finished the thing we deliberately moved past. Of their feature set, the
parts that are **real backlog for us** (capabilities our architecture wants and we just haven't built)
are, in priority order:

1. **Per-node model routing** (tiers + exact model) — §G1 · 🚧 in progress
2. **Concurrency cap / process pool** — §G2 (today a latent fork-bomb, not just a feature) · ✅ shipped
3. **Quality-pattern vocabulary** for verify-nodes — §G3
4. **True journal/replay resume** (content-hash, mid-DAG) — §G4 · ✅ shipped
5. Journaled **human checkpoint** — §G5 · ✅ shipped
6. **`agentType` consumption** — §G6
7. **Background + auto-continue** — §G7
8. **Structured-output repair loop** — §G8
9. **Saved & nested (sub-)workflows** — §G9
10. tok/s + per-phase budgets (telemetry) — §G10

Everything else is parity or a place where **we are ahead** (§3).

---

## 1. The architectural fork — "one real `pi` per node" vs "in-process subagent"

This is the thesis that makes every gap below worth closing: our gaps are **unfinished strengths**, not
debt, because each node is a real, independently-tooled, independently-sandboxed, (soon)
independently-modeled `pi`. The in-process design **structurally cannot** match that per-node
heterogeneity.

### 1a. How PDW wires tools to a subagent (shared & subtractive)

- One Pi process runs the workflow JS in a `vm` (`vendors/.../src/workflow.ts:830-861`). Each
  subagent is an **in-memory session**: `createAgentSession({ sessionManager: SessionManager.inMemory(), … })`
  (`src/agent.ts:372-385`).
- Tools are built **once** per `WorkflowAgent`: `baseTools = createCodingTools(cwd)` — the built-in pi
  coding tools (`src/agent.ts:301`).
- Per `agent()` call the only customization is a **name allow/deny filter** over that fixed set:
  `applyToolPolicy([...baseTools, ...opts.tools], toolNames, disallowedToolNames)` (`src/agent.ts:343`,
  `src/agent-registry.ts:136`). The workflow runtime never passes per-call `tools`
  (`workflow.ts:464-482` sets only `toolNames`/`disallowedToolNames`), so in practice a node can only
  **narrow** the shared coding toolset.
- The `agentType` markdown CAN bind a name allowlist/model/prompt, but `mcp`, `skills`, `background`,
  `isolation` in its frontmatter are **parsed-but-ignored** (`src/agent-registry.ts:14-17`). So you
  **cannot** give one specific node a unique MCP server or community plugin the others lack. The only
  additive injection (`opts.tools: ToolDefinition[]`) happens at **whole-workflow** construction (e.g.
  `/deep-research` injects web tools for the entire run), never per node.
- Isolation tops out at a **git worktree** — same machine, same parent process.

**Net:** every PDW subagent is the *same kind of thing* — a coding session over the built-in tools,
differing only by prompt, model, and a *narrowed* tool list.

### 1b. How piflow wires tools to a node (additive & heterogeneous, per process)

- Each node is a **separate headless `pi`**: `pi -p --mode json -a --no-session … --tools <piTools>
  -e <extensionFile> @<promptFile>` (`packages/core/src/runner/command.ts:61-77`).
- A node declares `tools: ToolSelection { allow?, deny? }` addressed by `namespace:name`
  (`packages/core/src/types.ts:36,114`). The resolver + `compileToolExtension` generate a **per-node pi
  `-e` extension** that `registerTool`s **exactly that node's** sdk/mcp/OpenClaw tools with a **real
  `execute`**: native execute for a pinned OpenClaw plugin via the capture-shim, or routed by address
  through `@piflow/tool-bridge` for MCP (`packages/core/src/tools/compile.ts:169-244`). MCP ingest is
  real (`tools/ingest.ts` → `tools/list` → `ToolEntry[]`).
- So node tools are **additive and heterogeneous**: node A = GitHub MCP + a memory plugin; node B =
  `Read`/`Grep` only; node C = an OpenClaw scraper. **Each node's process can independently grow** to
  be ultra-productive.
- Isolation is a real **OS process boundary** + optional `seatbelt` (macOS `sandbox-exec`) or remote
  `daytona` VM — different env / network / machine per node (`packages/core/src/sandbox/*`).

**Honest caveat:** the *mechanism* (compile + bridge + MCP ingest) is real and tested, but the
**OpenClaw community catalog is mostly skeleton today** — only the `oc.calc:add` seed is end-to-end
executable (`packages/core/src/tools/openclaw-community.ts:11`). The ceiling is real; the breadth of
plugged-in community tools is still aspirational.

### 1c. What we pay for it (and what is latent)

- Heavier: a process spawn per node + **filesystem-coordinated state** (no shared in-memory variables —
  intermediate data must pass through declared `produces`/`reads` files).
- We **under-exploit the ceiling today**: per-node model routing isn't wired (§G1), `agentType` is
  carried but unconsumed (§G6), the community catalog is skeleton (§1b). So the *potential* is much
  higher than PDW's; some of it is **latent**, which is exactly what this backlog turns on.

---

## 2. The gap catalog

Each gap: **what PDW has** (evidence) · **what we have** (evidence) · **the delta** · **how we'd close
it**. Severity = impact on our "fleet of efficient models" thesis.

### G1 — Per-node model routing · severity: HIGH · effort: LOW

**PDW.** `agent({ tier: 'small'|'medium'|'big' })` or `agent({ model: 'provider/id' })`, plus
`meta.phases[].model` and `meta.model`. Precedence (most specific first): explicit `model` >
`agentType.model` > `tier` > phase model > default `medium`
(`src/agent.ts:173-189` `resolveAgentModelSpec`; `src/model-routing.ts`; `src/model-tier-config.ts`).
Tiers map to real models, configured via `/workflows-models`, persisted to
`~/.pi/workflows/model-tiers.json`. It **actually switches** the subagent session's model.

**piflow.** `RunOptions.model` is **run-level** (`runner/runner.ts:121`); `command.ts:68` emits one
`pi --model <x>` for **every** node; `NodeSpec` has **no model field** (`types.ts:17-36`). We cannot
route a cheap model to scan nodes and a frontier model to the planner/synthesis node — the single
biggest miss for a product whose pitch is "run the identical DAG on a fleet of efficient models."

**Delta.** No per-node model; no tier abstraction.

**How we close it** (follows the *exact* in-flight pattern adding per-node `timeoutMs`/`retries`):
1. Add `model?: string` and `tier?: string` to `TemplateNode` (`template/types.ts`) +
   `node.schema.ts` + `loader.ts` (mirror the current `timeoutMs`/`retries` WIP).
2. Carry to `NodeSpec` (`types.ts`) and resolve at instantiate time.
3. A tier→model map in `~/.piflow/` (parallels their `model-tiers.json`); precedence
   `node.model > node.tier > run --model > provider default`.
4. **Thread it through — already supported:** `CommandContext.model` is per-call
   (`command.ts:29,68`). Populate it **per node** instead of run-wide. This is the whole reason G1 is
   LOW effort.

### G2 — Concurrency cap / process pool · severity: HIGH (safety) · effort: LOW · ✅ SHIPPED

> **Done (2026-06-25):** `runner/limit.ts` (zero-dep FIFO semaphore, default **8**, clamp `[1,16]`);
> `RunOptions.maxConcurrent` + opt-in `maxNodesPerRun`; CLI `--max-concurrent`. Wraps the stage fan-out
> so a node's retries share one slot; watchdog/halt/checkpoint untouched. +13 tests.

**PDW.** Shared limiter capped at `MAX_CONCURRENCY = 16` and `MAX_AGENTS_PER_RUN = 1000`
(`src/workflow.ts:284-295`, `createLimiter` `:1008`; `src/config.ts`). The cap is shared across nested
`workflow()` so it holds across nesting.

**piflow.** A stage runs **unbounded**: `await Promise.all(s.nodeIds.map(runNodeWithRetries))`
(`runner/runner.ts:1014`). No `p-limit`/semaphore anywhere. **Worse for us than for them**: their
overflow is in-memory sessions; ours forks real OS `pi` processes, so a wide stage (e.g. a 50-node
fan-out) spawns 50 `pi` children at once — a latent fork-bomb.

**Delta.** No concurrency cap, no total-agent cap.

**How we close it.** A semaphore around the stage map; a `maxConcurrent` run option (default ~ CPU-2,
clamped); an optional run-wide node cap. Small, self-contained change in `runner.ts`.

### G3 — Quality-pattern vocabulary for verify-nodes · severity: MED · effort: MED

**PDW.** `verify()`, `judgePanel()`, `loopUntilDry()`, `completenessCheck()`, `retry()`, `gate()` as
composable vm globals built purely on `agent()`/`parallel()` (`src/workflow.ts:638-786`). Ships
`/deep-research` and `/adversarial-review` as static workflows (`src/deep-research.ts`,
`src/adversarial-review.ts`).

**piflow.** A **declarative integrity-check** engine (`checks.ts`: `exists`, `non-empty`,
`count-floor`, `fenced-tail`…) whose header states a check **"NEVER judges GOODNESS"**
(`checks.ts:6`). We have no adversarial-verify / best-of-N / loop-until-dry as building blocks — exactly
the content our **verify-node** concept is meant to carry.

**Delta.** No LLM-judge quality verbs.

**How we close it.** Because we are a DAG, these are **reusable node templates**, not in-process
functions: a `verify` node template (fan N reviewers → consensus), a `judge-panel` node, a
`loop-until-dry` controller pattern. Ship them under `templates/` as composable sub-DAGs (depends on
§G9 for clean composition; usable standalone before that).

### G4 — True journal/replay resume · severity: MED · effort: MED · ✅ SHIPPED

> **Done (2026-06-25):** `runner/journal.ts` writes `.pi/journal.json` (atomic, only on terminal-good
> verdict). A node reuses iff its **envelope hash** + **input-file content hashes** are unchanged, else it
> + all DAG descendants re-run. Inputs derive from **DAG-parent artifacts via `wf.edges`** (since
> `io.reads` is `[]`) — fixes the stale-reuse blind spot. `--from/--until` kept as override; G1/G6
> extension point marked in the hash. +19 tests.

**PDW.** Each `agent()`/`checkpoint()` result is journaled by a **call-identity hash** (prompt + model
+ phase + agentType + schema); resume replays the **longest unchanged prefix** and re-runs only the
first changed/new call + everything after (`src/workflow.ts:402-417`, `src/run-persistence.ts`). Edit
one upstream call → it and only its downstream re-run; no tokens for the unchanged prefix.

**piflow.** Resume = `--from`/`--until` **stage-window** selection gated by an **artifact-stat
preflight** that HALTs if a required upstream output is missing (`runner.ts:276,962-985`). It *skips*
stages whose files already exist; it does **not** replay finished work, can't resume a mid-stage node,
and "edit one node → only it + descendants re-run" doesn't exist. `RunState` is checkpointed to
`.pi/state.json` per stage barrier (`runner.ts:1026`).

**Delta.** Coarse stage-skip vs fine content-hash replay.

**How we close it.** A node-level **content hash** (prompt + resolved tools + model + input-file
hashes). On resume: skip a node whose hash AND inputs are unchanged; re-run a node + its DAG
descendants when its envelope or any input changes. Extend the existing `.pi/state.json` checkpoint.

### G5 — Journaled human checkpoint (HITL) · severity: MED · effort: MED · ✅ SHIPPED (contract+services)

> **Done (2026-06-25):** `checkpoint` node kind (`kind: confirm|input|select`, `prompt`, `choices?`,
> `default?`, `headless?`, `timeoutMs?`). Runner writes `.pi/checkpoints/<nodeId>.json` marker, **parks
> without holding a concurrency slot**, watches for `<nodeId>.reply.json`, **re-validates** (hash/kind/
> choices — runner is sole authority), journals the reply (composes with G4), resumes; headless takes the
> declared default (never hangs); crash-mid-wait re-enters the wait. Surfaced through the ONE observe
> stream: `RunViewNode.checkpoint` + `'awaiting-input'` status via the existing `watchRun` delta. Reply
> service: `POST /__piflow/checkpoint/<run>` Vite courier (dumb writer). +14 tests. **GUI panel
> intentionally left to the owner** — build against `RunViewNode.checkpoint` + the POST endpoint.

**PDW.** `checkpoint(prompt, opts)` — a deterministic, **journaled, replayable** approval gate; on
resume the human's reply replays by call index like a cached `agent()`. Headless, it takes a declared
default and journals *that*, so a detached run never hangs (`src/workflow.ts:793-828`).

**piflow.** **None.** stdin is deliberately closed to prevent headless hangs (`command.ts:55`); the
policy actions are `block|warn|stop` automated consequences (`types.ts:151`), not human gates.

**Delta.** No HITL at all.

**How we close it.** A `checkpoint` node kind (or a pre-hook gate) that persists a `waiting` state the
**console (Claude Code) resolves** — fits our "steer by talking to agents in the terminal" model.
Headless default keeps background runs unattended. Journal the reply for resume (§G4).

### G6 — `agentType` consumption · severity: MED · effort: LOW–MED · 📐 DESIGNED

> **Design (2026-06-25):** `wiring-g6-agenttype.md`. Re-scoped with the owner to a **thin preset +
> branding** model, **author-time expansion** (NOT a runtime resolver): `piflow-init` flattens a preset
> into the node's concrete `tools`/`prompt` and keeps `agentType` as a *label*; the runner is untouched.
> A preset = canonical skills + a base tool set + a role-prompt + a `display{icon,label,color}`; it does
> **NOT** carry model/tier (G1 owns those). Merge is additive (node adds/removes tools; task prompt
> appended to the role-prompt). Catalog = product data in `~/.piflow/agents/` (+ seeds bundled with the
> init skill); the icon rides the ONE observe run-view to the GUI. Seeds: `market-research`,
> `paper-analyzer`, `interview`. Core touch is small (pure `mergePreset` + template/observe passthrough).

**PDW.** `agentType` resolves a `.pi/agents/<name>.md` definition binding **tools (name allow/deny) +
model + role prompt** (`src/agent-registry.ts`; applied `src/workflow.ts:371-375`). (Reminder: its
`mcp`/`skills` are parsed-but-ignored — §1a.)

**piflow.** `NodeSpec.agentType` is **carried but unconsumed** (`types.ts:31`); it never reaches the
command builder — AND the template format has no `agentType` field at all (`template/types.ts:19`,
`loader.ts:116`), so the primary authoring path can't even declare it (see the design doc ⚠️).

**Delta.** Field exists on the dense spec only, no binding, no template/observe surface.

**How we close it.** Author-time expansion (above): bind real MCP/community tools per `agentType` —
the additive thing PDW's in-process model structurally can't do (§1b) — while keeping presets thin,
overridable, and branded.

### G7 — Background + auto-continue delivery · severity: LOW–MED · effort: LOW

**PDW.** Background by default: the turn ends immediately, a live panel tracks runs, and each result is
delivered back so the conversation auto-continues.

**piflow.** `piflow run` is **foreground-only** (`packages/cli/src/run.ts:243-288`); backgrounding is
left to the shell; the GUI Companion's talk-back is a commented-out stub
(`gui/src/components/Companion.tsx:55`). The `watchRun` SSE/poll stream exists (read-only).

**Delta.** No detach + deliver-back.

**How we close it.** A `--detach` that backgrounds `runFromTemplate` + a console-side poll surfacing
completion. **Lower priority**: our console *is* Claude Code, which can already background a `Bash` run
and be re-invoked on completion.

### G8 — Structured-output repair loop · severity: LOW–MED · effort: LOW

**PDW.** On a schema miss the subagent is re-prompted up to `maxSchemaRetries` (tools restricted to
`structured_output`), then strict prose extraction, else a surfaced `SCHEMA_NONCOMPLIANCE`
(`src/agent.ts:113-155`).

**piflow.** We validate the artifact schema (`runner/schema.ts`, ajv-2020) and the return-schema tail
(`runner.ts:735`) and **block/warn** — but there is **no repair re-prompt**; the only retry is a full
fresh node re-run (`io.retries`).

**Delta.** No bounded in-node repair.

**How we close it.** On a return-schema miss, one bounded repair re-prompt to the same node process
before counting a full `io.retries` attempt.

### G9 — Saved & nested (sub-)workflows · severity: LOW–MED · effort: MED–HIGH

**PDW.** `workflow('name', args)` runs a saved workflow inline (shares caps), one level deep
(`src/workflow.ts:607-632`); `/workflows save` turns a run into a `/<name>` command
(`src/workflow-saved.ts`, `src/saved-commands.ts`).

**piflow.** **None** — the node schema has no field to reference another template; no save-run-as-command.

**Delta.** No sub-DAG composition.

**How we close it.** A node kind that references another template, **inlined at compile** (sub-DAG
expansion into the parent stages). Enables §G3 quality patterns as shippable sub-DAGs.

### G10 — Telemetry: tok/s, per-phase budgets, cost · severity: LOW · effort: LOW–MED

**PDW.** Live **tok/s** rate per agent (a stalled agent reads 0 tok/s), per-phase token sub-budgets
(`workflow.ts:303-367`), real token usage from the session.

**piflow.** Tokens are **real** (from each pi session's `events.jsonl` `message.usage` →
`buildRunView`, `observe/runView.ts:27`). **tok/s is never computed**; no phase budgets. **Cost is
upstream-broken for BOTH** (pi reports `usage.cost = 0`; we hide it deliberately —
`gui/.../NodeHud.tsx:293`, `packages/cli/src/status.ts:13`).

**How we close it.** Derive tok/s from `usage` deltas over wall-clock in the observe layer; add an
optional per-stage token budget. Cost stays blocked until pi reports it.

### Parity (already done — no gap)

- **Per-node retries + per-node hard timeout** — runtime had `io.retries` + `sandbox.timeoutMs`
  (`runner.ts:479,629`); the **in-flight WIP** (uncommitted 2026-06-25) exposes both at the *template*
  level (`template/types.ts`, `node.schema.ts`, `loader.ts`). This is the pattern G1 reuses.
- **Per-node tool allow/deny + MCP ingest** — §1b (we are ahead).
- **Pre/post-node hooks** — `runner.ts:621,777`; deterministic, never an LLM.
- **Sandbox backends** — `local` · `seatbelt` · `worktree` · `daytona` (we are far ahead; PDW has only
  worktree).
- **Structured-output validation gate** — present (the *repair loop* is the only delta, §G8).
- **Compile a spec → DAG** — `dag.ts:161`; template + agent-spec paths converge on one `compile()`.

---

## 3. What we have that PDW does NOT (don't lose these)

- **Durable multi-process fleet** — each node a real headless `pi`, filesystem-coordinated; survives
  the controller dying. PDW's run evaporates with its one process.
- **Rich sandbox backends** — `seatbelt` (macOS `sandbox-exec` deny-all-then-allow), `daytona` remote
  VMs. PDW has **only** git worktree.
- **A real data-flow DAG** — `compile()` infers edges + stages from declared `io.reads`/`produces`
  (`dag.ts`). PDW has **no DAG**; dependencies are imperative `await` order and `phase()` is a display
  label only.
- **Additive, heterogeneous per-node tools** — §1b; the structural advantage of one-real-`pi`-per-node.
- **Per-node declarative integrity checks + contracts** (`declared ⊇ actual` breach detection).
- **One verified-not-trusted observe layer** feeding GUI (web) + TUI + CLI + `watch` from a single
  reader. PDW has a TUI only.
- **Template system** (loader / instantiate / tokens / render) + the `langgraph` and `tool-bridge`
  packages.

## 4. Deliberate divergences (their feature; we replaced it on purpose — NOT backlog)

- **In-process code-mode scripting** (`agent()`/`parallel()`/`pipeline()` in a `vm`). We have no
  imperative scripting path; we bet on declarative templates + separate processes. (Note: our own
  README's claim that an imperative workflow and an agent spec "compile to the same DAG" is
  **aspirational** — `extractWorkflow` returns a raw result, not a `WorkflowSpec`; no bridge exists in
  core.)
- **Interactive TUI control** (pause/resume/stop/restart/save from the keyboard,
  `vendors/.../src/workflow-ui.ts:9,468`). Ours is **monitor-only by design** — steer by talking to the
  agents in the terminal.

## 5. Sequencing

1. ~~**G2 concurrency cap**~~ — ✅ SHIPPED 2026-06-25 (process pool; the safety fix).
2. ~~**G4 content-hash resume** + **G5 checkpoint**~~ — ✅ SHIPPED 2026-06-25 (shared journal/state work;
   G5's reply is journaled into G4's `journal.json`).
3. **G1 per-node model routing** — 🚧 in progress (separate session); reuses the live `timeoutMs`/`retries`
   pattern; `command.ts` already takes `ctx.model` per call. Folds into G4's envelope hash when it lands.
4. **G6 `agentType` presets** — 📐 DESIGNED (`wiring-g6-agenttype.md`); thin presets + author-time
   expansion. Unlocks branded, reusable starting points and, uniquely for us, per-node MCP/community
   binding per preset. Ready to implement (small core touch).
5. **G3 quality-verb node templates** + **G9 sub-DAG composition** — MED+; ship the verify-node story.
6. **G8 repair loop**, **G7 detach**, **G10 tok/s** — LOW, opportunistic.
