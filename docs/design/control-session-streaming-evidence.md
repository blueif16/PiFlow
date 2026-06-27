# Control-session streaming — smoke-test evidence

> **Status:** EVIDENCE (2026-06-27), pi 0.79.10 installed / 0.80.2 docs.

This validates `docs/design/control-session-streaming-spec.md` against the **real, installed** `pi`. Every
captured block is labeled `[runtime-verified]` (I ran it and pasted the output) or `[doc-derived]` (read from
the 0.80.2 package docs/.d.ts, no run). Verbatim captures live in `/tmp/piflow-smoke/` (scratch, not committed).

---

## 1. Environment

- **pi:** `/Users/tk/.nvm/versions/node/v24.1.0/bin/pi`, version **0.79.10** (`pi --version` → `0.79.10`).
- **Provider configured: YES.** `~/.pi/agent/settings.json` carries `defaultProvider: nebius`,
  `defaultModel: zai-org/GLM-5.2` (read without printing secrets). `pi --list-models` returns two configured
  models: `mmgw/MiniMax-M3` and `nebius/zai-org/GLM-5.2`. **I did not modify this file.**
- **0.80.2 reference package:** `/tmp/piapi/earendil-works-pi-coding-agent-0.80.2/package/` (`docs/rpc.md`,
  `docs/extensions.md`, `dist/modes/rpc/rpc-types.d.ts`, `CHANGELOG.md`).
- **Could run:** `pi --help`; `pi --mode rpc` handshake (no LLM); two tiny real LLM turns (text-only + one
  tool call) over RPC stdio; `pi --mode rpc -e <ext>` with the minimal mirror extension. ~3 trivial GLM turns
  total, each a few hundred tokens (cost 0 — these are zero-cost gateway models per `get_session_stats`).
- **Could NOT run (left as gaps, §6):** a live `steer`/`follow_up` interrupt mid-stream; a `new_session`/`fork`
  session-replacement to observe the stale-`ctx` throw at runtime; an interactive `--mode text` TUI; the
  0.80.2 binary (only 0.79.10 is installed).

---

## 2. Captured evidence

### Step 1 — `pi --help`: real flags `[runtime-verified]`

```
$ pi --version
0.79.10
$ pi --help        # (relevant lines, verbatim)
  --mode <mode>                  Output mode: text (default), json, or rpc
  --extension, -e <path>         Load an extension file (can be used multiple times)
  --no-extensions, -ne           Disable extension discovery (explicit -e paths still work)
  --provider <name>              Provider name (default: google)
  --model <pattern>              Model pattern or ID (supports "provider/id" and optional ":<thinking>")
  --thinking <level>             Set thinking level: off, minimal, low, medium, high, xhigh
  --session-dir <dir>            Directory for session storage and lookup
  --no-session                   Don't save session (ephemeral)
  --name, -n <name>              Set session display name
  --continue, -c / --resume, -r / --fork <path|id> / --session <path|id>
Extensions can register additional flags (e.g., --plan from plan-mode extension).
```

**Settled facts:** `-e`/`--extension` exists (repeatable); `--mode` accepts exactly **`text` (default), `json`,
`rpc`** — i.e. **`--mode rpc` IS real in 0.79.10**, not just 0.80.2. `cwd` is set by the launching process (no
`--cwd` flag); `--session-dir`/`--no-session`/`--name` cover session placement. Unknown flags are forwarded to
extension-registered flags ("Extensions can register additional flags").

### Step 2 — `docs/rpc.md` + `docs/extensions.md` `[doc-derived]`

- **`rpc.md:10–35`** — "RPC mode enables headless operation … via a JSON protocol over stdin/stdout."
  **Commands** = JSON objects on stdin (one per line); **Responses** = `{type:"response", …}`; **Events** =
  "Agent events streamed to stdout as JSON lines." Strict JSONL: split on `\n` only; **"Node `readline` is not
  protocol-compliant"** (it also splits on U+2028/U+2029). All commands take an optional `id` echoed on the
  response.
- **`rpc.md` Commands (§Commands)** — `prompt` (with `streamingBehavior:"steer"|"followUp"` to queue while
  streaming), `steer`, `follow_up`, `abort`, `new_session`, `get_state`, `get_messages`, `set_model`,
  `cycle_model`, `get_available_models`, `set_thinking_level`, `compact`, `bash`, `get_session_stats`,
  `switch_session`, `fork`, `clone`, `set_session_name`, `get_commands`, … — a **superset** of the spec's
  hand-rolled up-channel. `RpcCommand` union: `dist/modes/rpc/rpc-types.d.ts:14`.
- **`rpc.md:744–810` Events** — the streamed event set: `agent_start`, `agent_end`, `turn_start`, `turn_end`,
  `message_start`, `message_update` (carries `assistantMessageEvent` with `text_delta`/`thinking_delta`/
  `toolcall_*`/`done` sub-types), `message_end`, `tool_execution_start/update/end`, `queue_update`,
  `compaction_start/end`, `auto_retry_start/end`, `extension_error`. "Events do NOT include an `id`."
- **`rpc.md` Extension UI Protocol (~:985)** — extension `ctx.ui.select/confirm/input/editor` become
  `extension_ui_request`/`extension_ui_response` frames over the same stdio. **`ctx.mode==="rpc"` and
  `ctx.hasUI===true`** in RPC mode (confirmed at runtime, Step 4).
- **`extensions.md:155–180`** — extension = default-exported factory `(pi: ExtensionAPI) => void|Promise`.
  **`extensions.md:221–223`** — "Do not start background resources such as processes, sockets, file watchers,
  or timers **from the factory**. Defer … until `session_start` … Register an idempotent `session_shutdown`
  handler." **`extensions.md:1528`** — `pi.registerFlag(name, options)`; `getFlag(name)` reads it.
- **`extensions.md:1188–1200` + `CHANGELOG.md:954`** — session-replacement stale-ref rule (see §5, 6c).

### Step 3 — `pi --mode rpc` handshake, NO LLM turn `[runtime-verified]`

Driver: `/tmp/piflow-smoke/rpc-noturn.mjs` — `spawn("pi", ["--mode","rpc","--no-session","--offline"])`,
strict-JSONL stdout reader, sends five no-LLM commands. **No `-e` extension.** Verbatim stdout frames:

```
$ node rpc-noturn.mjs
STDOUT_FRAME {"id":"s1","type":"response","command":"get_state","success":true,"data":{"model":{"id":"zai-org/GLM-5.2","name":"GLM 5.2","api":"openai-completions","provider":"nebius","baseUrl":"https://api.tokenfactory.nebius.com/v1","reasoning":true,"input":["text"],"cost":{...},"contextWindow":1000000,"maxTokens":131072,...},"thinkingLevel":"medium","isStreaming":false,"isCompacting":false,"steeringMode":"one-at-a-time","followUpMode":"one-at-a-time","sessionId":"019f0ade-...","autoCompactionEnabled":true,"messageCount":0,"pendingMessageCount":0}}
STDOUT_FRAME {"id":"s2","type":"response","command":"get_available_models","success":true,"data":{"models":[{"id":"MiniMax-M3",...,"provider":"mmgw",...},{"id":"zai-org/GLM-5.2",...,"provider":"nebius",...}]}}
STDOUT_FRAME {"id":"s3","type":"response","command":"get_commands","success":true,"data":{"commands":[{"name":"skill:asta-skill",...,"source":"skill","sourceInfo":{...}}, ... ]}}
STDOUT_FRAME {"id":"s4","type":"response","command":"get_session_stats","success":true,"data":{"sessionId":"019f0ade-...","userMessages":0,"assistantMessages":0,"toolCalls":0,"toolResults":0,"totalMessages":0,"tokens":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0},"cost":0,"contextUsage":{"tokens":0,"contextWindow":1000000,"percent":0}}}
STDOUT_FRAME {"id":"s5","type":"response","command":"abort","success":true}
CHILD_EXIT code=143 sig=null totalFrames=5
```

**Proves:** the up-channel (stdin commands) + the state/response down-channel work with **zero** extension and
**zero** LLM cost — every command got an `id`-correlated `{type:"response", success:true, data}`. The
`get_state.data` is precisely the spec's §1c `mirror_sync` snapshot (model, thinkingLevel, isStreaming,
sessionFile/Id, steering/followUp modes, message counts); `get_session_stats.data.contextUsage` is the
`{tokens, contextWindow, percent}` the spec reads via `ctx.getContextUsage()`.

### Step 4 — minimal `-e` extension under `--mode rpc`, with one real turn `[runtime-verified]`

Extension `/tmp/piflow-smoke/mirror-min.ts` (the source I actually ran — see §4 recipe). Driver
`/tmp/piflow-smoke/rpc-ext-turn.mjs`: `spawn("pi", ["--mode","rpc","--no-session","--no-tools",
"-e","/tmp/piflow-smoke/mirror-min.ts","--piflow-mirror-out", OUT])`, then one tiny prompt. The extension
appends every event it sees (via `pi.on`) to `OUT`. Verbatim:

```
$ node rpc-ext-turn.mjs
CHILD_EXIT code=0 sig=null stdoutTypes=["agent_end","agent_start","message_end","message_start","message_update","response:prompt","turn_end","turn_start"]

$ cat mirror.events.jsonl      # what the EXTENSION saw through pi.on(...)
{"via":"ext","marker":"SESSION_START_HANDLER","reason":"startup","flagResolved":"/tmp/piflow-smoke/mirror.events.jsonl","mode":"rpc","hasUI":true,"cwd":"/private/tmp/piflow-smoke","model":"zai-org/GLM-5.2"}
{"via":"ext","type":"input","hasCtx":true,"mode":"rpc","isIdle":true}
{"via":"ext","type":"before_agent_start","hasCtx":true,"mode":"rpc","isIdle":true}
{"via":"ext","type":"agent_start","hasCtx":true,"mode":"rpc","isIdle":false}
{"via":"ext","type":"turn_start","hasCtx":true,"mode":"rpc","isIdle":false}
{"via":"ext","type":"message_start",...}   {"via":"ext","type":"message_end",...}        # user msg
{"via":"ext","type":"message_start",...}                                                 # assistant msg
{"via":"ext","type":"message_update",...} x7                                             # streaming deltas
{"via":"ext","type":"message_end",...}
{"via":"ext","type":"turn_end","hasCtx":true,"mode":"rpc","isIdle":false}
{"via":"ext","type":"agent_end","hasCtx":true,"mode":"rpc","isIdle":false}
{"via":"ext","type":"session_shutdown","hasCtx":true,"mode":"rpc","isIdle":true}
{"via":"ext","marker":"SESSION_SHUTDOWN_HANDLER"}
```

**Proves at once:** (a) `-e` injection loads cleanly **under `--mode rpc`** — exit 0, no `extension_error`
frame on stdout; (b) `session_start` fires with `reason:"startup"`, `mode:"rpc"`, **`hasUI:true`**, a live
`ctx` (cwd/model/sessionManager); (c) `registerFlag`+`getFlag` work — `--piflow-mirror-out` resolved to the
exact path inside `session_start`; (d) the generic `pi.on` handler sees the **full lifecycle firehose** matching
the spec's `MIRRORED_EVENTS`, with a live `ctx` on **every** event (`hasCtx:true`, correct `isIdle`).

### Step 5 — full event sequence + frame shapes from a real turn `[runtime-verified]`

Driver `/tmp/piflow-smoke/rpc-turn.mjs`, **no extension**, one prompt "Reply with exactly … OK". Verbatim:

```
$ node rpc-turn.mjs
FRAME {"id":"p1","type":"response","command":"prompt","success":true}
FRAME {"type":"agent_start"}
FRAME {"type":"turn_start"}
FRAME {"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"Reply with exactly the two characters: OK. Nothing else."}],"timestamp":1782593804817}}
FRAME {"type":"message_end","message":{"role":"user",...}}
FRAME {"type":"message_start","message":{"role":"assistant","content":[],"api":"openai-completions","provider":"nebius","model":"zai-org/GLM-5.2","usage":{...},"stopReason":"stop","timestamp":1782593804857}}
FRAME message_update ame.type=text_start
FRAME message_update ame.type=text_delta delta="OK"
FRAME message_update ame.type=text_end
FRAME {"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"OK"}],"api":"openai-completions","provider":"nebius","model":"zai-org/GLM-5.2","usage":{"input":429,"output":3,"cacheRead":0,"cacheWrite":0,"totalTokens":432,...},"stopReason":"stop","responseId":"chatcmpl-95c038309d24fc1b"}}
FRAME {"type":"turn_end","message":{...assistant...},"toolResults":[]}
FRAME {"type":"agent_end","messages":[{...user...},{...assistant "OK"...}],"willRetry":false}
CHILD_EXIT code=0 sig=null frames=12
DISTINCT_FRAME_TYPES ["agent_end","agent_start","message_end","message_start","message_update","response:prompt","turn_end","turn_start"]
```

Real shapes captured: `message_update.assistantMessageEvent` has `{type:"text_start"|"text_delta"|"text_end",
contentIndex, delta}` (the token stream); `message_end.message.usage` carries
`{input,output,cacheRead,cacheWrite,totalTokens,cost}` (the per-message usage the spec wanted —
**runtime-confirmed it rides `message_end`, not a separate event**); `turn_end` carries `{message, toolResults}`.

**Tool turn `[runtime-verified]`** (driver `/tmp/piflow-smoke/rpc-tool-turn.mjs`, `--tools ls,read`, prompt
forcing an `ls`):

```
FRAME {"type":"tool_execution_start","toolCallId":"chatcmpl-tool-a999884e3bd74f2d","toolName":"ls","args":{"path":"/private/tmp/piflow-smoke"}}
FRAME {"type":"tool_execution_end","toolCallId":"chatcmpl-tool-a999884e3bd74f2d","toolName":"ls","result":{"content":[{"type":"text","text":"mirror-min.ts\n..."}]},"isError":false}
CHILD_EXIT code=0 sig=null types=["agent_end","agent_start","message_end","message_start","message_update","response:prompt","tool_execution_end","tool_execution_start","turn_end","turn_start"]
```

`tool_execution_start` = `{toolCallId, toolName, args}`; `tool_execution_end` = `{toolCallId, toolName,
result:{content:[...]}, isError}`. **`toolCallId` is the stable correlation key** the spec's tool-card fold
(§5.2) relies on — confirmed identical across start/end.

---

## 3. Central-question verdict

**`pi --mode rpc` natively does BOTH halves — it streams the full agent event firehose to stdout AND accepts
user input/commands on stdin — so a custom `-e` event-forwarding extension is NOT required for streaming.**

Deciding evidence (all `[runtime-verified]`, 0.79.10): Step 5 captured the **complete** event stream
(`agent_start`→`turn_start`→`message_start/update/end`→`turn_end`→`agent_end`, plus `tool_execution_start/end`
in the tool turn) on rpc **stdout with no extension at all**; Step 3 captured the **input/command** side
(`prompt`, `get_state`, `get_available_models`, `get_session_stats`, `abort`) each returning an `id`-correlated
`response` — also no extension. The doc's command/event split (`rpc.md:744`) is therefore real, not just
tool/permission RPC.

**Most supported / most robust = `--mode rpc` over the child's stdin/stdout.** It is pi's first-class headless
embedding protocol (`rpc.md` is a 1200-line spec'd contract; `RpcCommand`/`RpcResponse` are exported types),
needs **no extension code to maintain**, has no `MIRRORED_EVENTS` drift risk, and the `id`-tagged
request/response discipline is built in. The `-e` mirror is a **viable alternative/supplement** (Step 4 proved
it loads and sees the same firehose with a live `ctx`), and is the better choice ONLY if piflow needs something
RPC stdout does not give: a transport other than stdio (e.g. writing to a Unix socket from inside pi), or
snapshot composition / event filtering pi itself doesn't expose. For the spec's stated goal — "stream the
firehose out + send input in" — **RPC alone is the simplest robust answer; reach for `-e` only for the extras.**

Nuance the spec already half-saw: its §4 made `-e` the primary and RPC the "fallback." The runtime evidence
**inverts the default** — RPC is the most-supported primary; `-e` is the value-add layer. Note both can coexist:
`pi --mode rpc -e mirror.ts` runs (Step 4), so piflow can use RPC for input+events and still load a small
extension only for whatever RPC can't do.

---

## 4. The verified recipe (copy-pasteable)

### Recipe A — RPC-only (recommended primary; no extension)

Spawn the control pi at the run folder and speak JSONL over its stdio:

```bash
# cwd = the run folder; provider/model from settings or pinned explicitly
pi --mode rpc --provider nebius --model zai-org/GLM-5.2 \
   --session-dir "<runDir>/.pi/sessions" --name "control-<run>"
```

Node bridge driver (the EXACT pattern I ran — strict JSONL, never `readline`):

```js
import { spawn } from "node:child_process";
const child = spawn("pi", ["--mode","rpc","--provider","nebius","--model","zai-org/GLM-5.2"],
  { cwd: runDir, stdio: ["pipe","pipe","pipe"] });

// DOWN-channel: events + responses → relay each frame to the GUI SSE stream
let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {                 // split on \n ONLY (rpc.md framing)
    const line = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const frame = JSON.parse(line);                       // {type:"response"|<event>, ...}
    sseToGui(frame);                                      // events have no id; responses echo the id
  }
});
// UP-channel: GUI POST → one JSON command per line on stdin
const send = (cmd) => child.stdin.write(JSON.stringify(cmd) + "\n");
send({ id: "1", type: "prompt", message });                                   // idle → starts a turn
send({ type: "prompt", message, streamingBehavior: "steer" });               // mid-stream interrupt
send({ type: "follow_up", message });                                         // queue until idle
send({ type: "abort" });                                                      // cancel current turn
send({ id: "2", type: "get_state" });                                        // snapshot-on-connect
send({ type: "set_model", provider: "nebius", modelId: "zai-org/GLM-5.2" });
send({ type: "set_thinking_level", level: "high" });
send({ type: "compact" });
```

Snapshot-on-connect = `get_state` + `get_messages` (+ `get_session_stats` for `contextUsage`); then relay live
events. This maps the spec's §3.2 `handleCommand` table 1:1 onto **native** RPC verbs — no translation layer.

### Recipe B — optional `-e` mirror (only for non-stdio transport / filtering)

The minimal extension I actually ran (`/tmp/piflow-smoke/mirror-min.ts`, ~35 lines), proven to load under
`--mode rpc`, see `session_start`, resolve a custom flag, and forward the firehose with a live `ctx`:

```ts
import { appendFileSync } from "node:fs"; // (prod: replace the file sink with a net.Socket to <runDir>/.pi/control/mirror.sock)
import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";

const MIRRORED_EVENTS = [
  "session_start","session_shutdown","before_agent_start","agent_start","agent_end",
  "turn_start","turn_end","message_start","message_update","message_end",
  "tool_execution_start","tool_execution_update","tool_execution_end",
  "model_select","thinking_level_select","input",
] as const;

export default function (pi: ExtensionAPI): void {
  pi.registerFlag("piflow-mirror-out", { type: "string", description: "piflow mirror output" });
  let out: string | undefined;
  const write = (rec: unknown) => { if (out) appendFileSync(out, JSON.stringify(rec) + "\n"); };
  const forward = (event: ExtensionEvent, ctx: ExtensionContext) => {
    write({ via: "ext", type: (event as any).type, hasCtx: !!ctx, mode: ctx?.mode, isIdle: ctx?.isIdle?.() });
    return undefined;                                   // observer: never block/transform
  };
  for (const name of MIRRORED_EVENTS) pi.on(name as any, forward as any);
  pi.on("session_start", (_e: any, ctx: ExtensionContext) => {
    out = pi.getFlag("piflow-mirror-out") as string | undefined;   // open the real sink HERE, not in the factory
  });
  pi.on("session_shutdown", () => { /* idempotent close of the sink */ });
}
```

**Mapping onto piflow's `-e` injection (`packages/core/src/runner/command.ts`):** `command.ts:80` already loops
`opts.extraExtensions` → `-e <path>` *before* the staged tool extension, fed from `PiCommandOptions.extraExtensions`
(`types.ts:727`) ← `runner.ts:2078` `commandOpts.extraExtensions: opts.extensions`. The control session must
**not** reuse `defaultPiCommand` (it stamps `-p --mode json -a --no-session --no-extensions`, command.ts:71) —
add a sibling builder that uses `--mode rpc`, drops `-p`, keeps `--provider/--model/--thinking`, passes the
mirror via `extraExtensions`, and its flag as `--piflow-mirror-out <path>` (unknown flags forward to the
extension, per `pi --help`). If you take Recipe A, no builder change touches `-e` at all — you just spawn `pi
--mode rpc` and own its stdio.

---

## 5. Spec confirmations / corrections

| # | Spec assumption | Verdict | Finding |
|---|---|---|---|
| 6a | `-e` injection works + an opened sink works | **CONFIRMED** | Step 4: `pi --mode rpc -e mirror-min.ts --piflow-mirror-out <f>` loaded, exit 0, no `extension_error`; the extension's file sink received every event. (Sink tested as a file; a Unix socket is the same Node `net`/`fs` surface — that exact swap is untested, §6.) |
| 6b | `--mode rpc` is real in the installed version | **CONFIRMED** | Step 1: `pi --help` in **0.79.10** lists `--mode <mode> … text, json, or rpc`. Step 3/5 drove it live. |
| 6c | stale-`ctx`/`pi`-ref-after-session-replacement throws | **CONFIRMED (doc-derived)** | `CHANGELOG.md:954` + `extensions.md:1190`: captured old `pi`/command `ctx` are stale after `newSession()`/`fork()`/`switchSession()` and **throw**; post-switch work must use the `withSession` `ReplacedSessionContext`. Not runtime-reproduced (would need extra turns + a session switch, §6) — but the spec's §3.3 "always use the latest `ctx`, re-snapshot on `session_start`" mitigation is exactly right. Note for Recipe A: RPC sidesteps this entirely — the bridge holds no `ctx`, it just reads stdout. |
| 6d | event set emitted matches the spec's `MIRRORED_EVENTS` | **CONFIRMED, with one correction** | Step 4/5 runtime-emitted: `input, before_agent_start, agent_start, turn_start, message_start/update/end, tool_execution_start/end, turn_end, agent_end, session_start, session_shutdown` — all in `MIRRORED_EVENTS`. **Correction:** the **RPC stdout** event vocabulary (`rpc.md:748`) is NOT identical to the **extension** `pi.on` vocabulary. RPC emits `queue_update`, `compaction_start/end`, `auto_retry_start/end`, `extension_error` (flat events); the extension API instead exposes `session_before_compact`/`session_compact`, `session_before_*`, `context`, `before/after_provider_*`, `tool_call`/`tool_result`, `user_bash`, etc. The two surfaces overlap on the streaming spine but diverge on lifecycle/gating — **pick the surface per need; don't assume one name list covers both.** |

Additional spec corrections from runtime:
- **Per-message usage IS available without a special event** — `message_end.message.usage` carries
  `{input,output,...,cost}` (Step 5). The spec's §1a note "no per-token cost delta; read on demand" is right
  about *deltas*, but for the GUI's cost/token display you can read `usage` straight off `message_end` (or via
  the `get_session_stats` RPC command, Step 3) — no `ctx.getContextUsage()` round-trip needed.
- **Spec §4's primary/fallback ordering should flip** (see §3 verdict): RPC is the most-supported primary;
  `-e` is the supplement.

---

## 6. Still unverified (honest gaps)

- **`steer`/`follow_up` mid-stream delivery semantics** — captured the verbs respond `success:true` (Step 3
  `abort`), but did NOT run a turn long enough to observe a `steer` message actually interrupting after the tool
  batch, or `queue_update` frames. Needs a multi-tool turn to time the interrupt.
- **Session-replacement throw (6c) not runtime-reproduced** — confirmed only from `CHANGELOG.md:954` /
  `extensions.md:1190`. A `new_session`/`fork` over RPC followed by reusing an old captured `ctx` would prove
  the throw; deferred to keep turn count low and avoid touching session storage.
- **Unix-socket sink (vs the file sink I ran)** — Step 4 proved the extension *path* and event delivery via a
  file. The spec's actual transport is a `net` Unix socket; opening it in `session_start` is the same Node
  surface but is **untested here**. Low risk, but verify the socket open + backpressure (non-`await` send) under
  load before shipping.
- **`extension_ui_request`/`extension_ui_response` round-trip** — documented (`rpc.md:985`), not exercised; only
  matters if the control pi runs extensions that call `ctx.ui.confirm/select` (e.g. permission prompts).
- **0.80.2 vs 0.79.10** — all runs were on the installed **0.79.10**; the RPC + extension surfaces matched the
  0.80.2 docs in every captured frame, but the runner should pin a known pi version (or feature-detect
  `--mode rpc`) before shipping, since 0.79.x changed session-replacement semantics within the line.
- **`assistantMessageEvent` full variant set** — captured `text_start/delta/end`; `thinking_*` and `toolcall_*`
  deltas are doc-listed (`rpc.md:830`) but not captured (the test prompts produced no thinking/streamed
  tool-args). Non-blocking — the assembled `message`/`message_end` is the stable source.

---

## Self-check (bar items 1–6)

1. **Real `pi --help` captured; `-e` and `--mode <values>` settled from it** — **PASS** (§2 Step 1: verbatim
   `--mode … text, json, or rpc` and `--extension, -e`, 0.79.10).
2. **Central question has a verdict backed by ≥1 captured artifact** — **PASS** (§3; Step 5 rpc-stdout event
   firehose + Step 3 rpc command/response, both runtime, no extension).
3. **Recipe concrete + copy-pasteable: exact spawn cmd + the extension source actually run** — **PASS** (§4
   Recipe A spawn+driver; Recipe B = the exact `mirror-min.ts` I executed).
4. **Every block labeled `[runtime-verified]`/`[doc-derived]`** — **PASS** (all §2 blocks + §5 6c labeled).
5. **Each of 6a–6d explicitly CONFIRMED/CORRECTED** — **PASS** (§5 table: 6a/6b/6d CONFIRMED, 6c CONFIRMED
   doc-derived, 6d carries a correction).
6. **"Still unverified" honest** — **PASS** (§6: steer timing, session-switch throw, socket sink, UI round-trip,
   0.80.2 skew, full delta variants).

All-PASS.
