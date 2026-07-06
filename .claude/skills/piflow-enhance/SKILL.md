---
name: piflow-enhance
description: >-
  Pi Flow · ENHANCE — improve an existing, running pi-flow workflow the disciplined way: turn a spotted flaw,
  a recurring finding, or human feedback into ONE atomic, generalizing change via capture→route→edit→verify→
  approve→commit, never a one-off hack. Owns the criteria fixture (the per-node quality bar) and Companion-Mode
  judging. Use to "improve a wave/node", "fix a recurring failure in the pipeline", "the generated output is
  wrong — fix the system not the case", "edit the skill vs edit the chain", "score / triage / fix a finished
  run", "run the optimize loop", "auto-improve a node from its trace". Also owns the METHOD-LIBRARY sync
  (Leg C, ~/Desktop/best-designs-for-agentic-system): consult the matching card before any edit, write the
  outcome back to its Applications after any land. To CREATE a workflow use piflow-init;
  to RUN one use piflow-start. The canonical capture→route→edit method is the hermes-skill-system skill; this
  COMPOSES it and pins the piflow-specific precedence + the autonomous SCORE→TRIAGE→FIX→GATE→LAND loop.
---

# Pi Flow · enhance — improve a running workflow

> **The canonical improvement *method* is the `hermes-skill-system` skill** (capture → route → edit → verify →
> human-approve → commit → record). Load it first for any by-hand edit; this skill COMPOSES it (it does NOT
> fork that method) and adds two piflow-specific things hermes doesn't know: the precedence rules below, and
> the AUTONOMOUS optimize loop (`piflowctl optimize …`) that turns a finished run's trace into staged,
> gate-proven node edits. (Paths are relative to the piflow repo root, `~/Desktop/piflow`.)

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

## The method library (Leg C) — CONSULT before edit · WRITE BACK after land
Portable, cross-product METHOD knowledge lives OUTSIDE this repo in the design library
(`~/Desktop/best-designs-for-agentic-system`): problem-indexed cards (Trigger → Practice → Evidence →
Applications). The library is ONE of four practice homes; a consult ROUTES the question to the home that
owns it and reads it fresh. Cards are OPTIMIZER-PLANE reference — **NEVER inject a card into a worker
node's runtime prompt** (same law as the criteria fixture and memory.md).

**1 · CONSULT — BLOCKING, at the route step (both loops), before authoring any fix or fixture.** FIND first:
`cd ~/Desktop/best-designs-for-agentic-system/cards && node _generate.mjs --find "<symptom>"` (`--json` =
ranked list). Then route by question kind to the home that OWNS the answer:
| Question kind | Home to consult |
|---|---|
| Which portable METHOD solves this problem class | the library cards (the FIND above) |
| Template/marker format · how to FILL a field · Output-Contract grammar | piflow-init "The laws" + `reference/artifact-contract.md` |
| How this CODE works · where to change it | `.agents/okf/` slices via `piflowctl understand <subsystem>` (okf-slices) |
| Has THIS node failed this way before · what we learned HERE | per-node/template `memory.md` via memory-slices (Leg A) |
Author the fix per the matched card's Practice. A fix that CONTRADICTS a `proven`/`adopted` card must state
the reason in the commit body OR fix the card first — never ship the contradiction silently.

**2 · GAP — a FIND miss (or no home owns the class) → dispatch a research agent BEFORE fixing**, never invent
the method inline. Brief shape: **problem statement** (the symptom class) · **what the trace shows** (evidence +
node/run refs) · **sources to sweep** (arXiv/practitioner + the sibling cards it borders) · **deliverable = ONE
card per `cards/_TEMPLATE.md`** (Trigger · Practice · cited Evidence · Applications). The card lands first,
then the fix applies it.

**3 · WRITE-BACK — after a VERIFIED land, the lesson goes to its ONE home**, per `layered-instruction-homes`,
smallest durable edit: a portable method → new/extended card (append ONE dated Applications line — win OR
under-delivery — `card(<key>): applied — <outcome>`; an under-delivery flips `status` and queues the card as
the next fix target); a field-emission rule → the FILL hint / init law; a product-local lesson → the node's
`memory.md`.

Seam status: consult + write-back is THIS skill's by-hand contract now. Autonomous seam TO-BUILD at the CLI
only (core stays library-blind): matched card → fixer `DefectScope` beside the Leg-A recurrence + Leg-B
code-map (pointer + resolve-at-read, as `enrichCodeMap`, `packages/cli/src/optimize-fix.ts`), a
`[[card:<key>]]` backref in MEMORIZE blocks, and the Applications write-back at `optimize --adopt`.

## Companion Mode is the dev-time face of enhance
When you're babysitting a run, the orchestrator + human ARE the verifier: judge every stage's artifact vs the
GOLD sample + its criteria-fixture entry as it lands, fix at the canonical owner, rerun the suffix. Full
procedure: piflow-init → "Companion Mode (dev-time)".

## The autonomous optimize loop (SCORE → TRIAGE → FIX → GATE → LAND)
Companion Mode is the *human* improvement loop; this is its *autonomous* sibling — it reads a FINISHED run's
`.pi` trace + the product's recorded verify reports, scores every node, triages each failure into one of four
buckets, has a context-isolated fixer edit a CANDIDATE COPY, and lets a deterministic gate decide. It is the
hermes loop with the capture+route steps MECHANIZED and the edit step BOUNDED + MEASURED — same law (one
generalizing change, the human is the eye, the oracle is immutable), executed as a command instead of by hand.

**This loop IS the production path. NEVER write a throwaway replay/fix/score script** — every step below is a
`piflowctl` subcommand or a product binding module that the CLI dynamic-imports. Ad-hoc bash here re-improvises
a tested seam and bypasses the gate (the whole point of the loop), so it is forbidden. (And as everywhere in
piflow: use the global `piflowctl` bin, never `node …/packages/cli/dist/cli.js`.)

### The two commands (copy-paste exact)
**1 · SCORE + TRIAGE (read-only, lands nothing) — always run this first to see the worklist:**
```bash
piflowctl optimize <rundir> [--json]        # default: the rendered routing markdown (the auto HERMES-ROUTING.md)
                                            # --json:  the raw { run, scores, defects } worklist for a driver
```
**2 · FIX → GATE → LAND (stages a manifest; lands NOTHING live):**
```bash
piflowctl optimize --fix <rundir> --binding <module> \
  [--node <substr>]        # scope the worklist to ONE node (the live oracle is expensive — build+browser per
                           #   candidate; a targeted first run is both the cost bound and the safety scope)
  [--watch] [--watch-json] # stream the FIX→GATE→LAND events live (see the 9-event order below); --watch-json = JSONL
  [--auto-adopt]           # default OFF — see the OUTCOME-gated accept rule; without it, EVERY win only STAGES
  [--staging-dir <d>]      # where the manifest lands (default: <rundir>/optimize/staging/manifest.json)
  [--edit-budget n]        # max fixer ATTEMPTS this round (the "learning rate"/cost cap; default 4)
  [--token-budget n]       # cumulative token cap; the driver stops before the next attempt once reached
```

### The FIX → GATE → LAND method (what the driver guarantees)
The model PROPOSES + SCORES; deterministic CODE decides, bounds, and lands. The control flow is straight-line:
- **Candidate-COPY only — the loop NEVER mutates the live file.** The fixer edits a candidate copy
  (`prepareCandidate` → `candidateRef`); the scorer reads the copy; the gate compares copy-vs-base. The live
  file is touched ONLY by the separate adopt step (below), which backs it up first (`<basename>.bak`).
- **Strict-improvement gate on the HELD-OUT VAL slice.** Accept = `≥1 edit applied AND candidate > base` on a
  val slice the fixer never saw — this strict bar (not the round count) is what stops self-edit DRIFT
  (autonomous self-editing measured +0.0pp WITHOUT it). An unmeasurable/abstained score CANNOT auto-accept →
  it routes to the human. FUNCTIONALITY carries a STRICTER gate: a code edit's higher blast radius means the
  product's OWN build/tests/typecheck must ALSO pass, not just a score bump.
- **The four-way triage buckets** (ascending blast radius; default to the lowest when unsure — corpus
  protection): **LAPSE** (self-originating structural slip, no code signal) · **SKILL** (a recurring lapse →
  edit the node's SKILL; needs the cross-run recurrence signal) · **FUNCTIONALITY** (a clean node whose
  checkable Tier-1 outcome failed → the product CODE is wrong) · **ARCH** (the failure originated upstream →
  route UP to reconcile). ARCH always takes the heavyweight human gate.
- **STAGING → manifest → human-adopt seam (adopt is a SEPARATE step).** A round writes a deterministic
  `manifest.json` (per-record: node · bucket · decision · gate reason/delta/landPolicy). It lands nothing.
  Physical adoption — backup-then-overwrite the live file from a candidate copy — is the explicit, reversible
  follow-up the human runs after reading the manifest. "The loop never mutates the live file" is the invariant.

### The OUTCOME-gated accept rule (when may a fix land itself?)
`--auto-adopt` is **default OFF**, and even with it ON it only adopts edits the gate marks `auto-adopt-eligible`:
- **Auto-adopt ONLY on deterministic Tier-0/1 signals** — an outcome-gated bucket (LAPSE/SKILL/FUNCTIONALITY)
  whose candidate strictly beat base on a MEASURED val slice (FUNCTIONALITY also passing the product build).
- **Judgment edits STAGE for the human** — ARCH (structural), and any edit whose score was unmeasurable /
  abstained / judge-gated, always stage. Never let a judge-gated or abstained score auto-land.

### Authoring a product binding (`{ oracle, copyScope, fixer }`)
The LIVE stages cannot live in `@piflow/core` (it is product-agnostic — see CLAUDE.md "Data & SDK boundaries"),
so each product ships ONE binding module that the CLI dynamic-imports (`--binding <module>`; a local path or a
package specifier). It MUST export three functions; the CLI validates them on load:
- **`oracle`** — re-verify a candidate build → a raw verify report (game-omni: `runMilestoneVerify2` + `npm
  build` + the browser). This is the held-out scorer.
- **`copyScope`** — copy the node's editable scope to a candidate dir (the minimal owns/readScope set + rebuild).
- **`fixer`** — the context-isolated `claude -p` that edits the candidate copy per defect bucket. Its model
  comes from the **deep** tier of `~/.piflow/model-tiers.json` (the strongest model authors the fix). It is
  **MEASURED, not trusted** — the gate decides whether its edit lands; a no-op or non-improving edit is
  discarded and never re-proposed.
- (optional `mineOpts` — customize the default trace miner's node→milestone map / val·train split.)

**game-omni is the reference binding** — `packages/verify/optimize/` (in the game-omni repo, NOT in
`@piflow/core`): `scope.mjs` (copyScope), `binding-live.mjs` (live oracle+fixer), `binding-dry.mjs` (a
no-model dry binding for wiring tests). Read it before authoring a new product's binding; don't reinvent the shape.

### ANTI-AD-HOC rules (absolute — why first, then the rule)
- **A throwaway script bypasses the gate that exists to stop drift → NEVER write one.** `piflowctl optimize
  --fix` IS the production path; if you reach for `node replay.mjs` or a bespoke score/fix loop, STOP — extend
  the binding instead.
- **A live-edited file has no backup and no gate record → manifests are STAGED, never live-edited.** Read the
  manifest, then run the explicit adopt step; never hand-patch the live file the loop proposed against.
- **A mutable oracle is reward-hackable → the oracle / verify harness / criteria fixture is IMMUTABLE.** A fix
  changes real product behavior so the held-out oracle passes; it NEVER changes the oracle, the verify checks,
  or the criteria fixture to make a candidate look better.
- **Injecting the bar teaches-to-the-test → NEVER inject the criteria fixture into a node prompt.** It is a
  JUDGING reference only; putting it in the prompt voids the clean-room signal the whole loop depends on.

### Self-check (a downstream agent must pass this before claiming the loop ran)
- Name the exact fix command WITH live monitoring: `piflowctl optimize --fix <rundir> --binding <module>
  --watch`.
- Recite the 9-event order `--watch` streams, in order:
  **`triaged → candidate-prepared → fixer-started → fixer-trace* → fixer-done → scored → gated → landed →
  stopped`** (`fixer-trace*` repeats per fixer step).
- Confirm: no `sleep`/`tail -f`/throwaway script anywhere; the live file was never edited (only a staged
  manifest, adopted as a separate backed-up step); the oracle/criteria fixture was untouched.

## Where the material is (read these — do not duplicate them here)
- **`hermes-skill-system`** skill — the canonical capture→route→edit→verify→approve→commit loop + the
  node-validation loop (`references/node-validation-loop.md`). **This is the method; load it first.**
- piflow-init → "The laws" + "Designing a node's I/O" — the piflow precedence + the I/O-map reconciliation rule.
- piflow-start → "Monitor & diagnose live" — the watch/status/telemetry surface the optimize loop's `--watch`
  reuses; the run-monitoring rules (no `sleep`/`tail` polling) apply identically here.
- `docs/design/` (this repo) — the design canon, when an improvement is an architectural change not a wave edit.

## Which loop to reach for
- A spotted flaw / feedback / an architectural change → the **hermes by-hand loop** (capture→route→edit) +
  the precedence above; the human approves before anything lands.
- A FINISHED run with measurable per-node outcomes → the **autonomous optimize loop** (`piflowctl optimize
  [--fix]`) — it mechanizes capture+route and bounds+measures the edit, staging a gate-proven manifest.
Both obey one law: ONE generalizing change, an IMMUTABLE oracle, and the human is the eye on what lands.
