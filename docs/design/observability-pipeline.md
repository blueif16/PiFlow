# The unified run-observability pipeline

> The canonical contract for the ONE shared-data pipeline that `piflow status`, `piflow watch`, the
> TUI, and a future GUI all consume. A surface implementer can build against this doc without reading
> the source.
>
> **Status:** shipped. Source of truth is the code at the paths cited below — where this doc and the
> code disagree, the code wins. Every type/signature here is quoted verbatim from HEAD.

---

## 1. Overview + layering

The pipeline has exactly **one** reader, **one** model, and **one** live stream. The runner writes the
engine-owned `.pi/` run layout; `@piflow/core/observe` is the SOLE module that reads those files and
builds the `RunModel`; every surface renders that model and never touches `.pi/` itself.

```
  runner                          ${RUN}/.pi/               @piflow/core/observe         surfaces
 ┌──────────────────┐           ┌──────────────────┐      ┌──────────────────┐       ┌─────────────┐
 │ writeStatus()    │──run.json─▶│ run.json         │      │ readRunModel(dir)│──────▶│ CLI  status │
 │  (status.ts)     │           │ nodes/<id>/      │─────▶│   → RunModel     │       │ CLI  watch  │
 │                  │           │   io.json        │      │                  │       │ CLI  logs   │
 │ NodeRecorder     │──events──▶│   events.jsonl   │      │ watchRun(dir,opts)│──────▶│ TUI         │
 │  (events.ts)     │  .jsonl   │ state.json       │      │   → RunUpdate ⋯   │       │ GUI (later) │
 └──────────────────┘           └──────────────────┘      └──────────────────┘       └─────────────┘
        PRODUCE                     the FILESYSTEM              the READER                 RENDER
                                    is the contract
```

**The load-bearing invariant — a surface NEVER reads `.pi/` itself.** ALL run-file reading and
model-building (status derivation, stage/lane reconstruction, the io-derived data-flow edges) lives in
`packages/core/src/observe/`. `packages/cli/src/status.ts`, `packages/cli/src/watch.ts`, and
`packages/tui/model.mjs` each carry NO bespoke `.pi/` reader — they import `readRunModel` / `watchRun`
from `@piflow/core` and only render. One definition of "the truth," many views. This is what makes the
*verified, not trusted* rule (§4) impossible for a surface to bypass.

The `.pi/` layout itself is the D7 contract — engine-owned and identical across every project. See
`docs/design/sdk-canonical-build-plan.md` → "Uniform run layout + per-node I/O ledger (D7)" for the
why; this doc covers only the observability surface over it.

---

## 2. The `.pi/` on-disk layout

A project decides only WHERE `${RUN}` roots (an opaque base dir); the internal shape is SDK-owned and
never drifts. Every path is produced by a pure helper in `packages/core/src/runner/layout.ts` — readers
and the write side share these helpers, so no path is ever hardcoded.

```
${RUN}/                          # per-thread workspace; product files (spec/ src/ dist/ …) live at semantic paths
  .pi/                           # piDir(run) — ENGINE-OWNED metadata namespace, identical in every project
    run.json                     # runJsonFile(run)  — the run-status digest (a RunStatus)
    state.json                   # stateFile(run)    — the RunState channels (D6 per-thread checkpoint)
    nodes/<id>/                  # nodeDir(run, id)  — one dedicated folder per node
      io.json                    #   nodeIoFile(run, id)     — the per-node I/O ledger (a NodeIo)
      events.jsonl               #   nodeEventsFile(run, id) — the slimmed pi event stream (the behavior tail)
      prompt.md / tools.ts / mcp.json   # nodePromptFile / nodeToolsFile / nodeMcpFile — the realized node (not read by observe)
```

What each file the pipeline reads holds:

| File | Helper | Holds | Read by |
|---|---|---|---|
| `.pi/run.json` | `runJsonFile` | A `RunStatus` — the whole run digest: per-node `NodeStatusRecord` map, the parallel `stage` barrier, run-level `totals`, `provider`/`model`, `done`/`ok`/`durationMs`. | `readRunModel` (every poll) |
| `.pi/nodes/<id>/io.json` | `nodeIoFile` | A `NodeIo` ledger: the node's `phase`, `reads[]`, `writes[]` (with on-disk `verified`/`bytes`), `promotes[]`. Authoritative source of declared writes + the data-flow edges. | `readRunModel` |
| `.pi/nodes/<id>/events.jsonl` | `nodeEventsFile` | One slimmed pi `--mode json` event per line (the behavior stream). Append-only; tailed by byte offset. | `watchRun` (the live tail) |
| `.pi/state.json` | `stateFile` | The RunState channels (D6). Not part of the observe model; listed for completeness. | — |

**Write safety.** `run.json` is written from PARALLEL lanes plus the run loop. The writer
(`writeStatus`, §6) serializes writes per dir and publishes each atomically (temp file + `rename`), so a
polling reader never sees a torn or stale file. `io.json` is written once per node by `writeNodeIo`
(`layout.ts`); `events.jsonl` is append-only.

---

## 3. The types

All types below are quoted **verbatim** from `packages/core/src/observe/types.ts` (re-exported by
`packages/core/src/observe/index.ts` and the `@piflow/core` barrel). `NodeStatus` and `RunStatus` are
imported from `packages/core/src/runner/status.ts`; `PiEvent` from `packages/core/src/runner/events.ts`.

### `NodeView` — one node as a view consumes it

```ts
export interface NodeView {
  id: string;
  label: string;
  phase: string | null;
  /** The verdict the view SHOWS — derived from on-disk artifact reality, not the raw record field. */
  status: NodeStatus;
  /** The status the record SELF-REPORTED (kept for transparency + the mutation test). */
  reported: NodeStatus;
  /** Declared artifacts that exist on disk right now. */
  artifactsVerified: number;
  /** Declared artifacts total. */
  artifactsTotal: number;
  /** Declared artifacts found absent on disk (the reason a node reads `blocked`). */
  missing: string[];
  durationMs?: number;
  /** 1-based stage this node lands in (its parallel lane is `lane`). */
  stageIndex: number;
  /** The node's column within its stage (siblings in a parallel lane share a stage, differ by lane). */
  lane: number;
}
```

- `id` / `label` — the node's identifier and human label.
- `phase` — the node's phase string from its `io.json`, or `null`.
- `status` — the DERIVED verdict the surface shows (verified-not-trusted; §4). Render THIS.
- `reported` — the raw self-reported status from the record (kept so a surface can show "claimed X, shown Y").
- `artifactsVerified` / `artifactsTotal` — declared artifacts present on disk / declared in total.
- `missing` — the declared-artifact paths found absent (the reason a node reads `blocked`).
- `durationMs` — node wall time, when recorded.
- `stageIndex` — 1-based stage this node lands in (0 if unplaced).
- `lane` — the node's column within its stage (parallel siblings differ by `lane`).

### `StageView` — a reconstructed stage

```ts
/** A reconstructed stage (a parallel barrier groups its concurrent nodes into one `parallel` stage). */
export interface StageView {
  index: number;
  phase: string | null;
  parallel: boolean;
  nodeIds: string[];
}
```

- `index` — 1-based stage position.
- `phase` — the stage's phase (stamped from its first node's `io.json`), or `null`.
- `parallel` — `true` when the stage holds more than one concurrent node.
- `nodeIds` — the node ids in this stage (a parallel lane-set, or a singleton).

### `EdgeView` — a file-level data-flow edge

```ts
/**
 * A file-level data-flow edge: node `from` WROTE a path that node `to` READ back (the engine's only
 * hard guarantee — nodes coordinate through files). Derived from the per-node io.json ledgers.
 */
export interface EdgeView {
  from: string;
  to: string;
  /** The shared on-disk path that links them (the producer's write = the consumer's read). */
  path: string;
}
```

- `from` / `to` — the producer node and the consumer node.
- `path` — the shared on-disk path the producer wrote and the consumer read (first writer wins).

### `RunModel` — the shared snapshot

```ts
/**
 * THE shared snapshot. A one-shot view of a run built from `.pi/run.json` + `nodes/<id>/io.json`. Both
 * the cli table and the tui DAG render from this (and only this) — it is a superset of each.
 */
export interface RunModel {
  run: string;
  done: boolean;
  ok: boolean | null;
  durationMs: number | null;
  provider?: string;
  model?: string | null;
  /** The parallel barrier the engine last published (null between/after stages). */
  stage: RunStatus['stage'];
  /** The run-level rollup at completion (null while running). */
  totals: RunStatus['totals'];
  nodes: NodeView[];
  stages: StageView[];
  edges: EdgeView[];
}
```

- `run` — the run id.
- `done` — `true` once the run reached a terminal state.
- `ok` — run-level verdict (`true`/`false`), or `null` while running.
- `durationMs` — run wall time, or `null` while running.
- `provider` / `model` — the executor provider and model id (optional).
- `stage` — the last-published parallel barrier `{ index, total, nodeIds }`, or `null` between/after stages.
- `totals` — the run-level rollup `{ nodes, ok, failed }` at completion, or `null` while running.
- `nodes` / `stages` / `edges` — the per-node views, the stage spine, and the io-derived data-flow edges.

### `RunUpdate` — one live delta on the stream

```ts
/**
 * One live delta on the single stream. `snapshot` is yielded FIRST (the full model); then `node-status`
 * on a node's status change, `node-event` per new events.jsonl line, and `done` when the run completes.
 */
export type RunUpdate =
  | { kind: 'snapshot'; model: RunModel }
  | { kind: 'node-status'; id: string; status: NodeStatus }
  | { kind: 'node-event'; id: string; event: import('../runner/events.js').PiEvent }
  | { kind: 'done' };
```

The four kinds, in the order a consumer sees them:

- `snapshot` — yielded FIRST, exactly once: the full `RunModel`. Carries all current state; later deltas
  are only what arrives AFTER it.
- `node-status` — a node whose DERIVED status changed since the last poll. `id` + the new `NodeStatus`.
- `node-event` — one new `events.jsonl` line for node `id`: a `PiEvent` (a loosely-typed
  `Record<string, unknown>` — observe forwards pi's event shape, it does not own the schema).
- `done` — terminal; emitted once when the run completes, then the stream ends.

---

## 4. The API

The whole surface is two functions plus the `WatchOpts` shape, re-exported from `@piflow/core`:

```ts
import { readRunModel, watchRun, type WatchOpts } from '@piflow/core';
```

### `readRunModel(runDir) → Promise<RunModel>` — one-shot snapshot

`packages/core/src/observe/read.ts`:

```ts
export async function readRunModel(runDir: string): Promise<RunModel>
```

Reads `.pi/run.json` (a `RunStatus`) + each node's `.pi/nodes/<id>/io.json` (a `NodeIo`) and folds them
into one `RunModel`. **Throws** (rather than returning a half model) when there is no readable
`.pi/run.json` — the message is `readRunModel: no readable .pi/run.json under <abs path>`; a consumer
treats that as "no run here." Pure read, no writes.

### `watchRun(runDir, opts?) → AsyncIterable<RunUpdate>` — live stream

`packages/core/src/observe/watch.ts`:

```ts
export interface WatchOpts {
  /** Abort the stream — the iterator returns promptly (no hang) on abort. */
  signal?: AbortSignal;
  /** Poll interval (ms). Default 700 (the `followRun` cadence). */
  pollMs?: number;
}

export async function* watchRun(runDir: string, opts: WatchOpts = {}): AsyncIterable<RunUpdate>
```

The single live stream. An async generator a consumer drives with `for await`:

1. Yields a `{ kind: 'snapshot', model }` FIRST (the full model). It seeds the per-node status baseline
   and each node's `events.jsonl` byte offset from the CURRENT files, so later deltas are only what
   arrives AFTER the snapshot — the snapshot already carries the existing state.
2. Then per poll: `node-status` for any node whose DERIVED status changed; `node-event` for each new
   `events.jsonl` line (tailed by byte offset, carrying a trailing partial line — never re-emits, never
   duplicates).
3. `{ kind: 'done' }` once `model.done`, then the stream ends.

**Cancellation contract (`opts.signal`).** Pass an `AbortSignal` to stop the stream. The iterator
returns PROMPTLY on abort — the internal sleep resolves immediately on the abort event, so a long
`pollMs` can never delay teardown. An already-aborted signal yields nothing and returns at once. (The
TUI's `subscribeRun` drives this via an `AbortController` and returns an unsubscribe fn that calls
`ctrl.abort()`.)

**Poll cadence (`opts.pollMs`).** Default **700 ms** (the `followRun` cadence). The CLI `watch` exposes
this as `--poll <s>`. The writer publishes `run.json` atomically, so a poll never reads a torn file; a
poll that finds no readable `run.json` is skipped cleanly and retried — `watchRun` is SAFE to start
before the run has written anything.

### Verified, not trusted — the status derivation

The load-bearing rule lives in ONE place so every surface shares it: `deriveStatus` in
`packages/core/src/observe/read.ts`, applied by `readRunModel`.

```ts
export function deriveStatus(reported: NodeStatus, missing: string[]): NodeStatus {
  if (reported === 'error') return 'error';
  if (reported === 'pending' || reported === 'running' || reported === 'reused' || reported === 'dry') {
    return reported;
  }
  if (missing.length) return 'blocked';
  return reported;
}
```

A node that CLAIMS completion (`ok` / `gap` / `blocked`) but whose declared artifact is ABSENT on disk
reads `blocked` — beating the self-report. The `error` verdict is terminal and passes through;
pre-terminal verdicts (`pending` / `running` / `reused` / `dry`) make no completion claim and pass
through. `readRunModel` computes `missing` by re-stat'ing each declared artifact via `artifactState`
(`runner/status.ts`) — the recorded `verified`/`exists` flags are NOT trusted. `NodeView.reported` keeps
the raw record field for transparency; `NodeView.status` is the derived verdict the surface renders.

The declared-artifact set comes from `declaredArtifacts` (read.ts): the `io.json` `writes[]` paths are
authoritative; it falls back to the run-status record's `artifacts[]` paths when no ledger exists.
Stages and lanes are reconstructed by `buildStages` (read.ts) from the run dir alone — the engine's
last-published barrier (`stage.nodeIds`) groups concurrent siblings into one parallel stage. Edges are
derived by the `writerOf` pass: a path written by node A and read back by node B becomes edge A→B (first
writer wins).

---

## 5. Per-surface consumption

Each surface is a THIN renderer over the shared source. The pattern is always: get a `RunModel` (one
shot or per snapshot delta) and render; for live behavior, fold the `node-event` stream.

### CLI `status` — `readRunModel` → render

`packages/cli/src/status.ts`. `runStatusCli` calls `readRunModel(rundir)` and passes the model to
`renderStatus(run: RunModel)`, a pure layout of the per-node table (id · label · derived status ·
verified/total artifacts · `durationMs`) + a stage line + the `totals` rollup foot. With `--every <s>`
it clears and re-reads on a loop until `model.done`. No bespoke `.pi/` reader.

```ts
const model = await readRunModel(rundir);          // throws → "no run here"
process.stdout.write(renderStatus(model) + '\n');  // pure render of the RunModel
```

### CLI `watch` — `watchRun` (the wake-on-event sentinel)

`packages/cli/src/watch.ts`. Subscribes to the shared stream and stays SILENT until exactly one
decision-worthy event: a node whose DERIVED status is `error` | `blocked` (fired from the first snapshot
or any `node-status` delta) → `node-failed`; or `{ kind: 'done' }` → the run verdict. Because a failed
node always surfaces BEFORE `done`, a clean `done` ⇒ `ok: true`, derived from the stream alone. The
stream source is injectable (`opts.updates`) so a test drives a deterministic `RunUpdate` sequence; the
default is `coreWatchRun(rundir, { signal, pollMs })`.

```ts
for await (const u of watchRun(rundir, { signal, pollMs })) {
  if (u.kind === 'snapshot') { const bad = u.model.nodes.find((n) => isFailed(n.status)); if (bad) … }
  else if (u.kind === 'node-status') { if (isFailed(u.status)) … }   // error | blocked
  else if (u.kind === 'done') { /* clean done ⇒ ok:true */ }
}
```

### CLI `logs` — `watchRun` filtered to `node-event`

The canonical pattern for a log tail is `watchRun` filtered to `node-event`: drop `snapshot` /
`node-status` / `done`, render each `PiEvent`.

```ts
for await (const u of watchRun(rundir, { signal })) {
  if (u.kind === 'node-event') renderEvent(u.id, u.event);   // one distilled line per action
}
```

> Implementation note: today the shipped `piflow logs` command is `runLogsCli` → `followRun`
> (`packages/core/src/runner/logs.ts`), which tails `.pi/nodes/<id>/events.jsonl` directly through the
> SAME `nodeEventsFile` layout helper and the same byte-offset + carry-partial-line tail technique
> `watchRun` reuses (the `followRun` cadence is where `watchRun`'s 700 ms default comes from). It is the
> one surface that still has its own reader; the `watchRun`-filtered form above is the convergence
> target. A NEW log surface should consume `watchRun` filtered to `node-event`.

### TUI — `readRunModel` + `watchRun` (subscribe)

`packages/tui/model.mjs`. `buildModel({ runDir })` calls `readRunModel(runDir)` and `adaptModel` maps
the shared `RunModel` into the view shape the renderers already consume (re-keying `nodes` into an
`{id: node}` map, reconstructing per-node inputs/outputs from the shared `edges`). `subscribeRun`
drives the live tail: it `for await`s `watchRun(runDir, { signal, pollMs })`, fires `onModel` on each
`snapshot` (re-adapted) and folds each `node-event` `PiEvent` into a per-node accumulator (text tail ·
tool tally · thinking chars) for `onTail` — opening NO `.pi/` file itself. Returns an unsubscribe fn
backed by an `AbortController`.

### GUI sketch — SSE over `watchRun` (~6 lines)

A GUI server forwards each `RunUpdate` to the browser as a Server-Sent Event. The whole server-side data
layer is the shared stream:

```js
import { watchRun } from '@piflow/core';

app.get('/runs/:dir/stream', async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());                          // client disconnect → prompt teardown
  for await (const u of watchRun(req.params.dir, { signal: ctrl.signal }))
    res.write(`data: ${JSON.stringify(u)}\n\n`);                // snapshot → node-status → node-event → done
});
```

The browser's `EventSource` receives a `snapshot` (render the full DAG), then live deltas; the GUI
renders the SAME `RunModel`/`RunUpdate` contract as every other surface, re-deriving nothing.

---

## 6. The producer side

Two writers populate `.pi/`; the observe pipeline only reads what they write.

### `writeStatus` → `.pi/run.json`

`packages/core/src/runner/status.ts`:

```ts
export function writeStatus(dir: string, status: RunStatus): Promise<void>
```

Writes the `RunStatus` digest to `runJsonFile(dir)` (`<dir>/.pi/run.json`), pretty-printed, `mkdir -p`
the `.pi/` namespace first. Called from the run loop and every parallel lane (`runner.ts` — at run start,
each stage barrier, and completion). It is **serialized per dir** (a promise chain → real last-write-wins)
and **atomic** (it snapshots the bytes synchronously, writes a unique temp file in the same `.pi/` dir,
then `rename`s into place), so concurrent lane writers never interleave and a polling reader
(`readRunModel`) never sees a torn or stale file. This is the file `readRunModel` reads every poll.

The companion `writeNodeIo` (`layout.ts`) writes each node's `io.json` ledger (the `NodeIo` record) — the
source of `phase`, declared `writes[]`, and the data-flow edges `readRunModel` derives.

### `NodeRecorder` → `.pi/nodes/<id>/events.jsonl`

`packages/core/src/runner/events.ts`. The runner taps each node's agent stdout (the `pi --mode json`
event stream), SLIMS it (`slimEvent` drops the heavy cumulative `message` snapshots and truncates large
tool results — what otherwise makes a raw stream 100s of MB), stamps a node-relative clock (`_t` ms +
`_rt` ISO), and appends one JSON event per line to `nodeEventsFile(outDir, id)` —
`.pi/nodes/<id>/events.jsonl`. This is the EXACT path `watchRun` tails. The recorder is wired in
`runner.ts` (`ctx.recordEvents ? new NodeRecorder(ctx.outDir, node.id, ctx.onEvent) : null`, then
`recordingSandbox(sandbox, recorder)`), defaults on (`recordEvents ?? true`), and the write stream opens
lazily on the first event — a node that emits nothing leaves no file (so `watchRun`'s tail tolerates a
missing file). It also exposes an optional live `EventSink` (`ctx.onEvent`) — an in-process push seam for
a future GUI that wants the stream without re-tailing the file.

---

## 7. Extension points (intentionally absent)

The contract deliberately does NOT yet carry the fields below. They are flagged here so a consumer knows
what is missing by design, not by oversight — and so a surface null-guards rather than fabricates them.
Each surface today renders these as blank/null (the CLI even prints a HALT-note instead of a fabricated
cost number — `status.ts` foot).

- **`updatedAt` / staleness.** `RunStatus` carries `updatedAt`, but `RunModel`/`RunUpdate` do NOT surface
  it. So the CLI `watch` DEAD-stall detector (`--dead-stall`) is parsed-but-inert — there is no streamed
  staleness signal yet. The hard guard remains the driver's own `--node-timeout`. Growth edge: surface
  `updatedAt` + a derived staleness on the model.
- **Gantt per-node `startMs` / `endMs`.** `NodeView` carries only `durationMs`; the TUI's Gantt band
  self-blanks because the source has no per-node start/end timestamps. Growth edge: add `startMs`/`endMs`
  to `NodeView`.
- **Per-node tokens / cost.** The legacy CLI table showed a token/cost rollup; `RunModel` does NOT carry
  it, so the renderer shows only status · verified-artifacts · `durationMs` · stage · ok/failed and never
  fabricates cost. The TUI accumulates a live token/tool tally from the `node-event` stream but the model
  has no persisted counts. Growth edge: a tokens/cost rollup on `RunTotals` and/or `NodeView`.
- **`RunUpdate` `done` carrying `ok`.** The `done` delta is `{ kind: 'done' }` — it carries no `ok` flag.
  The CLI `watch` infers `ok: true` from a clean `done` (a failed node always surfaces earlier as
  `error`/`blocked`). Growth edge: `{ kind: 'done'; ok: boolean | null }` so a consumer reads the run
  verdict directly off the terminal delta.

When any of these lands, it is an ADDITIVE field on the existing type — the one reader fills it, and
every surface gets it for free.

---

### File map (grep targets)

| Concern | File |
|---|---|
| The types | `packages/core/src/observe/types.ts` |
| `readRunModel` + `deriveStatus` + stage/edge derivation | `packages/core/src/observe/read.ts` |
| `watchRun` + `WatchOpts` + the event tail | `packages/core/src/observe/watch.ts` |
| The observe barrel | `packages/core/src/observe/index.ts` (re-exported by `packages/core/src/index.ts`) |
| `.pi/` path helpers | `packages/core/src/runner/layout.ts` |
| `RunStatus` / `NodeStatusRecord` / `writeStatus` / `artifactState` | `packages/core/src/runner/status.ts` |
| `NodeRecorder` / `slimEvent` / `recordingSandbox` / `PiEvent` | `packages/core/src/runner/events.ts` |
| `NodeIo` ledger type | `packages/core/src/types.ts` |
| CLI `status` / `watch` / front door | `packages/cli/src/{status.ts,watch.ts,cli.ts}` |
| CLI `logs` (own tail today) | `packages/core/src/runner/logs.ts` (`runLogsCli` / `followRun`) |
| TUI adapter | `packages/tui/model.mjs` |
| The D7 run-layout rationale | `docs/design/sdk-canonical-build-plan.md` → "Uniform run layout (D7)" |
