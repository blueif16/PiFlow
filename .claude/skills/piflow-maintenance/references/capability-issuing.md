# The CAPABILITY-ISSUING pattern — grow the fleet's verified capabilities mid-run

**What it is.** A standard node-role pattern that lets a workflow ACQUIRE new logic as a *registered,
battery-verified capability* instead of an executor improvising it in-head. One dedicated node (the
ISSUER) authors new capability modules on demand; every other node consumes them through the SAME
registry the built-ins live in. Use it whenever a producing workflow keeps meeting requirements its
executors weren't built for — the alternative (an executor "figuring it out" at execute time) is the
canonical mega-think / false-green source.

**Reference implementation:** game-omni (`~/Desktop/game-omni`), the traversal/behavior capability
system. Every file named below exists there; copy-adapt them rather than re-deriving. This doc is the
PORTABLE contract; the scripts are product-specific in their leg formats but structurally reusable.

## The invariant (the whole pattern in four lines)
1. **Issued ≡ built-in.** After the issuer runs, NO downstream consumer can tell an issued capability
   from a shipped one — one id, one registry surface, one consumption path. Never two sets of logic.
2. **Prose flows declare→issue ONLY.** The declarer's prose gap-spec is the issuer's input; nothing
   downstream of the issuer ever consumes prose as an implementation source.
3. **Registered = files-in-dir + battery PASS.** The dirs ARE the registry; a fail-closed battery is
   the only door in. Every catalog/manifest/tool view derives from the files — never hand-edited.
4. **Executors WIRE, never author.** A reference that resolves to no registered capability is an
   upstream defect → the executor HALTs (blocked submit), mechanically — never a rewrite-in-place.

## The four node roles (each maps to standard node-config surfaces — see SKILL §2/§3/§9)
| Role | Node shape | Standard surfaces used |
|---|---|---|
| **DECLARER** (game-omni: `w1-design`) | designs freely; for each mechanic beyond the registry, declares a GAP: proposed kebab-case id · intent + player-facing moment · interaction (input→motion→outcome) · the params downstream will bind · why nothing registered covers it. The prose spec IS the issuance prompt. | a **script tool** (`capability_lookup`) that surfaces the LIVE registry (ids · legs · params contract) merged with the static catalog, so the declarer diffs need vs registered instead of guessing |
| **ISSUER** (`capability-issuer`) | OWN optional stage right after the declarer. Authors the FULL capability per gap — every leg — proves it with the battery, then **double-registers**: run-local (this run consumes) + global template dirs (all future runs inherit it as a built-in). Zero gaps = empty-manifest no-op, exit 0 — cheap by design, keep it in the default profile. | `owns` = run-scoped issue dirs **+ the global template dirs**; a **blocking post-op** (`hooks.merge.ops` + `expect`, `onFailure:block`) regenerates the manifest THROUGH the battery fail-closed; a `capability_registry` script tool (list · contract · validate) |
| **PROVER** (`gameplay`/HARDEN) | binds every capability-backed moment to a REGISTERED id (copied verbatim — never re-cased/themed) with params proved by the capability's own ruler BEFORE writing geometry; an unproved reach never enters the artifact. | the family **ruler subcommands** on the calc script tool; a **refs check** as one more `merge.ops` gate: every `$custom:<id>`/family ref must resolve to the registered set, case-divergence fails WITH the closest-id suggestion |
| **WIRER** (`w4-execute-*`) | WIRE-or-HALT, one observable predicate: the capability's runtime file exists (built-in or issued) → bind the declared params and register it through the product's custom seam, never opening the file; not found → NO-INVENTION HALT (record the gap, `submit_result` blocked). The author branch must NOT exist. | the executor prompt contract + the artifact-existence check; the refs gate upstream makes "unresolvable" an upstream defect by construction |

## The capability unit (adapt the legs to your product; keep the bar)
ONE kebab-case id owns every leg. game-omni's legs: a MATH leg (`tools/traversals/<id>.mjs` — a pure
reach model the gates/rulers compute from) and a RUNTIME leg (`src/behaviors/capabilities/<id>.behavior.ts`
— self-registers at module scope through the product's custom-registry seam). Your product's legs will
differ; the NON-NEGOTIABLES are:
- **An exemplar file per leg whose header IS the format spec** the issuer imitates (game-omni:
  `rope-swing.mjs` + `rope-swing.behavior.ts`). New format rules go in the exemplar header, nowhere else.
- **Co-located tests per leg**, runnable standalone; the battery spawns them.
- **Verified numbers only:** any constant the leg needs either derives from the declared params/the
  math model or is a NAMED documented tunable — a bare magic number fails review.
- **A registration battery** (game-omni: `validate-capability.mjs` + `manifest.mjs --validate`) that
  checks, per leg: file naming ↔ id equality · the registration call is module-scope and its id string
  === the capability id · required exports · co-located tests PASS · the import barrel lists it. Any
  failure blocks the issuer node with a NAMED error.
- **An auto-coverage meta-test** that discovers every built-in capability and runs it through the same
  battery with zero test edits per addition.

## Wiring pitfalls (paid-for lessons — check these before your first live run)
- **Jail write-globs:** `owns` supports a TRAILING `/**` only; a mid-path `**`
  (`templates/modules/**/tools/**`) becomes a literal `**` dir in the OS jail and the write EPERMs.
  Scope dynamic segments with a state token instead (`{{WORKSPACE}}/templates/modules/{{state.archetype}}/…`)
  — promoted by an upstream node before the issuer runs.
- **Tests don't ship into the product build:** if the scaffold seeds source wholesale, PRUNE the
  capability test files from the product tree at the seed op (they import across roots the build
  doesn't carry) and regenerate the import barrel deterministically (sorted, byte-stable when nothing
  was issued). game-omni: `seed-capabilities.mjs` as a `w2-scaffold` merge op.
- **Same-bytes double-registration:** the global copy is the SAME validated bytes, copied post-validate
  only — never re-authored, never pre-validate.
- **Rule in prompt, incident in memory:** node prompts carry the positive contract only; failure
  history lives in the node's `memory.md` for the optimizer, never in the runtime prompt.

## Porting checklist (stand it up in a NEW product)
1. Define the capability unit: the legs your product needs, their file conventions, the two dir pairs
   (built-in global + run-issued local).
2. Author ONE built-in exemplar per leg, header = the format contract (this is the single highest-value
   artifact — the issuer imitates it).
3. Copy-adapt the battery + manifest scripts from game-omni (`packages/skills/harden-blueprint/gen/
   validate-capability.mjs`, `packages/skills/issue-capability/gen/{manifest,seed-capabilities}.mjs`)
   and their tests; keep fail-closed semantics and the shared check CLI contract (`--source
   --report-out --strict --json`, `verdict`, strict exit 1).
4. Add the ISSUER node (own stage, optional): prompt from game-omni's `capability-issuer/prompt.md`
   (full-stack recipe · validate loop · double-register · zero-gap termination ritual), `owns` +
   blocking post-op per the table above.
5. Give the DECLARER the lookup tool + the 5-field gap-spec contract; give the PROVER the ruler +
   the refs gate; flip the WIRER to wire-or-HALT.
6. Prove it in order: (a) zero-gap run → issuer no-ops, everything green; (b) a prompt requiring an
   uncovered capability → issuer authors the full stack, battery green, wirer wires with zero authored
   logic; (c) confirm the double-registered capability appears as a built-in to the NEXT run's declarer.
