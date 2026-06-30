# Mastra teardown — Observability & evals/scorers

> Per-aspect source brief for [`../competitive-analysis-vs-mastra.md`](../competitive-analysis-vs-mastra.md)
> (§1g, §3 M3/M7, §4). Evidence cited `file:line` relative to `vendor/mastra/`. Produced 2026-06-29 from a
> focused read of `packages/evals/`, `packages/core/src/{evals,observability,telemetry}/`, and the
> top-level `observability/` at HEAD `12af22b`. Honest by construction.

## Evals / scorers

Mastra's evaluation primitive is **`createScorer`** (factory) returning a **`MastraScorer`** instance — a
chainable pipeline, not a single `measure()` call. Defined in `packages/core/src/evals/base.ts:1030-1058`
(three typed overloads → impl at `:1049`); the class is `MastraScorer` at `base.ts:304`. A scorer is built
from up-to-four ordered steps, each added by a chained method: **`preprocess`** (`base.ts:386`),
**`analyze`** (`base.ts:422`), **`generateScore`** (`base.ts:452`, the only required step — `base.ts:513`
gates execution on its presence, `:531-537` throws "Cannot execute pipeline without generateScore() step"),
and **`generateReason`** (`base.ts:482`, produces a natural-language explanation of the score). Each step
may be either a plain JS function or a **`PromptObject`** with `createPrompt` + `outputSchema` that calls a
judge model (`ScorerJudgeConfig`, `base.ts:71`), so a single scorer can mix rule-based and LLM-judge steps.
The legacy `Metric.measure()` abstraction is **ABSENT** in this version (`grep '.measure('` over
`core/src` + `evals/src` returns nothing; README confirms the migration to scorers).

**Built-in scorers** ship in `@mastra/evals` (subpath `scorers/prebuilt`). LLM-judge scorers
(`packages/evals/src/scorers/llm/index.ts:1-13`):
- `createAnswerRelevancyScorer` (`llm/answer-relevancy/index.ts:32`)
- `createFaithfulnessScorer` (`llm/faithfulness/index.ts:29`)
- `createHallucinationScorer` (`llm/hallucination/index.ts:39`)
- `createToxicityScorer` (`llm/toxicity/index.ts:13`)
- `createBiasScorer` (`llm/bias/index.ts:19`)
- `createContextRelevanceScorerLLM` (`llm/context-relevance/index.ts:66`)
- `createContextPrecisionScorer` (`llm/context-precision/index.ts:54`)
- `createNoiseSensitivityScorerLLM` (`llm/noise-sensitivity/index.ts:61`)
- `createPromptAlignmentScorerLLM` (`llm/prompt-alignment/index.ts:74`)
- `createAnswerSimilarityScorer` (`llm/answer-similarity/index.ts:69`)
- `createToolCallAccuracyScorerLLM` (`llm/tool-call-accuracy/index.ts:32`)
- `createTrajectoryAccuracyScorerLLM` (`llm/trajectory/index.ts:113`)
- `createRubricScorer` (`llm/rubric/index.ts:172`, custom user-defined rubric)

Deterministic code/NLP scorers (`code/index.ts:1-8`): `createCompletenessScorer`
(`code/completeness/index.ts:77`), `createTextualDifferenceScorer` (`code/textual-difference/index.ts:117`),
`createKeywordCoverageScorer` (`code/keyword-coverage/index.ts:5`), `createContentSimilarityScorer`
(`code/content-similarity/index.ts:10`), `createToneScorer` (`code/tone/index.ts:9`),
`createToolCallAccuracyScorerCode` (`code/tool-call-accuracy/index.ts:64`), `createTrajectoryAccuracyScorerCode`
(`code/trajectory/index.ts:92`). Plus assertion-style **checks** (`code/checks/index.ts`): `includes`,
`excludes`, `equals`, `matches`, `similarity`, `calledTool`, `didNotCall`, `toolOrder`, `maxToolCalls`,
`usedNoTools` (lines 21-323).

**Attachment:** scorers attach declaratively to an agent via `scorers?: MastraScorers | Record<…>`
(`packages/core/src/agent/agent.types.ts:539`), each entry carrying optional `sampling` (`MastraScorerEntry`,
`base.ts:1060-1062`).

## Running evals

Mastra does **both offline and LIVE in-production scoring — VERDICT: yes, live sampling is real.** Live:
each attached scorer carries `sampling?: ScoringSamplingConfig`, typed `{ type: 'none' } | { type:
'ratio'; rate: number }` (`evals/types.ts:14`). At runtime, `runScorer` enforces it: `case 'ratio':
shouldExecute = Math.random() < scorerObject?.sampling?.rate` (`evals/hooks.ts:42-43`), returning early (no
score) when not sampled (`:50-52`); it then fires `ON_SCORER_RUN` (`:100`), registered globally in
`packages/core/src/mastra/index.ts:1479`. Offline/CI: scorers run standalone via `scorer.score(...)`, and
stored traces can be re-scored after the fact through **`scoreTraces`**
(`evals/scoreTraces/scoreTraces.ts:4`) and the `scoreTracesWorkflow` (`evals/scoreTraces/index.ts:1-2`).
The standalone `@mastra/evals` package does **not** persist (README: "do not persist results"); persistence
happens only through the core hook + storage path below.

## Observability / tracing

The AI-tracing model is a typed span tree. Span kinds are the **`SpanType`** enum
(`packages/core/src/observability/types/tracing.ts:35`) — note this is `SpanType`, not literally
`AISpanType` (uncertain whether an `AISpanType` alias exists elsewhere; not found in this file). Members
include `AGENT_RUN`, `MODEL_GENERATION`/`MODEL_STEP`/`MODEL_INFERENCE`/`MODEL_CHUNK`,
`TOOL_CALL`/`CLIENT_TOOL_CALL`/`MCP_TOOL_CALL`,
`WORKFLOW_RUN`/`_STEP`/`_CONDITIONAL`/`_PARALLEL`/`_LOOP`/`_SLEEP`/`_WAIT_EVENT`, `SCORER_RUN`/`SCORER_STEP`,
`MEMORY_OPERATION`, `RAG_*`, `PROCESSOR_RUN` (`tracing.ts:37-99`). Exporters implement
**`ObservabilityExporter extends ObservabilityEvents`** (`observability/types/core.ts:587`, `:559`), whose
hooks are `onTracingEvent`/`onLogEvent`/`onMetricEvent`/`onScoreEvent`/`onFeedbackEvent` +
`exportTracingEvent` — so traces, metrics, scores, and feedback flow through one exporter pipeline.

**Full exporter list** (top-level `observability/`): built-in (`@mastra/observability`,
`observability/mastra/src/exporters/`): `ConsoleExporter` (`console.ts:6`), `DefaultExporter`
(`default.ts:83`), `CloudExporter` (`cloud.ts:233`), `MastraStorageExporter` (`mastra-storage.ts:72`),
`MastraPlatformExporter` (`mastra-platform.ts:220`), all extending `BaseExporter` (`base.ts:84`).
Third-party: `BraintrustExporter` (`braintrust:84`), `LangfuseExporter` (`langfuse:41`), `LangSmithExporter`
(`langsmith:67`), `PosthogExporter` (`posthog:99`), `SentryExporter` (`sentry:117`), `LaminarExporter`
(`laminar:119`), Arize/Arthur via `OpenInferenceOTLPTraceExporter` (`arize:154`, `arthur:153`),
`OtelExporter` (`otel-exporter:97`), and two OTEL **bridges** `DatadogBridge` (`datadog:165`) and
`OtelBridge` (`otel-bridge:62`). The generic `@mastra/otel-exporter` speaks OTLP over `http/json`,
`http/protobuf`, `grpc`, and `zipkin` (`otel-exporter/src/loadExporter.ts:27-38`) with named-backend presets
for **dash0, signoz, newrelic, traceloop, laminar** (`provider-configs.ts:31-40`). (Note: legacy
`packages/core/src/telemetry/` is anonymous product usage-analytics over PostHog — `usage-telemetry.ts`,
`posthog.ts` — NOT the AI-tracing path.)

## Storage of traces/scores

Persistence is via pluggable storage adapters under `packages/core/src/storage/domains/`. Scores:
`ScoresStorage.saveScore(SaveScorePayload) → { score: ScoreRowData }` (`storage/domains/scores/base.ts:20`;
in-memory impl `inmemory.ts:23`). Traces/spans: the `observability` storage domain
(`storage/domains/observability/base.ts:94` — "traces, metrics, logs, scores, feedback") with
`getTrace`/`getTraceLight`/`listTraces`/`listTraceBranches`/`batchDelete` (`base.ts:218-390`) and an
in-memory backend. The `MastraStorageExporter` funnels live spans into this domain; the `ON_SCORER_RUN`
hook (`mastra/index.ts:1479`) routes sampled scores to `saveScore`. Concrete DB adapters live under the
repo's top-level `stores/` (see the memory-and-rag brief).

## Edges & limits

Capabilities Mastra's scorer/tracing stack enables that a "checks never judge goodness" + distilled-run-view
system lacks:
1. **Quality vocabulary as first-class scores** — faithfulness, hallucination, toxicity, bias, answer-relevancy, context-precision, noise-sensitivity, etc., each emitting a numeric `score` + `generateReason` explanation (`base.ts:452`,`:482`). A pure integrity-check layer asserts pass/fail on shape, never "how good."
2. **Live production sampling** — `{ type:'ratio'; rate }` scoring of a fraction of real traffic with the LLM judge (`hooks.ts:42-43`), a continuous online quality signal, not just offline/CI runs.
3. **Retroactive re-scoring of stored traces** — `scoreTraces` / `scoreTracesWorkflow` (`scoreTraces.ts:4`) re-judge historical runs when a new rubric lands, decoupling scoring from execution.
4. **Unified vendor fan-out** — one `ObservabilityExporter` interface ships spans+scores+feedback to ~13 backends (Langfuse, Braintrust, LangSmith, Arize, Datadog, OTLP/dash0/signoz/newrelic…), interoperating with the broader LLM-observability ecosystem.
5. **Typed end-to-end span tree** with per-step scorer spans (`SCORER_RUN`/`SCORER_STEP`) and rubric/custom judges (`createRubricScorer`), letting teams define arbitrary graded criteria.

**Limits:** LLM-judge scorers inherit judge cost, latency, and non-determinism (each sampled run is an
extra model call); `Math.random()`-gated sampling is unseeded/non-reproducible. The standalone
`@mastra/evals` package is non-persisting by design (README) — durability requires wiring core storage.
Scores are advisory signals attached out-of-band; nothing here is a hard correctness gate the way
declarative integrity checks are. *(UNCLEAR: whether `SpanType` is re-exported as `AISpanType` — only
`SpanType` was found in `tracing.ts`.)*
