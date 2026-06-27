# The SDK consumer — the canonical per-project layout (init)

> **The model.** The generic engine (DAG compile, the run loop, sandbox providers, the contract codec,
> observability) lives ONCE in the **`@piflow/core`** package. A project does NOT copy an engine — it
> installs the package and drops in a **thin consumer** that wires *its* workflow `.js` and *its*
> deterministic hooks into `runWorkflow`. This is the post-monolith successor to "copy the 153 KB
> `run.mjs` verbatim" (that engine is archived in `templates/legacy/`).

This is the file-set every project copies (`templates/pi-runner/`), what each file is FOR, and the line
between *what you own* and *what is generic*. **Read `artifact-contract.md` for the marker grammar, the L1
`Hook` schema in `docs/design/l1-node-envelope.md`, and `observability.md` for monitoring.**

## The three tiers (where every file lives)

```
your-repo/
├── .claude/workflows/<name>.js     ← TIER 1 (you own): the workflow — the single source of truth
└── pi-runner/
    ├── .env                        ← TIER 1 (you own): per-repo wiring (no secret)
    ├── package.json                ← TIER 1 (you own): declares the @piflow/core dependency
    ├── hooks/                      ← TIER 1 (you own): your deterministic op executors
    │   ├── index.mjs               ·   the barrel (what hook-bindings imports)
    │   ├── markers.mjs             ·   shared marker/path/JSON helpers
    │   ├── seed.mjs                ·   DRIVER-SEED      parser + token resolver  (PRE)
    │   ├── project.mjs             ·   DRIVER-PROJECT   parser + runProjection   (POST)
    │   ├── merge.mjs               ·   DRIVER-MERGE     parser + runMerge        (POST)
    │   ├── seed-contract.mjs       ·   DRIVER-SEED-CONTRACT parser + runSeedContract (POST)
    │   └── schema.mjs              ·   the post-node DRIVER-SCHEMA validator factory
    ├── sdk/                        ← TIER 2 (generic consumer engine — graduates into @piflow/core)
    │   ├── run.mjs                 ·   ENTRYPOINT: config → bridge → compile → runWorkflow (+ dry-run)
    │   ├── config.mjs              ·   resolve the run config from .env + CLI args (pure, testable)
    │   ├── bridge.mjs              ·   PORT: extract the workflow .js → a compilable WorkflowSpec
    │   ├── hook-bindings.mjs       ·   SEAM: DRIVER-* markers → @piflow/core Hook objects bound to hooks/
    │   ├── command.mjs             ·   build the headless `pi` invocation per node (CommandBuilder)
    │   └── local-provider.mjs      ·   in-place SandboxProvider (run pi in the real tree, no temp dir)
    ├── extract.mjs                 ← TIER 2: the recording extractor bridge.mjs depends on
    ├── logs.mjs                    ← TIER 2: 2-line `piflowctl logs` wrapper (the run monitor)
    └── extensions/node-contract.ts ← TIER 2: opt-in `-e` (typed submit_result + owned-paths block)
```

**`@piflow/core` (TIER 3 — NOT per-project files):** `runWorkflow`/`compile`/`validate`, the contract
codec (`parseMarkers`/`emitMarkers`), `runHooks`, the sandbox providers (`InMemory`/`Seatbelt`/`Worktree`/
`Daytona` + bounded `tailAppend` capture), the tool registry, and all observability
(`recordEvents`/`distillEvents`/`followRun`/`diagnoseRun`/`auditWorkflow` + the `piflow` bin). Upgrading
the engine = bumping the package, not editing a copy.

## Why this many files (each has ONE mission)

The split is single-responsibility, not incidental — every file is one seam you can test and replace in
isolation, and the layout mirrors `@piflow/core`'s own internal seams (runner · command · sandbox · codec):

- **Tier 1 is the genuine per-project surface** and it is SMALL: the workflow (what to do), `hooks/` (your
  deterministic ops), `.env`/`package.json` (wiring). This is the only code a new project actually authors.
- **Tier 2 is generic glue that exists in the consumer *today* only because `@piflow/core` has named gaps**
  (no in-place provider; `defaultPiCommand` lacks per-node DRIVER-TOOLS gating + `--thinking`; the
  workflow-intake port strips `DRIVER-*` and the core codec has no `PROJECT`/`MERGE`/`SEED-CONTRACT`
  grammar). It is **byte-identical across repos** ("the engine files never diverge") and is slated to
  **graduate into `@piflow/core`**, which shrinks Tier 2 toward zero. Keep each file separate — merging them
  into a god-file destroys the seam that lets one graduate without disturbing the others.
- **`hook-bindings.mjs` is the one Tier-2 file a project is most likely to edit**, because it maps *your*
  marker vocabulary to *your* `hooks/` executors. That is why it is isolated from the generic port
  (`bridge.mjs`).

## Adopt it (the steps)

1. **Confirm the source of truth** — exactly one `.claude/workflows/<name>.js`; `export const meta` a pure
   literal; body uses only the Workflow hooks. You edit and prove it on Claude; pi inherits it verbatim.
2. **Install `@piflow/core`** — copy `templates/pi-runner/` next to `.claude/`, then set the `@piflow/core`
   dependency in `pi-runner/package.json` to your install (a `file:` path to the skill's `packages/core`, a
   workspace dep, or the published package), and `npm install`.
3. **Wire `.env` (no secret)** — `cp .env.example .env`; set `PI_RUNNER_WORKFLOW` (the `.js` path, repo-root
   relative), `PI_RUNNER_ROOT` if not the parent of `pi-runner/`, and `PI_RUNNER_PROVIDER`/`PI_RUNNER_MODEL`
   (or leave the provider default). The credential lives ONCE in pi's global `~/.pi/agent/models.json`
   (`provider-and-headless.md`), never in `.env`.
4. **Author your `hooks/`** — keep the shipped generic op engine as-is if your workflow uses the standard
   `DRIVER-SEED/PROJECT/MERGE/SEED-CONTRACT` families; add a new family by writing one `hooks/<op>.mjs`
   (parser + executor), exporting it from `hooks/index.mjs`, and binding it in `hook-bindings.mjs` (see the
   contract below). A workflow with no deterministic ops needs no `hooks/`.
5. **Sanity-check + dry-run (free, no model)** — `node pi-runner/sdk/run.mjs --run <id> --arg <k=v>
   --dry-run` prints the stage/node count, each node's `[tools: …] [hooks: …]`, the resolved `pi` command,
   and a `⚠ TOOL BINDING` on any un-tokenized allow/deny entry. Confirm it matches the workflow you proved.
6. **Run (background)** — drop `--dry-run`. Artifacts land in-place; per-node event streams land at
   `<root>/_pi/<id>.events.jsonl`.
7. **Monitor** — `node pi-runner/logs.mjs <run> -f` (live), `--summary` (post-run diagnosis), `--node <id>`
   (one node). Full surface: `observability.md`.

## The hook-assembly contract (pre-node hooks · post-node checks)

This is the canonical answer to "where do the deterministic, non-model steps live, and in what shape." The
**format is the L1 `Hook` envelope** (`@piflow/core` types; schema canon `docs/design/l1-node-envelope.md`):

```
Hook = {
  id:       string                                   // stable name, shows in dry-run [hooks: …]
  phase:    'pre' | 'post'                            // before the model spawns, or after it exits
  when:     'always' | 'on-success' | 'on-failure'   // PRE seeds use 'always'; POST derives use 'on-success'
  inputs:   string[]                                 // its DAG edge AND resume key (workspace-relative)
  outputs:  string[]                                 // skipped when fresh (output mtime ≥ newest input)
  failure?: 'block' | 'warn'                          // 'block' throws (fails the node); 'warn' collects
  run:      string | (ctx: HookContext) => Promise<void>   // a shell string, or a bound JS executor
}
```

`runHooks` (in `@piflow/core`) fires them around each node: **PRE** (selected by `outcome`) before the
spawn, **POST** after — honoring `when`, idempotent skip-when-fresh, and `failure`. The per-node loop is
`create → stage → PRE hooks → buildCommand → exec → collect → stat artifacts → schema gate → checks →
status → POST hooks → dispose`.

**The authoring surface is the `DRIVER-*` marker** (in the workflow, via `contract()` — see
`artifact-contract.md`), NOT a hand-built `Hook`. The pipeline:

```
workflow DRIVER-* markers  ──parse──►  sdk/hook-bindings.mjs  ──build──►  Hook{}  ──bind──►  hooks/<op>.mjs
   (authoring surface)                  (the seam: family→phase)          (the format)        (your executor)
```

`hook-bindings.mjs` re-attaches what the workflow-intake port strips: it parses the four families from the
**raw** (un-stripped) node prompt and emits a `Hook` whose `run` calls the matching `hooks/` executor —
`DRIVER-SEED → pre/always`, `DRIVER-PROJECT/MERGE/SEED-CONTRACT → post/on-success`.

**Load-bearing: the two bases** (thread them, never conflate — this was a fixed parity bug):
- **`runCwd`/`root` = the repo root** — resolves every *repo-relative* marker path (seed `from`/`to`, token
  files, `DRIVER-PROJECT` source/mapRef, op schemas).
- **`projectBase` = the project dir** (`out/<run>`) — what the POST executors write their op `to` paths
  under, and what substitutes the `{project}` placeholder. It is NOT `runCwd` (pi runs at the repo root; the
  artifact is built under `out/<run>`).

## Convergence (the direction)

The robust end-state shrinks Tier 2: as the in-place provider, the per-node command builder, the extractor,
and the marker→hook codec graduate into `@piflow/core`, a new project's footprint approaches **just Tier 1**
— the workflow `.js`, `hooks/`, `.env`, `package.json`, and a one-line `run.mjs` that calls a packaged
entrypoint. Until then, Tier 2 ships in the template (byte-identical, gap-filler) and `templates/legacy/`
holds the pre-SDK monolith as the parity bridge.
