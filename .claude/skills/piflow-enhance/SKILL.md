---
name: piflow-enhance
description: >-
  Pi Flow · ENHANCE — improve an existing, running pi-flow workflow the disciplined way: turn a spotted flaw,
  a recurring finding, or human feedback into ONE atomic, generalizing change via capture→route→edit→verify→
  approve→commit, never a one-off hack. Owns the criteria fixture (the per-node quality bar) and Companion-Mode
  judging. Use to "improve a wave/node", "fix a recurring failure in the pipeline", "the generated output is
  wrong — fix the system not the case", "edit the skill vs edit the chain". To CREATE a workflow use piflow-init;
  to RUN one use piflow-start. STATUS — STUB: the canonical method is the hermes-skill-system skill; this routes
  to it and pins the piflow-specific precedence.
---

# Pi Flow · enhance — improve a running workflow  ·  STUB

> **This is a scope-declaring stub, not the finished skill.** The canonical improvement method already exists —
> it is the **`hermes-skill-system`** skill (capture → route → edit → verify → human-approve → commit → record).
> This skill exists so the lifecycle has a clean IMPROVE entry; do NOT hand-roll a parallel method here. Load
> `hermes-skill-system` and follow it; this stub only pins the piflow-specific bindings below.
> (Paths are relative to the piflow repo root, `~/Desktop/piflow`.)

## What this skill will own (the IMPROVE half of the lifecycle)
A workflow is a living system; a flaw, a recurring finding, or user feedback on a run is a trigger to evolve it.
The piflow-specific precedence rules (the part hermes doesn't know):

- **Improve a wave by editing its SKILL; improve the chain (ordering, hand-offs, wiring) by editing the
  workflow / the template.** This is the one global precedence rule (see piflow-init → "The laws" → *the
  workflow orchestrates, the SKILL carries the craft*). Corollary: NEVER restate SKILL craft in a node body —
  the body is a thin wiring pointer; craft lives ONLY in the skill (two grounds drift).
- **One canonical home, smallest durable edit.** Patch a section > add a `references/` file > new skill.
- **Generalize or don't ship.** Every edit must hold for ALL future runs — never hard-code one case, never
  write a reward-hackable test.
- **Anti-reward-hack is absolute.** Assert OBSERVABLE state only; the oracle (assertions / the criteria fixture /
  the verify harness) is immutable — a fix changes real behavior, never the test.
- **Reconcile consumers on any output edit** (piflow-init → "The laws" → the node I/O map): change what a node
  writes → find every reader and re-point it, then `grep` the old shape clean.
- **The human is the eye** for the playable/observable artifact; verification is confirmed by a real run, never
  assumed.

## The standing artifacts this skill maintains
- `<repo>/.agents/skill-system-criteria.md` — the per-node, human-judged QUALITY bar (the criteria fixture).
  Complement to the mechanical Output Contract: the contract checks the artifact *exists*; the criteria say
  whether it is *good*. **Never injected into a node prompt** (that teaches-to-the-test and voids the clean-room
  signal) — it is a JUDGING reference only.
- `<repo>/.agents/skill-system-map.md` (composition) + `<repo>/.agents/skill-system-io-map.md` (the
  producer→consumer ledger) — keep these CURRENT; a stale map is the real failure mode.

## Companion Mode is the dev-time face of enhance
When you're babysitting a run, the orchestrator + human ARE the verifier: judge every stage's artifact vs the
GOLD sample + its criteria-fixture entry as it lands, fix at the canonical owner, rerun the suffix. Full
procedure: piflow-init → "Companion Mode (dev-time)".

## Where the material is (read these — do not duplicate them here)
- **`hermes-skill-system`** skill — the canonical capture→route→edit→verify→approve→commit loop + the
  node-validation loop (`references/node-validation-loop.md`). **This is the method; load it first.**
- piflow-init → "The laws" + "Designing a node's I/O" — the piflow precedence + the I/O-map reconciliation rule.
- `docs/design/` (this repo) — the design canon, when an improvement is an architectural change not a wave edit.

## When this stub is filled in
Lift the piflow-specific precedence + the criteria/map maintenance into a self-contained skill here that
*composes* `hermes-skill-system` (don't fork its method). Until then: load `hermes-skill-system`, apply the
precedence above, and the human approves before anything lands.
