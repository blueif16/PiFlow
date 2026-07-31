# @piflow/core

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

- 132b524: Add an optional `note` affordance to `op[]` entries and the node top-level.

  `node.json` objects are strict (`additionalProperties:false`), so authoring rationale — WHY a gate runs a
  particular script, a KNOWN-GAP marker — had no schema-blessed home and had to live outside the file. `note`
  is an optional string on each `op[]` entry and on the node top-level; it validates, rides through the loader
  verbatim, and is ignored at run time (never rendered). It is the one comment slot on an otherwise strict
  node.json.

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

- 596e6e0: Add a first-class `fixer-aborted` OptimizeEvent so a watchdog/timeout cutoff is a PORTABLE signal.

  The FIX→GATE driver's context-isolated fixer can be cut short by a live behaviour watchdog or a wall-clock
  timeout. Until now the only trace of that was buried in the product's OPAQUE `fixer-trace` payload (which core
  never inspects) or smuggled into the fixer's `summary` string — so the control plane had no product-agnostic way
  to key on a cutoff.

  - `CandidateEdit` gains an optional `aborted?: { reason: string }` — a product-agnostic SHAPE with a
    product-specific reason STRING. The fixer reports the cutoff STRUCTURALLY on its typed return.
  - `runFixGate` emits a new `{ type: 'fixer-aborted'; node; reason }` OptimizeEvent (right before `fixer-done`)
    whenever `edit.aborted` is set, reading the fixer's TYPED return — it never sniffs the opaque `emit` payload.
    The loop is otherwise unchanged: an aborted fixer is just a (usually 0-edit) proposal the gate rejects, so the
    round still scores → gates → lands → stops exactly as before.
  - `renderOptimizeEvent` handles the new variant (`fixer-aborted [node] reason`). The `--watch` CLI renderer
    needs no change — it delegates to `renderOptimizeEvent` / `JSON.stringify`, so it surfaces the new event for
    free.

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

### Patch Changes

- 08c153a: Extract the Daytona cloud-sandbox backend out of `@piflow/core` into a new choose-to-install extension `@piflow/daytona` (`npm i @piflow/daytona`; the CLI loads it dynamically on `--sandbox daytona`). One long-lived Daytona VM per run (per-node workdir subtrees, torn down once) behind `@piflow/core`'s existing sandbox seam — boot from a pre-built snapshot or a raw image ref, with the pi gateway credential allowlisted into the VM. This mirrors `@piflow/e2b`: both cloud providers are now extensions, and core keeps only the local/inmemory/seatbelt/worktree backends plus `NotImplementedProvider`. Daytona behavior is byte-for-byte unchanged (a MOVE). `@piflow/core` drops its `DaytonaSandbox`/`DaytonaSandboxProvider`/`createDaytonaProvider`/`realDaytonaSdk` exports and its `@daytona/sdk` dependency (pre-1.0, acceptable); the CLI's `--sandbox daytona` path now dynamic-imports the extension with a clear `npm i @piflow/daytona` install message.
- b1dab77: Declare `engines.node >=22` on every published `@piflow/*` package.

  Node 22 is already the repo's dev/test/CI floor (the `openclaw` dev-tooling pins undici 8.x,
  which calls `worker_threads.markAsUncloneable`, present only on Node >=22.10). This makes the
  support floor uniform and explicit across the published surface rather than leaving the
  packages' `engines` unset — `npm`/`pnpm` now warn on Node <22 at install time. Code is unchanged.

- 04072fe: `loadTemplate` now REJECTS a node that authors `op[]` alongside the `inject`/`hooks` aliases.

  When a node carries a directly-authored `op[]`, the loader's grammar-unification (`lowerToOps`) returns it
  verbatim and never lowers the deprecated aliases — so an `inject`/`hooks.*` sitting next to it was SILENTLY
  dropped (e.g. `DRIVER-INJECT` vanished and the model quietly stopped receiving the injected file, with no
  error). This was only catchable by diffing resolved markers.

  The new fail-closed §8 check names the node and the dropped alias(es) and tells the author to hand-lower each
  into the same `op[]`. `checks`/`policy`/`return` are exempt — they keep their own channels
  (`io.checks`/`io.policy`/`io.returnSchema`) and survive alongside an authored `op[]`, so they are not flagged.

- Updated dependencies [b1dab77]
  - @piflow/tool-bridge@0.1.1
