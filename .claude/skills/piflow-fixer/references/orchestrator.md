# Orchestrator — running one feedback cycle end-to-end

Open this when: a run verdict has returned and you own the cycle · you are writing a dispatch packet ·
choosing a model lane · a fix loop is stalling, oscillating, or blowing its budget · deciding when to escalate.

> **SHIPPED substrate mechanism vs the aspirational orchestration below.** What `optimize fix --node` actually
> runs: issues are processed **sequentially** (`for (const rec of records)`), each through `fixIssueWithRetries`
> (per-issue bounded retry, default 3, with in-attempt dropback threading the prior reject's `{category,steer}`),
> under ONE system-wide net — the consecutive-exhausted `--breaker` (default 3 → HALT the pass with an
> architecture signal). That is the whole automated loop. The richer machinery in §1/§5 below — parallel
> per-issue subagent dispatch, a batched frozen verify run, cross-cycle STALL/OSCILLATION detection, the
> DEAD-lever ledger, 2-3-candidate fan-out — is **NOT built into the substrate loop**; it is the OVERLORD's
> manual judgment applied across `optimize fix` invocations, or future work. Treat §1/§5 as the discipline, not
> a runtime you can assume fires.

## 1 · The cycle
```
verdict returns
  → two-front read (tokens/calls/errors/think + judge marks; verification.md §6 shape)
  → enumerate issues (detector + evidence line each; triage.md §1)
  → per issue: LAPSE gate (triage.md §2) → consult memory + dead-lever record + library (research on miss)
  → dispatch one targeted subagent per non-LAPSE issue (packet below)
  → collect fixes → ONE batched frozen verify run (verification.md §§2,4)
  → per-issue gate on its pre-registered signal → close / keep open / mark blocked / file watch-item
  → ledgers by pointer → playbook deltas (playbook-maintenance.md) → report two-front to the owner
```
The orchestrator routes, dispatches, gates, improves — it does not fix in-line. LAPSE issues never spawn a
fixer: the orchestrator applies the routing change itself and moves on.

## 2 · The dispatch packet (per issue — curated pointers, never pastes)
```
ISSUE:     nodes/<node>/issues/<name>.md            (the spec; read in full first)
MEMORY:    <node>/memory.md#<lesson-anchor>          (recurrence state, prior levers tried)
DEAD:      <levers already proven inert for this signature — do NOT re-propose>
CARDS:     <library card keys relevant to the routing>
CODE:      <the code-map/okf slice key for the harness region>
PROTOCOL:  pre-register your signal (verification.md §1) before any rerun; frozen-input rules apply
FENCE:     no oracle/judge/gold files (read or write) · no git · no scope growth ·
           if the root is out of reach or the scope must grow: HALT and report, never invent
RETURN:    condensed — the edit(s) · which foot · which lever · both halves named · the pre-registered
           signal · self-check line. Your return is a CLAIM; the gate decides.
```
Large artifacts pass as file paths, never inline. Never pre-judge the fixer's findings in the packet
("don't flag X", "this is probably Y") — that reward-hacks the fix.

## 3 · Model lanes — by JOB SHAPE, not prestige `[[fixer-model-tiering]]`
| job shape | lane |
|---|---|
| forensics / recon / inventory / extraction | cheap tier |
| bounded, well-specified, EDIT-COMMITTING fix | mid tier that reliably ACTS |
| open-ended root-causing, cross-cutting diagnosis, design | deep tier |
| blind judging | strong tier, blind, same calibration every time |
Evidence: a deep-tier fixer over-deliberates and commits nothing (6 runs, 0 edits, every budget lever tried)
while the mid tier landed the only gate-ACCEPT — deliberation quality is not the fixer's product; landed,
gate-proven edits are. **Audit the routing on a cadence by edits-landed + gates-passed per lane**, and treat
"more reasoning can only help" as the anti-pattern it is `[[overthinking-and-thinking-caps]]`.

## 4 · §Tripwires — the fixer's own conduct `[[retry-escalation-ladder]]` `[[tool-call-efficiency]]`
- Classify a failure retryable/non-retryable BEFORE retrying (a schema violation re-sent unchanged is not retryable).
- NEVER resubmit byte-identical; each retry changes exactly ONE variable. Same call shape failing twice ⇒ WARN
  yourself; three times ⇒ the approach is wrong — stop retrying.
- ≤3 retries per failure, then the ladder IN ORDER: steer (adjust the approach) → research (docs/library/memory)
  → alternative route → escalate WITH evidence (what was tried, one variable at a time, and what each showed).
  Never skip to escalation without the evidence; never loop past the ladder.
- No-progress budget: ~20+ calls with ZERO landed edits = stuck, not thorough. Stop; report state honestly.
- Rabbit-hole cap: ≤3 hops into a dependency/side-question before returning to the assigned root.
- "Settled for a degraded half-fix" is a FAILURE OUTCOME to report, not a quiet success — it ranks with
  "looped forever", and hiding it poisons the gate.

## 5 · Loop invariants (across cycles) `[[loop-control-invariants]]`
- **Circuit breaker** independent of per-round caps: a hard ceiling on total rounds/spend per issue, whatever
  the per-round budgets say.
- **Stall:** two consecutive cycles moving NO mechanism signal ⇒ stop; re-question the routing (wrong foot?
  wrong grain? root actually upstream/unreachable?) instead of a third similar attempt.
- **Oscillation:** a proposed fix re-introducing what a prior fix removed (A→B→A) ⇒ halt the lane, escalate —
  the two "fixes" disagree about the root and neither is grounded.
- **Dead-lever record:** every rejected/inert lever is recorded per signature and consulted at dispatch
  (packet field DEAD); re-proposing a dead lever is a playbook violation, not a fresh idea.
- **Stuck ⇒ diversify, never deepen:** fan out 2–3 genuinely DIFFERENT candidate fixes (different lever, or
  different root hypothesis) and let the gate select `[[parallel-variants-over-longer-thinking]]`; doubling a
  stuck attempt's budget buys deliberation, not progress. Keep the pool's best per-case winners, not just the
  single best overall (greedy best-only stalls in local optima — GEPA, arXiv 2507.19457).
- **Fix-round caps + lesson expiry:** every loop has a hard trial cap, and cross-cycle lessons are re-verified
  or retired when the harness version bumps (Reflexion, arXiv 2303.11366; playbook-maintenance.md §4).

## 6 · Escalation to the human/owner
Escalate with a CLOSED decision menu, never an open lament: state the issue, the evidence, the options costed
(including "accept as open"), and your recommendation. Standard escalation triggers: BLOCKED issues
(demand-levers.md §5) · oscillation · circuit-breaker trip · a fix requiring scope beyond the fence · a
detector-vs-judge contradiction that re-judging did not resolve. The orchestrator never widens its own fence.

## 7 · Anti-patterns
- Fixing in-line as the orchestrator (context bloats; attribution dies).
- One mega-dispatch with every issue in it — per-issue packets keep scope fences and signals clean.
- Judging a fixer by its diagnosis eloquence instead of edits landed + gates passed.
- Doubling budgets on a stuck lane; N identical retries dressed as persistence.
- Re-proposing a lever the dead-lever record already holds for this signature.
- Escalating without the one-variable-at-a-time evidence trail, or not escalating past the circuit breaker.
