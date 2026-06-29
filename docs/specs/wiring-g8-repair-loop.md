# Wiring G8 — Structured-output repair loop

> Status: DESIGN (research 2026-06-25). Closes §G8 of `competitive-gaps-vs-pi-dynamic-workflows.md`.
> Severity LOW–MED · effort LOW. All `file:line` verified against the working tree.

## TL;DR

On a schema miss, re-prompt the node ONCE (bounded) before counting a full `io.retries` re-run. PDW
re-prompts the same in-memory session — that **does not transfer** (piflow nodes are `--no-session` with
stdin closed). The robust port is a **fresh, bounded repair call in the still-alive sandbox**, whose
prompt is built from the failing output + the ajv errors + the schema. Default off (`maxRepairAttempts:0`).

## Verified current state

Two ajv-2020 schema gates exist, both in `runNode`:
- **Artifact-schema gate** — `validateArtifactSchemas()` (`runner/schema.ts:47-53`; `allErrors:true,
  strict:false`, errors capped at 8, formatted `${instancePath} ${message}`), called at
  `runner.ts:993-1000`. Invalid artifact → `rec.schemaInvalid`.
- **Return-schema gate** — validates the fenced-JSON tail against `io.returnSchema`. Fires **only** when
  `returnMode === 'required'` AND a schema is declared AND a block parsed (`runner.ts:1054`,
  `returnSchemaBreach`). *(Doc §G8 cites `runner.ts:735` — correct it to `:1049-1054`; 735 is now G5
  checkpoint code.)*
- **Verdict ladder** (`runner.ts:1056-1087`): artifact breach → `st='blocked'` at `:1071-1073`; return
  breach → `:1077-1079`.
- **The only retry is a full fresh re-run.** `runNodeWithRetries` (`runner.ts:755-762`):
  `maxAttempts = 1 + (io.retries ?? 0)`; each attempt is a brand-new sandbox + re-exec. **No repair
  re-prompt** (grep: zero `repair`/`maxSchemaRetries` in the schema/runner path; the only "repair" in
  core is the fusion best-of-N *judge* prompt at `workflow/fusion/prompts.ts:53-72`, a different
  mechanism).
- **The failing output is in-hand** at the insertion point: `result.stdout` (full) +
  `parsed = lastJsonBlock(result.stdout)` (`runner.ts:1033`), plus the ajv error strings in
  `schema.invalid[].errors` / `returnSchemaInvalid`. **The sandbox is still alive** here (disposed only
  in `finally` at `:1142`) — an in-process second exec is feasible.
- **Authoring→runtime wiring (the pattern a new field follows):** schema `node.schema.ts` (`retries`
  `:80-86`, `timeoutMs` `:72-79`, `return` `:182-186`, `contract.returnMode` `:141-144`) → types
  `template/types.ts` (`retries` `:32`) → runtime `types.ts` (`NodeIO.retries` `:277`, `returnSchema`
  `:264`) → loader `template/loader.ts:128-136`.

## PDW reference — what transfers, what does NOT

`vendor/pi-dynamic-workflows/src/agent.ts:113-155` (`resolveStructuredOutput`): on a miss,
`setActiveToolsByName(["structured_output"])` and re-prompt the **same in-memory session** up to
`maxSchemaRetries` (default 2) with "call structured_output now as your only action"; then strict
schema-validated prose extraction; else throw `SCHEMA_NONCOMPLIANCE`.

- **Transfers:** the *shape* — bounded N-attempt loop, then a terminal surfaced error; default N≈2; the
  "your previous output failed — produce only the corrected result" framing.
- **Does NOT transfer:** PDW's repair is cheap because the session is in-memory (`session.prompt(...)`
  continues the conversation). piflow emits `--no-session` (`command.ts:64`, ephemeral) and closes stdin
  in every sandbox (`command.ts:55`) — there is no session to continue and no stdin to feed. There is no
  `structured_output` tool either; a node's structured result is the fenced-JSON tail of stdout
  (`lastJsonBlock`) or a file on disk. So "restrict to the schema tool" becomes "re-prompt to rewrite
  *only* the failing artifact / fenced-JSON tail."

## Options

- **A — Resume-session repair** (drop `--no-session`, `pi --continue` for the repair turn). Highest
  fidelity but **worst fit**: breaks the load-bearing headless invariant, introduces session-file
  lifecycle across local/seatbelt/worktree/daytona, and re-bills cumulative context.
- **B (recommended) — fresh bounded repair call.** Build a new minimal `pi` invocation in the *same*
  live sandbox from the prev output + ajv errors + schema; re-collect; re-validate; loop up to
  `maxRepairAttempts`. Respects every headless invariant, reuses the in-hand failing output and the
  existing collect + validate code verbatim. The harness owns the loop, not the model.
- **C — in-prompt self-check only** (a "validate before returning" pass). A cheap *complement*, not a
  bounded guarantee.

## Recommendation — Option B (+ C as a prompt-level complement)

**Touch-points:**
1. `node.schema.ts` — add `contract.maxRepairAttempts` (integer, `minimum:0`), mirroring `retries`.
2. `template/types.ts` — `TemplateNode.contract.maxRepairAttempts?: number`.
3. `packages/core/src/types.ts` — `NodeIO.maxRepairAttempts?: number` (next to `retries`, `:277`).
4. `template/loader.ts:118-137` — carry it (`...(maxRepairAttempts ? {maxRepairAttempts} : {})`).
5. `runner.ts` — the loop. After the verdict block (≤`:1087`), if `st === 'blocked'` **solely** because
   of `schema.invalid.length` or `returnSchemaBreach`, and `maxRepairAttempts > 0`, enter a repair loop
   inside the live-sandbox `try`: stage a repair prompt as `_pi/<id>/repair-<k>.md`, build a fresh
   command via `ctx.buildCommand` (reuse `eff.model`/provider/extension), `execRunner` under the same
   `nodeTimeoutMs`+recorder, re-collect via `ctx.collectMutex`, re-run `validateArtifactSchemas` + the
   return-gate. Clean pass → fall to `st='ok'`; exhaustion → keep `blocked` + `rec.repairExhausted=true`.
   Record `rec.repairAttempts`. Each turn is event-recorded → shows in observe automatically.
6. `runner/journal.ts` — **no `envelopeHash` change** (deliberate): a repaired-good node journals `ok`
   with its existing envelope hash — "produced a conforming output" is the same node identity whether it
   took 1 turn or 2 (same logic by which `retries` is absent from the envelope). Document at the
   `:99-101` extension comment.

**Bound + default:** `maxRepairAttempts` per-node, default **0** (off — preserves today exactly). Sane
opt-in 1–2 (matches PDW). Worst-case wall = `(retries+1) × (1 + maxRepairAttempts) × timeout` — document
it; repair turns run **inside `runNode`** so they reuse the node's G2 slot.

**Terminal-failure surface:** keep `st='blocked'` (run halts at the barrier — loud-failure convention)
with an unmistakable issue, e.g. `contract breach — output failed its declared schema after N repair
attempt(s): <last ajv errors>`, plus `rec.repairExhausted`.

**Repair-prompt template** (authored per `agentic-prompt-design`: output-shape-first, errors-as-blueprint,
"don't fabricate to fill a field"), harness-filled `{{...}}`:

```
<role>You fix a structured output that FAILED its schema. Output ONLY the corrected result — no prose.</role>
<task>Produce a CORRECTED version that conforms exactly. Change ONLY what the errors require; preserve all valid content.</task>
<schema>{{declaredSchema}}</schema>                 <!-- the artifact JSON-Schema OR the returnSchema, verbatim -->
<validation_errors>{{ajvErrors}}</validation_errors> <!-- FACTS — fix exactly these, invent nothing -->
<your_previous_output>{{previousOutput}}</your_previous_output>
<output_spec>Write the corrected result to {{target}} (same artifact path / same fenced-JSON tail). It
MUST validate against <schema>. Fill every required field. Use only values present in your previous output
or logically implied by it — do NOT fabricate new data to satisfy a field.</output_spec>
<constraints>MUST: emit only {{target}}, conform to every <schema> rule. MUST NOT: add commentary or
invent data not grounded in your previous output.</constraints>
<self_check>Before returning, validate against <schema>: every required field present, every enum/type
satisfied. If a required value is genuinely absent and cannot be derived, use the schema-allowed
empty/default rather than fabricating.</self_check>
```

**Composition:** G2 — same slot (runs inside `runNode`). G4 — repaired-good journals `ok`, envelope
unchanged → resume reuses it; never-repairable stays `blocked` → re-runs (correct). Checks — repair
re-runs the *same* full gate sequence, so a repair that fixes the schema but trips an integrity check
still blocks. Timeout — each turn is a fresh `execRunner` under the same watchdog.

## Test strategy (FAILS if the loop is broken)

Use the injectable `buildCommand` seam (`test/return-schema.test.ts`, `test/runner.test.ts`) with a
stateful builder (bad on call 1, good on call 2):
1. **bad-then-good succeeds via repair, NOT a full re-run** — `maxRepairAttempts:1, retries:0`; assert
   `ok`, `rec.repairAttempts===1`, builder called **twice within one `runNode`** (retry budget untouched).
2. **bad-forever surfaces terminal error after EXACTLY N** — `maxRepairAttempts:2`, always bad; assert
   `blocked`, `repairExhausted`, issue `/after 2 repair attempt/`, builder called **3×** (1+2).
3. **`maxRepairAttempts:0` = today** — blocks immediately, builder once.
4. **repair fixes schema but an integrity check still fails → stays blocked** (no gate bypassed).
5. **loader wiring** — `contract.maxRepairAttempts:2` populates `io.maxRepairAttempts`.
6. **G4 composition** — a repaired-good node's envelope hash equals the same node with
   `maxRepairAttempts:0` (budget is out of identity); resume reuses it.

The repair **prompt** itself routes to an eval (cheap real model: malformed output + schema + errors →
assert corrected output validates), not a unit test.

## Risks & open questions

- **Prev output source:** return miss → `result.stdout` (in-hand); artifact miss → the collected file on
  disk. One template, parameterized `{{target}}`/`{{previousOutput}}`.
- **Field placement:** `contract.maxRepairAttempts` (schema-scoped, recommended) vs top-level next to
  `retries`. Owner's call.
- **Worst-case wall multiplication** — document; decide whether a repair turn gets full `nodeTimeoutMs`
  (recommend yes — it's a real generation).
- **Multi-artifact nodes** — one repair turn addresses **all** current violations (re-validate the whole
  set each turn).
- **Inside `runNode` vs a wrapper** — inside (recommended) keeps the live sandbox + the in-hand failing
  output; a wrapper would re-seed a fresh sandbox each turn (wasteful). This deviates from "every attempt
  is a fresh sandbox" — that's the point: a repair is not a retry.
- **No `structured_output`-tool analog** — we rely on prompt + harness re-validation; a model that
  ignores the instruction exhausts the budget → terminal blocked (correct, loud).
