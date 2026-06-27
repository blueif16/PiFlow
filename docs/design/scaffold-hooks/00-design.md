# Scaffold-hooks — design & decision record

**Goal (user, this session).** Give the CLI scaffolder (`piflowctl add-node`) a convenient, robust way to
"build up" a node's **hooks** so the in-place PORT use case (lesson-build et al.) is fully flag-drivable —
then restructure the `piflow-init` skill with proper per-family **references** instead of one crammed field.

This file is the consolidated decision record. The three research briefs feed it:
- `01-sdk-hooks-inventory.md` — authoritative shapes of every hook family + merge ops (the FACTS to emit).
- `02-node-action-forward-compat.md` — op[] vs hooks (PENDING re-run; superseded below by the main-thread trace).
- `03-scaffolder-and-skill-recon.md` — exact edit sites, the clobber verdict, the reference structure.

---

## 1. Ground truth — `op[]` vs `hooks` (traced from primary source, 2026-06-27)

`node-action-protocol.md` is **AS-BUILT / SHIPPED** (line 96; G11/G12/G13 landed, M0–M7 green). The unified
**`op[]`** envelope is the canonical format; the deprecated keys (`inject`/`hooks`/`checks`/`policy`) are
`@deprecated` **aliases the loader lowers into `op[]`** via `lowerToOps` (`lower.ts:44`), called once at
`loader.ts:120`. **The skill's standing law — "op[] is M5, NOT loadable, the loader will REJECT it; do NOT
emit op[] yet" (`SKILL.md` ~219-223) — is STALE/WRONG.**

But there is a **runtime-parity boundary** for a *directly-authored* `op[]`, decisive for what we emit:

| authoring | `node.ops` (derive intent) | `node.op` (unified) | derive families run? | gate/run/action run? |
|---|---|---|---|---|
| **`hooks` block** | populated (`loader.ts:116` `toNodeOps(n.def.hooks)`, attached `:171`) | populated (lowered, `:174`) | **YES** (executors read `node.ops?.{seed,project,merge,promote}` — `runner.ts:999/1048/1069/1161`) | YES |
| **direct `op[]`** | **absent** (`toNodeOps` reads only `n.def.hooks`) | populated verbatim (`lower.ts:45`) | **NO** — except `projectRegistry` (`runner.ts:1554`); seed/project/merge/promote silently no-op | YES (`gate` `1009/1369`, `run` `1078/1574`, `action` lowers at compile) |

**Decision driver:** emitting raw `op[]` for `seed`/`project`/`merge`/`promote` would pass `extract` and then
**silently NO-OP at runtime** (derive executes only off `node.ops`, which the loader fills only from `hooks`).
That is the precise green-dry-run / dead-at-launch trap the porter feedback (`0002`) is built around.

---

## 2. DECISION (revised, user directive 2026-06-27) — FIX `op[]` parity first, then scaffold `op[]` directly

The earlier "emit `hooks`, graduate later" plan is **REJECTED**: a silent runtime no-op is a bug to FIX, not
tolerate, and building the scaffolder on `hooks` would force a full rewrite at graduation. The order is inverted:

**STEP 0 (PREREQUISITE — engine fix, before any scaffolding).** Close the §1 parity boundary so a
directly-authored `op[]`'s derive families (`seed`/`project`/`merge`/`promote`/`registryProject`) EXECUTE with
byte-identical runtime effect to the `hooks` twin. Recommended seam (smallest risk, full executor reuse): in
the loader's `toNodeIntent`, when a node authored `op[]` (and no `hooks`), DERIVE `node.ops` from the `op[]`
`transform` entries — the symmetric inverse of `lowerToOps` (`lower.ts:44`) — so the existing, tested POST-derive
executors (`runner.ts:999/1048/1069/1161`) run unchanged. Guard: only back-fill when `node.ops` is otherwise
absent (a node authoring BOTH stays single-sourced, no double-run). ADDITIVE: every existing `hooks`-authored
template runs byte-identically (Constraint #2). Oracle: a PARITY test — for each of the 5 derive families, an
`op[]`-authored node ≡ its `hooks` twin at runtime. This is the "new standard": `op[]` is the single working
canonical format.

**STEP 1+ (scaffolder).** `buildNode` emits **`op[]`** entries directly (NOT `hooks`). `hooks` remains a
supported legacy alias the loader still lowers — but it is NOT what we scaffold. The CLI flags are *semantic*
(`--seed`, `--promote`, `--merge-run`, …) and map onto `op[]` entries (`{when, writes, reads, transform:{…}}`).
Because the basis is robust, we never rewrite the scaffolder.

---

## 3. The scaffolder hook API (flags → emitted `op[]`)

Semantic flags, each emitting ONE `op[]` entry (`{when, writes?, reads?, transform:{kind,…}}`). Per
`01-inventory`, only `merge`'s `run` op has a flag-shaped body; `fold`/`concat`/`reconcile` and the structured
project bodies are too rich for a flag value → **hand-authored** (the author owns those, like prose).

| flag | repeatable | emits (one `op` entry) |
|---|---|---|
| `--seed to=from` | yes | `{when:'pre', writes:[to], transform:{kind:'seed', from}}` |
| `--promote from=to` | yes | `{when:'post', transform:{kind:'promote', from, to, reducer?}}`; `from` is `@return:<field>` or `<file>:<field>`; `--promote-merge to=set\|append\|deepMerge` sets `reducer` |
| `--project to=from[,from2]` | yes | `{when:'post', writes:[to], reads:[…from], transform:{kind:'project', from}}` |
| `--merge-run cmd[:arg,arg][@cwd]` | yes | `{when:'post', run:{cmd,args,cwd}}` (the authorable `run` body — already first-class on `node.op`, `runner.ts:1574`) |
| `--registry-project source=…,mapRef=…,key=…` | no | `{when:'post', transform:{kind:'projectRegistry', source, mapRef, key}}` |

Placement: `node.op` is assembled in `buildNode` after `contract`. Add `parseSeed/Promote/Project/MergeRun/
RegistryProject` beside `parseMcp`/`parseCheck`, reusing the existing repeatable-list parser. Grammar gotchas
to honor (from `01-inventory`): the `op` entry is `additionalProperties:false` with EXACTLY ONE body key;
`promote.from` is its own `<file>:<field>` / `@return:<field>` grammar (NOT a `{{…}}` token) and an undefined
source THROWS; field-name flip — the promote reducer is `transform.reducer` here (the `hooks` alias spelled it
`merge`). STEP 0 must land first, or these `op[]`-emitted derives won't execute.

**Clobber:** `scaffoldAddNode` overwrites `node.json` from flags (deterministic contract, `scaffold.ts:166`).
The hand-authored rich ops (merge.fold, etc.) follow the same you-own-prose rule: once hand-authored on a node,
stop re-running `add-node` on it. No merge mode (it would break reproducibility).

**Clobber/merge mode: NONE.** `scaffoldAddNode` does an unconditional `fs.writeFile` (`scaffold.ts:166`) —
overwrite-from-flags is the deterministic CONTRACT (header `:4-9`, test `scaffold.test.ts:97-108`). Flag-emitted
hooks regenerate cleanly. The hand-authored structured ops (merge.fold, etc.) are governed by a documented
**graduation rule**: once you hand-author a structured op on a node, stop re-running `add-node` on it (mirrors
the existing CLI-owns-config / you-own-prose split). A merge mode would break reproducibility — rejected.

---

## 4. Skill + references structure (P1+P3, after P2)

Mirror the existing `agent-presets/` split (one file per unit + a README index) — honors the user's "different
references per hook, don't cram the field" and respects the 398-line `SKILL.md` budget:

```
.claude/skills/piflow-init/references/hooks/
  README.md            # lifecycle (PRE seed→gate / POST project→merge→promote→registryProject→gate),
                       # the hooks→op[] alias note, and the family→flag table
  seed.md  promote.md  project.md  merge.md  registry-project.md   # one per family: shape · flag · example · gotchas
```

`SKILL.md` changes (P1+P3): (a) make `piflowctl new`/`add-node`/`extract` the canonical config path; (b) replace
the stale stand-up steps 4-6 (`PI_RUNNER_WORKFLOW=.js`, `node pi-runner/sdk/run.mjs`) with the `piflow`/`piflowctl`
bin gates; (c) correct the `op[]` law (loadable; emit `hooks` for derive; op[] is the graduation target);
(d) point the hooks section at `references/hooks/`.

---

## 5. Test-first plan (P2)

Harness: **vitest**, `packages/cli/test/scaffold.test.ts`; oracle = the **real `loadTemplate`** (no mock).
Red mutation: a node with a `--promote` that the emitter DROPS → its downstream `{{state.X}}` has no promoting
upstream → `loadTemplate`'s `checkChannels` throws `dangling channel`. Write that test first (it must FAIL when
`buildNode` ignores the hook flags), then implement `buildNode`'s hooks assembly + the parsers until green.
