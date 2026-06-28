# EXE research — RondoFlow (`rondoflow/rondoflow`) vs piflow

> Status: research brief. Created 2026-06-28. Source vendored at `vendor/rondoflow`
> (full clone, `rondoflow/rondoflow` `main`, **v1.0.0** `a65c35f`; never committed — `.gitignore:4`).
> Evidence is cited `file:line` in BOTH repos. Honest by construction: where RondoFlow is ahead it
> says so; where we are ahead it says so. Companion to
> `docs/research/2026-06-27-adk-python-workflow-runtime-comparison.md` (ADK = the *in-process*
> cousin) and `docs/specs/competitive-gaps-vs-pi-dynamic-workflows.md` (PDW); grounded in
> `docs/design/l1-node-envelope.md`, `docs/design/l2-l3-boundary-map.md`,
> `docs/design/node-action-protocol.md`.

## 0. TL;DR

RondoFlow is **"Build teams of Claude Code agents — visually"** (`README.md:3-5`): a local-first,
Postgres-backed **product** (Next.js canvas + Fastify/Socket.IO server) that walks a React-Flow
graph as a DAG and runs **each node as a real `claude` CLI subprocess** with full tool/MCP/skill
access (`README.md:23-27`, `spawner.ts:313`). Unlike ADK/PDW (one Python process, shared memory),
RondoFlow lands on **piflow's side of the substrate fork** — *separate real agent processes
coordinating outside a shared runtime*. That makes it the most direct architectural neighbour we
have studied.

But it makes the **opposite bet on the two axes piflow treats as load-bearing**, and it **ships the
exact control plane piflow deferred**:

1. **Coordination = prose-handoff through the prompt, not files.** A node's output is an in-memory
   string (`chain-executor.ts:387`); the **Director re-emits the full previous output inside a
   "message" that is the next agent's *sole* input** (`director.ts:266-273`). This is precisely the
   re-emitted-prose anti-pattern piflow's first philosophy rejects ("coordinate *only* through
   declared files, by reference, never re-emitted prose", `l1-node-envelope.md:26`).
2. **Isolation = logical policy, not an OS jail.** There is **no seatbelt/bwrap/container per agent**
   — the only `IS_SANDBOX` use sets `IS_SANDBOX=1` to *defeat* Claude Code's root refusal, the
   opposite of a jail (`spawner.ts:352-362`). Safety is Claude Code's own permission system + a
   **post-hoc** substring policy gate that can only kill or inject stdin (`policy-checker.ts:29-48`,
   `socket/handlers.ts:309-337`). `--add-dir` only *widens* the filesystem (`prompt-builder.ts:323-330`).
3. **It built piflow's L3.** A **Planner** (before), a mid-run **Director** (an LLM quality gate
   after *every* step → continue/redirect/conclude, `director.ts:48,70`), an **Advisor** (after),
   cross-run **Memory**, and a **Loop engine** are all shipped and live (`README.md:140-147`) — i.e.
   the "run + observe + intervene + learn" control plane piflow marks **deferred, post-M6**
   (`l2-l3-boundary-map.md:14`).

The verdict mirrors ADK: nothing here overturns our thesis. RondoFlow is a real existence-proof that
the **Planner/Director/Advisor triad has product value**, but it buys that value with the two
patterns our design explicitly forbids (re-emitted-prose handoff + **runtime** re-entry,
`node-action-protocol.md:420`) and **none** of our isolation moat (per-node OS/VM jail + per-node
capability removal, `node-action-protocol.md:320-334`). It is also **Claude-Code-coupled** — its
non-Claude "providers" are text+web-search veneers with no real tools (`streaming-runner.ts`,
`prompt-builder.ts:135-169`) — whereas piflow is provider-agnostic, one real `pi` per node. **Borrow
the L3 UX shape; keep our substrate and our constraints.**

---

## 1. How RondoFlow actually works (the EXE research)

**A run is a `ChainExecutor` walking a graph one node at a time.** `chain-executor.ts` builds a
predecessor map + topological order (`:322-323`), then loops: pick the first ready node (all
predecessors completed/skipped, `:342-344`), check conditional/group edges enable it (`:355-367`),
run it, record output, let the Director evaluate, route the contextualised message to the enabled
successor(s) (`:471-478`). It honours branches, fan-out, and fan-in (`JoinNode`-style, fan-in
concatenates inputs `:544-545`). It is **single-threaded orchestration** — the Director cannot
parallelise (`:317`); the separate DAG path handles parallel branches.

**Each node is one real `claude --print` subprocess.** `ClaudeCodeSpawner.spawn` (`spawner.ts:313`)
`child_process.spawn`s the `claude` binary with an args array (never `shell:true`, `:381-388`).
`buildArgs` (`:607-676`) emits: `--print --verbose --output-format stream-json --permission-mode
<mode> --system-prompt <persona+memory> --session-id … --no-session-persistence`, then conditionally
`--model`, `--append-system-prompt <skills>`, `--allowedTools <csv>`, `--max-budget-usd`,
`--mcp-config <json>`, `--add-dir <dir>` (per dir), `--`, then the message as the final positional.
Output is parsed line-by-line as stream-json and re-emitted as live Socket.IO events. **One
subprocess per step**; follow-ups write a `{type:'user',message}` JSON line to the live child's
**stdin** (`:519-528`).

**The node "envelope" is assembled from the DB, not authored as data.** `buildSpawnConfig`
(`prompt-builder.ts:65`) reads the `Agent` row + its skills/policies/memories/externalFolders and
produces: system prompt = `persona + agent memory + workspace memory` (`:95-110`); append prompt =
each enabled skill's `SKILL.md` (`:115-124`); `allowedTools` = the agent's set or `DEFAULT_TOOLS`,
**always unioned with `ALWAYS_ALLOWED_TOOLS = [Read, WebSearch, WebFetch]`** (`:28-48,177-182`);
model from tier/purpose (`:187-195`); `permissionMode` from `AgentMode` (`full → bypassPermissions`,
`:207-216`); MCP config (`:260`); and `addDirs`/`cwd` from workspace + **external folders** (an
agent's external folder becomes `cwd` and is added to `--add-dir`, `:323-330`).

**Coordination is prose, and the Director is the message bus.** Node outputs live in an in-memory
`Map<number,string>` (`chain-executor.ts:387`), persisted to Postgres. Between steps the Director's
system prompt is explicit: *"The 'message' field is passed DIRECTLY as the sole input to the next
agent. The next agent will ONLY see this message — it has NO other context… include the FULL output
from the previous step"* (`director.ts:266-273`). The next node's input is that contextualised
message (`chain-executor.ts:527-551`); files on disk are incidental (whatever `claude` happened to
write in the shared `cwd`), **never a declared edge**.

**The control plane — shipped, live (this is the headline):**
- **Planner** (before) — `planner.ts`: a bounded JSON-only Claude call over `{agents, edges,
  skills}` returning `{analysis, agentChanges[], edgeChanges[], approved}` (`:46-53`); the UI applies
  the diff. Tunes the team before the run.
- **Director** (during) — `director.ts:70` `evaluate()`: after **every** step a Haiku-tier call
  scores the output against the objective with a **rigor knob 1–5** (`:275-276,317-332`) and returns
  `action ∈ {continue, redirect, conclude}` + the contextualised next-message + a `learning`
  (`:48,57-65`). `redirect` = **retry THIS step at runtime** (`chain-executor.ts:452-462`:
  `completed.delete(idx); remaining.unshift(idx)`), auto-approved once then human-gated, capped
  `MAX_RETRIES_PER_STEP=2` (`:328,502-519`). `conclude` ends early. Learnings are written to Memory
  (`director.ts:135-145`) and reloaded next run (`:114-133`). **The Director is advisory: a failed
  evaluation degrades to `continue`, never aborts the chain** (`:99-109`).
- **Advisor** (after) — `advisor.ts`: compares result to objective, returns `{objectiveMet,
  suggestions[]}` with apply-able `actionPayload`s (attach skill / rewrite persona).
- **Memory** — `memory-extractor.ts` (Haiku, ≤5 durable facts, `confidence≥0.6`) +
  `memory-store.ts` (upsert, **Jaccard>0.8 dedup**), re-injected into the system prompt
  (`prompt-builder.ts:96-110,355-367`).
- **Loop engine** — `loop-engine.ts:152`: re-run an agent until a goal is met, **fresh process per
  iteration** to dodge context-window rot (`:220`), bounded `maxIterations` (default 10); goal
  decided by `evaluateCriteria` — `regex` / `test_pass` (shell exit code) / `manual` (human) /
  `max_iterations` (`:288-313`). **No LLM judge inside the loop** — the Director is the LLM judge,
  the loop is deterministic.
- **Workflow generation** (L2) — `workflow-generator.ts`: describe a task → a 2–5 agent DAG with
  personas/models/skills (`README.md:154-158`).

**Safety model (logical, monotonic-tightening):** three policy layers (global/agent/session)
folded by `mergePolicy` — `blockedCommands` **union**, `requireApproval` **escalate-sticky**,
`maxTimeout`/`maxFileSize`/`maxBudgetUsd` **`Math.min`**, `permissionMode` keep-higher-rank
(`policy-resolver.ts:79-136`), so a lower layer can never relax a global one. The gate
(`policy-checker.ts:21,29-48`) is **command-substring blocklist + approval-flag** evaluated **on the
streamed `tool_use` event** (`handlers.ts:309-314`) — i.e. **after** the model issues the call;
there is **no `--permission-prompt-tool`/`canUseTool` hook** wired in, so enforcement is post-hoc
(kill the process, or inject a stdin rejection). Approval is a soft UI pause over a never-OS-paused
process (`approval-manager.ts:22`, `handlers.ts:871-915`). Secrets are AES-GCM encrypted, env is
allowlisted, MCP creds resolve via bearer/header/oauth2-client-credentials (`mcp-auth.ts:145-207`).

**Multi-provider is a thin streaming veneer.** `AgentRunner` (`agent-runner.ts:16-23`) =
`spawn/sendMessage/kill/isRunning/pid` over a fixed event set (`text/tool_use/tool_result/usage`).
Claude Code satisfies it natively; **OpenAI and Perplexity runners produce streaming text + a
*synthetic* web-search tool-use event only** (`openai-runner.ts`, `perplexity-runner.ts`,
`streaming-runner.ts`). `allowedTools/mcpConfig/addDirs/cwd/permissionMode` are **Claude-Code-only**
and ignored by API runners (`prompt-builder.ts:135-169`). So "real agents that *do* things" is true
for Claude Code and **cosmetic** for the others.

**What it empowers:** a polished, local-first, multi-user team product — visual multi-agent
authoring, real-time streaming with HITL approvals, an LLM-steered run (Planner/Director/Advisor),
loop-until-goal, cross-run memory, team discussions with a facilitator, cron schedules, an in-app git
panel, an email-output node, roles/audit/analytics. It is an **application**, where piflow is a
**substrate/SDK + viewer**.

---

## 2. Feature-by-feature: us vs RondoFlow

| RondoFlow capability (`file:line`) | piflow equivalent (`design ref`) | Verdict |
|---|---|---|
| Real subprocess per node (`spawner.ts:313`) | One real headless `pi` per node (`l1:18,177`) | **Parity** (same substrate branch) |
| Visual React-Flow canvas authoring (`README.md:31`) | Declarative template (`.piflow/<wf>/template`) + GUI **viewer** | **Different category** (app vs SDK) |
| Edges **drawn** on the canvas (`chain-executor.ts:322`) | Edges **inferred** from `io.reads ⋈ io.produces` (`l1:34`) | **We're ahead** (sparse-authored) |
| **Prose-handoff** via Director message (`director.ts:266-273`) | **Filesystem-as-contract**, by reference (`l1:26`) | **We're ahead** (durable/inspectable/fidelity) |
| In-memory string outputs (`chain-executor.ts:387`) | Declared artifacts + schema-validated (`nap.md:191`) | **We're ahead** |
| Conditional/group branch edges (`chain-executor.ts:355`) | `route`/profile + control-node seams (`l2-l3:29`) | Parity |
| Fan-in concat (`chain-executor.ts:544`) | Stages/lanes + fusion judge sub-DAG (`l1:36`) | Parity |
| **Director redirect = RUNTIME retry** (`chain-executor.ts:452-462`) | **Compile-time UNROLL**, bounded `k`, no back-edge (`nap.md:273-291`) | **Deliberate fork** (§3) |
| Loop-until-goal (regex/test/human) (`loop-engine.ts:288`) | `io.retry` by failure-class + bounded reroute (`nap.md:236-243`) | Parity (different trigger) |
| **Director (LLM quality gate, mid-run)** (`director.ts:70`) | **L3 control node on a seam — DEFERRED** (`l2-l3:14,29`) | **They've shipped; we deferred** (§4) |
| **Planner (pre-run team tuning)** (`planner.ts`) | L2 COMPOSE planner = **M6, in flight** (`l2-l3:13`) | **They've shipped; ours is specced** |
| **Advisor (post-run analysis)** (`advisor.ts`) | L3 Hermes/optimize loop — **deferred** (`l2-l3:31`) | **They've shipped; we deferred** |
| escalate to a STRONGER model + evidence | retry/`escalate.tier` + `consultPreamble` (`nap.md:247`) | **We're ahead** (they retry same agent) |
| Cross-run Memory (extract+dedup+inject) (`memory-store.ts`) | L3 "middle/outer loop" — deferred (`l2-l3:39`) | **They've shipped; we deferred** |
| Multi-provider (Claude/OpenAI/Perplexity) (`agent-runner.ts:16`) | Provider-agnostic, **real tools every node** (`l1:18`) | **We're ahead** (theirs is text-veneer) |
| Per-agent tool allowlist (`prompt-builder.ts:177`) | Per-node `tools.allow` + `ns:name` registry/MCP (`l1:195`) | Parity |
| MCP config + encrypted creds (`mcp-config-builder.ts`, `mcp-auth.ts`) | MCP bridge + `SecretResolver` allowlist (`nap.md:303-308`) | Parity |
| 3-layer policy, monotonic-tighten (`policy-resolver.ts:79`) | Sandbox readScope/owns + policy `onFailure` (`nap.md:213`) | Parity (config) |
| **No OS jail; post-hoc substring gate** (`spawner.ts:352`, `policy-checker.ts:29`) | **OS-kernel read+write jail / cloud VM** (`nap.md:320-334`) | **We're ahead** (different axis) |
| HITL approval = stdin round-trip, soft (`handlers.ts:871`) | Journaled checkpoint (G5) + `--detach` (G7) | Parity (ours durable) |
| Schedules/cron (`scheduler.ts`), git panel, email node, roles/audit | — (out of SDK scope) | **They're ahead** (app surface) |
| Postgres/Prisma persistence (`schema.prisma`) | `.pi`/`run-view.json` + `~/.piflow` index (`CLAUDE.md`) | Different (DB vs files) |

---

## 3. The architectural fork (two opposite bets on the same substrate)

RondoFlow and piflow agree on the **substrate** (real, separate agent processes — not ADK/PDW's one
shared Python runtime), then **diverge on the two axes piflow's whole thesis rests on**:

1. **Coordination — prose vs filesystem.** RondoFlow's Director *re-emits the full prior output as
   the next agent's sole input* (`director.ts:266-273`). piflow's load-bearing rule is the exact
   negation: nodes coordinate **only through declared files, by reference, never re-emitted prose**
   (`l1:26`), and edges are **inferred** from those files (`l1:34`). RondoFlow's choice is what makes
   its mid-run Director *possible* (one LLM sits on every message hop) — but it caps fidelity
   (an 800–6000-char preview is what the Director sees, `director.ts:231,335`), loses the artifact as
   a durable/inspectable/resumable contract, and forces every handoff through a model.
2. **Isolation — none vs OS-kernel.** RondoFlow has **no per-agent OS jail** (`spawner.ts:352-362`);
   `--add-dir` only widens (`prompt-builder.ts:328`); the policy gate is a post-hoc substring match
   in the socket layer (`policy-checker.ts:29-48`). piflow gives **each node its own OS-kernel
   read+write jail (seatbelt/bwrap) or cloud VM (daytona/e2b) and its own tool-scope**, so no single
   node holds {private data · untrusted content · exfil channel} — the **lethal-trifecta split**,
   demonstrated end-to-end on E2B (`nap.md:320-334`). This is the cleanest moat: an injection in
   content a RondoFlow research agent fetches runs with that agent's *full* host capabilities; in
   piflow the capability was already removed, model-independently.

**Loops are again the sharpest illustration.** RondoFlow's Director does **runtime re-entry** —
`redirect` deletes the completed step and re-queues it (`chain-executor.ts:457-460`); the loop engine
runs a native `while iteration < max` (`loop-engine.ts:152`). piflow **refuses the back-edge** and
**unrolls** the bounded QA loop into acyclic compile-time clones (`expandReroute`, `nap.md:273-291`);
`checkCycles` is never modified, and a **runtime cyclic/re-entry primitive is an explicit non-goal**
(`nap.md:420`). Theirs is more ergonomic for unknown iteration counts; ours is durable, resumable,
and OS-isolatable per attempt.

A third, smaller fork: **provider model.** RondoFlow *is a Claude Code orchestrator* (`README.md:3`)
— real tools exist only for Claude; OpenAI/Perplexity are text+web-search shells
(`prompt-builder.ts:135-169`). piflow is **provider-agnostic by construction** (one `pi` per node,
non-Claude coding models, heterogeneous per-node model·tools·sandbox·skill, `l1:166`).

---

## 4. The big one: RondoFlow is piflow's deferred L3, shipped

This is the most useful thing to take from the study. Our `l2-l3-boundary-map.md` defines L3 as
"*run + observe + intervene + learn*: control nodes on seams (debug → Hermes ladder · stuck-node
governor · background supervisor)" and marks it **deferred, post-M6** (`:14`). RondoFlow has built
exactly that surface and proven it has product pull — but as a **runtime LLM loop on the message
bus**, which is the architecture our design rejected. The mapping is clean:

| RondoFlow (shipped) | piflow L3 concept (`l2-l3` ref) | The principled piflow form |
|---|---|---|
| **Director** continue/redirect/conclude per step (`director.ts:48`) | inner loop / stuck-node governor (`:35,39`) | a **verify pi-node** + bounded **reroute**/**escalate** (`nap.md:252,247`) — model lives in a *node*, not a hook on the seam |
| **Director rigor 1–5** (`director.ts:317`) | the quality bar | gate `onFailure` + `escalate.tier` per node (`nap.md:213,247`) |
| **Planner** pre-run team tuning (`planner.ts`) | L2 COMPOSE (`:13`) | the COMPOSE planner (M6) emitting a `WorkflowSpec` |
| **Advisor** post-run fixes (`advisor.ts`) | Hermes/optimize outer loop (`:31,39`) | a control node that edits a node's skill/prompt **between runs** (`:50`) |
| **Memory** extract→dedup→inject (`memory-store.ts`) | the "gradient" / learnings (`:39`) | durable learnings registered between runs, human-approved (`:42`) |
| Director redirect = **runtime** retry (`chain-executor.ts:452`) | — | **compile-time unroll**, the explicit non-goal boundary (`nap.md:420`) |

**The load-bearing difference: when intervention happens.** RondoFlow intervenes **mid-run, every
step, with an LLM in the loop**. piflow's hard constraint is the opposite: *"hot-edits happen at
seams, **between runs** … never mid-run"* and the self-improving edge is *generate → verify →
human-approve → durably register → next run uses it* (`l2-l3:42`). RondoFlow's Director is, in our
vocabulary, a **model-bearing control node placed on *every* seam** — and our own principle already
says how to absorb that: *"if a candidate hook needs a model, promote it to a pi node"* (`l1:39-40`).
So piflow's correct equivalent of the Director is **not** a mid-run message-bus interceptor; it is a
**verify node + bounded reroute** (the static, acyclic, resumable form we already shipped), plus an
L3 control node that re-composes/edits **between** runs.

**What to borrow (UX shape, not mechanism):**
- The **Planner-before / Director-during / Advisor-after triad as a product surface** — it's a good
  mental model for the GUI/console and validates the M6 COMPOSE + L3 roadmap.
- The **rigor knob (1–5)** as an author-facing dial over gate strictness / escalate aggressiveness.
- **Cross-run memory with dedup** as the concrete shape of the "outer loop / gradient."
- **Loop-until-goal with a deterministic criterion** (regex / test exit code / human) — this is
  *already* piflow's discipline (deterministic gate, model in a node), and it confirms the loop bound
  + non-LLM goal-check is the right factoring.

**What to refuse (and why it's principled, not lazy):**
- **Prose re-emission as the handoff** — violates `l1:26`; keep filesystem-as-contract. A piflow
  "Director" reads the produced **artifact**, it does not concatenate prose into the next prompt.
- **Runtime re-entry / live back-edges** — explicit non-goal (`nap.md:420`); keep compile-time unroll.
- **The model on every seam** — keep the model in producer/verify **nodes**; control nodes stay
  deterministic plumbing or get promoted to their own sandboxed `pi` (`l1:39-40`).
- **No-OS-jail** — keep per-node capability isolation; it is the moat (`nap.md:320-334`).

---

## 5. Honest watch-list — what RondoFlow has that we don't

Most of the gap is **product surface**, not substrate, and most is **out of SDK scope by design**
(the GUI is "a static viewer", `CLAUDE.md`). Worth a conscious decision:

- **The full L3 control plane as shipped UX.** Not debt in the SDK, but a strong signal for the
  **console/GUI roadmap** and the M6→L3 sequence. Adopt the *triad shape*; implement it the piflow
  way (§4). **Verdict: borrow the shape; the mechanism stays ours.**
- **Cross-run memory.** A concrete, simple extract→dedup→inject loop we can mirror as the L3 outer
  loop — human-approved + registered between runs, per `l2-l3:42`. **Verdict: candidate for the L3
  spec; cheap, high-leverage.**
- **App-tier features** — visual drag-to-canvas authoring, multi-user roles/audit/analytics, cron
  schedules, in-app git panel, team discussions/facilitator, email node, Postgres persistence.
  **Verdict: out of scope for `@piflow/core` (data/SDK boundary, `CLAUDE.md`); some belong to the GUI
  product layer, none to the substrate.**
- **A polished onboarding + "describe → team" generator** with templates. Our L2 COMPOSE (M6) is the
  equivalent; RondoFlow's generator is a good reference for the *review-and-edit-before-run* UX.

Nothing on this list challenges the thesis; the items are either UX to borrow or app features
outside the SDK.

## 6. Bottom line

RondoFlow is the closest neighbour we've benchmarked: it shares piflow's **real-separate-agent-process
substrate** (unlike ADK/PDW's shared runtime) and it **ships the L3 control plane we deferred** —
proving the Planner/Director/Advisor + memory + loop-until-goal triad has genuine product value. But
it pays for that with the **two patterns our design explicitly forbids** (re-emitted-prose handoff +
runtime re-entry) and with **zero per-node isolation** (no OS jail; a post-hoc substring policy
gate), and it is **Claude-Code-coupled** (non-Claude providers are text veneers). So the takeaway is
asymmetric and clear: **borrow the L3 *experience* (the triad, the rigor dial, cross-run memory) and
let it sharpen the M6→L3 roadmap — but implement every piece the piflow way** (model in verify/control
*nodes*, filesystem-as-contract, compile-time bounded unroll, OS-enforced per-node capability
removal). RondoFlow is the best argument *for* building piflow's L3, and the clearest illustration of
*how not to* build it.
