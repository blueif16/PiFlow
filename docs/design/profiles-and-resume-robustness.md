# Profiles (product-declared run modes) + resume robustness

_Design spec — 2026-06-24. Driver: a real failure on game-omni P06 (a `--from` resume that needed to skip
verify nodes silently no-op'd with an empty log + exit 0). The fix is two GENERIC, vocab-free SDK
capabilities + a TEMPLATE-level declaration that owns the product vocab._

## The principle (non-negotiable)

**`production` / `companion` / `verify` are the PRODUCT's (game-omni's) vocabulary, NOT the SDK's.** The same
way the de-game-ified core carries no game noun, `@piflow/core` must carry no "companion"/"verify" literal.
The SDK gains ONE generic primitive — **node elision by a declared predicate** — and the product TEMPLATE
declares the named modes as DATA. This mirrors the pre-SDK pattern (the `.js` `args.mode==='companion'` +
`if(!COMPANION)` branch lived in the WORKFLOW, never the engine); we are porting that product toggle into the
template format, not inventing an engine mode.

## What broke (the grounding case)

game-omni's DAG wires verify nodes INTO the dependency chain as gates:
`w4-execute-m1 → verify-2-m1 → w4-execute-m2 → verify-2-m2 → w4-execute-m3` (each milestone's execute
`deps` on the PRIOR milestone's verify — "don't build M2 until M1 is validated"). So in companion bring-up,
after windowing verify nodes out by hand (`--until w4-execute-m1`), a `--from w4-execute-m2` resume blocked:
the preflight (`runner.ts` ~877–917) stats EVERY earlier stage's artifacts, found `verify-2-m1`'s report
missing, and **returned `ok:false` while printing nothing** (empty log, exit 0). The only signal was a
separate `piflowctl status` showing `__resume__ blocked`.

## The three changes

### 1. Resume preflight is observable — DONE (Phase 1, commit `df5a1fc`)
`packages/cli/src/run.ts` — `runRunCli` now inspects the returned `RunResult.status`; on `done && ok===false`
it prints each `error`/`blocked` node + its `issues` (incl. the synthetic `__resume__`) to stderr and exits
non-zero. Extracted as the pure, exported `runFailureReport(status, runDir)` (unit-tested in
`packages/cli/test/run.test.ts` block D). GENERIC — no product vocab. This alone kills the silent no-op.

### 2. Profile = a node-elision predicate (SDK generic — Phase 2, TODO)
A run compiles against an active PROFILE. A profile names a GENERIC predicate over node metadata that already
exists (`phase`, and a future optional `tags`/`kind`) marking nodes to ELIDE. `compile()` removes the matched
nodes and **rewires deps transitively**: for every dependent `D` of an elided node `N`, replace `N` in
`D.deps` with `N.deps` (transitive bypass). So eliding `verify-2-m1` makes `w4-execute-m2.deps` become
`["w4-execute-m1"]` — a coherent, gateless DAG. The SDK knows only "elide nodes matching this predicate";
it never hears "verify."
- Touch points: `packages/core` compile (the elision+rewire transform over `WorkflowSpec`/`Workflow`);
  `RunOptions.profile?: string` (resolve a template-declared profile → the predicate); `packages/cli` `run.ts`
  `--profile <name>` flag threaded to `runFromTemplate`.
- The resume preflight (#1's runner site) then naturally works: an elided node is not in the active DAG, not
  upstream, not required. (Independently, the preflight SHOULD also only require nodes that are TRANSITIVE
  `deps` of the selected window, not every earlier stage — a generic dep-correctness hardening worth doing in
  the same pass.)

### 3. The TEMPLATE declares the modes (product vocab lives here — Phase 3, TODO)
`docs/design/template-format.md` gains a `profiles` block; game-omni's `.piflow/game-omni/template/meta.json`:
```json
"profiles": {
  "production": {},
  "companion": { "elidePhases": ["verify-1", "verify-2"] }
},
"defaultProfile": "production"
```
game-omni owns `production`/`companion`/`verify` — as data, in its own template. A new product declares its
own modes the same way; the SDK reads the named profile's generic filter.

## Skill guidance (Phase 4, TODO)
- **piflow-init**: the recipe for declaring USEFUL profiles when authoring a workflow — a full `production`
  flow with gates + a dev/`companion` flow that elides them; tag nodes by `phase`/`kind` so a profile can
  select them. (This supersedes the existing "Companion Mode" `.js` `if(!COMPANION)` section — same concept,
  now template DATA + a generic SDK primitive.)
- **piflow-start**: run with `--profile <name>` (values resolve from the template, never a memorized flag) +
  the standing discipline rule: **use `piflowctl status`/`logs`/`watch`/`inspect` for monitoring/debugging; never
  hand-parse `run.json` with `node -e`** (a custom one-off that HID this very block — `piflowctl status` surfaced
  it instantly).

## Proof (Phase 5, TODO)
Re-run game-omni P06 M2/M3 with `--profile companion` → verify nodes elided, `w4-execute-m2` depends on
`w4-execute-m1`, builds clean, NO resume block → the validated full game. The same case that exposed every gap.

## Status
- [x] Phase 1 — preflight observability (`df5a1fc`)
- [ ] Phase 2 — SDK profile/elision + dep-correct preflight
- [ ] Phase 3 — template-format `profiles` + game-omni meta.json
- [ ] Phase 4 — piflow-init / piflow-start guidance
- [ ] Phase 5 — prove on P06 `--profile companion`
