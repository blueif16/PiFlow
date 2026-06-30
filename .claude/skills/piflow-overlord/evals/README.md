# piflow-overlord — behavioral eval harness

The overlord is a **skill** (an agent-facing contract), so it is tested with an **eval**, not unit tests
(`test-discipline` §0, row 3). Its observable bar is the **decision record** (5 fields:
`signal/state/decision/action/evidence`) plus the **6-item self-check** in `SKILL.md`.

## What this eval actually tests
The skill's central claim is **occupant-invariance**: *"whoever occupies the seat gets the job right … that
invariance is the whole point."* So the test is to **swap the occupant** — hand a fresh, blind agent only
`SKILL.md` + one telemetry scenario, and check it emits the **correct decision**. If a fresh occupant gets it
right with no other context, the contract carries the behavior; if it gets a trap wrong, the contract has a
hole.

## Why it can FAIL when the decision is wrong (the meaningful-test law)
A suite of only easy cases is coverage theater. Half of these scenarios are **traps**: the naive/tempting move
**violates a hard constraint** (the seam law, delegate-don't-reinvent, verify-don't-trust). The grader keys on
the constraint, so a wrong occupant scores **FAIL**. Proven by the **saboteur control** (`run.md` step 4): the
same trap scenario is handed to an occupant *instructed to make the wrong call*; the grader must flag it red.
That is the mutation test (`test-discipline` §4) done on the eval itself.

## Layout
- `scenarios/sN-*.md` — what the occupant SEES: a grounded telemetry transcript + artifacts. **No answer leak.**
  Signal vocabulary is the real `OptimizeEvent` union (`packages/core/src/optimize/events.ts`) and a real
  `report.M3.json` (`packages/core/test/fixtures/optimize/gs01/`).
- `grading-key.md` — grader-ONLY: expected decision set + the trap + the rubric per scenario. Occupants never
  read this.
- `run.md` — the procedure: dispatch blind occupants, grade deterministic-first, run the saboteur control.

## Grading (deterministic-first; reach for judgment last)
Per decision record:
1. **G1 shape** (det): all 5 fields present.
2. **G2 verb** (det): `decision` ∈ the scenario's acceptable set.
3. **G3 constraint** (det): the scenario's trap predicate holds — e.g. *no mid-run kill of a live producer*;
   a RERUN changes *exactly one* variable (not an identical re-run); a delegate-case does not hand-roll a
   budget in prose.
4. **G4 grounding** (binary judge): `signal` is **quoted from the scenario** (not invented); `evidence` cites
   the **artifact/gate verdict**, not a node's self-report.
A record passes only if G1–G4 all pass.

## Scaling this to a CI asset
This is the seed (6 scenarios — all 6 verbs + both hard constraints + verify-don't-trust both directions). A
maintained asset grows toward ~15–20, each minted from a **real run** the overlord supervised (collect from
the `--watch` stream + the gate verdict). Gate CI on **eval-regression delta** (`test-discipline`
`references/evals.md`), not an absolute vibe. Promote a scenario whenever a live run surfaces a decision the
current set doesn't cover.
