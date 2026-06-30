# Mastra teardown — Workflow orchestration engine

> Per-aspect source brief for [`../competitive-analysis-vs-mastra.md`](../competitive-analysis-vs-mastra.md)
> (§1a–1b, §2, §4). Evidence cited `file:line` relative to `vendor/mastra/`. Produced 2026-06-29 from a
> focused read of `packages/core/src/workflows/` at HEAD `12af22b`. Honest by construction.

## Workflow definition & primitives

A workflow is built with `createWorkflow({ id, inputSchema, outputSchema, stateSchema?, schedule? })`
(`create.ts:25`), then steps are chained on the returned `Workflow` instance and frozen with `.commit()`
(`workflow.ts:2276`). Every primitive pushes a typed `StepFlowEntry` plus a serialized twin onto two
parallel arrays (`stepFlow` / `serializedStepFlow`); the entry union is the canonical grammar
(`types.ts:519-546`). Control-flow primitives, each fluent and chainable:

- **`.then(step)`** — sequential step append; previous output must satisfy next input schema (`workflow.ts:1688`).
- **`.parallel([stepA, stepB])`** — fan-out; all steps run concurrently, output is a keyed record (`workflow.ts:1992`); executed via `Promise.all` (`handlers/control-flow.ts:139`).
- **`.branch([[condFn, step], …])`** — conditional fan-out; every condition is evaluated and all truthy branches run (`workflow.ts:2055`; eval `Promise.all` at `control-flow.ts:309`).
- **`.dowhile(step, condFn)`** — run step, repeat while condition true; loop entry carries `loopType:'dowhile'` (`workflow.ts:2111`).
- **`.dountil(step, condFn)`** — run step, repeat until condition true (`workflow.ts:2159`); `condFn` receives `iterationCount` (`step.ts:127-147`).
- **`.foreach(step, { concurrency })`** — map a step over a previous array output; concurrency-limited via a `fastq` callback queue that refills slots as they free (`workflow.ts:2207`; `control-flow.ts:955-1120`).
- **`.map(mappingConfig | fn)`** — inject an implicit step that remaps data; supports `{step,path}`, `{value,schema}`, `{initData,path}`, `{requestContextPath}`, and dynamic `{fn,schema}` (`workflow.ts:1823`).
- **`.sleep(ms | fn)`** — pause (`workflow.ts:1733`); **`.sleepUntil(date | fn)`** — pause to a timestamp (`workflow.ts:1772`).
- **Nested workflows** — `Workflow implements Step` (`workflow.ts:1561`), so a sub-workflow is passed directly to `.then`/`.parallel`/`.foreach`; nested results are tagged with `NESTED_WORKFLOW_RESULT_SYMBOL` (`constants.ts:18`) and detected by `step.component === 'WORKFLOW'` (`handlers/step.ts:434`).
- **`.waitForEvent(...)`** — REMOVED; now throws and directs you to suspend/resume (`workflow.ts:1808`).

## Step abstraction & data flow

A `Step` is `{ id, inputSchema, outputSchema, resumeSchema?, suspendSchema?, stateSchema?,
requestContextSchema?, execute, retries?, scorers? }` (`step.ts:150-177`), built via `createStep` which
also adapts Agents, Tools, and Processors into steps (`workflow.ts:337`). `execute` receives a rich
context (`step.ts:24-72`): `inputData`, `state` + `setState`, `resumeData`, `suspendData`,
`getInitData<T>()`, `getStepResult(step)`, `suspend`, `bail`, `abort`, `abortSignal`, `writer`,
`retryCount`. Data flows **positionally**: each step's output becomes the next step's `inputData`
(`default.ts:800`, `prevStep`); cross-step access is explicit via `getStepResult` (returns output only if
status `success`, `step.ts:179-193`) or via `.map`. Schemas are Standard-Schema; validation is opt-in
per-run via `validateInputs` (`workflow.ts:3139-3164`), applied to input, initial state, request context,
and resume data.

## Execution model

**In-process, single Node process.** The default engine (`DefaultExecutionEngine`, `default.ts:54`) runs
the graph as a plain `for (i…steps.length)` loop, `await`-ing each entry sequentially (`default.ts:774-813`).
Concurrency exists only *within* an entry: parallel/branch use `Promise.all`, foreach uses an in-memory
`fastq` worker pool (`control-flow.ts:1120`). `.sleep`/`.sleepUntil` are literally `setTimeout` inside the
running process (`default.ts:110,122`) — blocking the run, not yielding to a durable timer.
Streaming/eventing is via a `PubSub`: each `Run` defaults to an in-process `EventEmitterPubSub`
(`workflow.ts:3091`); `.watch(cb)` subscribes to topic `workflow.events.v2.<runId>` (`workflow.ts:3788-3827`),
and `.stream`/`.streamLegacy` wrap `watch` into a `ReadableStream` (`workflow.ts:3411`). `.start` blocks
for the result; `.startAsync` fires and returns `{runId}` (`workflow.ts:3335-3357`).

A second engine exists: `EventedExecutionEngine` (`evented/execution-engine.ts:19`), auto-selected when a
`schedule` is declared (`create.ts:33`). It does **not** loop; it publishes a `workflow.start` event to
the `workflows` topic and waits for `workflow.end/fail/suspend` (`evented/execution-engine.ts:142-227`). A
`WorkflowEventProcessor` (`evented/workflow-event-processor/index.ts:79`) consumes each event and drives
one step at a time, persisting after each — the step-at-a-time substrate needed for durability.

## Suspend / resume & human-in-the-loop

A step calls `suspend(payload, { resumeLabel? })` (`handlers/step.ts:347`): this records
`suspendedPaths[stepId] = executionPath`, optionally registers named resume labels, and returns a branded
`InnerOutput` (`step.ts:22`). The engine catches the suspended status, formats the run as
`status:'suspended'` with `suspendPayload`, and writes a **snapshot** to storage (`default.ts:830-860`).
The snapshot (`persistWorkflowSnapshot`, `handlers/entry.ts:172-195`) is a JSON `WorkflowRunState`
(`types.ts:380-405`): `status`, `value` (state), `context` (all step results keyed by id),
`serializedStepGraph`, `suspendedPaths`, `resumeLabels`, `activePaths`, `requestContext`,
`tracingContext`, `timestamp`. To resume, you re-create the `Run` by `runId` and call `.resume({
resumeData, step? | label? })` (`workflow.ts:3843`): it `loadWorkflowSnapshot` from storage
(`workflow.ts:3962`), rejects if not suspended, auto-detects the suspended step from `suspendedPaths` if
none given (`workflow.ts:3988-4024`), then re-runs from the saved `resumePath` with the saved
`stepResults` (`default.ts:760-767`). Observability: `.watch`, `.getWorkflowRunById(runId)`
(storage-backed, `workflow.ts:2842`), and `state-reader.ts` helpers (`getSuspendedSteps`,
`getResumeLabels`).

## Durability & persistence

Durable surface = **the storage snapshot only**. What survives a controller crash: a *suspended* run,
because its full state was written to the workflows storage domain (`persistWorkflowSnapshot`) and can be
reloaded by `runId` in a fresh process. What does **not** survive on the default engine: a *mid-flight*
run. The `for` loop, in-flight `Promise.all` branches, the `fastq` foreach queue, and `setTimeout` sleeps
all live in process memory; kill the process and that run is lost (snapshots are persisted between
entries, gated by `shouldPersistSnapshot`, but a running step is not checkpointed). The evented engine
improves this — it persists after each step event and is resumed by replaying events from the `workflows`
topic — but durability is only as strong as the configured `PubSub`/storage: the default
`EventEmitterPubSub` is single-process and in-memory; cross-process delivery requires a backend like
`UnixSocketPubSub` (same-host, `events/unix-socket-pubsub.ts`) or a third-party broker. The cron
`WorkflowScheduler` (`scheduler/scheduler.ts:27`) coordinates multiple polling instances by an atomic
compare-and-swap on `nextFireAt` in storage (`scheduler.ts:19-21`), and a `LeaseProvider`
(`events/pubsub.ts:120`) exists for single-owner election — but both default to no-op/single-process.

## Edges & limits

**Enables:** (1) an expressive, fully type-checked fluent DAG (sequential, parallel, conditional, two loop
forms, concurrency-bounded foreach, data-mapping) authored in one TS file; (2) ergonomic suspend/resume
with named resume labels and rich snapshots for human-in-the-loop; (3) workflows-as-steps composition with
nested-run tracking; (4) live streaming/watch over pubsub and server-side `onFinish`/`onError` lifecycle
hooks; (5) a pluggable engine seam (default in-process, evented, Inngest/Temporal via override hooks like
`wrapDurableOperation`, `executeSleepDuration`).

**Constraints a multi-process DAG-fleet would not share:** (1) one workflow run = one Node event loop — no
per-node OS process, no per-node sandbox/tools/heterogeneous runtime; (2) default-engine durability is
between-step snapshots only, so a crash mid-step loses that run and a running controller is a single point
of failure (the run isn't fs-coordinated and self-healing); (3) `.sleep` is in-process `setTimeout`, so
long sleeps pin a live process rather than being a durable, controller-free wake; (4) cross-process
execution is bolt-on (requires evented engine + a non-default PubSub broker + shared storage), not the
native model; (5) coordination/durability is mediated by a storage adapter + pubsub broker rather than by
the filesystem, so "survives controller death" is conditional on that external infrastructure, not
intrinsic.

*(Self-check note: `component:'WORKFLOW'` is consumed at `handlers/step.ts:434` and asserted by `Workflow
implements Step` at `workflow.ts:1561`; the exact assignment line of that string literal was not located
via grep — the consumption site is cited, not an invented assignment line.)*
