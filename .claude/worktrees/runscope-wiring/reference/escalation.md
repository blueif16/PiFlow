# Escalation gate (advisor inversion)

A non-Claude model runs every node; on a **verified** failure the driver consults a stronger, ideally
different-family model **once**, fed the non-Claude attempt's failure evidence. This is the *advisor
inversion*, not a generic try-efficient-first cascade: the strong model is invoked only on an efficiently-
verifiable failure, so the "efficient floor" is never wasted (the failed attempt's evidence *feeds* the
consult). Research basis: `research/llm-escalation-triggers-2026-06-26.md` (the regime where consult
pays off: long loops where the strong model only consults + escalation gated on an artifact-exists
signal). Engine: `run.mjs`, generic. Per-repo selection: wiring `.env`. Consult model: `models.json`.

## Why the trigger is the artifact contract, never self-confidence

A 48-model study found every model systematically overconfident; same-model self-review has
**correlated blind spots** (attempt #3 repeats the same confident wrong answer). So the gate fires on
**empirical, externally-verifiable** signals the driver already computes — the centerpiece being the
`DRIVER-ARTIFACTS` contract breach (we `stat()` the files the node was *required* to produce; we do
not ask the model "are you sure").

## The classifier (`classifyFailure(n)` — pure function on already-computed signals)

| Signal (already on `n`) | Class | Action |
|---|---|---|
| `n.driverPreflight` | driver gate | **HALT** (no model ran) |
| `status blocked/gap` whose issue names a missing **upstream input** | upstream gap | **HALT** (escalation can't manufacture an input) |
| `n.contractMissing.length` — required artifact verified missing | capability/contract | **ESCALATE** (ground-truth trigger) |
| `n.killedRepeat` — stuck-loop | capability | **ESCALATE** (same-model retry just loops again) |
| `n.killedTimeout` — over budget | capability | **ESCALATE** |
| `exitCode≠0` + stderr ∈ /rate-limit·ECONN·429·5xx·network/ | transient | **RETRY_SAME** (efficient; infra, not capability) |
| `!n.parsedOk` — no return block | degenerate | retry-same once → then **ESCALATE** |
| any other failure | capability | **ESCALATE** |

## The consult is not blind

On escalate, `consultPreamble(n)` prepends the **verified** failure evidence (not a score): the
failure class + the missing-artifact list / `looped on …` / stderr tail, and instructs the stronger
model not to repeat the mistake and to produce every required artifact.

## Wiring (`.env`, per repo) + the cross-family target

```
PI_RUNNER_ESCALATE=1                 # arm it (default off)
PI_RUNNER_ESCALATE_PROVIDER=minimax  # optional; omit to stay in-provider
PI_RUNNER_ESCALATE_MODEL=MiniMax-M3  # the consult model id (lives in ~/.pi/agent/models.json)
PI_RUNNER_MAX_RETRIES=1              # same-model transient retries before escalating
```

**Pick a CROSS-FAMILY consult.** A provider whose non-Claude default is already its top tier has no upward
headroom (e.g. DashScope `cp`: `qwen3.7-max` is the ceiling, `qwen3.7-plus` is more efficient) — so escalate
to a *second provider* with a reasoning model. The reference repo uses `minimax/MiniMax-M3`
(reasoning, 1M ctx), already in `models.json`. Cross-family also breaks the correlated blind spots
that make a same-family retry useless.

## Implementation shape (all driver-side — no pi extension)

`runNodeWithEscalation(node)` wraps `runNode` and the stage loop calls it. `piArgs`/`runNode` accept a
per-node `{model, provider, promptPrefix}` override, so the consult is just the same headless `pi -p`
spawn on a different `--model`/`--provider`. The wrapper records `n.attempts[]` + `n.escalated`.

## Per-node opt-out

`DRIVER-NO-ESCALATE` (a presence-only marker, same family as `DRIVER-ARTIFACTS`) on a pure gate node
skips the gate.

## Tie to Hermes

`n.escalated` + `n.attempts` is a first-class capture signal: **a wave that escalates every run is a
skill/prompt flaw, not a model flaw.** Feed escalation-rate-per-wave into the loop → fix the skill so
the non-Claude model succeeds, or pin that wave to the stronger model. The gate doubles as the
instrumentation that tells the self-improvement loop *where to look*.

## Open / tune-later

- Same-model transient retry vs straight-to-escalate: start `MAX_RETRIES=1`, tune from `n.attempts`.
- A `killedTimeout` re-run currently reuses the same node budget; a larger consult timeout is a future knob.
- Does the non-Claude provider honor prefix caching / batch discounts? Measure before assuming.
