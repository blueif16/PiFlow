# Declarative PRE/POST Node Hooks for Pi Flow — Best-Practice Survey & Synthesis

**Date:** 2026-06-21
**For:** Pi Flow — TS SDK orchestrating a DAG of headless coding-agent ("pi") nodes that coordinate ONLY through the filesystem (artifacts by path).
**Question:** Generalize today's ad-hoc `DRIVER-SEED` (pre-stage) / `DRIVER-MERGE`/`DRIVER-PROJECT` (post-process) markers into a clean **declarative hook model** where each hook **declares the files it reads and writes**, joins the node's filesystem data-flow graph, and appears in the DAG viz.

**Research legs run:** **Exa** (docs + practitioner blogs) + **Reddit** (r/dataengineering, r/devops, r/github via the macrocosmos/reddit-scraper Apify actor, 23 posts). **NO YouTube** (per instruction). Both legs succeeded.

**Scope fence honored:** This brief covers the **HOOK lifecycle only** — schema, firing semantics, IO passing, failure/resume. It does NOT design sandbox/isolation internals or tool-registry internals (other agents own those). Framework claims are cited; uncertain/secondhand claims are flagged inline with **[UNCERTAIN]** or **[SECONDHAND]**.

---

## 1. System-by-system survey

For each: hook DECLARED in config or code? WHEN it fires? HOW it gets the unit's IO? Does a FAILED hook fail the unit / block downstream?

### 1.1 dbt `pre-hook` / `post-hook` — the closest analogy
- **Declared:** Declaratively, in config — `dbt_project.yml` (`+pre-hook:` / `+post-hook:`), a model's `.yml` `config:`, or an in-file `{{ config(pre_hook=..., post_hook=...) }}`. Value is a SQL string, a list of strings, or a **dict** `{"sql": ..., "transaction": false}`. Hooks are **additive** across levels and **cumulative**; ordering is deterministic (dependency-package hooks first, then project-file, then model-file, in definition order). [docs.getdbt.com/reference/resource-configs/pre-hook-post-hook](https://docs.getdbt.com/reference/resource-configs/pre-hook-post-hook), [docs.getdbt.com/reference/define-configs](https://docs.getdbt.com/reference/define-configs)
- **When:** `pre-hook` immediately before the model/seed/snapshot is built; `post-hook` immediately after. **post-hook runs ONLY on success** — confirmed by practitioners: "post hooks only run for successful models, whereas `on-run-end` hooks always run." [discourse.getdbt.com/t/post-hook-when-a-model-fails/6204]
- **How it gets IO:** Not file paths — hooks get the **compilation context**: `{{ this }}` (the relation being built), `ref()`/`source()`, model config, macros. The node's "output" (the table) is addressable via `{{ this }}`. This is dbt's analogue of "the hook receives the node's artifact handle."
- **Failure blocks?** A failing `pre-hook` aborts the model (model not built). On transactional adapters (Postgres/Redshift) hooks run **inside the model's transaction** by default, so a failure rolls back; on Snowflake **each statement runs in its own transaction** so partial effects persist — practitioners call the BEGIN/COMMIT hook workaround "hacky" and warn it leaves table locks on failure. [discourse.getdbt.com/t/snowflake-adapter-supports-transactions.../16438], Reddit r/dataengineering "Inserting audit record with dbt / Snowflake"
- **Resume nuance (DIRECTLY relevant to our `--from`):** `execute_hooks_on_any_reuse` — "When dbt State skips a node because it's still fresh, that node's pre- and post-hooks are **not** executed by default… if the node wasn't executed, its hooks don't run." Set `true` for audit hooks that must run on every invocation. [docs.getdbt.com/reference/resource-configs/execute-hooks-on-any-reuse] → **This is exactly the question Pi Flow must answer for artifact-stat resume.**

### 1.2 Claude Code hooks (PreToolUse / PostToolUse / Stop)
- **Declared:** Declarative JSON in settings (`~/.claude/settings.json`, project settings, or plugin `hooks/hooks.json`). Keyed by event name; each entry has an optional **`matcher`** (regex over `tool_name`, e.g. `"Write|Edit"`; `"*"`/omitted = all) and a list of hooks with `type: "command"` (or `"prompt"`) + `command` + optional `timeout`. [code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks), [github.com/anthropics/claude-code .../hook-development/SKILL.md]
- **When:** Three cadences — once per session (`SessionStart`/`SessionEnd`), once per turn (`UserPromptSubmit`/`Stop`/`StopFailure`), **per tool call** (`PreToolUse` before, `PostToolUse` after — the workhorse pair). `PostToolUse` fires after the tool finishes **whether success or error**. [code.claude.com/docs/en/hooks-guide.md]
- **How it gets IO:** **JSON on stdin** (command hooks) / POST body (HTTP). Common fields `session_id`, `cwd`, `hook_event_name`; event-specific `tool_name`, `tool_input` (Pre), `tool_result`/`tool_input` (Post). A `PreToolUse` hook can **rewrite tool inputs** by emitting modified JSON on stdout; `PostToolUse` can transform the result or set `updatedToolOutput`/`additionalContext`. [agent SDK hooks: code.claude.com/docs/en/agent-sdk/hooks.md]
- **Failure blocks?** Communicated by **exit code**: exit 0 = proceed (stdout parsed for JSON control); **exit 2 = blocking error** — `PreToolUse` blocks the tool call, stderr is fed back to the model. `PostToolUse` exit-2 signals an issue but **cannot "un-run"** the already-executed tool. Finer control via exit-0 + JSON `permissionDecision: allow|deny|ask`. **Hooks fail OPEN by default if they crash** [SECONDHAND, engineering-playbook]: a buggy hook with `set -e` can exit non-zero and accidentally block. [engineering-playbook.vercel.app/claude-code/pretooluse-and-posttooluse-hooks]

### 1.3 GitHub Actions — composite-action `pre:`/`post:` & step patterns
- **Declared:** `action.yml` metadata — `runs.pre` / `runs.post` (JS/Docker actions) name a script; `runs.pre-if` / `runs.post-if` gate them. Composite actions declare `inputs`, `outputs`, `runs.steps[*]`. [docs.github.com/.../metadata-syntax]
- **When:** `pre:` at job start before `main:`; `post:` at job end after `main:`. **Both "always run by default."** Critically, **`post-if` defaults to `always()`** and **status checks evaluate against the JOB's status, not the action's own** — so `post:` runs even when the main step failed/was cancelled (this is why people use it for cleanup, lock release, token teardown). [docs.github.com/.../metadata-syntax `runs.post-if`], [github.com/actions/runner/issues/1478 — "Always run" vs "Conditional run" use cases]
- **How it gets IO:** Via **env vars and the workspace** — inputs arrive as `INPUT_*` env, outputs via `$GITHUB_OUTPUT`. State handed from `pre`→`main`→`post` via **`STATE_*` env / `saveState`**; the docker pre/post-entrypoint run in **separate containers** so "any state you require must be accessed in either the workspace, `HOME`, or as a `STATE_` variable." [docs.github.com `runs.post-entrypoint`]. Composite actions: **interface is inputs+outputs, nothing else carries over**; secrets are NOT auto-available. [github.com/actions/runner .../1144-composite-actions.md]
- **Failure blocks?** If a composite step fails with no `if`, the whole composite job fails (default step `if` is `success()`). `continue-on-error: true` lets subsequent steps run. `post:` still runs because of `always()`. [github.com/actions/runner .../0549-composite-run-steps.md]
- **Takeaway for us:** GitHub's split of **"always-run cleanup"** vs **"on-success-only"** post-steps, and **state passed via the workspace/STATE vars (not return values)**, maps almost 1:1 onto our filesystem-only model.

### 1.4 LangGraph `pre_model_hook` / `post_model_hook`
- **Declared:** As **callables/runnables** passed to `create_react_agent(..., pre_model_hook=, post_model_hook=)`. **Each hook becomes its own NODE in the compiled StateGraph** (pre_model_hook → agent; agent → post_model_hook with conditional routing). [reference.langchain.com/.../create_react_agent], [github.com/langchain-ai/langgraph/pull/4059], [issue #5710 — "Each hook becomes a node in the workflow graph if defined"]
- **When:** `pre_model_hook` before the LLM-calling node (use: trim/summarize history); `post_model_hook` after (use: HITL, guardrails, validation).
- **How it gets IO:** Receives **current graph state**, returns a **state update**. `pre_model_hook` must return `messages` (UPDATE state) or `llm_input_messages` (used as LLM input only, does NOT update state). Hooks can read/write any state channel.
- **Failure blocks?** Not framed as block/allow — a hook is a graph node, so an exception fails that node and (absent error handling) the graph step. Notable: **state is the carrier, hooks are first-class nodes** — the single most aligned precedent for "a hook joins the same graph as the node."

### 1.5 Orchestrator cluster — Temporal / Prefect / Dagster / Airflow
- **Temporal interceptors:** Code, registered on Worker/Client. **Middleware/chain** model: `execute_activity(input)` runs your code → `await self.next…` → your code after. You inspect/modify **input AND result**, handle errors at either stage. NOT file-declarative; this is the **wrap-the-call** pattern (closest to "a control node wrapping a node"). [docs.temporal.io/develop/python/workers/interceptors], [github.com/temporalio/sdk-python .../_interceptor.py]
- **Prefect state-change hooks:** Declared as `on_completion=[...]`, `on_failure=[...]`, `on_running=[...]` lists on `@task`/`@flow`. Fire **on state transitions**; signature `(task, run, state)`. **Run CLIENT-SIDE, execution not guaranteed**; run OUTSIDE the run context (`get_run_logger()` raises). `on_running` is **synchronous before the body** and fires on **each retry**. Plus transaction hooks `on_commit`/`on_rollback`. [docs.prefect.io/v3/concepts/states], [docs.prefect.io/.../state-change-hooks]
- **Dagster op hooks + asset checks + IO managers** (three distinct, all relevant):
  - **Op hooks:** `@success_hook` / `@failure_hook`, attached on `@job(hooks={...})` or per-op. Receive a **`HookContext`** exposing `op_output_values`, `op_exception`, `op_config`, `resources`, `step_key`. Per-op granularity. [docs.dagster.io/guides/build/ops/op-hooks]
  - **Asset checks:** `@asset_check(asset=…, blocking=True)` — **a declarative POST-validation that BLOCKS downstream**: "if the check fails with severity ERROR, downstream assets won't execute… gating applies only to failed check results; if no result is emitted, downstream proceeds and a warning is logged." [docs.dagster.io/guides/test/asset-checks], [docs.dagster.io/api/dagster/asset-checks] → **This is our "post-hook that validates the node's artifacts and can fail the unit" with explicit blocking semantics.**
  - **IO managers:** `handle_output`/`load_input` — **separate the read/write of artifacts from the transform logic**, so swapping the store doesn't touch node logic. [docs.dagster.io/guides/build/io-managers] → conceptual cousin of "hooks own staging/projection of files; the node owns the work."
- **Airflow `pre_execute`/`post_execute` + callbacks:** `pre_execute(context)` immediately before `execute()` — **"raising an exception will prevent the task from being executed"**; `post_execute(context, result)` immediately after — **"raising an exception will prevent the task from succeeding."** Plus state callbacks `on_success_callback`/`on_failure_callback`/`on_execute_callback`. [airflow.apache.org/.../baseoperator] → cleanest statement of **pre-hook failure ⇒ node skipped; post-hook failure ⇒ node fails.**

### 1.6 git hooks / Husky — canonical naming & block semantics
- **Declared:** Convention over config — executable scripts named exactly `pre-commit`, `post-commit`, `pre-push`, etc., in the hooks dir (Husky: `.husky/`, via `core.hooksPath`). [git-scm.com/docs/githooks], [typicode.github.io/husky]
- **When/Block?** **`pre-commit`: non-zero exit ABORTS the commit** (bypassable with `--no-verify`); **`post-commit`: notification only, CANNOT affect the outcome.** This is the canonical "pre can veto, post cannot un-do" asymmetry — same as Claude Code Pre/Post and Airflow pre/post. Husky: "add `exit 1` to abort the Git command." [git-scm.com/book/.../Customizing-Git-Git-Hooks]
- **IO:** Positional args + env (e.g., `commit-msg` gets the message-file path); no return channel beyond exit code.

### 1.7 Incremental-build analogy — Bazel / Make (input/output declaration)
**This is the deepest precedent for "hook declares files it reads/writes."**
- A Bazel **action** "describes how to generate a set of **outputs** from a set of **inputs**"; the set of input and output files **must be known at analysis time** and is registered in the dependency graph. Targets declare `srcs`/`deps`/`outs`; `ctx.actions.declare_file`/`declare_directory` declare outputs. [bazel.build/extending/rules], [bazel.build/concepts/dependencies]
- **Correctness rule:** "the graph of actual dependencies must be a **subgraph** of the graph of declared dependencies" — i.e., **declare everything you read, or get undefined behavior.** [bazel.build/concepts/dependencies]
- **Hermeticity + content-hash skip:** "an action only uses its declared input files… and only produces its declared outputs." Bazel skips an action when the **hashes** of declared inputs + the command + declared outputs all match the cache. Make's flaw: it tracks only **timestamps of declared inputs**, misses command changes → `make clean`. [bazel-docs guide.html], [blogsystem5.substack.com/p/bazel-action-determinism]
- **Takeaway:** Declared inputs/outputs are precisely what lets a build system (a) wire the DAG and (b) **skip up-to-date work** — exactly Pi Flow's `--from` artifact-stat resume. **Treat each hook as a Bazel action: declared `inputs[]` → `outputs[]`, content-addressable, skippable when fresh.**

### 1.8 Practitioner sentiment (Reddit leg)
- **dbt hooks are beloved but blunt:** "What DBT function you discovered recently and use everywhere? … this is hooks (pre_hooks and post_hooks) allowing to run any sql on your DB!" (37 upvotes, r/dataengineering). But the **failure/atomicity gap is the #1 pain**: the audit-record-on-failure thread shows post-hooks silently skipped on failure and transaction hacks that deadlock. → **Validates exposing explicit `when: always|on-success|on-failure` and idempotency, which dbt lacks.**
- **Strong "deterministic gate > AI agent on a seam" signal** (directly informs §3): two r/devops/r/github posts independently built **deterministic PreToolUse gates** because "Markdown instructions are suggestions… compliance was probabilistic not deterministic," and "You don't want something probabilistic guarding your infra config at 2am. You want something that either fires or doesn't, with zero ambiguity… Deterministic beats intelligent when the cost of being wrong is an outage." [r/github "Built a dumb deterministic version instead", r/devops "AI-agent governance/guardrail"]
- **PreSync/PostSync as first-class hooks:** Argo CD Resource Hooks split deployment into **PreSync** and **PostSync** workflows for staged, controllable transitions (r/devops, 27 upvotes) — another pre/post-around-the-unit precedent.
- **Helm pre/post hooks** can't easily read the deployed state back (r/devops, 38 upvotes: "Helm is write-only… cannot read the name of a pod deployed during a deployment") → argues for our hooks' IO being **explicit declared paths**, not implicit runtime state.

---

## 2. SYNTHESIS — the Pi Flow declarative hook model

### 2.1 Proposed hook SCHEMA (TS-ish)

```ts
/** A deterministic, file-declaring step that runs immediately before (pre) or
 *  after (post) a node's agent. NOT an LLM step. Joins the node's filesystem
 *  data-flow graph via declared inputs[]/outputs[]. */
interface NodeHook {
  id: string;                       // stable id; appears in the DAG viz
  phase: "pre" | "post";            // pre = stage/prepare inputs; post = transform/merge/validate outputs

  /** Files the hook READS. For a pre-hook these are graph inputs that gate it;
   *  for a post-hook these are (a subset of) the node's declared artifacts. */
  inputs: PathPattern[];            // e.g. ["templates/seed.json", "out/agent/*.json"]

  /** Files the hook WRITES. For a pre-hook these FEED the node (become node inputs);
   *  for a post-hook these are derived/merged/projected artifacts. */
  outputs: PathPattern[];           // declared like a Bazel action's outs — used to wire the DAG AND for resume

  /** When the hook fires relative to node outcome (git/Airflow/GH-Actions semantics). */
  when: "always" | "on-success" | "on-failure";   // pre-hooks: effectively "always" (they gate the node)

  /** The deterministic body — exactly one of: */
  run?: string;                     // shell command (cwd = node sandbox); IO contract = declared paths
  fn?: (ctx: HookContext) => Promise<void> | void;  // in-process TS fn

  /** Replay/skip behavior under artifact-stat resume (--from). Bazel-style. */
  idempotent?: boolean;             // default true: outputs are a pure function of inputs ⇒ skippable when fresh
  runOnReuse?: boolean;             // default false: like dbt execute_hooks_on_any_reuse — force-run even if node reused

  failure?: "block" | "warn";       // default "block": a failed hook fails the unit (see §2.4)
  timeoutMs?: number;
}

/** What the hook body receives — paths, not the node's internals (sandbox-agnostic). */
interface HookContext {
  nodeId: string;
  phase: "pre" | "post";
  inputs: Record<string, string>;   // declared input name -> resolved absolute path
  outputs: Record<string, string>;  // declared output name -> resolved absolute path it MUST write
  nodeStatus?: "success" | "failure";  // post-hooks only
  // NOTE: no sandbox/tool-registry internals here (out of scope, owned elsewhere)
}
```

Field rationale by precedent: `inputs`/`outputs` ← **Bazel action** `srcs`/`outs` (DAG wiring + skip); `when` ← **GitHub `post-if: always()`** + **git pre/post** + **Prefect `on_completion`/`on_failure`**; `run`/`fn` ← **dbt `{sql}` dict** / **Claude Code `type: command`**; `idempotent`/`runOnReuse` ← **dbt `execute_hooks_on_any_reuse`** + **Bazel hermeticity**; `failure: block|warn` ← **Dagster asset-check `blocking`** + **Airflow pre/post exception semantics**; HookContext as **declared paths** ← **GitHub workspace/`STATE_` passing** + **Dagster IO managers** (decouple read/write from logic).

### 2.2 Direct answer: CAN pre/post hooks be declarative AND file-dependency-aware — and HOW do they join the DAG?

**Yes — and the strongest precedent (Bazel) proves the two go together.** A hook that declares `inputs[]`/`outputs[]` is exactly a Bazel action: the declaration is simultaneously (a) the DAG-wiring contract and (b) the resume key. Wire it as:

- A **pre-hook** is a graph node placed **upstream of the agent node**: its declared `outputs[]` become (a subset of) the agent's `inputs`. Edge: `preHook.outputs → node.inputs`. (Exactly LangGraph's `pre_model_hook → agent` edge, but with **files** as the channel instead of in-memory state.)
- A **post-hook** is a graph node placed **downstream of the agent node**: its declared `inputs[]` are (a subset of) the node's required artifacts. Edge: `node.artifacts → postHook.inputs → postHook.outputs`. (LangGraph's `agent → post_model_hook`; Dagster's blocking asset check on a node's output.)
- **In the viz**, render hooks as distinct, smaller nodes adjacent to their node (cf. LangGraph "each hook becomes a node"; Argo PreSync/PostSync). The filesystem edges already exist because inputs/outputs are paths — the same artifact-by-path data-flow the nodes use. **The hook does NOT need a side channel; the file IS the edge.**
- **Correctness obligation (from Bazel):** the hook's *actual* file reads/writes must be a **subgraph** of its *declared* `inputs`/`outputs`, or resume and the viz lie. Enforce by running hooks under the node's sandbox scope (sandbox internals owned elsewhere) and, optionally, by statting that declared outputs were produced.

### 2.3 The line: deterministic HOOK (code) vs CONTROL NODE / agent (LLM on a seam)

| Use a **HOOK** (deterministic code, no model) when… | Use a **CONTROL NODE / agent** (LLM) when… |
| --- | --- |
| The transform is **mechanical & specifiable**: stage a template, rename/merge files, JSON-schema-validate, project a subset, compute a manifest, fail on a missing artifact. | The seam needs **judgment/intelligence**: decide *which* artifact is best, summarize/triage agent output, route conditionally on semantics, repair malformed output. |
| You need it **fast, free, and 100% repeatable** — "either fires or doesn't, with zero ambiguity." [r/github, r/devops] | A wrong-but-plausible answer is acceptable / the input space is open-ended. |
| It must be **trustworthy as a gate** (validation that blocks the unit). Determinism is the whole point. [r/devops: "Deterministic beats intelligent when the cost of being wrong is an outage."] | The work is itself a unit of cognition → then it deserves to be **its own pi node**, not a hook. |
| Maps to: Bazel action, dbt hook, Claude Code command hook, Airflow pre/post_execute, Dagster asset check. | Maps to: Temporal interceptor wrapping a call with logic, LangGraph `post_model_hook` doing HITL/guardrails — but if it's an LLM, in Pi Flow it should be a **node**, not a hook. |

**Rule:** a hook is the **plumbing on the seam**; a control node is the **cognition on the seam**. If a candidate hook needs an LLM, promote it to a first-class pi node so it gets its own sandbox, tool allowlist, and output contract — don't smuggle a model into a hook. (Hooks staying model-free is also what keeps `idempotent` honest.)

### 2.4 FAILURE & RESUME semantics

**Failure (consensus across git, Airflow, Claude Code, Dagster, GitHub Actions):**
- **Pre-hook failure ⇒ the node does NOT run, and the unit fails.** (Airflow `pre_execute` raising "prevents the task from being executed"; git `pre-commit` non-zero aborts; Claude Code `PreToolUse` exit-2 blocks.) A pre-hook is a **veto gate**.
- **Post-hook failure ⇒ the unit fails (does not "succeed").** (Airflow `post_execute` raising "prevents the task from succeeding"; Dagster blocking asset check stops downstream.) BUT the node's side effects **already happened** — a post-hook **cannot un-run the agent** (git `post-commit` "cannot affect the outcome"; Claude Code `PostToolUse` cannot un-run the tool). So post-hook failure must mark the unit failed for **downstream gating**, not pretend the agent didn't run.
- **`when` controls firing vs outcome:** `when: "always"` post-hooks (cleanup, audit) run regardless of node success — model on **GitHub `post-if: always()`**, evaluated against the **node's** status. `when: "on-failure"` for compensation/rollback artifacts. `failure: "warn"` downgrades a hook from a gate to advisory (GitHub `continue-on-error`, Dagster non-blocking check).
- **Downstream blocking:** a `failure: "block"` hook (default) fails the unit ⇒ standard DAG failure propagation blocks dependents. A `failure: "warn"` hook logs and lets downstream proceed (Dagster: "if no result is emitted… downstream proceeds and a warning is logged").

**Resume / idempotency (the `--from` story — Bazel + dbt are the guides):**
- Because hooks declare `inputs[]`/`outputs[]`, the resume engine treats a hook **identically to a node**: if a hook's declared outputs exist and are **fresh w.r.t. its declared inputs** (stat/content-hash), **skip it** — Bazel's "match inputs+command+outputs in the cache ⇒ omit the step." This is why `idempotent` defaults to **true**: outputs must be a pure function of declared inputs (no hidden reads, no appends to external state).
- **The dbt trap to expose explicitly:** when a node is reused (not rebuilt), are its hooks skipped? dbt's default is **skip** (`execute_hooks_on_any_reuse: false`); audit/lineage hooks opt in with `true`. Pi Flow should surface the same switch as **`runOnReuse`** (default `false`), so the common case replays cleanly and the rare always-run audit hook is opt-in.
- **Anti-pattern to forbid (Reddit-validated):** non-idempotent post-hooks that **append** to external state or rely on transactions across statement boundaries (the dbt/Snowflake audit-table deadlock). For filesystem-only hooks, prefer **write-whole-file** outputs (replace, not append) so a replay is naturally idempotent — mirrors Bazel's "actions must (re)create all their declared outputs."

---

## 3. The three sharpest best-practice rules for Pi Flow

1. **Declare inputs/outputs like a Bazel action — the declaration IS the DAG edge AND the resume key.** A hook's `outputs[]` are paths; a pre-hook's outputs feed the node, a post-hook's inputs are the node's artifacts. Forbid undeclared reads/writes (actual ⊆ declared, or resume/viz lie). One declaration buys graph wiring, viz placement, and skip-when-fresh.

2. **Pre vetoes, post cannot un-run — make `when` + `failure` explicit because dbt's implicitness is the #1 practitioner pain.** Default `when: on-success` for post-hooks but offer `always` (GitHub `post-if: always()`) for cleanup/audit and `on-failure` for compensation; default `failure: block` (Dagster blocking check) with `warn` as the escape hatch. Never silently skip a post-hook on node failure without the user choosing it.

3. **Keep hooks model-free; if a seam needs intelligence, promote it to a pi node.** Determinism is the entire value of a hook ("either fires or doesn't, zero ambiguity" — r/devops/r/github building deterministic gates *because* LLM compliance is probabilistic). Model-free is also what keeps `idempotent` true and `--from` replay correct. An LLM on a seam deserves its own sandbox + tool allowlist + output contract — that's a node, not a hook.

---

## 4. Sources (cited inline above)
**Exa leg:** dbt docs (pre-hook/post-hook, define-configs, execute-hooks-on-any-reuse, hooks-operations) + dbt Community Forum; Claude Code hooks docs (hooks, hooks-guide, agent-sdk/hooks) + anthropics/claude-code hook-development SKILL + engineering-playbook; GitHub Actions metadata-syntax + actions/runner ADRs 0549/1144 + issue 1478; LangGraph create_react_agent reference + PR #4059 + issues #5710/#5692; Temporal interceptors (Python/TS) + sdk-python `_interceptor.py`; Prefect states + state-change-hooks + SDK; Dagster op-hooks + hooks API + asset-checks + io-managers + issue #17251; Airflow baseoperator; git-scm githooks + Pro Git book; typicode/husky docs; Bazel dependencies/rules/actions + guide + blogsystem5 action-determinism.
**Reddit leg (Apify macrocosmos/reddit-scraper, dataset `81mKagLGvCREPjL0C`, 23 posts):** r/dataengineering (dbt hooks praise; dbt/Snowflake audit-atomicity pain; dynamic-DAG hooks limits); r/devops (deterministic AI-governance PreToolUse gate; Argo CD PreSync/PostSync; Helm write-only state limitation; Terraform pre-commit CI layering); r/github (deterministic PR-context gate over AI agent; pre-push/server-side hook blocking).
