# The Output Contract (artifact contract)

The fourth contract layer for a multi-node workflow — the one Claude Code does **not** give you
natively, and the one that makes "this node must deliver exactly this artifact to exactly this
place" a thing the *system* owns rather than a thing the model *promises*.

## Why this exists

Claude Code already specifies three of the four contract layers for a unit of work, and a converted
workflow already uses all three:

| Layer | Native mechanism | Validation |
|---|---|---|
| **Requirements / when-to-use** | skill `description` frontmatter · Workflow `meta.description`/`meta.phases` | none (heuristic) |
| **Input / Output protocol** | skill body `## Inputs` + `` ## Output(`path`) `` (progressive disclosure) | none (prose) |
| **Return contract** | `agent(prompt, {schema})` → forced **StructuredOutput** tool call | strict, native, **retried** |
| **Artifact contract** | — *(none native)* — | **orchestrator territory** |

The native structured-output mechanism validates the model's **returned message**, never the
**filesystem**. Anthropic's own guidance puts artifact-on-disk verification at the orchestrator
layer (`fs.existsSync`, a preflight check node). So `outputArtifacts` in a node's return is a
**self-report** — and a self-report from a derailed non-Claude model is worthless precisely when you need
it: it can claim `[]`, name the wrong path, or (the real incident) wander into a *sibling lesson's*
file, write nothing for its own, and still exit clean. The driver had nothing to compare against,
because it only ever checked *what the node claimed it wrote*, never *what the node was required to
produce*.

The earlier `no-return-block → error` fix closed only the **no-parse** hole. It did **not** close:
*parsed a clean return but produced an empty/wrong artifact set*, nor *wrote outside its lane*. The
Output Contract closes both — by declaring the required end-product up front, as data the driver
owns.

## The mechanism — two markers + one helper

Same convention as `DRIVER-PREFLIGHT`: a marker line in the node's prompt that the **generic
driver** parses in plain code (no extractor change — the marker rides the prompt for free).

```
DRIVER-ARTIFACTS:     <space-separated ABSOLUTE paths that MUST exist, non-empty, on exit>
DRIVER-OWNS:          <space-separated ABSOLUTE paths/globs this node may write; /* or /** = a dir>
DRIVER-READ-SCOPE:    <space-separated ABSOLUTE roots this node may READ; OS-enforced under --sandbox>
DRIVER-SCHEMA:        <one PATH to a JSON-Schema the produced DRIVER-ARTIFACTS must validate against>
DRIVER-FILL-SENTINEL: <a template-fill sentinel string (e.g. "<FILL:") a seeded skeleton must not retain>
```

The workflow author never hand-writes those lines. A single `contract({...})` declaration —
authored **once**, the same double-duty economy as `schema` — renders **both** the forceful
Definition-of-Done prose (which the model reads) **and** the two markers (which the driver parses):

```js
// in .claude/workflows/<name>.js, next to discipline()
function contract({ artifacts = [], owns = [], readScope = [], schema = '', fillSentinel = '', note = '' }) {
  const abs = (p) => `${REPO}/${p}`
  return [
    'OUTPUT CONTRACT — you are DONE only when EVERY file below exists and is non-empty at EXACTLY ' +
    'its path. Write NOTHING outside the owned paths. If you cannot, set status="blocked" and say ' +
    'why — do NOT exit clean (an empty or wrong-path artifact set is a FAILURE, not an ok).',
    `DRIVER-ARTIFACTS: ${artifacts.map(abs).join(' ')}`,
    `DRIVER-OWNS: ${(owns.length ? owns : artifacts).map(abs).join(' ')}`,
    readScope.length ? `DRIVER-READ-SCOPE: ${readScope.join(' ')}` : '',
    schema ? `DRIVER-SCHEMA: ${schema}` : '',                   // POST-node: validate the artifact's SHAPE
    fillSentinel ? `DRIVER-FILL-SENTINEL: ${fillSentinel}` : '',// the seeded-skeleton-not-yet-filled guard
    note ? `OWNED-PATH NOTE: ${note}` : '',
  ].filter(Boolean).join('\n')
}

// at each producing node — declare the end-product AND the read surface as DATA:
const rPed = await agent([
  discipline(),
  'W0 — PEDAGOGY GATE. …',
  `INPUT: ${REPO}/${P.brief}.`,
  contract({
    artifacts: [P.pedagogy],
    readScope: [`${REPO}/${data}`, `${REPO}/${out}`, `${ROOT}/.agents`],
    note: 'pure pedagogy reasoning; touches no code.',
  }),
].join('\n'), { schema: NODE_RESULT })
```

- `artifacts` — files that **MUST** exist (non-empty) when the node exits. The **hard gate**.
- `owns` — the **only** paths the node may write (defaults to `artifacts`). A trailing `/*` or
  `/**` marks a directory the node owns.
- `readScope` — the node's full legitimate READ surface: its own data/out dirs + the shared
  skill/catalog roots it is pointed at. Renders `DRIVER-READ-SCOPE`. **Entries are ABSOLUTE and joined
  AS-IS** (NOT `abs()`-prefixed — readScope roots commonly span outside `REPO`, e.g. `${ROOT}/.agents`).
  OS-enforced under `--sandbox` (macOS Seatbelt: any read outside {toolchain ∪ scope} EPERMs, inherited
  by child processes); inert without it. **Every producing node should declare one** — see
  `reference/read-scope-sandbox.md`.
- `schema` — **(POST-node) the artifact's SHAPE gate.** The path to a JSON-Schema the produced
  `artifacts` must validate against. Renders `DRIVER-SCHEMA`; after the node, the driver validates each
  PRESENT required artifact against it and an **invalid** artifact is a BREACH (`blocked`), the exact
  twin of a *missing* one. This closes the class the existence gate cannot — *present but malformed* (a
  wrong type, a missing required key, an unfilled `<FILL:>` sentinel that still violates a type/enum). A
  PATH (repo-relative or absolute) joined AS-IS, like `readScope`. See **The post-node schema gate** below.
- `fillSentinel` — the template-fill sentinel string (e.g. `'<FILL:'`). Renders `DRIVER-FILL-SENTINEL`,
  which the **in-loop** write-first gate (the node-contract extension, when armed) refuses to
  `submit_result` over while a required artifact still contains it — the in-loop complement of the
  post-node schema gate (a leftover sentinel breaks the schema's type/enum and is caught post-hoc too).
- `note` — an optional extra owned-path caveat (e.g. a `LESSON-AGNOSTIC` rule).

## The node-contract LIFECYCLE — PRE-node and POST-node, declared in one place

A node's contract is not just "what must exist on exit." It brackets the node on **both** sides, and a
node author declares **both halves in the one `contract({...})`** so the whole envelope is visible at the
node, not scattered across the driver:

| Phase | Marker | Driver action (generic, plain code — no model) |
|---|---|---|
| **PRE — stage the start** | `DRIVER-SEED: <dest> <= <src>` | Deterministically pre-stage the node's STARTING artifact before pi spawns (e.g. copy a per-archetype skeleton in for the node to fill). Idempotent: only when dest is absent/empty AND src exists. |
| **PRE — verify the inputs** | `DRIVER-PREFLIGHT: <paths>` (or the `--from` resume preflight over the skipped nodes' `DRIVER-ARTIFACTS`) | `stat()` the upstream inputs the node depends on; HALT if any is absent, so a node never runs on missing inputs. |
| **POST — existence** | `DRIVER-ARTIFACTS: <paths>` | `stat()` each required path; a missing/empty one is a BREACH (`blocked`). |
| **POST — shape** | `DRIVER-SCHEMA: <schema>` | Validate each present required artifact against the JSON-Schema (draft-2020-12); an invalid one is a BREACH (`blocked`). |
| **POST — filled** | `DRIVER-FILL-SENTINEL: <sentinel>` | (In-loop, when the node-contract extension is armed) block `submit_result` while a required artifact still holds the template sentinel — the unfilled-skeleton guard. |

The shape: **PRE = seed the start + preflight the inputs; POST = existence + schema + filled.** The PRE
half makes the node start from a known state; the POST half makes "done" a programmatic verdict the
driver owns, not a self-report the model emits. All five markers are inert when absent, so a node opts
into exactly the halves it needs — a pure check node declares only `DRIVER-PREFLIGHT`; a from-scratch
producer declares `DRIVER-ARTIFACTS`+`DRIVER-SCHEMA`; a fill-a-skeleton producer adds `DRIVER-SEED`+
`DRIVER-FILL-SENTINEL`. Encoding the whole envelope up front is the shift-left, root-cause discipline:
specify the start state AND the end product as DATA, instead of detecting a malformed/absent artifact
downstream when its consumer chokes.

## Driver enforcement (`run.mjs`, generic)

After a node exits, in addition to stat()ing the self-reported `outputArtifacts`:

1. **Required-artifact hard gate.** Parse `DRIVER-ARTIFACTS`; stat each path **independent of the
   self-report**. Any missing → `status = "blocked"`, with `contract breach — required artifact(s)
   missing: …` in `issues`. This branch sits **above** the self-reported status, so a node that
   claims `ok` but didn't produce a required file cannot pass. Recorded as `n.requiredArtifacts`.
2. **Required-artifact SCHEMA gate (hard).** Parse `DRIVER-SCHEMA`; if present, validate each PRESENT
   required artifact against that JSON-Schema. Any invalid → `status = "blocked"`, with `contract breach
   — artifact(s) violate the declared schema: …` in `issues` and the per-artifact errors in
   `n.schemaInvalid`. Sits in the same `blocked` branch as the existence gate, just below it (a *missing*
   artifact is the existence gate's call; the schema gate judges only what is *present*). Driver-verified,
   programmatic — never an LLM judging its own output. See **The post-node schema gate** below.
3. **Owned-path containment (soft, post-hoc).** Parse `DRIVER-OWNS`; check every self-reported write
   is inside an owned glob. A reported out-of-lane write → a `contract warn` issue + `n.ownsBreach`.
   This is **soft** because the self-report won't *admit* a contamination write. Two hard layers now
   compose above it: the **in-loop block** (the node-contract extension, below — PREVENTS the write)
   and `git diff --name-only ⊆ owns` via per-stage commits (DETECTS it after the fact).

A node with no `DRIVER-ARTIFACTS`/`DRIVER-SCHEMA` line is unaffected (backward-compatible —
check/preflight/gate nodes legitimately produce nothing, and a node may declare artifacts but no schema).

## The post-node schema gate (generic, opt-in — `DRIVER-SCHEMA`)

The existence gate proves an artifact *is there*. It cannot prove the artifact is *well-formed* — a
non-Claude model that returns a clean `ok` and writes a real file can still leave it the wrong shape: a
missing required key, a wrong type, or a pre-seeded template skeleton whose `<FILL:>` leaves were never
replaced. That defect surfaces only one or two nodes downstream, when a consumer chokes on the malformed
input — the exact late-binding failure the contract exists to pull forward. **The schema gate is the
shape twin of the existence gate:** a node declares its artifact's JSON-Schema (`contract({ schema })`),
and after the node the driver validates the produced artifact against it. An invalid artifact is a
BREACH (`blocked`), caught **programmatically at the producing node's own stage** — never by asking an
LLM whether its output is valid.

- **Generic + marker-gated.** Any node opts in by declaring a `schema`; a node without one is unchanged.
  `run.mjs` parses `DRIVER-SCHEMA` for *any* workflow — no per-repo engine edit.
- **draft-2020-12 capable — the precise gap.** A modern schema using `allOf`/`if-then`/`$defs`/`const`
  is **rejected by `ajv-cli`'s default draft-07**. The gate therefore loads a draft-2020-12 validator
  (`ajv`'s `Ajv2020` entry point), so a real-world schema validates instead of erroring on its own meta-
  schema. This was the live wall a hand-rolled `ajv-cli` check hit.
- **Lean + gracefully-degrading (the engine law).** `run.mjs` stays byte-identical across repos, so it
  **cannot hard-depend** on a bundled validator. A draft-2020-12 validator is an **optional per-repo
  dep**: declare `ajv` (+ `ajv-formats`) in `pi-runner/package.json` so it installs into
  `pi-runner/node_modules` (per-repo wiring, exactly like `.env` — NOT an engine file). The loader is
  best-effort — it resolves a validator from the engine dir / `RUN_CWD` / `ROOT` `node_modules`, and if
  **none** resolves it WARNS and SKIPS (a non-blocking `schema gate skipped — …` issue), so a missing
  optional dep never bricks a run, while a declared schema *with* a validator present is enforced hard.
- **Subsumes the no-`<FILL:>` check.** A leftover template sentinel breaks the schema's type/enum, so
  the schema gate catches it post-hoc regardless. `DRIVER-FILL-SENTINEL` is the fast **in-loop**
  complement (the node-contract extension blocks `submit_result` while a required artifact still holds
  the sentinel) — immediate model feedback, with the schema gate as the post-hoc floor.

*Worked instance (game-omni):* the HARDEN node produces the frozen `blueprint.json`, the binding
document the whole build reads. Its schema is JSON-Schema draft-2020-12; an `ajv-cli` post-node check
defaulted to draft-07 and could not validate it, so there was no programmatic integrity gate at all.
HARDEN now declares `contract({ schema: 'packages/skills/harden-blueprint/blueprint.schema.json',
fillSentinel: '<FILL:' })`; the gate validates the real blueprint as PASS and catches a deliberately-
broken copy (a deleted required key, or a retained `<FILL:>`) as a `blocked` breach. `ajv` is installed
via the repo's `pi-runner/package.json` (per-repo wiring); the engine resolution stays generic.

## The node-contract extension (in-loop, opt-in) — `extensions/node-contract.ts`

The contract above is enforced by the **driver, after the node exits**. pi's own extension API lets
us enforce two of its concerns **inside the agent loop**, where the model gets immediate feedback and
can self-correct. This is a generic `-e` extension shipped with the template (explicit `-e` still
loads under `--no-extensions`), opt-in via `PI_RUNNER_CONTRACT_EXT`. It does NOT replace the driver
checks — it shifts them left; the driver's stat() + fenced-JSON fallback remain, so ON or OFF is
non-breaking.

1. **`submit_result` — a typed terminating return tool.** The node ENDS by *calling* it; pi validates
   the args against the TypeBox schema (`{node,status,outputArtifacts,summary,issues,pipelineFindings}`)
   and `terminate:true` ends the turn. The structured payload rides the `tool_execution_end` json
   event as `result.details`; the driver reads it there (`submittedResult`) **in preference to** the
   fenced-JSON parser — so the non-Claude model can no longer botch the ```json fence (the single most-
   patched run.mjs surface: `98fcdd3 → 89fe3ac`). If the model didn't call the tool, the driver falls
   back to the parser exactly as before. **Spike-verified (2026-06-09):** qwen3.7-max calls it
   reliably headless; `details` land at `ev.result.details` (the exact field the driver reads).
2. **Owned-paths in-loop block.** A `pi.on("tool_call")` hook reads `PI_NODE_OWNS` (the driver sets it
   per node from the `DRIVER-OWNS` marker) and returns `{block:true,reason}` for any `write`/`edit`
   whose resolved path is outside the lane — PREVENTING the cross-contamination write instead of
   detecting it post-hoc. **Spike-verified (2026-06-09):** out-of-lane write blocked (file never
   created), in-lane write succeeds (no over-block). **Best-effort caveat:** it gates `write`/`edit`
   (target = `input.path`); a shell redirect inside `bash` can still bypass it, so the driver's
   post-hoc check + worktree-per-run remain the backstop for bash writes.

Arming it in production (`PI_RUNNER_CONTRACT_EXT=1`) is the next real-run validation step — the
isolated spikes pass, but over-blocking risk (a node whose legitimate write falls outside a too-tight
`DRIVER-OWNS`) is only provable on a full lesson run.

## Per-node tool gating as a behavior LOCK (`DRIVER-TOOLS` / `DRIVER-EXCLUDE-TOOLS`)

A node's `tools` list (rendered as `DRIVER-TOOLS` → pi `--tools`) is usually read as a *capability*
grant — "what the node is allowed to do." On a non-Claude/weak executor it is more powerful than that: **the
tool set is the node's ACTION SHAPE, and cutting it to the minimum FORCES the action you want.** A weak
model fills an open action space with its shortest-effort interpretation — when that interpretation is
"explore more / think more / edit-match-fail-and-retry," no amount of prompt prose pulls it back onto the
one action that produces the artifact. The lever is not exhortation; it is **removing the tools that
afford the wrong shape**, so the right shape is the *only* exit.

- **Cut to the minimum that affords the deliverable, not the maximum the node could use.** A producing
  node whose job is "read N inputs, then emit one file" needs `read, write, submit_result` — and nothing
  else. Every extra tool is an escape hatch into a degenerate loop.
- **Why this beats prose.** "Don't explore, just write" is unenforceable on a weak model; *not having a
  search tool* is enforced by construction. Tool gating moves the boundary from the prompt (advisory)
  into the harness (structural) — the same shift-left as the artifact contract itself.
- **Pairs with the thinking cap + read-scope.** Tool gating bounds the *action* space; `--thinking
  minimal`/`low` bounds the *reasoning* budget (caps compose-in-head); `DRIVER-READ-SCOPE` bounds the
  *read* surface (a node that can't grep the tree can't read-thrash). The three compose into a tight box
  that leaves the intended action as the path of least resistance.

*Worked instance (game-omni HARDEN).* HARDEN composes a large `blueprint.json` from a reference chain.
With the full toolset (`read, ls, grep, find, edit, write, bash, submit_result`) the non-Claude executor
(MiniMax-M3 on pi) **explored forever** — it read a dozen files, ran repeated `grep`/`bash` over the
tree, composed in its head, and was killed by the stall guard having written **zero** files across two
live runs. Removing the explore tools (`ls/grep/find/bash`) AND `edit` left **`read, write,
submit_result`** as the only exit: read the chain, then the one whole-file `write` is the sole way to
finish. That tool cut — not a prompt rewrite — is what fixed the compose-in-head/explore-forever stall
(it pairs with `--thinking minimal` and a tightened `DRIVER-READ-SCOPE`; the `write`-not-`edit` choice
also matches the format weak models emit most reliably for a fresh artifact). **The lesson generalizes:
when a weak executor won't stop doing the wrong thing, take away the tool that lets it.**

## Invariants

- **Markers are ABSOLUTE paths.** For `DRIVER-ARTIFACTS`/`DRIVER-OWNS`, `contract()` prepends
  `${REPO}/…` from REPO-relative inputs; the driver stat()s them as-is. (Same rule as
  `DRIVER-PREFLIGHT`.) `DRIVER-READ-SCOPE` is the exception: its `readScope` entries are **already
  absolute** (they commonly span outside `REPO`, e.g. `${ROOT}/.agents`), so they are joined AS-IS, not
  `abs()`-prefixed.
- **One declaration, both outputs.** Never hand-write the prose and the markers separately — they
  would drift. `contract()` is the single source; the prose and the machine spec are the same data.
- **Generic in the engine, declared in the workflow.** `run.mjs` parses the marker for *any*
  workflow; the per-node `artifacts`/`owns` live in the `.js` single source of truth. Editing
  `run.mjs` for one repo is the drift this pattern exists to prevent.
- **Dev vs prod split.** In the dev Workflow runtime the prose guides Claude (there is no fs
  post-hook, and Claude is reliable). On pi the driver *enforces*. Both executors see the same
  prompt text, so there is no second copy.

## Composition — per-stage commits and worktree isolation

The contract is the **shift-left, root-cause** layer. Two isolation layers compose with it:

- **Worktree per run** (SHIPPED — opt-in `--worktree`): each run gets its own git worktree, so a
  node *cannot see* a sibling's files — cross-contamination becomes **impossible** rather than merely
  *caught*. The contract still runs inside the worktree (its markers are rewritten to the worktree
  paths), so the two layers reinforce. Full spec: `reference/worktree-isolation.md`.
- **Per-stage git commit** (next): commit each node's diff inside the run's worktree. Gives a precise
  per-wave artifact snapshot (the audit trail *is* the commit DAG), resume-at-last-good-stage, and —
  crucially — turns the **owned-path check hard**: `git diff --name-only` for the stage must be a
  subset of `DRIVER-OWNS`, catching any stray write *mechanically*, with the exact offending path, at
  the stage it happened (today the owns check is soft — it inspects only the self-report).

## Relationship to the Hermes loop

The contract is the "encode the desired outcome up front" move; the Hermes loop is the "evolve when
reality still diverges" move — complements, not substitutes. A **contract breach** (`status=blocked`
with a `contract breach` issue, surfaced at the stage with the exact missing path) is a first-class
Hermes **capture signal**: it points at the failing node directly instead of waiting for a
downstream consumer to choke. And authoring a contract instead of a reactive guard is itself the
Hermes-idiomatic fix: it **generalizes across all runs** and hard-codes no single case.
