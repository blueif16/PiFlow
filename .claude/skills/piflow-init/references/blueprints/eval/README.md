# Compose eval — can a skill spot the correct DAG for a real workflow?

This is the acceptance test for the whole blueprint layer. It does NOT test the SDK (that is `extract` +
`tsc`); it tests whether an agent, given a real workflow NEED and the authoring guide, **composes the DAG whose
shape actually solves it** — the right blueprint(s), sized right, wired right. Per `test-discipline`, a skill is
gated by an eval, not unit tests.

## Protocol (per task)

1. **Compose.** Give a COMPOSE agent ONLY the task prose (`tasks.md`, one task) + the authoring layer
   (`AUTHORING-GUIDE.md`, the `README.md` catalog, the blueprint `.md`s, the presets). It reasons the task into
   a DAG and stamps a template into a scratch dir via the scaffold loop. It NEVER sees `reference.md`.
2. **Mechanical gate.** Run `piflowctl extract <scratch-dir>`. Exit ≠ 0 ⇒ the task FAILS outright (a DAG that
   does not compile cannot be the answer).
3. **Topology judge.** A SEPARATE critic agent is given the stamped DAG (the `extract` output + the `node.json`
   set) AND that task's `reference.md` entry, and scores the SHAPE match — never byte-identity. It returns
   PASS/FAIL + evidence against the reference's `must` / `must-not` list.
4. **Task PASS** ⟺ `extract` exit 0 AND the critic returns PASS.

## Suite bar (all must hold)

- Every REAL task (T1–T5) PASSES (right shape, extract-green).
- **The test-the-test (T6) is CAUGHT:** T6 is an inherently-SERIAL self-fix task; a `fan-out-map-reduce`
  composition of it MUST score FAIL. Feed the critic a *planted* map-reduce composition of T6 — if it scores
  PASS, the critic is not discriminating SHAPE (only "extract-green"), and the eval is void until the critic is
  fixed. This is the eval's own falsifier.
- Judge SHAPE, not prose. A task passes on the topology (blueprint choice · lane count in range · wiring
  signature), regardless of prompt wording.

## Why these levers (anti-teach-to-the-test)

- `tasks.md` and `reference.md` are SEPARATE files; the COMPOSE agent sees only the task. The reference (the
  oracle) is the critic's alone — the standard is never injected into the composer (that would void the signal,
  same rule as the criteria fixture).
- The critic scores against an OBSERVABLE rubric (blueprint id, countable lane range, named wiring edges), never
  "is this a good DAG". Each `reference.md` entry carries both a `must` list and a `must-not` (the wrong shapes)
  so a plausible-but-wrong composition is caught, not rubber-stamped.

## Running it

Author-time, run as a small workflow: one COMPOSE lane per task → `extract` → one critic lane per task judging
against `reference.md`. Report per-task PASS/FAIL + the suite bar. (A future `piflowctl blueprint` verb, see
`docs/design/blueprint-compose-verb.md`, makes the compose step deterministic; the eval still judges the SHAPE
the agent CHOSE, which the verb does not decide.)
