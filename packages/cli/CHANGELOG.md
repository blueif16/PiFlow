# @piflow/cli

## 0.2.0

### Minor Changes

- 3fc00ee: Make `--sandbox local` actually enforce the Linux jail, and refuse rather than degrade.

  Two reproduced bugs (verified live on an E2B Debian microVM) are fixed and the posture is now fail-closed:

  - **Probe false-negative on merged-usr Linux (Debian/Fedora).** The bwrap capability probe bound only `/usr`,
    so `true` couldn't find its ELF loader (`/lib64` + the `/lib` symlink chain) and the probe exited 1 — a
    false negative that silently dropped `--sandbox local` to UNSANDBOXED even though the jail works. The probe
    now binds the whole root read-only (`--ro-bind / /`), a distro-agnostic capability check.
  - **Private `/tmp` shadowed a `/tmp`-nested write lane.** `buildBwrapArgs` emitted `--tmpfs /tmp` after the rw
    binds and also bound the bare host `/tmp`, so a write lane under `/tmp` was overmounted by the tmpfs
    (`Can't chdir …`). The tmpfs is now laid down first (an under-`/tmp` lane overlays it and survives) and the
    bare host `/tmp` is no longer bound (the tmpfs is the private writable `/tmp`).
  - **Fail-closed (BREAKING).** When read-scope enforcement is requested but no kernel jail backend is available
    (unsupported OS, or Linux without a usable bubblewrap), `LocalSandbox.exec` now REFUSES — it returns a
    failure result without running the command, instead of silently running it unsandboxed. The only way to run
    unsandboxed is the explicit `--sandbox danger-full-access`. A `--sandbox local` run on a host with no usable
    jail backend now fails loudly; install bubblewrap + allow unprivileged user namespaces, or opt out with
    `--sandbox danger-full-access`.

- ca3cac6: `add-node` now scaffolds the FULL per-node SDK surface — gates, judge, checkpoint, control, and topology.

  The scaffolder previously emitted only the derive hooks, a lossy `--check` (`kind:path` only), and
  `policy.fail`, so authoring any richer gate meant hand-editing `node.json`. It now emits every per-node block
  the loader already honors — **zero SDK/schema change**; `loadTemplate` stays the oracle and every flag
  round-trips through it (the anti-drift gate):

  - **Checks** — `--check <kind[:path[:severity[:param]]]>` (`param` JSON-parsed for count-floor's `{min,path}`),
    `--check-pre` (the pre lane over staged inputs), `--on-warn` (policy.warn). The terse `--check kind[:path]`
    form is unchanged.
  - **Execution gate** — `--gate-run <cmd[:args][@cwd]>`: a POST `op.run` whose non-zero exit BLOCKS the node
    (distinct from `--merge-run`, a data-derive with no verdict).
  - **Control** — `--escalate <tier|model>` (on failure → a stronger model, `io.escalate`) · `--reroute
<node[:max]>` (bounded loop back to a strict-ancestor node).
  - **Judge** — `--judge <judgeTier[:threshold]>` inlines the sibling `judge.md` rubric prose into `judgeGate`
    (materialized at load into a real `<id>__judge` node); the CLI rejects `judgeTier === --tier` (no
    self-judging). `--judge-on-fail`/`--judge-retry-max`/`--judge-retry-scope` set the gate policy.
  - **HITL** — `--checkpoint <confirm|input|select:prompt>` (+ `--checkpoint-choice/-default/-headless/-timeout`):
    the G5 human gate.
  - **Topology** — `--fusion <moa|best-of-n>` (+ `--fusion-n/-panel/-judge/-obligations/-no-verify`) ·
    `--subworkflow <ref>` (inline a sub-template as a sub-DAG).
  - **Contract** — `--full-access` (per-node jail-off, local only) · `--fill-sentinel <s>`.

  `piflowctl add-node --help` and the `piflow-init` skill document the full surface.

- 2cd4d7e: `piflowctl schema` — a self-describing, topic-segmented CLI reference for authoring agents.

  A fresh agent composing a workflow can pull just the slice it needs instead of reading the whole flag
  firehose:

  - `piflowctl schema` → a one-line-per-topic INDEX (no flags front-loaded).
  - `piflowctl schema <topic>` → that topic's concise flag grammar + load-bearing gotchas. Topics: `node`,
    `tools`, `agent`, `routing`, `derive`, `checks`, `control`, `judge`, `hitl`, `topology`, `contract`,
    `commands`.
  - `piflowctl schema --json [node|meta|workflow]` → the formal `@piflow/core` JSON Schema (a re-export of
    the SDK's own frozen schema objects, never a copy — it can't drift from the SDK).

  A single `CLI_TOPICS` source is rendered into BOTH `piflowctl schema` AND the `add-node` `--help`, so the
  reference an agent reads and the help can never diverge (pinned by a single-source test, and a coverage
  test that asserts every add-node flag lives in exactly one topic).

- 476da6d: Add `piflowctl skills install [targetDir] [--force]` — ship the workflow-authoring skills into a target repo.

  A fresh Claude Code agent in ANY repo can now run one command to get piflow's authoring brain (the
  `piflow-init` / `piflow-start` / `piflow-enhance` trio) into that repo's `.claude/skills/`, so it's equipped
  to compose workflows against the SDK. The trio is bundled in the npm tarball; a source checkout falls back to
  the repo's canonical `.claude/skills/`.

  No-drift design: the canonical skill source stays repo-root `.claude/skills/` (the one editable copy); the
  packaged copy under `packages/cli/skills/` is a generated build artifact (a `prepack` step), gitignored and
  never hand-edited — the same discipline as a generated `workflow.json`. Install is a byte-faithful copy
  (an installed `SKILL.md` is byte-identical to its canonical source); an existing skill dir is kept unless
  `--force`.

- 41159ef: Read-scope isolation is now SECURE BY DEFAULT on the real-run path.

  `piflowctl run --sandbox local` previously executed each node with NO OS enforcement of the
  node's declared `contract.readScope` — a node's shell could read the entire filesystem
  (`~/.ssh`, `.env`, sibling lanes). The Seatbelt provider that enforces read scope existed but
  was unreachable from the CLI.

  Now the in-place `LocalSandbox` wraps every node exec in the shared `seatbeltExecPlan` jail on
  macOS, kernel-enforced and SYMMETRIC: reads are bound to `readScope` + toolchain, and WRITES are
  bound to the node's `owns` (write scope) + workdir + toolchain scratch (the writable set is adopted
  from OpenAI Codex's `workspace-write` profile). Because the Seatbelt profile inherits to every
  child, a node's `bash` can neither read nor write outside its declared lane — it gets exactly its
  prepared context and writes only its own outputs. `process-exec` and network stay open (the `pi`
  agent must run tools and reach its model gateway — unlike Codex, which jails shell sub-commands
  that need no network).

  - New `--sandbox danger-full-access` value: the loud, explicit escape hatch that disables the
    jail (`LocalSandboxProvider({ enforceReadScope: false })`).
  - A typo'd `--sandbox` value now errors loudly instead of silently degrading to `inmemory`.
  - The Seatbelt profile auto-grants the resolved node binary dir + version-manager roots
    (NVM_DIR/FNM_DIR/MISE_DATA_DIR/VOLTA_HOME/PNPM_HOME) and `~/.piflow`, so `pi` boots under the
    jail regardless of how node was installed.

  BEHAVIOR CHANGE: a `--sandbox local` run that previously relied on reads outside its declared
  `readScope` will now hit EPERM for those paths. Declare the path in the node's `readScope`, or
  use `--sandbox danger-full-access`. On non-macOS, `local` still runs unsandboxed (with a warning)
  until the Linux bubblewrap backend is wired.

- 8ab0a7c: Present `op[]` as the canonical authoring surface, and rename the ambiguous `--schema` flag.

  - New `piflowctl schema ops` topic: `op[]` is the ONE action envelope; `inject`/`hooks` are internal
    load-compat aliases you don't author; authoring `op[]` beside them is REJECTED at load; the node.json is
    strict with an optional `note` slot for rationale.
  - **BREAKING:** `piflowctl add-node --schema <p>` is renamed to `--artifact-schema <p>`. The old name read
    like the structured-RETURN handshake but it is per-ARTIFACT output validation (`contract.schema` →
    `DRIVER-SCHEMA`). The `schema contract` topic now states the distinction explicitly (the return handshake
    is the separate node.json `return` field + `returnMode`).

- 859c767: `piflowctl skills install` gains opt-in add-ons, an interactive wizard, and a per-project manifest.

  The workflow-authoring trio still installs by default. On top of it you can now add optional skill packs —
  the first is `okf` (the `okf-slices` code-understanding skill):

  - `--with <id>` (repeatable) / `--all` — add specific add-ons / every add-on.
  - `--wizard` — interactively choose which add-ons to install.
  - The chosen set is recorded in `<targetDir>/.piflow/skills.json` (`{ "addons": [...] }`); a later bare
    `skills install` replays it. No flag + no manifest = the trio only (unchanged default).

  Add-on skills are bundled into the npm tarball alongside the trio. This ships the add-on SKILL only (a pure
  `.claude/skills/` byte-copy, preserving the anti-drift invariant); seeding a repo's OKF generator /
  `.agents/okf/` is a separate future step.

- d344ec5: Add the telemetry surface — an agent-facing projection one layer above `observe`.

  `observe` is wide by design (a superset built for the GUI/TUI/CLI human views). Telemetry is a
  thin, opinionated **projection** of the run-view — NOT a second collector — that distills the
  decision-grade subset an agent needs to self-debug: per-node verdicts, the cost spine
  (tokens/cost/context-pressure), loop signals, an anomaly worklist, and **failure-onset
  localization** that walks the file-flow DAG backward from each failure to its earliest decisive
  upstream node.

  Two modes share one span vocabulary (the record is the fold of the stream, the LangSmith/OTel
  pattern):

  - `projectRunDigest(view)` — RECORD: the one-shot `RunDigest`.
  - `telemetryStream(watchRun(dir))` — STREAM: edge-triggered `TelemetryEvent` deltas at
    `important` | `verbose`; anomalies fire once, the moment a node first crosses a threshold.
  - `toGenAiAttributes(node)` — maps a node digest to OTel `gen_ai.*` for any OTLP backend
    (LangSmith / Langfuse / Datadog), no SDK dependency.

  The rich reducer (`createNodeAccumulator`) gains the one capture it was missing for the
  tool-loop anomaly: `modelCalls`, `maxToolRepeat`/`repeatedTool`, and a non-destructive
  `metrics()` for the live stream. New CLI verb:

  ```
  piflowctl telemetry <rundir> [nodeId] [--watch] [--verbose] [--json]
  ```

  Record mode prints the rollup + anomaly worklist + root cause + per-node table; `--watch`
  streams live deltas (docker `logs -f` style) then the authoritative record; `--json` emits the
  raw digest for an agent to consume directly.

- eb81f3e: Add `piflowctl understand [subsystem] [--check|--rebuild]` — the user-facing front door to the code-understanding
  slices (`.agents/okf/topics/`). It FINDs the slice that owns a subsystem/file/symbol (ownership beats a bare prose
  mention), runs the drift gate (`--check`, blocks only on a moved anchor), and regenerates the machine-derived
  regions (`--rebuild`). A thin wrapper over the one repo-local engine, so it never drifts from the pre-commit hook;
  errors clearly when a repo has no `.agents/okf/` substrate.

  Renames the skills add-on id `okf` → `understand` (`skills install --with understand`) so the typed surface no
  longer exposes the internal "OKF" acronym. The legacy `okf` id still resolves (back-compat alias), in both
  `--with` and an existing `.piflow/skills.json`.

### Patch Changes

- 08c153a: Extract the Daytona cloud-sandbox backend out of `@piflow/core` into a new choose-to-install extension `@piflow/daytona` (`npm i @piflow/daytona`; the CLI loads it dynamically on `--sandbox daytona`). One long-lived Daytona VM per run (per-node workdir subtrees, torn down once) behind `@piflow/core`'s existing sandbox seam — boot from a pre-built snapshot or a raw image ref, with the pi gateway credential allowlisted into the VM. This mirrors `@piflow/e2b`: both cloud providers are now extensions, and core keeps only the local/inmemory/seatbelt/worktree backends plus `NotImplementedProvider`. Daytona behavior is byte-for-byte unchanged (a MOVE). `@piflow/core` drops its `DaytonaSandbox`/`DaytonaSandboxProvider`/`createDaytonaProvider`/`realDaytonaSdk` exports and its `@daytona/sdk` dependency (pre-1.0, acceptable); the CLI's `--sandbox daytona` path now dynamic-imports the extension with a clear `npm i @piflow/daytona` install message.
- be2f36b: Add `@piflow/e2b` — the E2B open-egress cloud-sandbox backend, packaged as a choose-to-install extension (`npm i @piflow/e2b`; the CLI loads it dynamically on `--sandbox e2b`). One long-lived E2B sandbox per run (per-node workdir subtrees, killed once) behind `@piflow/core`'s existing sandbox seam; egress is open by default — the unblock for heterogeneous/remote MCP that Daytona's tier-gated egress can't serve. Establishes the providers-are-extensions pattern (Daytona stays in core for now).
- b0212ad: `piflowctl inspect` no longer gives two false "not wired" signals.

  - The `ops:` line now covers ALL THREE op families — run-family ops and gate ops (pre/post), not just derive
    transforms. A node migrated to `op:[{run}]` (or carrying a gate) used to render `ops: (none)` even though
    the runner dispatches it.
  - A `programmatic` node (which spawns no pi and therefore has no prompt / no `DRIVER-*` markers) now prints
    its resolved `op[]` directly instead of an empty `prompt:` block that read as "0 markers → not wired".

- b1dab77: Declare `engines.node >=22` on every published `@piflow/*` package.

  Node 22 is already the repo's dev/test/CI floor (the `openclaw` dev-tooling pins undici 8.x,
  which calls `worker_threads.markAsUncloneable`, present only on Node >=22.10). This makes the
  support floor uniform and explicit across the published surface rather than leaving the
  packages' `engines` unset — `npm`/`pnpm` now warn on Node <22 at install time. Code is unchanged.

- 991cb7f: Add an SDK-level fix-cycle CEILING to the FIX→GATE driver — a deterministic, portable per-node re-attempt
  bound so a structurally-unfixable node ESCALATES instead of looping across `optimize --fix` invocations.

  The bound is additive and OPT-IN; absent its inputs the driver is byte-for-byte backward-compatible.

  - `FixGateStages` gains two OPTIONAL stages — `readFixCycles?(node): number` and `bumpFixCycles?(node): void`.
    `@piflow/core` persists NOTHING for the counter (boundary law: the SDK is logic only) — the product injects a
    file-backed counter; core only reads/bumps it through these stages.
  - `FixGateOpts` gains an optional `fixCycleCeiling?: number`. The ceiling activates ONLY when it AND both
    counter stages are present; otherwise it is a no-op.
  - `runFixGate` skips (does NOT attempt) a node whose `readFixCycles(node) >= fixCycleCeiling` — no `fixer-started`,
    no edit/token budget spend — surfaces it on the new `FixGateResult.skipped: FixCycleSkip[]`, and emits a new
    `{ type: 'fix-cycle-ceiling'; node; cycles; ceiling }` OptimizeEvent. The counter is bumped ONLY after a REAL
    failed fix (a rejected verdict with >=1 edit applied); an accept, a 0-edit, or an aborted proposal does not
    consume budget.
  - `renderOptimizeEvent` handles the new variant (`fix-cycle-ceiling [node] cycles/ceiling — escalate`); the
    `--watch` CLI renderer needs no change (it delegates to `renderOptimizeEvent` / `JSON.stringify`).
  - CLI: a new `--fix-cycle-ceiling <n>` flag threads the bound + the binding's optional counter stages into
    `runFixGate`. A binding WITHOUT the counter port still validates and runs (the ceiling stays inert).

- bd692d0: The bundled `piflow-init` skill now teaches `op[]` as the canonical authoring surface.

  `enrich-contract.md §1` (and `parse-claude-workflow.md`) previously taught the deprecated `hooks` grammar as
  the port target. They now author `op[]` directly, with a source-marker → `op[]` table whose middle column is
  the legacy `inject`/`hooks` alias each replaces (the migration recipe), the blocking-gate vs no-verdict-derive
  fork made explicit, the "don't mix grammars — the loader rejects op[] beside inject/hooks" rule, and the
  `note` slot for rationale. The `--schema` flag reference is updated to `--artifact-schema`.

- Updated dependencies [3fc00ee]
- Updated dependencies [08c153a]
- Updated dependencies [41159ef]
- Updated dependencies [b1dab77]
- Updated dependencies [04072fe]
- Updated dependencies [132b524]
- Updated dependencies [991cb7f]
- Updated dependencies [596e6e0]
- Updated dependencies [d344ec5]
  - @piflow/core@0.2.0
  - @piflow/server@0.1.1
