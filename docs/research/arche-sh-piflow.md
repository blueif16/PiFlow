# `@arche-sh/piflow` — primary-source analysis & comparison vs our `@piflow/*` SDK

> **One-line takeaway:** `@arche-sh/piflow` is a **pi extension bundle** (an engineering-skills
> framework + a single `delegate` scout-role primitive). Our `@piflow/*` is a **DAG workflow
> orchestration engine** (one headless `pi` per node, compiled graph, stage barriers, per-node
> sandbox/model/tool isolation). They share a name and a `pi` substrate but are **different product
> categories**, not direct competitors.

---

## 1. Provenance & method

- **Date of analysis:** 2026-06-26.
- **Version analyzed:** `@arche-sh/piflow@0.10.2` (latest dist-tag on 2026-06-26).
- **Source of truth:** the published npm tarball
  `https://registry.npmjs.org/@arche-sh/piflow/-/piflow-0.10.2.tgz`, obtained with
  `npm pack @arche-sh/piflow@0.10.2` into `/tmp/arche-piflow/` (outside this repo).
  - **shasum verified:** `d80b4bb92bdf76a147df712d5403c6a381159eb0` (matches `npm notice` on download).
  - 99 files unpacked; the package ships **both** compiled `dist/*.js` and the original `src/*.ts` +
    `extensions/**/*.ts`, so every TypeScript module below is the real shipped source, not a guess.
- **npm timeline (verified via `npm view ... time`):** first publish `0.1.0` on **2026-05-21**;
  latest `0.10.2` on **2026-06-25**. **65 published versions** in ~5 weeks. License **MIT**, runtime
  `dependencies`: **none** (peer-deps on `@earendil-works/pi-*` only). Maintainer
  `jsh.itsolution <jsh@itsolutionkr.com>`, `package.json` `author: "jason2077"`.
- **Their package files I actually read** (paths inside the tarball's `package/`):
  - `package.json`, `README.md`, `CHANGELOG.md`
  - CLI / install spine: `src/cli.ts`
  - delegate role primitive: `extensions/delegate/index.ts`, `extensions/delegate/role-runner.ts`,
    `extensions/delegate/route-resolver.ts`, `extensions/delegate/role-loader.ts`,
    `extensions/delegate/role-routes.ts`, `extensions/delegate/delegate-description.ts`,
    `extensions/delegate/roles/explore.md`, `extensions/delegate/roles/session-miner.md`
  - other extensions: `extensions/skill-tool/index.ts`, `extensions/tick/index.ts`,
    `extensions/nudge/index.ts`, `extensions/bootstrap/index.ts`
  - skills/manifest: `src/manifest.ts`, the `skills/` tree (file listing), `presets/preferences.md`,
    `presets/role-routes.example.json`
- **Our repo (this side of the comparison) I actually read:** the four
  `packages/{core,cli,langgraph,tool-bridge}/package.json`; `README.md`;
  `packages/core/src/runner/runner.ts` (head), `packages/core/src/runner/model-routing.ts`,
  `packages/core/src/sandbox/index.ts`; the `packages/core/src/` tree listing.
- **What I could NOT verify:**
  - **GitHub repo contents.** `raw.githubusercontent.com` / `api.github.com` were unreachable from
    this environment (curl returned empty; `WebFetch` failed with `ERR_TLS_CERT_ALTNAME_INVALID` — a
    proxy/TLS artifact, not a missing repo). All "their code" claims below are therefore pinned to the
    **tarball**, which is authoritative regardless. README links to `docs/demos/*.gif`,
    `docs/adr/*`, `CONTEXT.md`, `docs/agents/*` — those files are **not in the npm tarball** (only
    `dist`, `extensions`, `skills`, `presets`, `src`, README, CHANGELOG, LICENSE are in `files`), so
    any claim that rests solely on them is labeled "README claim, unverified in source."
  - Runtime behavior of their `delegate` against a live pi session (read code, did not execute).
  - The npm description's "65 versions (0.4.17 → 0.10.2)" range — npm's own `time` map shows the first
    published version as `0.1.0` (2026-05-21); I use the verified `npm view` timeline.

---

## 2. What it is (one-paragraph verdict)

`@arche-sh/piflow` is a **single npm-packaged extension for the `pi` coding agent**
(earendil-works/pi, pi.dev) that does two things: (1) it ships a **library of "engineering skills"** —
markdown contracts like `diagnose`, `tdd`, `prototype`, `to-issues`, `where` — that the model loads on
its own when your plain-English request matches a skill's trigger description, and (2) it adds a small
**runtime layer** of pi extensions, the centerpiece of which is `delegate`: a single tool that hands a
bounded task to an **in-process child `pi` agent** configured by a role profile (`explore` for
read-only codebase scouting, `session-miner` for `/where` session recall). Its own README states the
scope plainly: *"Debugging, planning, and repo-resume loops for pi"* and *"The runtime layer stays
small."* It is the **successor to two earlier split packages, `pi-dev` (skills) and `pi-role`
(delegate)**, merged into one. It solves the problem of *"a single pi session restarts from a blank
page, floods its own context, and guesses instead of following a disciplined loop."* It is **not** a
workflow engine, has **no DAG, no graph compiler, no multi-node run, and no persistent run state** —
confirmed by the complete absence of any such module in its 99-file tree (see §3).

---

## 3. Architecture & code walkthrough

### 3.1 Package layout (annotated, from the tarball file tree)

```
package/
├── package.json            # type:module; bin:{piflow}; pi:{extensions[],skills[]}; NO deps; peer @earendil-works/pi-*
├── README.md  CHANGELOG.md  LICENSE
├── dist/                   # compiled mirror of src/ (bootstrap, cli, install, manifest, paths)
├── src/
│   ├── cli.ts              # the `piflow` bin — maintenance CLI only (install/doctor/cleanup)
│   ├── install.ts          # seed user files + clean up old copied skill "mirrors"
│   ├── manifest.ts         # the canonical SKILLS[] list (single source of truth)
│   ├── bootstrap.ts        # first-run seeding + shadow-resource detection
│   └── paths.ts
├── extensions/             # the pi runtime layer (registered via package.json `pi.extensions`)
│   ├── delegate/           # the `delegate` ROLE PRIMITIVE (the interesting part)
│   │   ├── index.ts                  # registers ONE `delegate` tool
│   │   ├── role-runner.ts            # spins up an IN-PROCESS child AgentSession per call
│   │   ├── route-resolver.ts         # per-role model routing (route → frontmatter candidates → fail)
│   │   ├── role-loader.ts            # parses roles/*.md frontmatter → RoleProfile
│   │   ├── role-routes.ts            # reads ~/.pi/agent/piflow/role-routes.json (user override)
│   │   ├── delegate-description.ts   # the agent-facing tool description (isolation/fan-out notes)
│   │   ├── provider-tools/server-tool-inject.ts  # wire-level server-native tool injection
│   │   ├── host-context-providers.ts # cwd/git/tracker/context blocks for the child's 1st message
│   │   └── roles/{explore.md, session-miner.md}  # the TWO active role profiles
│   ├── skill-tool/index.ts # re-exposes skills as ONE `skill` tool (for claude-class models)
│   ├── tick/index.ts       # injects a trusted local date anchor
│   ├── nudge/index.ts      # watchdog: aborts a silent provider wait & re-triggers
│   ├── bootstrap/index.ts  # session_start: idempotent seeding + shadow advisory
│   └── shared/             # nudge-budget, nudge-watchdog, temporal-anchor
├── skills/                 # ~30 SKILL.md contracts (the "skills framework")
│   ├── diagnose/ tdd/ prototype/ to-issues/ to-prd/ triage/ grill-with-docs/ zoom-out/ ...
│   └── where/ taste/ mario/ ...  (+ maintainer-only: graphify, create-skill, run-probe, ...)
└── presets/{preferences.md, role-routes.example.json}
```

### 3.2 Entry points

Two surfaces, declared in `package.json`:

```jsonc
"bin": { "piflow": "./dist/cli.js" },
"pi": {
  "extensions": [ "./extensions/delegate/index.ts", "./extensions/tick/index.ts",
                  "./extensions/nudge/index.ts", "./extensions/skill-tool/index.ts",
                  "./extensions/bootstrap/index.ts" ],
  "skills": [ "./skills/taste", "./skills/where", "./skills/diagnose", ... ]
}
```
The `pi.extensions` / `pi.skills` arrays are the **real product surface** — pi discovers and loads them
when the package is installed via `pi install npm:@arche-sh/piflow`. The `bin` is secondary.

### 3.3 The `bin: piflow` CLI surface (from `src/cli.ts`)

The CLI is **maintenance-only**, by its own help text: *"The CLI is for package maintenance and
cleanup, not the daily workflow."* The complete subcommand set (`src/cli.ts:57-108`):

| subcommand | what it does |
|---|---|
| `install [--global\|--local] [--skip-prefs] [-y]` | seed `preferences.md` + piflow-owned user files; clean up old copied skill mirrors. **Does not copy skills** — they load from the package. |
| `update [--include-prefs]` | same cleanup/seed path; keeps prefs by default |
| `list` | show old copied piflow skills, if any |
| `uninstall <skill>` | soft-remove an old copied skill (rename to `.removed-…`) |
| `cleanup-global-mirrors` | move byte-identical old copied skills aside |
| `doctor` | check package readiness / source / old copies / external CLIs |
| `version` (`-v`, `--version`) | print version |
| `help` (`-h`, `--help`, default) | usage |

There is **no `run`, no `start`, no graph, no node** subcommand. Critically, its `help()` banner names
the product *"piflow — autonomous engineering skill framework for the pi runtime"* (`src/cli.ts:11`).

### 3.4 The "skills framework" mechanism

A skill is a directory under `skills/<name>/` with a `SKILL.md` (YAML frontmatter + body). Two
discovery paths:

1. **pi-core's native prose list.** pi already lists installed skills as `<available_skills>` and the
   model `read`s the matching `SKILL.md`. `package.json`'s `pi.skills` array feeds that.
2. **The `skill` tool (`extensions/skill-tool/index.ts`).** A *translation* of the same skill set into
   a tool-call affordance, because — per the file's own header comment — *"pi core already lists skills
   as prose … which gpt-class models follow but claude-class models skip … Tool-call affordance is the
   dialect claude models are trained on."* It builds a `skill` tool whose enum is the skill names and
   whose `execute` simply reads and returns the `SKILL.md` body as the tool result
   (`skill-tool/index.ts:105-119`):
   ```ts
   const body = readFileSync(row.file, "utf-8");
   return { content: [{ type: "text",
     text: `Skill ${row.name} loaded (from ${row.file}). Follow this contract:\n\n${body}` }],
     details: { skill: row.name } };
   ```
   No intent classification in code; *"trigger sentences live in each SKILL.md description, vendored
   verbatim"*. Command-only skills (`disable-model-invocation: true`) stay out of the enum.

`src/manifest.ts` is the single source of truth for which skills exist and their kind (`human` entry
points vs `support` workflow skills), plus a `consumerInstall: false` flag that hides "maintainer-only"
skills (`teach`, `graphify`, `create-skill`, `run-probe`, …) from default installs. The nine
`VENDORED_ENGINEERING_SKILLS` (`diagnose`, `tdd`, `prototype`, `to-issues`, `to-prd`, `triage`,
`grill-with-docs`, `improve-codebase-architecture`, `zoom-out`) are **vendored verbatim from Matt
Pocock's skill set** (`manifest.ts:24-34`, README confirms the attribution).

### 3.5 The `delegate` role primitive — the genuinely interesting part

`extensions/delegate/index.ts` registers **one** tool, `delegate(name, task, context?,
output_contract?)`. The header comment states the design law: *"Single primitive for every active
persona this extension provides (explore, session-miner)."* When called, `runRole`
(`role-runner.ts:184`) does the following — and this is where it's worth being precise, because it is
**conceptually adjacent to our per-node model — but at a totally different altitude**:

- **Spins up an in-process child `AgentSession`** (`createAgentSession`, `role-runner.ts:350`). Its own
  header: *"Spin up an in-process child AgentSession … No subprocess. No turn cap. Run-to-completion."*
- **Per-role model routing** (`route-resolver.ts:resolveRoleRoute`): a user-local
  `~/.pi/agent/piflow/role-routes.json[role]` override wins; else the role's ordered frontmatter
  candidates (`model:` + `models:`) are matched against the user's authenticated registry; else it
  throws `CapabilityError` — *"There is no parent model fallback for any role."* So `explore` runs on
  `claude-haiku-4-5` (cheap) and `session-miner` on `claude-sonnet-4-6` independent of the parent
  session's model (`roles/*.md` frontmatter).
- **Per-role tool allow-list:** the child runs `noTools: "all"` + `tools: clientTools`
  (`role-runner.ts:360-361`); `explore` gets `read,grep,find,ls`, `session-miner` gets `ls,read`
  (read-only). Server-native tools (e.g. Anthropic `web_search`) are injected at wire level via the
  child's own `before_provider_request` hook (`role-runner.ts:235-292`).
- **Isolated system prompt:** the child's system prompt is **replaced** by the role body; the runner
  sets `noContextFiles:true` (no AGENTS.md/CLAUDE.md walk), `noSkills:true`, and
  `appendSystemPromptOverride:()=>[]` so *"the child sees the role body and nothing else competing with
  it"* (`role-runner.ts:298-332`). The parent's skills/persona/history are NOT visible to the child —
  the only host context is a fixed-order block (`cwd → session-dir → git → tracker → context → task`,
  `role-runner.ts:153-166`).
- **Same-turn parallel fan-out** is *observed* (a batch tracker numbers `[i/N in turn]`) but the
  parallelism itself is pi-core's `executeToolCallsParallel`; delegate just nudges the caller to emit
  multiple delegate calls in one turn (`delegate-description.ts:FAN_OUT_NOTE`).

The two active roles, in full:

- **`explore`** (`roles/explore.md`): *"Fast codebase exploration. Read-only client tools. Returns
  structured handoff."* `model: claude-haiku-4-5`, `tools: read,grep,find,ls`. Output is a fixed
  `## Files / ## Key Symbols / ## Start Here` handoff with anti-patterns (no full-file dumps, max 30
  lines/symbol, cite `file:line` only when grounded). It is a **read-only sub-agent scout**, the same
  pattern as a Claude Code "Explore" subagent.
- **`session-miner`** (`roles/session-miner.md`): *"Recall fact engine for `/where`. Mines selected pi
  session JSONL into Now / Recent Work / Carryover facts only. Read-only."* `model:
  claude-sonnet-4-6`, `tools: ls,read`, `wants_host_git`/`wants_host_tracker`. It is the engine behind
  the `/where` skill — it reads prior pi session transcripts for the cwd and returns a compact
  "where are we?" card instead of dumping old threads into the chat.

The README confirms research/pipeline roles were **removed** (`index.ts:6-8`, ADR-0009): the only
roles that exist are these two read-only scouts.

### 3.6 The rest of the runtime layer

- **`tick`** (`tick/index.ts`): injects a hidden trusted local-date message before every LLM call via
  pi's `context` hook so "today" doesn't come from model memory.
- **`nudge`** (`nudge/index.ts`): a watchdog on time-to-first-visible-progress (TTFP). On a silent
  provider wait past a budget (default 120s, env `PIFLOW_NUDGE_BUDGET_MS`, escalating 120→480s), it
  calls `ctx.abort()` (same channel as Ctrl+C) and re-triggers the turn with a resume message. Tunable
  via `~/.pi/agent/piflow/config.json` `{"nudge":{"enabled":false}}`.
- **`bootstrap`** (`bootstrap/index.ts`): on `session_start`, idempotently seeds missing user files and
  warns if old copied piflow resources shadow the package.

---

## 4. Feature inventory (code-backed)

**CLI (`bin: piflow`, `src/cli.ts`):** `install`, `update`, `list`, `uninstall <skill>`,
`cleanup-global-mirrors`, `doctor`, `version`, `help`. (Maintenance only — no run/graph commands.)

**pi extensions (registered via `package.json` `pi.extensions`):**
- `delegate` tool — `delegate(name, task, context?, output_contract?)` → in-process child agent.
- `skill` tool — load an engineering-skill contract by name (`skill-tool/index.ts`).
- `tick` — trusted local-date/system-state anchor (`tick/index.ts`).
- `nudge` — silent-provider-wait watchdog + auto-resume (`nudge/index.ts`).
- `bootstrap` — first-run seeding + shadow-resource advisory (`bootstrap/index.ts`).

**delegate roles (`extensions/delegate/roles/`):** `explore` (read-only codebase scout, haiku),
`session-miner` (read-only `/where` recall engine, sonnet). Per-role: model candidates + thinking
level, tool allow-list, server-tool budgets, optional `wants_host_git`/`wants_host_tracker`,
`task_suffix` / `task_guidance`. User override via `~/.pi/agent/piflow/role-routes.json`.

**Skills (`src/manifest.ts`, `skills/`):**
- *Human entry points:* `/taste` (preferences), `/where` (session recall), `/mario` (persona),
  `onboard-repo`.
- *Engineering workflow (model-loadable):* `diagnose`, `tdd`, `prototype`, `to-prd`, `to-issues`,
  `triage`, `grill-with-docs`, `improve-codebase-architecture`, `zoom-out`, `setup-matt-pocock-skills`,
  `browser-use-cli`.
- *Maintainer-only (`consumerInstall:false`):* `teach`, `recon-with-vision`, `run-probe`,
  `osascript-mechanics`, `iterm-mechanics`, `pi-cli-mechanics`, `capture-terminal`, `live-ready`,
  `pi-extension-tui`, `graphify`, `improve-skill-flow`, `create-skill`, `record-demo-gif`.

**Packaging:** zero runtime deps; peer-deps on `@earendil-works/pi-ai`, `pi-coding-agent`, `pi-tui`;
ESM; Node ≥22.19; ships `src` + `dist`.

---

## 5. Relationship to `pi`

`@arche-sh/piflow` is a **first-class pi extension**. It hooks in three ways, all *inside* a pi session:

1. **Install path:** `pi install npm:@arche-sh/piflow` (README). pi reads the package's `pi.extensions`
   and `pi.skills` arrays and loads them.
2. **Extension API:** every extension is `export default function(pi: ExtensionAPI)` and uses
   `pi.registerTool(...)`, `pi.on("session_start"/"before_provider_request"/...)`,
   `pi.sendMessage(...)`. It depends on pi-core internals like `createAgentSession`,
   `DefaultResourceLoader`, `SessionManager`, `parseFrontmatter`, `SkillInvocationMessageComponent` —
   i.e. it is built **against pi's in-process SDK**, sharing pi's event loop.
3. **Config:** piflow keeps its own namespace under `~/.pi/agent/piflow/` (`role-routes.json`,
   `config.json`) and seeds `preferences.md` — it explicitly does **not** write pi-core's
   `settings.json` (`role-routes.ts:31-33`).

**How OUR repo uses pi — the key contrast.** Our `@piflow/core` spawns pi as an **external headless
subprocess, one per DAG node**, credentialed once via pi's global `~/.pi/agent/models.json`, and kept
**external (not bundled)** so the SDK stays product-agnostic (`README.md:108`, "Headless invariants:
close stdin, `--offline`, `--no-extensions`"). We run `pi` *as a process* from a driver that owns the
graph; they run *inside* a pi process as an extension and (for delegate) spin a child `AgentSession`
**in-process**. Both legitimately "use pi per unit of work," but ours is process-level fleet
orchestration and theirs is in-session extension + in-process child agents. Notably, our headless
invariant `--no-extensions` means a node's pi would **not** load their extension anyway.

---

## 6. Head-to-head vs our `@piflow/*` SDK

| Axis | `@arche-sh/piflow@0.10.2` | our `@piflow/*` (`@piflow/core@0.1.0`) |
|---|---|---|
| **Product category** | pi **extension bundle**: engineering-skills framework + `delegate` scout role | **DAG workflow orchestration engine** (an agent designs a graph; a fleet runs it) |
| **Core abstraction** | a **skill** (markdown contract) + a **role** (child-agent profile) | a **node envelope** (work · sandbox · tools · hooks · contract) compiled into a **DAG** |
| **How pi is used** | runs **inside** a pi session as an extension; `delegate` spawns an **in-process** child `AgentSession` | spawns pi as an **external headless subprocess, one per node** (`--offline --no-extensions`) |
| **Orchestration model** | **none** — model-driven skill loading + one-shot delegate scouts; no graph, no multi-step run | **compiled DAG**: `compile()` → stages → parallel lanes → stage-barrier state merge (LangGraph super-step semantics) |
| **Tools / MCP wiring** | per-role client tool allow-list + wire-level server-native tool injection (e.g. `web_search`) | per-node declarative tool allow-list; MCP via `@piflow/tool-bridge` (`callTool`); OpenClaw/Hermes catalog ingest |
| **Sandbox model** | none (child runs in the host cwd, read-only tools only) | **per-node sandbox isolation**: `local` · `seatbelt` · `worktree` · `daytona` (real `@daytona/sdk` dep) |
| **Multi-model / heterogeneity** | **per-role** model routing (`route-resolver.ts`): explore=haiku, miner=sonnet; user override file | **per-node** model/provider routing (`model-routing.ts`): `node.model > tier > run --model > pi default` |
| **Observability / run-view** | TUI streaming of the delegate child's trace; no persistent run state | **one** `observe` stream (`watchRun`/`readRunModel`) over an on-disk `.pi/run.json`; GUI + TUI + `watch` + `logs` twins |
| **Packaging / deps** | 1 package; **zero** runtime deps; peer `@earendil-works/pi-*`; ships src+dist | 4 packages (`core`/`cli`/`langgraph`/`tool-bridge`); core deps `@daytona/sdk`, `esbuild`; MCP SDK in bridge |
| **Maturity (versions / age)** | **65 versions** in ~5 weeks (0.1.0 2026-05-21 → 0.10.2 2026-06-25); successor to pi-dev + pi-role | `0.1.0`, pre-publish prep (branch `chore/npm-publish-prep`); runner + observe GA, L2/L3 next horizon |
| **License** | MIT | MIT |

### Prose

**Where they overlap (genuinely).** Three real points of contact. (1) Both are built on the same `pi`
agent. (2) Both **route a different model per unit of work** — their `route-resolver.ts` picks a model
per *role*, ours `model-routing.ts` picks a model per *node*; the design instinct (cheap model for
cheap work) is identical. (3) Both isolate a unit's context: their `delegate` child runs with
`noContextFiles`/`noSkills` and a replaced system prompt so it "sees the role body and nothing else";
our nodes run in isolated sandboxes with a tight tool allow-list. So our memory line "one-real-pi-
per-node enables per-node heterogeneous tools/sandbox/model" has a **rhyme** on their side: "one child
agent per delegate role with its own model/tools." The difference is altitude and durability.

**Where they are a different category (with evidence).** The single strongest piece of evidence: their
entire 99-file tarball contains **no graph compiler, no DAG, no multi-node runner, and no persistent
run state** — the closest thing to "orchestration" is a single `delegate` tool that runs **one**
child agent **to completion with no turn cap and no successor node** (`role-runner.ts` header: *"No
subprocess. No turn cap. Run-to-completion."*), and their own CLI help calls the product an
*"autonomous engineering skill framework"* (`src/cli.ts:11`), never a workflow engine. Our `@piflow/core`
is *defined by* the pieces they lack: a `dag.ts` compiler, a `runner/` with parallel stages and a
stage-barrier merge, four sandbox backends incl. Daytona, and a single `observe` run-view stream
(`packages/core/src/{dag,runner,sandbox,observe}/`). A workflow is **data** on our side (`WorkflowSpec`
→ compiled DAG, authored once, run by a non-Claude fleet); on their side a "workflow" is a **prompt the
model follows** (a `SKILL.md` contract loaded into one live session). Those are different products that
happen to share a substrate and a name.

**Who wins on each axis (no home-team bias).** They win on **skills/contract craft and in-session
ergonomics**: a polished, model-loadable library of debugging/TDD/planning contracts, a slick
`/where` session-recall flow, a nudge watchdog, trusted-time injection, and zero-dep packaging — all
shipping today at 65 versions of polish. If your goal is *"make a single pi session more disciplined,"*
they are far ahead and we don't compete. We win on **multi-node orchestration**: a compiled DAG, true
parallel stages with deterministic state merge, per-node hard sandbox isolation (Daytona/seatbelt/
worktree), verified-not-trusted artifact checks, and one observability stream feeding GUI/TUI/watch. If
your goal is *"prove a workflow once and run the identical graph on a non-Claude fleet, unattended,"*
they have no equivalent. On the **shared "per-unit model heterogeneity"** axis it's a wash by design —
both do it cleanly at their respective altitudes. On **maturity as shipped artifacts**, they win
today (we're at 0.1.0 pre-publish); on **architectural ambition / scope**, we're solving a strictly
larger problem.

---

## 7. Name & namespace collision analysis

Both projects are named "piflow" and both ship a `bin` literally named `piflow`:

- Theirs: `"bin": { "piflow": "./dist/cli.js" }` under scope **`@arche-sh`**.
- Ours: `"bin": { "piflow": "./dist/cli.js" }` under scope **`@piflow`** (`packages/cli/package.json`).

**Concrete consequences if we publish `@piflow/cli` with `bin: piflow`:**

1. **Global bin clash (the real one).** npm installs a package's `bin` as a command on `PATH`. A user
   who has installed *their* package globally (or via `pi install`, which links the package) and then
   `npm i -g @piflow/cli` gets a **last-writer-wins `piflow` symlink** — one silently shadows the
   other. Two unrelated tools fighting for the same global command name is a real, reproducible
   foot-gun, and the failure is invisible (`piflow` "works" but runs the wrong tool).
2. **npm search / discoverability confusion.** A search for "piflow" already surfaces `@arche-sh/piflow`
   with 65 versions and a polished README. An unscoped bare `piflow` package name is **already taken on
   npm by neither of us cleanly** (theirs is scoped) — but the *word* "piflow" is now strongly
   associated with their pi-extension product in npm's relevance ranking. We'd be the second "piflow,"
   fighting for the same SEO term, with a smaller version history.
3. **SEO / GitHub.** Theirs is `github.com/arche-sh/piflow`; ours is `github.com/blueif16/PiFlow`. Both
   "piflow" on GitHub search. Their npm package links to a clean `arche-sh/piflow` repo; ours to
   `blueif16/PiFlow`. Brand ambiguity is guaranteed.
4. **Scope is NOT colliding.** `@piflow` (ours) vs `@arche-sh` (theirs) are distinct npm org scopes, so
   the *package names* `@piflow/cli` and `@arche-sh/piflow` never collide on the registry. The collision
   is **only** (a) the human-facing word "piflow" and (b) the **global `bin` name**.

**Recommendation (concrete, not "it depends"):**

> **Keep the `@piflow` org scope and the "Pi Flow" product name; RENAME the global `bin` to avoid the
> command clash.** Ship `@piflow/cli` with `"bin": { "piflow-run": "./dist/cli.js" }` (or `"piflowctl"`),
> not `piflow`.

Reasoning: (a) The `@piflow` *scope* is ours, distinct from `@arche-sh`, and our whole identity (repo,
docs, skills, MISSION) is "Pi Flow" — renaming the product is expensive and unnecessary since the
*registry* names don't collide. (b) The **only** mechanical break is the global `bin`, and that is cheap
to dodge: a distinct command name (`piflow-run` mirrors our existing `piflow-tui` monitor bin in
`README.md:107`, so it's idiomatic for us) removes the last-writer-wins symlink hazard entirely while
keeping every doc that says "Pi Flow." (c) Our own README already shows the CLI as `piflow run
<templateDir>` (`README.md:139`) — `piflow-run run …` is mildly redundant, so `piflowctl run …` reads
better; pick one, but the principle is: **do not claim the bare `piflow` command.** (d) We should also
**not** attempt to grab the unscoped `piflow` package name — it would invite exactly the brand confusion
in §7.2 and put us in an implicit naming dispute with an established 65-version package.

---

## 8. Actionable implications for us

### (a) Worth borrowing (ideas, not code)

- **`nudge` watchdog → our runner's silent-stall handling.** Their TTFP watchdog (abort a silent
  provider wait, re-trigger with a resume message, escalate the budget) is a clean pattern. Our
  `runner.ts` already has "node-timeout + silent-stall watchdogs … routed through ONE killChild seam"
  (its header), but their *escalating-budget + auto-resume* refinement (120→480s, wider budget after an
  edit/write) is a nice touch for our deferred "escalation ladder."
- **`tick` trusted-time anchor.** Cheap, and our nodes run headless where "today" matters for some
  tasks — injecting a trusted date is a one-line win if we ever see model-date drift.
- **`task_guidance` (caller-facing) vs `task_suffix` (child-facing) split** (`role-loader.ts`). A tidy
  way to put the "shape of a good task" in the *tool description the caller reads* while keeping the
  *output contract* in the child's prompt. Maps onto how we author node prompts + contracts.
- **`route-routes.json` strict, no-fallback resolution** (`route-resolver.ts`). Their decision that an
  unresolved route **fails loudly** rather than silently falling back to the parent model matches our
  own `ModelRoutingError`-on-unresolvable-tier stance (`model-routing.ts:71-81`) — independent
  convergence is a good signal we got that call right.

### (b) Does their existence change our positioning or the competitive-gaps backlog?

**No to positioning, mostly.** They are **not** the competitor our backlog targets (per project memory
that's `vendors/pi-dynamic-workflows`, the in-process code-mode engine). `@arche-sh/piflow` is a
different category — a pi *extension*, not a workflow *engine* — so it does **not** invalidate the
"one-real-pi-per-node enables per-node heterogeneous tools/sandbox/model" thesis; if anything their
per-role-model `delegate` is independent evidence that per-unit model heterogeneity is the right
instinct. **One adjustment:** our positioning copy should stop assuming "piflow" uniquely means us in
the pi ecosystem — an established same-named pi extension exists, so any "the piflow way" messaging
needs the `@piflow/*` scope attached to disambiguate.

### (c) The bin/name decision (restated)

Adopt the §7 recommendation before publishing `@piflow/cli`:
- **Keep** product name "Pi Flow" and org scope `@piflow`.
- **Rename the bin** away from the bare `piflow` (e.g. `piflowctl` or `piflow-run`) to kill the
  global-command clash with `@arche-sh/piflow`'s `bin: piflow`.
- **Do not** register the unscoped `piflow` package name.
- This is a `packages/cli/package.json` `bin` edit + a README/skill find-replace of the documented
  command (`piflow run …` appears in `README.md` and the `piflow-start` skill). **Recommendation only —
  not applied here.**

---

## Self-check (audit against the bar)

- **Every claim about their package is file-path-cited, not README-only** — **PASS.** Architecture,
  CLI, skill mechanism, and delegate behavior are each quoted from `src/cli.ts`, `manifest.ts`,
  `skill-tool/index.ts`, `role-runner.ts`, `route-resolver.ts`, `role-loader.ts`, `roles/*.md`.
  README-only items (demos/ADRs not in the tarball) are explicitly labeled in §1.
- **I read their source AND our package.jsons + core src** — **PASS.** §1 lists the exact files;
  comparison cites `model-routing.ts`, `sandbox/index.ts`, `runner.ts`, all four package.jsons.
- **Correctly distinguishes "different category" from "competitor"** — **PASS.** §2/§6 state plainly
  they do NOT do DAG orchestration, with the no-graph/no-runner tarball evidence as the strongest point.
- **Self-contained, dated, working links** — **PASS.** Dated 2026-06-26; tarball URL + shasum;
  internal file refs are repo-relative.
- **§7 gives a concrete reasoned bin/name recommendation** — **PASS.** "Keep scope+name, rename the bin
  to `piflowctl`/`piflow-run`, don't grab unscoped `piflow`," with reasoning.
- **MUST-NOTs honored** — **PASS.** Only this file was created; no repo manifest edited; nothing pulled
  in from `/tmp`; no publish/install-into-repo command run.
