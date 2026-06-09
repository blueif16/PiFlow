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
DRIVER-ARTIFACTS: <space-separated ABSOLUTE paths that MUST exist, non-empty, on exit>
DRIVER-OWNS:      <space-separated ABSOLUTE paths/globs this node may write; /* or /** = a dir>
```

The workflow author never hand-writes those lines. A single `contract({...})` declaration —
authored **once**, the same double-duty economy as `schema` — renders **both** the forceful
Definition-of-Done prose (which the model reads) **and** the two markers (which the driver parses):

```js
// in .claude/workflows/<name>.js, next to discipline()
function contract({ artifacts = [], owns = [], note = '' }) {
  const abs = (p) => `${REPO}/${p}`
  return [
    'OUTPUT CONTRACT — you are DONE only when EVERY file below exists and is non-empty at EXACTLY ' +
    'its path. Write NOTHING outside the owned paths. If you cannot, set status="blocked" and say ' +
    'why — do NOT exit clean (an empty or wrong-path artifact set is a FAILURE, not an ok).',
    `DRIVER-ARTIFACTS: ${artifacts.map(abs).join(' ')}`,
    `DRIVER-OWNS: ${(owns.length ? owns : artifacts).map(abs).join(' ')}`,
    note ? `OWNED-PATH NOTE: ${note}` : '',
  ].filter(Boolean).join('\n')
}

// at each producing node — declare the end-product as DATA:
const rPed = await agent([
  discipline(),
  'W0 — PEDAGOGY GATE. …',
  `INPUT: ${REPO}/${P.brief}.`,
  contract({ artifacts: [P.pedagogy], note: 'pure pedagogy reasoning; touches no code.' }),
].join('\n'), { schema: NODE_RESULT })
```

- `artifacts` — files that **MUST** exist (non-empty) when the node exits. The **hard gate**.
- `owns` — the **only** paths the node may write (defaults to `artifacts`). A trailing `/*` or
  `/**` marks a directory the node owns.
- `note` — an optional extra owned-path caveat (e.g. a `LESSON-AGNOSTIC` rule).

## Driver enforcement (`run.mjs`, generic)

After a node exits, in addition to stat()ing the self-reported `outputArtifacts`:

1. **Required-artifact hard gate.** Parse `DRIVER-ARTIFACTS`; stat each path **independent of the
   self-report**. Any missing → `status = "blocked"`, with `contract breach — required artifact(s)
   missing: …` in `issues`. This branch sits **above** the self-reported status, so a node that
   claims `ok` but didn't produce a required file cannot pass. Recorded as `n.requiredArtifacts`.
2. **Owned-path containment (soft, today).** Parse `DRIVER-OWNS`; check every self-reported write
   is inside an owned glob. A reported out-of-lane write → a `contract warn` issue + `n.ownsBreach`.
   This is **soft** because the self-report won't *admit* a contamination write — full hard
   enforcement is `git diff --name-only ⊆ owns`, which arrives with **per-stage commits** (below).

A node with no `DRIVER-ARTIFACTS` line is unaffected (backward-compatible — check/preflight/gate
nodes legitimately produce nothing).

## Invariants

- **Markers are ABSOLUTE paths.** `contract()` prepends `${REPO}/…`; the driver stat()s them
  as-is. (Same rule as `DRIVER-PREFLIGHT`.)
- **One declaration, both outputs.** Never hand-write the prose and the markers separately — they
  would drift. `contract()` is the single source; the prose and the machine spec are the same data.
- **Generic in the engine, declared in the workflow.** `run.mjs` parses the marker for *any*
  workflow; the per-node `artifacts`/`owns` live in the `.js` single source of truth. Editing
  `run.mjs` for one repo is the drift this pattern exists to prevent.
- **Dev vs prod split.** In the dev Workflow runtime the prose guides Claude (there is no fs
  post-hook, and Claude is reliable). On pi the driver *enforces*. Both executors see the same
  prompt text, so there is no second copy.

## Composition — per-stage commits and worktree isolation (the roadmap)

The contract is the **shift-left, root-cause** layer. Two isolation layers compose with it:

- **Per-stage git commit** (next): commit each node's diff in the run tree. Gives a precise
  per-wave artifact snapshot (the audit trail *is* the commit DAG), resume-at-last-good-stage, and —
  crucially — turns the **owned-path check hard**: `git diff --name-only` for the stage must be a
  subset of `DRIVER-OWNS`, catching cross-contamination *mechanically*, with the exact offending
  path, at the stage it happened.
- **Worktree per run** (endgame for big parallel fleets): each run gets its own checkout, so a node
  *cannot see* a sibling's files — cross-contamination becomes **impossible** rather than *caught*.

## Relationship to the Hermes loop

The contract is the "encode the desired outcome up front" move; the Hermes loop is the "evolve when
reality still diverges" move — complements, not substitutes. A **contract breach** (`status=blocked`
with a `contract breach` issue, surfaced at the stage with the exact missing path) is a first-class
Hermes **capture signal**: it points at the failing node directly instead of waiting for a
downstream consumer to choke. And authoring a contract instead of a reactive guard is itself the
Hermes-idiomatic fix: it **generalizes across all runs** and hard-codes no single case.
