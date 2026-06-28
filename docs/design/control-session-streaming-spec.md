# Control-Session Streaming Surface — the pi-side `-e` mirror + the web-side acceptance (API-grounded)

> **Status:** DIRECTION / discussion (2026-06-27). The API-grounded HOW for the control session whose WHY,
> host-shape, courier, observer tiering and SRE ladder are already settled in
> `docs/design/control-session-mirror.md` (do not re-litigate that prose). Cross-ref:
> `docs/design/detached-run-control-vm.md` (the cloud control-VM this rides on; local==cloud, base-URL swap).
> This doc pins the streaming surface to the **current** pi — `@earendil-works/pi-coding-agent@0.80.2`
> (verified from the packed tarball + the locally-installed 0.79.10) — and judges it against **tau**'s logic,
> which was written for the **deprecated** `@mariozechner/pi-coding-agent@0.73.x`. Every API row below carries
> a real source citation and a stability rating. Where tau's 0.73 surface no longer holds, §2 says so.
>
> **Two findings that reshape the build (read first):**
> 1. **`pi.events` is NOT an event firehose.** It is a generic inter-extension message bus
>    (`emit(channel,data)`/`on(channel,handler)` — `event-bus.d.ts:1`). Lifecycle events are dispatched
>    per-literal-name via `pi.on("<name>", …)` (`loader.js:177`, `runner.js:522`); there is **no `pi.on("*")`
>    wildcard**. "Generic passthrough" therefore means *register one shared handler across the enumerated
>    event-name set* (§3), not subscribe-to-all.
> 2. **pi 0.80.2 ships its own duplex protocol — `--mode rpc`** (JSONL over stdin/stdout; `rpc.md:10`,
>    `rpc-types.d.ts`). Its command vocabulary (`prompt`/`steer`/`follow_up`/`abort`/`get_state`/`get_messages`/
>    `set_model`/`set_thinking_level`/`compact`/…) is a **strict superset of tau's hand-rolled WS up-channel**,
>    and it already emits the event/response/state down-channel tau built by hand. This is a first-class
>    alternative to (and a fallback for) the `-e` mirror extension; see §4.

---

## 0. Sources used (and how to re-verify)

All `@earendil-works/pi-coding-agent` citations are to **0.80.2** unless noted. Two physical sources, in
agreement on the extension API:

- **Packed tarball (primary).** `npm pack @earendil-works/pi-coding-agent@0.80.2` →
  `/tmp/piapi/earendil-works-pi-coding-agent-0.80.2/package/`. Type declarations under `dist/**/*.d.ts`,
  authoring guide `docs/extensions.md`, RPC guide `docs/rpc.md`, `CHANGELOG.md`. Also packed
  `@earendil-works/pi-agent-core@0.80.2` and `@earendil-works/pi-ai@0.80.2`.
- **Locally-installed (cross-check).** `/Users/tk/.nvm/.../lib/node_modules/@earendil-works/pi-coding-agent`
  is **0.79.10** — the version piflow's `pi` bin actually runs today. The extension API surface in §1 is
  byte-identical between 0.79.10 and 0.80.2 except where §2 notes a delta.

Paths below are relative to the package root (`…/package/`). "Cited file + version" satisfies the bar.

---

## 1. Current pi extension API surface (0.80.2)

The extension is a default-exported factory — `ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>`
(`dist/core/extensions/types.d.ts:1037`). It subscribes via `pi.on(...)`, controls via `pi.*` and the
per-handler `ctx` (`ExtensionContext`), and reads snapshot state via `ctx.*`/`ctx.sessionManager`.

### 1a. Event stream — every event type pi 0.80.2 emits

Subscribe with `pi.on("<type>", handler)`; the handler receives `(event, ctx)`. The **complete** union is
`ExtensionEvent` (`types.d.ts:742`), enumerated by the overload set on `ExtensionAPI.on` (`types.d.ts:817–846`).
All rows below are from `dist/core/extensions/types.d.ts` @ 0.80.2 and are **documented-stable** (each appears
in `docs/extensions.md` with an example) unless the Stability column says otherwise. The lifecycle order is
the diagram in `docs/extensions.md:276–338`.

| `pi.on(...)` event | Payload shape (key fields) | Source | Stability |
|---|---|---|---|
| `project_trust` | `{type, cwd}` → returns `{trusted:"yes"\|"no"\|"undecided", remember?}` | `types.d.ts:376,391` · ext.md:346 | documented-stable |
| `resources_discover` | `{type, cwd, reason:"startup"\|"reload"}` → `{skillPaths?,promptPaths?,themePaths?}` | `types.d.ts:393` · ext.md:365 | documented-stable |
| `session_start` | `{type, reason:"startup"\|"reload"\|"new"\|"resume"\|"fork", previousSessionFile?}` | `types.d.ts:405` · ext.md:386 | documented-stable |
| `session_before_switch` | `{type, reason, targetSessionFile?}` → `{cancel?}` | `types.d.ts:413` · ext.md:398 | documented-stable |
| `session_before_fork` | `{type, entryId, position}` → `{cancel?, skipConversationRestore?}` | `types.d.ts:419` · ext.md:417 | documented-stable |
| `session_before_compact` | `{type, preparation, branchEntries, reason, willRetry, signal}` → `{cancel?,compaction?}` | `types.d.ts:425` · ext.md:434 | documented-stable |
| `session_compact` | `{type, compactionEntry, fromExtension, reason, willRetry}` | `types.d.ts:437` · ext.md:434 | documented-stable |
| `session_before_tree` | `{type, preparation, signal}` → `{cancel?,summary?,…}` | `types.d.ts:468` · ext.md:466 | documented-stable |
| `session_tree` | `{type, newLeafId, oldLeafId, summaryEntry?, fromExtension?}` | `types.d.ts:474` · ext.md:466 | documented-stable |
| `session_shutdown` | `{type, reason:"quit"\|"reload"\|"new"\|"resume"\|"fork", targetSessionFile?}` | `types.d.ts:447` · ext.md:483 | documented-stable |
| `before_agent_start` | `{type, prompt, images?, systemPrompt, systemPromptOptions}` → `{message?,systemPrompt?}` | `types.d.ts:499` · ext.md:497 | documented-stable |
| `agent_start` | `{type}` | `types.d.ts:511` · ext.md:534 | documented-stable |
| `agent_end` | `{type, messages: AgentMessage[]}` | `types.d.ts:515` · ext.md:534 | documented-stable |
| `turn_start` | `{type, turnIndex, timestamp}` | `types.d.ts:520` · ext.md:546 | documented-stable |
| `turn_end` | `{type, turnIndex, message, toolResults}` | `types.d.ts:526` · ext.md:546 | documented-stable |
| `message_start` | `{type, message: AgentMessage}` (user/assistant/toolResult) | `types.d.ts:533` · ext.md:560 | documented-stable |
| `message_update` | `{type, message, assistantMessageEvent}` — **the token-by-token delta** | `types.d.ts:538` · ext.md:560 | documented-stable |
| `message_end` | `{type, message}` → `{message?}` (replace, must keep role) | `types.d.ts:544` · ext.md:560 | documented-stable |
| `tool_execution_start` | `{type, toolCallId, toolName, args}` | `types.d.ts:549` · ext.md:596 | documented-stable |
| `tool_execution_update` | `{type, toolCallId, toolName, args, partialResult}` | `types.d.ts:556` · ext.md:596 | documented-stable |
| `tool_execution_end` | `{type, toolCallId, toolName, result, isError}` | `types.d.ts:564` · ext.md:596 | documented-stable |
| `model_select` | `{type, model, previousModel?, source:"set"\|"cycle"\|"restore"}` | `types.d.ts:573` · ext.md:667 | documented-stable |
| `thinking_level_select` | `{type, level: ThinkingLevel, previousLevel}` | `types.d.ts:580` · ext.md:688 | documented-stable |
| `context` | `{type, messages: AgentMessage[]}` → `{messages?}` (pre-LLM, can modify) | `types.d.ts:483` · ext.md:620 | documented-stable |
| `before_provider_request` | `{type, payload: unknown}` → replace payload | `types.d.ts:488` · ext.md:632 | documented-stable |
| `after_provider_response` | `{type, status, headers}` | `types.d.ts:493` · ext.md:649 | documented-stable |
| `tool_call` | `{type, toolCallId, toolName, input}` (per-tool union) → `{block?,reason?}` | `types.d.ts:619,661` · ext.md:705 | documented-stable |
| `tool_result` | `{type, toolCallId, toolName, input, content, isError, details}` → `{content?,details?,isError?}` | `types.d.ts:662,702` · ext.md:768 | documented-stable |
| `user_bash` | `{type, command, excludeFromContext, cwd}` → `{operations?,result?}` | `types.d.ts:586` · ext.md:805 | documented-stable |
| `input` | `{type, text, images?, source:"interactive"\|"rpc"\|"extension", streamingBehavior?}` → continue/transform/handled | `types.d.ts:598` · ext.md:837 | documented-stable |

This is **30 event types** vs tau's ~14 (§2). For the mirror, the streaming spine is `message_start` /
`message_update` / `message_end` + `tool_execution_*`; the rest are status/lifecycle.

> Note on "more sources of streaming": there is **no per-token cost/usage delta event** in 0.80.2 — usage is
> read on demand via `ctx.getContextUsage()` (§1c) and assembled `AgentMessage`s carry usage at `message_end`.
> There is **no dedicated permission/approval-request event**; tool gating runs through the `tool_call`
> handler's `{block,reason}` return (the extension *is* the approval point), and `project_trust` is the only
> trust dialog. Sub-agent spawns are not first-class events in 0.80.2 (HALT item, §7).

### 1b. Control / input methods

`pi.*` methods (registration + actions) and `ctx.*` (per-handler). Tau's talk-back verbs map cleanly here.

| Method | Signature (abbrev) | Semantics | Source | Stability |
|---|---|---|---|---|
| `pi.sendUserMessage` | `(content: string \| (Text\|Image)[], {deliverAs?:"steer"\|"followUp"}) => void` | Inject a user turn. Idle → starts a turn. Streaming → `steer` interrupts after current tool batch; `followUp` waits until idle. | `types.d.ts:875` · ext.md(input) | documented-stable |
| `pi.sendMessage` | `({customType,content,display,details}, {triggerTurn?, deliverAs?:"steer"\|"followUp"\|"nextTurn"}) => void` | Custom (non-user) message; `nextTurn` queues for the next prompt. | `types.d.ts:867` | documented-stable |
| `ctx.abort` | `() => void` | Abort the current agent op (the streaming turn). | `types.d.ts:230` · ext.md(ctx) | documented-stable |
| `pi.setModel` | `(model: Model) => Promise<boolean>` | Switch model; `false` if no API key. | `types.d.ts:897` | documented-stable |
| `pi.getThinkingLevel` / `pi.setThinkingLevel` | `() => ThinkingLevel` / `(level) => void` | `ThinkingLevel = "off"\|"minimal"\|"low"\|"medium"\|"high"\|"xhigh"` (agent-core `types.d.ts:250`). | `types.d.ts:899,901` | documented-stable |
| `ctx.compact` | `({customInstructions?, onComplete?, onError?}) => void` | Fire-and-forget compaction. | `types.d.ts:238` | documented-stable |
| `pi.registerCommand` | `(name, {description?, handler:(args, ctx:ExtensionCommandContext)=>Promise<void>, …}) => void` | Slash command; handler `ctx` adds session control (`newSession`/`fork`/`switchSession`/`waitForIdle`/`reload`). | `types.d.ts:850,246` | documented-stable |
| `pi.registerShortcut` / `pi.registerFlag` / `pi.getFlag` | shortcut: `(KeyId,{handler})`; flag: `(name,{type,default})` ; `getFlag(name)` | Keybind / CLI flag (use a flag to receive piflow's socket path at spawn — §3). | `types.d.ts:852,857,863` | documented-stable |
| `pi.setSessionName` / `pi.getSessionName` | `(name)=>void` / `()=>string\|undefined` | Session display name. | `types.d.ts:881,883` | documented-stable |
| `ctx.shutdown` | `() => void` | Graceful shutdown + exit (deferred to idle in interactive). | `types.d.ts:233` | documented-stable |
| `pi.events` | `EventBus {emit(channel,data); on(channel,handler):()=>void}` | **Generic inter-extension bus — NOT the lifecycle firehose.** | `event-bus.d.ts:1` · `types.d.ts:970` | documented-stable (but see finding #1) |
| `ctx.ui.onTerminalInput` | `(handler)=>()=>void` | Raw terminal bytes — **interactive (tui) mode only**; do not rely on it for the control channel. | `types.d.ts:77` | present-but-mode-gated |

### 1c. State accessors for snapshot-on-connect

When a web client attaches, send a full snapshot *then* deltas (tau's lesson). Assemble it from:

| Accessor | Returns | Source | Stability |
|---|---|---|---|
| `ctx.sessionManager.getEntries()` | `SessionEntry[]` (append-only; messages + model/thinking changes + custom) | `session-manager.d.ts:257,136` | documented-stable |
| `ctx.sessionManager.getBranch(fromId?)` | path root→leaf (resolves the active conversation) | `session-manager.d.ts:242` | documented-stable |
| `ctx.sessionManager.getSessionFile()` | `string \| undefined` (the JSONL path) | `session-manager.d.ts:189` | documented-stable |
| `ctx.sessionManager.getSessionName()` / `ctx.cwd` | display name / run folder | `session-manager.d.ts:210` · `types.d.ts:215` | documented-stable |
| `ctx.model` | `Model \| undefined` (current model) | `types.d.ts:222` | documented-stable |
| `ctx.getContextUsage()` | `{tokens:number\|null, contextWindow, percent:number\|null}` | `types.d.ts:192,236` | documented-stable |
| `ctx.isIdle()` / `ctx.hasPendingMessages()` | streaming/queue flags | `types.d.ts:224,232` | documented-stable |
| `pi.getThinkingLevel()` | current `ThinkingLevel` | `types.d.ts:899` | documented-stable |
| `ctx.modelRegistry.getAvailable()` | `Model[]` with auth configured (the model menu) | `model-registry.d.ts:57` | documented-stable |

This is exactly tau's `mirror_sync` payload, available 1:1 on the current API.

---

## 2. Diff vs tau (0.73 → 0.80): keep / changed / gone

tau's reference surface (from the prompt's FACTS, written against 0.73.1).

**KEEP — verified identical names/shapes on 0.80.2:**
- Entry shape `export default function (pi: ExtensionAPI) {…}` — still the contract (`types.d.ts:1037`).
- Events tau subscribes to all still exist with the same names: `agent_start/end`, `turn_start/end`,
  `message_start/update/end`, `tool_execution_start/update/end`, `model_select`, `session_start`,
  `session_shutdown` (`types.d.ts:817–846`).
- Talk-back: `pi.sendUserMessage(msg,{deliverAs:"steer"\|"followUp"})` (`types.d.ts:875`); `ctx.abort()`
  (`types.d.ts:230`); `pi.setModel` / `pi.setThinkingLevel` / `pi.getThinkingLevel` (`types.d.ts:897,901,899`);
  `ctx.compact({customInstructions,onComplete,onError})` (`types.d.ts:199,238`); `pi.registerCommand`
  (`types.d.ts:850`); `pi.get/setSessionName` (`types.d.ts:881,883`).
- Snapshot state: `ctx.sessionManager.getEntries()` (`session-manager.d.ts:257`), `ctx.model`,
  `ctx.getContextUsage()`, `ctx.isIdle()`, `ctx.modelRegistry.getAvailable()`,
  `ctx.sessionManager.getSessionFile()`, `ctx.cwd` — all present (§1c).

**CHANGED — same intent, watch the shape:**
- `auto_compaction_start/end` and `auto_retry_start/end` (tau's 0.73 list) are **not discrete events** on
  0.80.2. Compaction is now `session_before_compact` / `session_compact`, both carrying
  `reason:"manual"\|"threshold"\|"overflow"` and `willRetry` (`types.d.ts:425,437`) — i.e. the
  auto-compaction *and* the overflow-retry signal are folded into these two with a discriminator. Map tau's
  four to these two.
- `message_update` now carries `assistantMessageEvent: AssistantMessageEvent` alongside the running
  `message` (`types.d.ts:538`) — richer than 0.73's delta; fold using `message` (the assembled snapshot) and
  treat `assistantMessageEvent` as the optional fine-grained delta.
- `input` event gained `streamingBehavior` and `source:"interactive"\|"rpc"\|"extension"` (added 0.77,
  `CHANGELOG.md:394`) — lets the mirror tell a human keystroke apart from its own injected message (avoids
  echo loops, §6).
- `pi.sendMessage` second arg is `{triggerTurn?, deliverAs?}` with `deliverAs:"nextTurn"` added
  (`CHANGELOG.md:3452,3534`); the old `triggerTurn:boolean` positional is gone (pre-0.73 migration).

**GONE / NEW — do not carry tau's assumptions:**
- **No `session_session_start`-style "all events" hook and no `pi.on("*")`.** `pi.events` is a *generic bus*,
  not the lifecycle firehose (finding #1). Throw away any tau mental model where one subscription yields every
  event. Passthrough = enumerate (§3).
- **NEW: pi's own `--mode rpc` duplex** (`rpc.md`, `rpc-types.d.ts`) — tau predated/ignored it; it is now the
  strongest alternative transport for the *talk-back* half (§4). Its `RpcCommand` union is a superset of tau's
  WS up-channel; its event/`response`/`get_state` down-channel reimplements tau's `mirror_sync`/`response`.
- **NEW events worth mirroring** that tau never had: `before_agent_start`, `context`,
  `before_provider_request`, `after_provider_response`, `tool_call`/`tool_result` (gating + mutation),
  `user_bash`, `thinking_level_select`, the `session_before_*` / `session_tree` family,
  `resources_discover`, `project_trust` (§1a).
- **Session-replacement invalidation (0.79):** after `newSession()`/`fork()`/`switchSession()`, captured
  `pi`/`ctx`/`sessionManager` references **throw** (stale); post-switch work must run inside the `withSession`
  callback (`CHANGELOG.md:954`). tau's "hold one `pi` for the process lifetime" assumption breaks here — the
  mirror must re-bind on session replacement (§6).

---

## 3. Pi-side `-e` mirror extension design

A single piflow-owned extension file, injected at spawn via `-e` (not `pi install`). It opens a transport,
sends a snapshot on connect, forwards every lifecycle event generically, and accepts the input/control verbs.

### 3.1 Host mode — interactive control pi runs `--mode rpc`, not `--mode json`

The DAG nodes spawn pi headless in `--mode json` (`command.ts:71`: `-p --mode json … --no-extensions`). The
**control session is interactive** (architecture decision), so it must NOT reuse that argv. Pick `--mode rpc`:
`ctx.mode==="rpc"` has `hasUI:true` (`extensions.md:2592`), a structured input channel, and runs extensions —
whereas `--mode json` has `hasUI:false` and UI methods are no-ops (`extensions.md:2593`). The control pi argv
is a *separate* builder (do not edit `defaultPiCommand`; add a sibling, e.g. `controlPiCommand`, that drops
`-p/--mode json/--no-extensions` and uses `--mode rpc`, keeps `--provider`/`--model`/`--thinking`, sets
`cwd=runDir` at the sandbox layer like `local.ts:120,134`, and adds `-e <mirror.ts>`).

### 3.2 Entry shape (piflow's own composition; grounded in verified API)

```ts
// GENERATED/STAGED by @piflow/core — piflow control-session mirror. Injected via `pi -e`.
// Verified API: ExtensionFactory (types.d.ts:1037), ExtensionAPI.on overloads (types.d.ts:817-846).
import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";

// The full event-name set (§1a). New pi events are added here ONLY — handlers are generic.
const MIRRORED_EVENTS = [
  "project_trust","resources_discover",
  "session_start","session_before_switch","session_before_fork",
  "session_before_compact","session_compact","session_shutdown",
  "session_before_tree","session_tree",
  "before_agent_start","agent_start","agent_end","turn_start","turn_end",
  "message_start","message_update","message_end",
  "tool_execution_start","tool_execution_update","tool_execution_end",
  "model_select","thinking_level_select",
  "context","before_provider_request","after_provider_response",
  "tool_call","tool_result","user_bash","input",
] as const;

export default function (pi: ExtensionAPI): void {
  // Receive the socket path piflow passes at spawn (registerFlag — types.d.ts:857).
  pi.registerFlag("piflow-mirror-sock", { type: "string", description: "piflow mirror socket path" });

  let sink: MirrorSink | undefined;       // the transport (§4) — opened lazily on session_start
  let lastCtx: ExtensionContext | undefined;

  // --- GENERIC forward: identical handler for every event type. New event types in pi
  //     flow through the moment their name is added to MIRRORED_EVENTS above — no per-event code. ---
  const forward = (event: ExtensionEvent, ctx: ExtensionContext) => {
    lastCtx = ctx;
    // pure passthrough envelope; observer-tier policy NEVER mutates (return undefined => no change)
    sink?.send({ v: 1, type: "event", event });
    return undefined; // never block/transform — the mirror is read-only on the agent (CLAUDE.md boundary)
  };
  for (const name of MIRRORED_EVENTS) pi.on(name as any, forward);

  // --- Lifecycle: start at session_start, snapshot on connect, teardown on shutdown ---
  pi.on("session_start", (_e, ctx) => {
    lastCtx = ctx;
    const sockPath = pi.getFlag("piflow-mirror-sock");
    if (typeof sockPath === "string") sink = openSink(sockPath, () => snapshot(pi, ctx));
  });
  pi.on("session_shutdown", () => { sink?.close(); sink = undefined; });

  // --- Input/control: accept up-channel verbs, translate to verified API, ALWAYS reply by id ---
  sinkOnCommand((cmd) => handleCommand(cmd, pi, () => lastCtx));
}
```

`snapshot()` assembles tau's `mirror_sync` from §1c: `{entries: ctx.sessionManager.getEntries(), model:
ctx.model, thinkingLevel: pi.getThinkingLevel(), sessionName: ctx.sessionManager.getSessionName(),
sessionFile: ctx.sessionManager.getSessionFile(), isStreaming: !ctx.isIdle(), contextUsage:
ctx.getContextUsage(), availableModels: ctx.modelRegistry.getAvailable(), cwd: ctx.cwd}`. Sent as the first
frame to each connecting client, then deltas flow via `forward`.

`handleCommand()` maps the up-channel to verified methods (§1b), every reply tagged with the request `id`:

| up-channel verb | pi call | source |
|---|---|---|
| `prompt` / `steer` / `follow_up` | `pi.sendUserMessage(text, {deliverAs})` | `types.d.ts:875` |
| `abort` | `ctx().abort()` | `types.d.ts:230` |
| `set_model` | `await pi.setModel(modelRegistry.find(provider,id))` | `types.d.ts:897`,`model-registry.d.ts:61` |
| `set_thinking_level` | `pi.setThinkingLevel(level)` | `types.d.ts:901` |
| `compact` | `ctx().compact({customInstructions})` | `types.d.ts:238` |
| `get_state` / `get_messages` / `mirror_sync_request` | re-send `snapshot()` | §1c |
| `shutdown` | `ctx().shutdown()` | `types.d.ts:233` |

### 3.3 Lifecycle + orphan safety
- **Start at spawn, not at module load.** The factory only registers; the socket opens in `session_start`
  (`extensions.md:219–223` explicitly forbids starting sockets/timers from the factory).
- **Teardown on `session_shutdown`** (idempotent close), which fires on quit/reload/replacement
  (`types.d.ts:447`).
- **Session-replacement re-bind.** On `session_before_switch`/`fork` the captured `ctx`/`sessionManager` go
  stale (§2, `CHANGELOG.md:954`); the mirror always uses the *latest* `ctx` from `forward`/`session_start`
  (`lastCtx`) and re-snapshots on the next `session_start` — it never holds a `ctx` across a replacement.
- **Orphan cleanup.** The control pi is a child piflow owns (like the node spawn in `local.ts:134`,
  `detached:true`, own process group); piflow kills the group on session end. The mirror additionally exits if
  the socket peer is gone for > N heartbeats (defends against a leaked pi if the bridge dies).

### 3.4 Injection at spawn (fit `runner/command.ts`, do NOT touch `defaultPiCommand`)
- The mirror `.ts` is **staged into the sandbox** exactly like the tool extension today —
  `runner.ts:1416–1420` writes `resolved.extension` to `<nodeStage>/tools.ts` via `sandbox.writeFile`; the
  control path writes `mirror.ts` the same way and threads its path as an **extra** extension. `command.ts:80`
  already loops `opts.extraExtensions` into `-e <ext>` *before* the staged tool extension, so the mirror rides
  that seam — no edit to the builder's invariants.
- Pass the socket path as `--piflow-mirror-sock <path>` (the flag the mirror registers, §3.2). pi's CLI
  forwards unknown flags to extension-registered flags.
- Keep the SDK product-agnostic: the mirror source is generated/staged by `@piflow/core` (like `compile.ts`),
  not committed; both pi scopes stay in `PI_INJECTED_EXTERNALS` (`compile.ts:284–290`) so a bundled mirror
  keeps pi external.

---

## 4. Transport decision

**Decision: REUSE piflow's existing SSE-down + POST-up courier seam end-to-end. The pi-side mirror does NOT
open a WebSocket and does NOT serve HTTP itself; it speaks the simplest possible local IPC to the piflow
bridge (a Unix-domain socket / localhost line-stream), and the bridge re-exposes it on the existing
`/__piflow/...` surface.** No new WebSocket stack.

**Rationale (explicit):**
1. **The duplex requirement is already met without WS.** Down = SSE (`GET /__piflow/control/<run>/stream`,
   the same `text/event-stream` machinery as `piflowRunStream`, `vite.config.ts:120–141`). Up = POST
   (`POST /__piflow/control/<run>/message`|`/intent`, the same dumb-courier shape as
   `piflowCheckpointReply` → `writeCheckpointReply`, `vite.config.ts:519–524`,
   `checkpoint-reply.mjs:33`). Full duplex = two unidirectional HTTP channels, which the GUI client already
   runs (`runStream.ts:124` EventSource + `fetch` POST). WS would buy nothing the courier+SSE pair doesn't.
2. **It unifies with the runner-as-authority + cloud reattach** — exactly the `control-session-mirror.md`
   §"who hosts the mirror" recommendation (prototype (i) self-serve, *land* (ii) bridge-pipes). Cloud is a
   base-URL swap (`detached-run-control-vm.md`); the GUI client is byte-identical local vs cloud.
3. **The mirror stays trivially small and supported.** Writing JSONL to a Unix socket needs only Node's
   `net`/`fs` (no `ws`, no `qrcode` — tau's deps); the only pi API it touches is the documented-stable
   extension surface (§1).
4. **Pi already ships a duplex we can fall back to.** If the `-e` socket proves fragile, the *talk-back* half
   can drop the mirror entirely and drive `pi --mode rpc` over the child's **stdin/stdout JSONL**
   (`rpc.md:22–24`): `prompt`/`steer`/`abort`/`get_state`/`get_messages`/`compact` are native commands
   (`rpc-types.d.ts`). The bridge would write RPC commands to the child's stdin and read events from stdout —
   no extension at all. This is the documented fallback in §6/§7. (The `-e` mirror is still preferred because
   it gives the *generic event passthrough* and snapshot composition we control, and keeps the
   transport uniform with telemetry.)

**Why a Unix socket between mirror and bridge (not the mirror serving HTTP):** keeps the "runner/bridge is the
sole network authority" property — the pi child never binds a public port (no auth surface on the pi side; §6),
and the bridge already owns the `/__piflow/...` auth/jail perimeter (`vite.config.ts` realpath jail at
`piflowFile`). The socket path lives under the run dir (e.g. `<runDir>/.pi/control/mirror.sock`), discoverable
the same way the bridge finds other run artifacts.

**Flow:**
```
control pi (cwd=runDir, --mode rpc, -e mirror.ts)
   │  JSONL over <runDir>/.pi/control/mirror.sock  (events ▲ down, commands ▼ up)
piflow bridge (Vite middleware dev / piflowctl prod)
   ├─ GET  /__piflow/control/<run>/stream   → SSE: relays mirror event frames + meta/heartbeat  (like vite.config.ts:120)
   ├─ POST /__piflow/control/<run>/message  → forwards {prompt|steer|follow_up|abort|set_model|…} to the socket (like :519)
   └─ POST /__piflow/control/<run>/intent   → writes .pi/control/<seq>.json; the RUNNER validates+acts (mirror.md courier)
GUI: extends the existing EventSource/POST client (§5)
```
Lifecycle ops (`restart`/`resume`/`re-run`) do **not** go to the pi at all — they go to `/intent`, the
runner's one validated door (`control-session-mirror.md` §"two classes"); the pi only does chat + file edits.

---

## 5. Web-side acceptance design

Fit the existing client (`runStream.ts` + `Companion.tsx`), do not stand up a parallel stack.

### 5.1 Extend `runStream.ts` — one more `Frame` kind, reuse the connection where possible
The telemetry `Frame` union (`runStream.ts:40–47`) is the observe `RunUpdate` kinds + `meta`/`stream-error`.
Add a **control-session frame** carrying the mirror's generic event envelope:
```ts
// add to the Frame union (runStream.ts:41)
| { kind: "companion-event"; event: import("…").ExtensionEvent }   // pi mirror lifecycle event (§1a)
| { kind: "companion-snapshot"; snapshot: MirrorSnapshot }          // the §1c snapshot-on-connect
| { kind: "companion-response"; id: string; ok: boolean; data?: unknown } // reply to an up-channel command
```
**Connection choice — a SECOND EventSource, by design.** The telemetry stream
(`/__piflow/stream/<run>`) must stay **pure one-way DAG telemetry** (`control-session-mirror.md` §"two
channels": the control channel is *separate to keep telemetry one-way*). So the companion opens a *distinct*
`EventSource("/__piflow/control/<run>/stream")` — but it lives behind the **same `RunStreamContext`
multiplex** (`runStream.ts:70–73`): `CanvasInner` (or a sibling provider) owns this one too, and the Companion
reads it via `useRunStreamContext()` (it already does for telemetry — `Companion.tsx:45`). Two upstreams,
**still one shared subscription per stream, zero per-consumer reconnections** — honoring the
"dedup the tap" rule (`control-session-mirror.md` §readers).

### 5.2 Client-side fold (tau's transferable pattern, our types)
Reduce control frames into a companion view-model alongside the telemetry reducer (`runStream.ts:75–95`):
- **messages**: fold `message_start`→ append; `message_update`→ replace-in-place by the message's id (use the
  assembled `event.message`); `message_end`→ finalize. Seed from `companion-snapshot.entries`.
- **toolExecutions: `Map<toolCallId, {name,args,partial,result,isError,phase}>`** keyed by `toolCallId` so
  `tool_execution_start/update/end` (and `tool_call`/`tool_result`) collapse into ONE card (the explicit tau
  lesson; `toolCallId` is the stable key per `types.d.ts:549,309`).
- **status**: `model_select`→ model; `thinking_level_select`→ level; `agent_start`/`agent_end` +
  `isStreaming` from snapshot → busy/idle; `session_compact`→ context-usage refresh.
- **forward-compatible**: an unknown `event.type` is still rendered as a generic row (passthrough), so a new
  pi event shows up in the log without a client change (mirrors §3's generic forward).

### 5.3 Reconnect + snapshot-on-reconnect
EventSource auto-reconnects; on each (re)open the bridge re-sends `companion-snapshot` first (the mirror's
`snapshot()` on a new socket peer, §3.2), then deltas — so a late joiner or a dropped client always
re-bases. Stop reconnecting on a terminal `{kind:"done"}`/session_shutdown (the existing `runStream.ts:130`
pattern). Add exponential backoff + a heartbeat read (the bridge already emits `:ping` every 15s,
`vite.config.ts:128`).

### 5.4 Wire `Companion.tsx:55` `sendToPi` → the up-channel
Replace the commented seam (`Companion.tsx:55`: `// sendToPi(text, { run, node }) ← wire here`) with a POST to
the courier:
```ts
// Companion.tsx send()
await fetch(`/__piflow/control/${encodeURIComponent(activeRun)}/message`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ v: 1, id: crypto.randomUUID(), type: "prompt",
                         text, deliverAs: live.isStreaming ? "steer" : undefined,
                         node: expandedId }),  // node = the already-carried expandedId context
});
// the pi's reply streams back as companion-event/message_* frames on the control EventSource (§5.1)
```
The optimistic local echo (`Companion.tsx:56–60`) stays; the honest "not wired yet" system line is removed
once the stream is live. Abort/lifecycle buttons POST `{type:"abort"}` to `/message` and restart/resume to
`/intent` respectively.

---

## 6. Robustness & future-proofing

- **Generic / forward-compatible event forwarding.** §3's `forward` is one handler bound across the
  enumerated name set; the *envelope* (`{v,type:"event",event}`) is opaque, and §5.2 renders unknown
  `event.type` generically. A new pi event needs only its name added to `MIRRORED_EVENTS` (one line) — and if
  we drive `--mode rpc` instead (§4 fallback), even that is unnecessary because RPC streams all events to
  stdout natively. **Risk:** the `pi.on` overloads are name-typed, so `MIRRORED_EVENTS` won't auto-grow;
  mitigate with a CI check that diffs the array against the exported `ExtensionEvent` union (HALT item §7).
- **Versioned wire protocol.** Every frame carries `v:1` (down) and every command carries `v` + `id` (up);
  the bridge rejects unknown `v`. This lets the mirror, bridge, and GUI roll independently and matches pi's
  own `id`-tagged request/response discipline (`rpc-types.d.ts`).
- **Reconnect / backpressure / heartbeat.** Reconnect = EventSource + backoff (§5.3); heartbeat = the
  bridge's existing `:ping` (`vite.config.ts:128`) plus a mirror→bridge keepalive on the socket. Backpressure:
  the mirror sends best-effort and **drops fine-grained `message_update`/`tool_execution_update` deltas under
  pressure** (coalesce to the latest per message-id / toolCallId), because `message_end`/`tool_execution_end`
  carry the authoritative final state — the snapshot-then-delta model self-heals a dropped delta on the next
  resync. Never block the agent on a slow client (the `forward` handler must not `await` the socket).
- **Multiple clients + late joiners.** The bridge fans one socket out to N SSE subscribers (the existing
  multiplex). Each new SSE connection triggers a fresh `companion-snapshot` (§5.3). Readers are unlimited and
  harmless (`control-session-mirror.md` §readers); only *writers* go through the courier, which the runner
  serializes (`checkpoint-reply.mjs` re-validation pattern).
- **pi restart / abort / crash.** `abort` → `ctx.abort()` (turn only, pi stays up). pi crash/exit →
  `session_shutdown` (clean) or socket EOF (dirty) → bridge emits a terminal control frame; GUI shows
  "session ended", offers re-`start`. The runner owns the child's process group (`local.ts:134`
  `detached:true`) so a crashed bridge cannot orphan the pi (§3.3). Session replacement re-binds (§3.3).
- **Auth on the socket.** The pi child binds **no network port** — it speaks a Unix-domain socket under the
  run dir (§4), so there is no listening surface to auth. The *only* authenticated/jailed boundary is the
  bridge's `/__piflow/...` perimeter (already realpath-jailed for file reads, `vite.config.ts` `piflowFile`);
  cloud adds the `detached-run-control-vm.md` bearer-token + reverse-proxy in front of it. **Never** let the
  mirror open a TCP/WS listener (that is tau's mobile-QR model, which we explicitly are not copying).
- **Rest only on supported API + flagged fallbacks.** Everything in §1 is from `types.d.ts`/`session-manager.d.ts`/
  `model-registry.d.ts`/`event-bus.d.ts` and `docs/extensions.md` (documented-stable). **Private-API
  reliance: none required.** The one mode-gated item, `ctx.ui.onTerminalInput` (tui-only, `types.d.ts:77`),
  is **not used** — input arrives over the socket, not the terminal. Fallbacks: (a) if the `-e` socket is
  unreliable, switch the talk-back half to native `pi --mode rpc` over child stdio (§4) — zero extension; (b)
  if generic `pi.on` enumeration is a maintenance burden, the RPC path makes it moot.

---

## 7. Open questions / verification gaps (HALT-and-check)

- **Sub-agent / nested-agent events.** 0.80.2 has no first-class sub-agent spawn event in `ExtensionEvent`
  (§1a). If the control/SRE pi spawns sub-agents, their activity may only surface as `tool_*` of a spawning
  tool. **HALT**: confirm against pi's agent-spawn tool (if any) and the `agent-session` SDK before promising
  hierarchical sub-agent tracing in the mirror.
- **`assistantMessageEvent` (the `message_update` delta) inner shape.** I cited it exists
  (`types.d.ts:538`, type `AssistantMessageEvent` from `@earendil-works/pi-ai`) but did not enumerate its
  variant fields. The fold in §5.2 deliberately uses the assembled `event.message` (stable) rather than the
  delta, so this is non-blocking — but if we want true token-streaming UI, **verify** `AssistantMessageEvent`
  in `pi-ai` `dist/types.d.ts` first.
- **Does `--mode rpc` accept `-e` extensions and run their socket cleanly?** `extensions.md:2592` says RPC
  runs extensions with `hasUI:true`, but I did not runtime-verify a socket-opening extension under
  `--mode rpc`. **HALT**: smoke-test `pi --mode rpc -e mirror.ts` before committing the mode choice; the §4
  fallback (pure RPC stdio, no extension) de-risks this.
- **`MIRRORED_EVENTS` drift.** The name list is hand-maintained against the `ExtensionEvent` union; needs a CI
  diff-check (§6) so a future pi event isn't silently dropped.
- **Live version skew.** The bin in use is **0.79.10**, the spec targets **0.80.2**; the extension surface
  matched across both in my inspection, but pin the runner to a known pi version (or feature-detect) before
  shipping, since the `session_before_*` invalidation semantics (§2) changed within the 0.79 line.
- **Exact GUI provider ownership for the second EventSource.** §5.1 assumes a `CanvasInner`-style owner
  provides the control stream through `RunStreamContext`; confirm whether to extend that context or add a
  sibling `ControlStreamContext` so telemetry and control reducers stay cleanly separated.

*(No `NEEDS_API_ACCESS`: strategies 2a (installed 0.79.10) and 2b (packed 0.80.2) both succeeded; the current
extension API was read directly from the package, not inferred.)*
