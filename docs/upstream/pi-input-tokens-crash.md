# Upstream bug report — pi crashes on `input_tokens` when a usage block is malformed mid-turn

**Target:** `earendil-works/pi` (the `@earendil-works/pi-coding-agent` executor)
**Reporter context:** piflow (`@piflow/core`) drives one `pi` process per workflow node.
**pi version:** `pi-coding-agent` v0.79.10 (globally npm-installed; the `pi` on PATH)
**Gateway/model:** `mmgw` gateway serving an `anthropic-messages`-shaped MiniMax-M3 stream.

> This document is a WRITE-ONLY draft prepared from the forensics of piflow run `260710-02`.
> Nothing has been sent upstream. It exists so the report can be filed verbatim when ready.

## Summary

Three consecutive assistant turns crashed with

```
Cannot read properties of undefined (reading 'input_tokens')
```

Each crashed turn had **already produced valid `thinking` + `toolCall` content**, but the crash
discarded the whole turn (no artifact written, the turn recorded as `stopReason:"error"` with
all-zero usage). The process then limped through two `Request timed out.` turns before finally
succeeding — a ~23-minute self-recovery inside ONE continuous session. The crash is a client-side
parse fault, not a model capability miss: valid content was generated and thrown away.

## Environment / trigger

- The `mmgw` gateway emits an `anthropic-messages`-shaped stream for MiniMax-M3.
- Under load it intermittently **omits or malforms the `usage` object mid-turn** (a streamed
  `message_delta`/`message_stop` whose `usage` is absent or missing `input_tokens`).
- pi's response/session accumulator destructures `usage.input_tokens` **without a null guard**, so a
  single malformed chunk throws a `TypeError` that aborts the entire turn (and, in this run, was fatal
  to forward progress until a later attempt happened to get a well-formed stream).

## Evidence (run 260710-02, `gameplay` node session)

Session file: `.pi/sessions/2026-07-10T01-51-37-149Z_gameplay.jsonl`

| session line | timestamp (UTC)     | observation |
|--------------|---------------------|-------------|
| 80           | `02:02:47.013Z`     | assistant turn, `errorMessage="Cannot read properties of undefined (reading input_tokens)"`, real thinking/toolCall content present, then discarded |
| 84           | `02:03:08.080Z`     | same crash signature, content again discarded |
| 86           | `02:03:22.309Z`     | same crash signature, content again discarded |
| 87           | `02:25:55.376Z`     | next line — a full-prompt re-injection **22.5 min later** (zero intervening activity) |
| 88, 89       | `02:26:05/02:26:18Z`| `errorMessage="Request timed out."` |
| 90           | `02:26:44.407Z`     | first SUCCESS — `usage.input=161649`, `cacheRead=128` (full reprocess) |

All three crash turns (80/84/86) carried completed `thinking`/`toolCall` blocks. The fault is in
the turn's terminal usage handling, not in content generation.

## Expected behavior

When a streamed `usage` block is absent or missing `input_tokens`/`output_tokens`:

1. **Soft-fail the turn, keep the content.** A missing usage number is a telemetry gap, not a reason
   to discard a completed assistant turn. Default the missing fields to `0` (or `null`) and finalize
   the turn with the thinking/text/toolCall content intact.
2. **Never throw a `TypeError` out of the stream accumulator.** One malformed chunk from a flaky
   gateway must not abort the exchange. Guard the destructure:
   `const inTok = msg?.usage?.input_tokens ?? 0;` (and the same for `output_tokens`).
3. Optionally surface a one-line warning (`usage block malformed; token counts defaulted to 0`) so the
   telemetry gap is visible without being fatal.

## Suspected accumulator site

The crash is NOT in piflow's own usage parsing — piflow's sites are already null/`typeof`-guarded
(`packages/core/src/runner/claude-result.ts` and `packages/core/src/observe/claude-distill.ts`). It is
inside the `pi` executor (or the `@anthropic-ai/sdk` stream parser it vendors), specifically the
per-turn usage accumulator that reads `message.usage.input_tokens` on a `message_delta`/`message_stop`
event. That is where a null guard belongs.

## Minimal repro sketch

1. Point `pi` at a gateway that returns an `anthropic-messages` stream but drops the `usage` object on
   a `message_delta` (or emits `usage` without `input_tokens`) partway through an assistant turn.
2. Have the model produce a normal thinking + tool-call turn.
3. Observe: the turn crashes with `Cannot read properties of undefined (reading 'input_tokens')` and
   the completed content is lost, instead of the turn finalizing with defaulted token counts.

## Piflow-side mitigation (already routed, not part of this report)

Independently of the upstream fix, piflow classifies this crash signature as a transient `infra`
failure and retries with capped exponential backoff (`isPiClientCrash` + `min(60s, 15s·2^N)`), on the
`fix/infra-retry-backoff` branch. That converts the fatal crash into a survivable retry but does not
recover the discarded turn — only the upstream null-guard does that.
