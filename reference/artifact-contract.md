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
**self-report** — and a self-report from a derailed cheap model is worthless precisely when you need
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
DRIVER-ARTIFACTS:   <space-separated ABSOLUTE paths that MUST exist, non-empty, on exit>
DRIVER-OWNS:        <space-separated ABSOLUTE paths/globs this node may write; /* or /** = a dir>
DRIVER-READ-SCOPE:  <space-separated ABSOLUTE roots this node may READ; OS-enforced under --sandbox>
```

The workflow author never hand-writes those lines. A single `contract({...})` declaration —
authored **once**, the same double-duty economy as `schema` — renders **both** the forceful
Definition-of-Done prose (which the model reads) **and** the two markers (which the driver parses):

```js
// in .claude/workflows/<name>.js, next to discipline()
function contract({ artifacts = [], owns = [], readScope = [], note = '' }) {
  const abs = (p) => `${REPO}/${p}`
  return [
    'OUTPUT CONTRACT — you are DONE only when EVERY file below exists and is non-empty at EXACTLY ' +
    'its path. Write NOTHING outside the owned paths. If you cannot, set status="blocked" and say ' +
    'why — do NOT exit clean (an empty or wrong-path artifact set is a FAILURE, not an ok).',
    `DRIVER-ARTIFACTS: ${artifacts.map(abs).join(' ')}`,
    `DRIVER-OWNS: ${(owns.length ? owns : artifacts).map(abs).join(' ')}`,
    readScope.length ? `DRIVER-READ-SCOPE: ${readScope.join(' ')}` : '',
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
- `note` — an optional extra owned-path caveat (e.g. a `LESSON-AGNOSTIC` rule).

## Driver enforcement (`run.mjs`, generic)

After a node exits, in addition to stat()ing the self-reported `outputArtifacts`:

1. **Required-artifact hard gate.** Parse `DRIVER-ARTIFACTS`; stat each path **independent of the
   self-report**. Any missing → `status = "blocked"`, with `contract breach — required artifact(s)
   missing: …` in `issues`. This branch sits **above** the self-reported status, so a node that
   claims `ok` but didn't produce a required file cannot pass. Recorded as `n.requiredArtifacts`.
2. **Owned-path containment (soft, post-hoc).** Parse `DRIVER-OWNS`; check every self-reported write
   is inside an owned glob. A reported out-of-lane write → a `contract warn` issue + `n.ownsBreach`.
   This is **soft** because the self-report won't *admit* a contamination write. Two hard layers now
   compose above it: the **in-loop block** (the node-contract extension, below — PREVENTS the write)
   and `git diff --name-only ⊆ owns` via per-stage commits (DETECTS it after the fact).

A node with no `DRIVER-ARTIFACTS` line is unaffected (backward-compatible — check/preflight/gate
nodes legitimately produce nothing).

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
   fenced-JSON parser — so the cheap model can no longer botch the ```json fence (the single most-
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
