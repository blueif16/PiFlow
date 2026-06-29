# Agent Executor Interface — one surface, many agents (pi + Claude Code)

> **Status:** DESIGN / PROPOSED (nothing built yet). Branch `worktree-feat-claude-code-executor` (based on `main`).
> **What this is.** The unified contract that lets piflow drive *more than one kind of coding agent* per node —
> today `pi`, and now a headless **Claude Code** session for read/write/fix/summarize/debug work — without the
> runner caring which one ran. It defines the normalized run spec, the driver seam, and the bridge translators.
> **Companion to `agent-executor-surface.md`** (the *denominator*: every pi-driving capability, classified
> AGNOSTIC / PI-CLI / BRIDGE). **Reference, don't duplicate** — that doc owns the per-capability inventory + the
> `file:line` anchors; THIS doc owns the abstraction over them. Section refs below (e.g. "surface §8") point there.
> **Scope is deliberately small (owner decisions, 2026-06-29):** Claude Code runs on the **local, already-logged-in
> subscription** only (no API key, no cloud token); we do **NOT** wire pi's custom/sdk/MCP tools to Claude; Claude
> gets the **builtin read/write/edit/bash/grep/glob** tools and nothing more. Its job is to *fix code, summarize,
> debug* — the things it is best at — while the main workflow keeps running on the pi fleet and their coding plans.
> **Frozen-spine discipline (per `CLAUDE.md`):** a node that names no executor runs BYTE-IDENTICALLY on `pi`.

---

## 0. The idea at a glance

The runner is already bisected at the right seam (surface §13): everything below the **`CommandBuilder`**
(`packages/core/src/runner/command.ts:20`) + **`ExecRunner`** (`exec-runner.ts:9`) seams is **AGNOSTIC** — sandbox
jails, artifact-stat verdict, op[] gating, checks/policy, retry FSM, secret broker, watchdog, concurrency. A new
agent inherits all of it for free. So a "unified interface" is mostly *already here*; what's missing is (a) a
normalized **`AgentRunSpec`** so a node's intent is expressed agent-neutrally, (b) a small **`AgentDriver`** that
each agent implements, and (c) ~5 **bridge translators** for the capabilities whose *wire shape* differs.

Coverage of the pi surface by a local Claude Code CLI (full analysis derives from the surface doc's
classifications): **~30 capabilities AGNOSTIC (free), ~14 BRIDGE (adapter), ~6 PI-CLI flags with direct Claude
equivalents, 3–4 true gaps** — and all four gaps fall OUTSIDE this scope (custom tools, skills, multi-provider,
`--bare`+auth). Within scope, Claude Code covers the surface **completely**, and *exceeds* pi in three places it
fills pi gaps: per-node system prompt (surface §3, "none found" in pi), native cost/tokens (surface §12), and
structured return via `--json-schema` (surface §10).

## 1. Scope fence

**IN (v1):**
- A second executor selectable per node: a headless `claude -p` session on the **local subscription**.
- The normalized `AgentRunSpec` / `AgentResult` / `AgentDriver` contract (§2) and a `PiCliDriver` + `ClaudeCliDriver`.
- Bridge translators for: tool-name mapping (builtins only), prompt input, warm-resume session id, telemetry, auth (§4).
- Claude tool grant limited to builtins: `Read, Write, Edit, Bash, Grep, Glob` (read/write/fix/debug).

**OUT (explicit — do not build now; each has a home for later):**
- **`ClaudeSdkDriver`** (`@anthropic-ai/claude-agent-sdk` `query()`) and any in-process custom tools.
- Wiring pi's `-e`/`pi.registerTool` **custom/sdk/MCP tools** to Claude (surface §5/§6). Claude uses builtins only.
- **Skills → Claude** (surface §7): no `--skill` port; if ever needed, inline SKILL.md — deferred.
- **Cloud auth / cloud sandboxes** for Claude (`CLAUDE_CODE_OAUTH_TOKEN`, Bedrock/Vertex). Local providers only.
- **Multi-gateway `--provider` routing** for Claude (surface §4): collapses to "Anthropic via the local login."

## 2. The normalized surface

```ts
// What piflow hands ANY agent for one node-run. Executor-neutral; piflow already
// resolves tokens (surface §2), the model id (surface §4), and the tool selection (surface §5).
interface AgentRunSpec {
  prompt: string;                       // resolved prompt text (no {{tokens}} left)
  systemPromptAppend?: string;          // per-node system prompt — pi can't honor today; Claude can (surface §3)
  model?: string;                       // resolved model id (Anthropic id for Claude; omit ⇒ plan default)
  effort?: 'low' | 'medium' | 'high';   // reasoning depth — pi `--thinking` ↔ Claude `--effort` (surface §4)
  tools: {                              // NORMALIZED tool names (not pi bare-names, not Claude names)
    available: string[];                // the node's grant
    deny?: string[];
  };
  session?: { resume?: string; feedback?: string };  // warm resume (surface §8): id to resume + feedback-only prompt
  outputSchema?: JsonSchema;            // structured return (surface §10): pi submit_result ↔ Claude --json-schema
}

// The normalized return + telemetry every driver produces.
interface AgentResult {
  ok: boolean; exitCode: number;
  text?: string;                        // final summary
  structured?: unknown;                 // when outputSchema set
  sessionId?: string;                   // CAPTURED (Claude mints it; pi takes the given id) — surface §8
  cost?: { usd: number; inputTokens: number; outputTokens: number; cacheRead?: number; cacheWrite?: number };
}

// The driver seam. ExecRunner (spawn+watchdog) stays AGNOSTIC and shared; the driver owns
// only the three things that differ per agent.
interface AgentDriver {
  readonly id: 'pi' | 'claude-code';
  // Couplings the executor imposes on the sandbox BEFORE creation (e.g. Claude must read ~/.claude to auth).
  augmentSandbox?(spec: AgentRunSpec): { read?: string[]; write?: string[]; env?: Record<string, string | undefined> };
  // v1: both drivers are command-emitting (fits the existing string seam). A future SDK driver overrides run().
  buildCommand(spec: AgentRunSpec, ctx: DriverContext): string;
  // Parse THIS executor's stdout into the normalized result + telemetry.
  parseResult(raw: { stdout: string; exitCode: number; killed: 'timeout' | 'stall' | null }): AgentResult;
}
```

## 3. How it maps onto the existing seams

No new spawn machinery. The driver plugs into what already exists:

| Existing seam | Today (pi) | Under the abstraction |
|---|---|---|
| `RunOptions.buildCommand` (`runner.ts:88`, default `command.ts:326`) | `defaultPiCommand` | `driver.buildCommand` — selected per node |
| `ExecRunner` (`exec-runner.ts:9`) | spawn + watchdog | **unchanged, shared** (AGNOSTIC) |
| return parse (`return-parse.ts:9` `lastJsonBlock`) + distill (`observe/distill.ts:120`) | pi stdout/usage shape | `driver.parseResult` |
| sandbox create (`node-lifecycle.ts:200-213`) | `node.sandbox.read/write/env` | union `driver.augmentSandbox()` first |

**Executor selection — one additive optional (frozen-spine safe):**
```ts
// types.ts NodeSpec — additive; absent ⇒ 'pi' ⇒ byte-identical to today.
executor?: 'pi' | 'claude-code';
```
The runner keeps a `Record<executor, AgentDriver>` and picks `drivers[node.executor ?? 'pi']`. We prefer a new
`executor` field over overloading `provider` because for Claude the gateway concept collapses (surface §4) — `executor`
selects the *agent binary*; `model` still selects the model *within* it. v1 also **gates `claude-code` to in-place
(local) sandbox providers** (the auth is host-local), mirroring the warm-resume eligibility gate (surface §8,
`IN_PLACE_KINDS`).

## 4. The bridge translators

Each absorbs one BRIDGE class from the surface doc. Only these five are needed in scope (custom tools / MCP /
skills are OUT, so their adapters are not built):

| Translator | pi side (surface ref) | Claude side | v1 |
|---|---|---|---|
| **ToolNameMap** | bare names `--tools read,write,…` (§5) | `--tools "Read Write Edit Bash Grep Glob"` | builtins-only table (§5 below) |
| **PromptInput** | `@file` arg (§2) | prompt on **stdin** (`claude -p < prompt.md`) | ✅ |
| **SessionAdapter** | mint id, `--session`/`--session-id` (§8) | **capture** id from result; `--resume <id>` | ✅ |
| **TelemetryParser** | `--mode json` `usage` shape (§12) | `--output-format stream-json` final `result` event (`total_cost_usd`,`usage`,`session_id`) | ✅ (degrades to exit-code+artifact if skipped) |
| **AuthPolicy** | inject gateway key on cloud (§11) | **strip** `ANTHROPIC_API_KEY`; rely on `~/.claude` OAuth; **never `--bare`** | ✅ |

## 5. The `ClaudeCliDriver` contract

**Builtin tool map** (read/write/fix/debug only):

| normalized | pi (`BUILTIN_TOOLS` `registry.ts:11`) | Claude |
|---|---|---|
| read | `fs:read`→`read` | `Read` |
| write | `fs:write`→`write` | `Write` |
| edit | `fs:edit`→`edit` | `Edit` |
| grep | `fs:grep`→`grep` | `Grep` |
| find | `fs:find`→`find` | `Glob` |
| bash | `sh:bash`→`bash` | `Bash` |
| ls | `fs:ls`→`ls` | (no native Ls — via `Bash`/`Glob`) |

**`AgentRunSpec` → `claude -p` flag mapping:**

| spec field | claude flag |
|---|---|
| `prompt` | piped on **stdin** (`… < _pi/<id>/prompt.md`) |
| `systemPromptAppend` | `--append-system-prompt-file <staged>` |
| `model` | `--model <id>` (omit ⇒ subscription default) |
| `effort` | `--effort low\|medium\|high` |
| `tools.available` | `--tools "<mapped names>"` (restricts availability) |
| `tools.deny` | `--disallowedTools "<mapped>"` |
| auto-approve (pi `-a`) | `--permission-mode bypassPermissions` — the **seatbelt jail is the real boundary** (surface §9; see `sandbox-readscope-default-on` memory), not Claude's prompt |
| `session.resume` | `--resume <id>` (feedback prompt on stdin) |
| `outputSchema` set | `--output-format json --json-schema '<schema>'` → `.structured_output` |
| else (telemetry) | `--output-format stream-json --verbose` (stream keeps the stall-watchdog fed; final `result` carries cost+session) |

**Command skeleton:**
```
claude -p --permission-mode bypassPermissions \
  --output-format stream-json --verbose \
  --model <id> --effort <e> \
  --tools "Read Write Edit Bash Grep Glob" \
  [--append-system-prompt-file <f>] [--resume <id>] \
  < _pi/<id>/prompt.md
```

**Model resolution — SETTLED & SHIPPED (`af19417`).** The 3-tier global config (`~/.piflow/model-tiers.json`)
is REUSED: it gains an optional parallel **`claude` block** with the same `fast`/`balanced`/`deep` keys mapping to
Claude models (aliases `opus`/`sonnet`/`haiku`, or `claude-*` ids). `pi` reads `tiers`; the claude-code executor
reads `claude` via `resolveClaudeModel(node, run)` (`runner/model-routing.ts`), precedence:
`node.model > tiers.claude[tier] > tiers[tier] (only if Claude-valid via isClaudeModel — never leak a pi-only id like
deepseek to --model) > undefined (omit --model ⇒ Claude account default, e.g. opus[1m] on a Max plan)`. Total — never
throws (Claude always has a default), unlike pi's loud tier failure. `tier` is thus the portable knob (same node runs
on either executor); `model` is the executor-specific pin. Example: `{ "tiers": {"deep":"deepseek-r1"}, "claude": {"deep":"opus"} }`.

**AuthPolicy (local subscription):** `augmentSandbox()` (1) adds `~/.claude` (OAuth login) **and the `claude`
binary** to `read`, (2) strips `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` from the child env so the subscription
OAuth wins (surface §11 confirms local nodes inherit `process.env`, so a stray exported key would otherwise clobber
the login), (3) never passes `--bare` (it skips OAuth/keychain). **One real wrinkle to spike (§7):** Claude also
*writes* session/config under `~/.claude` (and on macOS may read creds from the **keychain**) — the write jail and
seatbelt must permit that, e.g. via `CLAUDE_CONFIG_DIR=<per-node writable dir seeded with the credential>` or by
adding `~/.claude` to `write`.

## 6. Coverage verdict (within scope)

| Surface category | Status under `ClaudeCliDriver` |
|---|---|
| §1 Invocation/lifecycle, §9 Sandbox, §10 I/O, §13 seams | **free** (AGNOSTIC — inherited; exit-code + artifact-stat verdict already executor-blind) |
| §2 Prompt, §4 model/effort, §5 builtin tools, §8 warm resume, §12 telemetry | **bridged** (the five translators) |
| §3 system prompt, §10 structured return | **gained** (Claude fills pi gaps) |
| §5 custom tools, §6 MCP, §7 skills, §4 `--provider` | **out of scope** (not needed for read/write/fix/debug) |

## 7. The v1 cut (test-first)

The contract IS the `claude -p` string, so the first test asserts exactly it.
1. **`ClaudeCliDriver.buildCommand` unit** — given an `AgentRunSpec` for a debugger node, assert the exact command
   string (fails if a flag drifts). Same for `augmentSandbox()` (asserts `~/.claude` enters `read`, `ANTHROPIC_API_KEY`
   is stripped).
2. **De-risk auth first, jail second.** Prove a real `claude -p` run on the local subscription with the sandbox in
   `danger-full-access` (jail off) to confirm the command + login + file writes; THEN tighten to enforced read/write
   scope and resolve the `~/.claude` read/keychain wrinkle (§5).
3. **`parseResult`** — parse a recorded `stream-json` transcript into `AgentResult` (ok/exitCode/sessionId/cost).
4. **Wire selection** — `executor?: 'pi' | 'claude-code'` on `NodeSpec` + the driver registry; a node with no
   `executor` is byte-identical (a snapshot test on `defaultPiCommand` output guards this).

## 8. Open questions / deferred decisions

- **Auth inside the seatbelt jail (the one true integration risk)** — file vs macOS-keychain credential read, and
  Claude's writes to `~/.claude`. Candidate: `CLAUDE_CONFIG_DIR` → per-node dir seeded with the credential. Spike in §7.2.
- **Telemetry parity** — a Claude-shaped distiller (`observe/distill.ts` adapter) to feed cost/tokens into `run-view`;
  Claude reports cost natively, so this is also the lever to fix the known cost/token bug for Claude nodes. Optional for v1.
- **`--no-context-files` parity** — Claude can't both suppress a repo `CLAUDE.md` and keep OAuth via `--bare`. Mitigate
  by running in a cwd without a `CLAUDE.md`; revisit only if a leak is observed.
- **When does the SDK driver become necessary?** Only when a node needs in-process custom tools or `canUseTool`
  permission callbacks (out of scope now). The `AgentDriver` seam already leaves room for it (`run()` override).
