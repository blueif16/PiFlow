# Gate list + additive profiles — decision record & design

Status: accepted (owner-decided); core slice implemented on `feat/additive-gate-profiles`.
Related: `docs/design/node-action-protocol.md` (the `op[]` / `io.checks` lifecycle),
`docs/design/expert-representations-worker-types.md` (Plane 3 — Gates), `workflow/gate-authoring.ts`
(`lowerGate`), `workflow/judge/materialize.ts` (`materializeJudgeNodes`), `optimize/substrate/issues.ts`
(the issue ledger).

## The decision, in one paragraph

A node's gating becomes a **typed additive LIST** — `gates: GateEntry[]` on `node.json` — with three
entry types: `execution` (deterministic — a schema/predicate check OR a shell script; "normally always
holds true"), `agentic` (a judge on a different model), and `hitl` (a human checkpoint). There are **no
on/off switches**: composition is append-only. The TEMPLATE default carries `execution` gates only. A
**PROFILE** is a sparse additive overlay in its own file (`template/profiles/<name>.json`) that names only
the nodes it modifies and lists gate ADDITIONS (typically `agentic`/`hitl`); running with no profile is a
pure-template compile. The old `elidePhases` profile model (which SUBTRACTS nodes) is deprecated on this
path but not removed — a loud warning fires, node retirement happens separately.

---

## (a) The `gates:[]` node surface — new field, lowered onto existing machinery

**Decision: `gates` is a NEW authored field that LOWERS at load time onto the three machineries that
already exist, not a runtime view.** The runner already dispatches `op[]`/`io.checks` (deterministic
gates), a materialized `<id>__judge` node (agentic), and a `checkpoint` (hitl); a runtime `gates` field
would force three new dispatch paths for zero gain. Lowering at load reuses `lowerGate`
(`gate-authoring.ts`, execution/floor → `op[]`), `materializeJudgeNodes` (`judge/materialize.ts`, agentic
→ a real judge node), and the existing `checkpoint` surface (hitl) with **zero new runner code**. The
owner's three types are a thin re-vocabulary over the existing `GateAuthorSpec` union that `lowerGate`
already speaks.

`GateEntry` (discriminated on `type`):

| owner type  | shape                                                             | lowers to (existing carrier)                    |
|-------------|-------------------------------------------------------------------|-------------------------------------------------|
| `execution` | `{ type, check?, path?, param?, advisory?, cmd?, args?, cwd?, policy? }` (exactly one of `check`\|`cmd`) | a `check` → `FloorGate` → `op.gate` folded into `io.checks`; a `cmd` → `ExecutionGate` → `op.run` |
| `agentic`   | `{ type, judgeTier, rubric, threshold?, policy? }`                | the node's `judgeGate` field → `materializeJudgeNodes` inserts `<id>__judge` |
| `hitl`      | `{ type, question, checkpointKind?, choices?, policy? }`          | the node's `checkpoint` field (G5 runtime)      |

The fan-out (`fanoutGates`, `workflow/gate-list.ts`) runs INSIDE `toNodeIntent`, BEFORE
`materializeJudgeNodes`, so a profile-added agentic gate materializes its judge on the same path an
authored `judgeGate` does. Empty list or absent field = no gates (byte-identical to today). At most one
`agentic` and one `hitl` per node (a node has a single `judgeGate`/`checkpoint` slot); a second, or a
collision with a directly-authored `judgeGate`/`checkpoint`, is a **loud** `TemplateError`. `execution`
gates stack freely. Final firing order is the existing cost ladder (execution → agentic → hitl,
`costLadderOrder`): a profile can ADD gates but can never make an agentic gate run before the deterministic
floor.

## (b) Profile file format + loader semantics

**Decision: one JSON file per profile at `template/profiles/<name>.json`, shaped `{ description?, nodes:
{ <nodeId>: GateEntry[] } }`; merge = APPEND to each named node's list.** A per-file overlay keeps the
template's `meta.json` clean, makes a profile a reviewable diff, and matches the owner's "sparse additive
overlay in its own file."

```jsonc
{
  "description": "production — adaptive self-fix + a ship checkpoint",
  "nodes": {
    "w4-execute-m3": [ { "type": "agentic", "judgeTier": "deep", "rubric": "…" } ],
    "gameplay":      [ { "type": "hitl", "question": "Ship this build?" } ]
  }
}
```

- **Merge**: overlay entries are APPENDED after the node's authored `gates[]` (never replace/remove — the
  overlay cannot subtract). Ordering within the merged list is authored-first, then overlay-in-file-order;
  runtime firing order is still the cost ladder.
- **Collision**: two gates of the deterministic kind stack; a second agentic/hitl (or one colliding with a
  directly-authored `judgeGate`/`checkpoint`) is a loud `TemplateError` (the single-slot constraint).
- **Unknown node**: a `nodes` key that is not a template node id is a **loud** `TemplateError` listing the
  known ids — never a silent no-op (a typo in a profile must not quietly gate nothing).
- **File shape**: validated against `profileSchema` (`additionalProperties:false`) through the same ajv the
  template loader uses; a malformed overlay fails closed, exactly like a malformed `node.json`.

## (c) `--profile <name>` resolution + `elidePhases` deprecation

**Resolution order (the single documented precedence):**
1. `template/profiles/<name>.json` exists → the NEW additive overlay, applied at load. **Wins.**
2. else `meta.json.profiles[<name>]` exists → the LEGACY `elidePhases` elision path (unchanged,
   `applyProfileByName`), with a loud one-line deprecation warning.
3. else → a loud unknown-profile `TemplateError` listing both the available overlay files and the legacy
   `meta.json` profile names.

**Deprecation story (do not silently break existing templates):** whenever a template's `meta.json`
carries a `profiles` map, `loadTemplate` emits ONE loud `console.warn` pointing at the migration
(`meta.json profiles.elidePhases is deprecated → move to template/profiles/<name>.json additive
overlays`). The legacy elision still FUNCTIONS this release — `applyProfileByName` and `ProfileSpec` are
untouched, `elidePhases` is not deleted. Node retirement (the thing `elidePhases` was really used for) is a
separate track; profiles must not elide nodes going forward.

**Scope of the core slice on this axis:** the additive overlay is resolved + applied inside
`loadTemplate(dir, { profile })` (where deliverable 2 puts the merge, and where the unit tests drive it);
the deprecation warning fires at load. Wiring the CLI `--profile` flag to prefer the overlay file over the
legacy `applyProfileByName` call (the step-1-wins guard in `run.ts`/`entry.ts`) is a small follow-on noted
in Open Questions — it does not change the load-time contract this slice pins.

## (d) Gate-failure → issue-minting seam (designed; not wired in this slice)

The issue lifecycle (`open → … → resolved`, `optimize/substrate/issues.ts`) is the optimization spine, so
a blocking gate failure should be able to OPEN an issue and let the resume policy re-run from the previous
node with the fix applied (frozen upstream = `--from` semantics).

**The seam (design):**
- **Who opens it:** `postProcessJudgeDrafts` (`optimize/substrate/judge.ts`) is the existing mint — it
  turns an agent/tool-authored DRAFT (`title`/`severity`/`sig`/`body`) into a full `Issue`
  (`status:'open'`, `firstSeen:run`) under `nodes/<node>/issues/`, deduping by
  `computeIssueId(nodeId, sig)`. A gate failure produces a Draft via a pure
  `gateFailureToDraft(nodeId, gate, verdict)`; `postProcessJudgeDrafts` mints or reopens it. No new mint
  path, no status-machine change.
- **The `sig` it gets:** a STABLE `gate:<type>:<nodeId>:<gateKey>` (gateKey = the check kind+path, the
  judge rubric hash, or the checkpoint question). Because `computeIssueId` hashes `(nodeId, sig)` only, a
  re-failure of the SAME gate resolves to the SAME issue file — idempotent open, and a `reopen` if it had
  been `resolved`.
- **What the resume policy needs:** the failing node id (to compute `--from <prevNode>`), the blocking
  artifact/verdict path (body context for the fixer), and the run id (`firstSeen`/`lastSeen`). Resume
  freezes upstream outputs and re-runs from the previous node with the fix applied — the existing `--from`
  contract; the issue's `attempts[]` records each landed fix commit + the verifying run.

**Why design-only here:** minting is a durable write on the out-of-band optimize substrate, not the runner
hot path. Wiring it into `node-lifecycle` would reshape the runner and the substrate status machine —
explicitly out of scope. The seam is specified; a follow-on adds `gateFailureToDraft` + the runner emit
point behind the optimize lane.

## (e) game-omni verify-retirement mapping (new vocabulary; no game-omni edit in this slice)

| game-omni today                        | new vocabulary                                                        | where it lives            |
|----------------------------------------|-----------------------------------------------------------------------|---------------------------|
| verify-1 structural checks on gameplay | `execution` gates (schema/predicate) on the `gameplay` node           | TEMPLATE default          |
| verify-2 core correctness on `w4-execute-mN` | `execution` gate (script/schema check) on `w4-execute-mN`       | TEMPLATE default          |
| adaptive self-fix (judge critiques + reroutes) | `agentic` gate (judge + rerouteTo loop)                       | `production` PROFILE overlay |
| subjective residue (taste / ship-readiness) | `hitl` gate, OR an out-of-band optimize-substrate judge          | `production` PROFILE, or the optimize lane |

So a bare `piflowctl run` on game-omni is verify-1 + verify-2 (execution only); `--profile production`
appends the adaptive-fix judge and the ship checkpoint. Nothing is elided; the difference is purely
additive.

## Open questions (reversible defaults chosen)

1. **CLI `--profile` end-to-end wiring.** The load-time contract is pinned here; the `run.ts`/`entry.ts`
   guard that makes the overlay file win over the legacy `applyProfileByName` call is a follow-on.
   *Default:* keep both paths live (overlay applied in `loadTemplate`; legacy elision still reachable),
   deprecation-warned — reversible, breaks nothing.
2. **Multiple agentic gates per node.** One judge slot per node today. *Default:* a second agentic entry is
   a loud error. Reversible: a future multi-judge scheme would namespace `<id>__judge-<k>`.
3. **`gateFailureToDraft` severity mapping.** *Default:* map the gate's `policy.onFail` (`block`→`high`,
   `warn`→`low`) when the seam is wired; reversible in the pure draft builder.
