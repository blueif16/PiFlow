# D10 applied — the game-omni state map (channels · per-node reads/owns · the parked-gap fixes)

> The worked example that turns **D10** (state stores VALUES + HANDLES, never large CONTENT; reads are per-node
> DECLARED keys — see `sdk-canonical-build-plan.md`) into game-omni's concrete wiring. It is ALSO the
> implementation plan for the three blockers to a full run: **P2** (gameplay `seedContracts`), **P3** (W2 genre
> `union`/projections), **P4** (companion-mode). Source of truth read for this map: the migrated template
> `.piflow/game-omni/template/` (the D8 node defs) as of 2026-06-24.

## Where game-omni stands today (the gap D10 closes)

The migrated template uses ONE state channel — `archetype` (w0 `promote`s it `set`; gameplay/w1/w2 read
`{{state.archetype}}` in their `seed`s). Everything else flows as FILES at hardcoded `{{RUN}}/spec/…` paths
named in each node's `readScope` + prompt. That is the filesystem-as-contract model D10 demotes: the files stay,
but they become *materialized views of handles in state*, and each node declares the KEYS it reads instead of
being pointed at raw paths. Two derive families never made the migration (the parked gaps); under D10 they are
not bespoke hooks — they are **pure derives over the `blueprint` handle + `${WORKSPACE}` config**.

## The channel set

VALUES are small and injected inline; HANDLES are `{ path, hash, status }` to a file under `${RUN}` (D10
reference-not-content); CONFIG is immutable `${WORKSPACE}` input, NOT a channel (D10 config-is-context).

| Channel | Kind | Produced by | Notes |
|---|---|---|---|
| `archetype` | value | w0-classify | routes every `{{state.archetype}}` seed + read-scope narrowing (exists today) |
| `mode` | value | run input (`--arg mode`) | `production` \| `companion`; selects the DAG at instantiate (P4) — a STATIC branch, never a runtime route (D6) |
| `milestones` | value (id list) | w1-design (gdd tail) | the fan-out count for w4/verify-2 |
| `classification` | handle | w0-classify | → `spec/classification.json` |
| `gdd` | handle | w1-design | → `spec/gdd.md` |
| `blueprint` | handle | gameplay | → `spec/blueprint.json` — THE load-bearing handle; producers fold sections into it |
| `contracts` | value (small obj) | **derive** (P2) | `{shell,guidance,sound,asset}` bind-slices; each producer reads ONLY its key |
| `fragments` | handle list (`append`) | shell ∥ guidance ∥ sound | each lane appends `{section, path}`; the assembly step consumes (parallel-merge) |
| `assetManifest` / `modelManifest` | handle | asset / model `run` | → `public/assets/**` (P1 gen pipeline writes the bytes) |
| `designVerdict` | value | verify-1-design | `DESIGN_PASSED` \| `FAILED` (today a file field; lift to a channel) |
| `gameConfig` / `index` / `runtimeData` | handle | **derive** (P3) | derived from `blueprint` + the genre record's `projections` |
| `scaffold` | handle | w2-scaffold | the running project tree (`src/`, `index.html`, …) |
| `qaVerdict.M<k>` | value | verify-2-m`<k>` | per-milestone `VALIDATION_PASSED` \| `FAILED` |

CONFIG (never a channel): `templates/genres.json`, `templates/modules/<archetype>/**`, `.agents/node-catalog.json`,
the scaffold templates, the `*.schema.json`. Injected into the derives as `(handle-content, config) → output`.

## Per-node map (reads · owns/writes · promote · derive)

`reads` = the declared state keys delivered to the node (small value → inline; handle → the node reads the file,
or just its declared SECTION). `derive` = the runner-run mechanical POST step (a pure function of a frozen handle
+ config — never the LLM).

| Node | reads | owns / writes (files) | promote → channel | derive (runner) |
|---|---|---|---|---|
| **w0-classify** | `arg.prompt` | `spec/classification.json` | `classification` (handle), `archetype` (value) | — |
| **w1-design** | `classification`, `archetype` | `spec/gdd.md` | `gdd` (handle), `milestones` (value) | — |
| **gameplay** (Harden) | `gdd`, `archetype` | `spec/blueprint.json` | `blueprint` (handle) | **P2: `deriveContracts`** → `contracts` |
| **shell** | `contracts.shell` | `spec/shell.fragment.json` | append `fragments` | — |
| **guidance** | `contracts.guidance` | `spec/guidance.fragment.json` | append `fragments` | — |
| **sound** | `contracts.sound` (+ sfx-bank config) | `spec/sound.fragment.json` | append `fragments` | — |
| **asset** | `contracts.asset`, `blueprint#meta.artStyle` | `asset-prompts.json` | `assetManifest` (handle) | `run` gen (P1) → `public/assets/**` |
| **model** | `contracts.asset` (3D slots) | `model-queries.json` | `modelManifest` (handle) | `run` fetch (P1) → `public/assets/models/**` |
| **(assembly)** | `fragments`, `blueprint` | `spec/blueprint.json` (sections) | `blueprint` (rev) | **fold all fragments → `blueprint.{shell,guidance,sound}`** |
| **verify-1-design** | `blueprint` | `spec/DESIGN_REVIEW.md` | `designVerdict` (value) | — (pure verify; skipped if `mode=companion`) |
| **w2-scaffold** | `blueprint`, `archetype`, `assetManifest`, `modelManifest` | `src/**`, `index.json`, `STRUCTURE.md` | `scaffold`, `gameConfig`, `index` (handles) | **P3: `deriveProjections`** (copy/merge/union from genres.json) + the existing concat/reconcile/event-gate |
| **w4-execute-m`<k>`** | `blueprint`, `scaffold` | `src/**`, `MEMORY.w4-M<k>.md` | `build.M<k>` (handle) | `run` emit-side event-wiring gate |
| **verify-2-m`<k>`** | `build.M<k>`, `blueprint` | `verify/report.M<k>.json` | `qaVerdict.M<k>` (value) | — (pure verify; skipped if `mode=companion`) |

**The strongest D10 illustration is the producer row.** Today a chrome producer would read the whole
`blueprint.json`; under D10 it declares `reads: [contracts.shell]` and is handed a small inline slice — its
`owns`, `bind` handles, `demand`, `tone`. The producer never sees the rest of the blueprint. That slice IS the
curated read-key; it is also exactly what `deriveContracts` (P2) produces.

## P2 — `seedContracts` as a derive (not a parked hook)

`gameplay`'s missing hook becomes a POST derive on the `blueprint` handle:

```
deriveContracts(blueprint, nodeCatalog) -> contracts          # contracts = a small VALUE channel
  for each chrome node-TYPE in nodeCatalog.nodes:
    contracts[node] = resolveNodeContract(blueprint, entry, nodeCatalog.observables)   # { owns, bind, demand, tone, ... }
```

- INPUT: the frozen `blueprint` handle (read once) + the `.agents/node-catalog.json` **config** (`${WORKSPACE}`,
  injected — never a channel).
- OUTPUT: the `contracts` channel (small enough to be an inline VALUE, keyed by node). Each producer reads ONLY
  `contracts.<self>`.
- ZERO archetype literals — every value is drilled from this run's blueprint; the catalog supplies the SHAPE.
- This is the byte-faithful behavior of the recovered `resolveNodeContract` family, RE-HOMED as a derive over a
  channel rather than a base64 `DRIVER-SEED-CONTRACT` marker that mutates the file in place.

## P3 — W2 `union`/projections as a derive

`w2-scaffold`'s dropped `project` hook becomes a config-driven derive on the `blueprint` handle:

```
deriveProjections(blueprint, genreRecord.projections) -> { gameConfig.json, index.json, world.json }
  copy   -> drill a blueprint subtree verbatim                  (runtimeData)
  merge  -> overwrite seeded config .value + top-level literals  (gameConfig — folds shell/guidance/sound in)
  union  -> dedup slot rows from assetList ∪ entities[].assetSlot (index — the Preloader's asset manifest)
```

- INPUT: the frozen `blueprint` handle + the genre record's `projections` map resolved from `templates/genres.json`
  by `archetype` (the **config**; exact-id then archetype-prefix fallback).
- OUTPUT: `gameConfig` / `index` / `runtimeData` handles. The `union` op is the load-bearing one — a thin/wrong
  `index.json` is the "every entity renders as a colored rect" failure (the Preloader only loads `generated`
  rows). Today the W2 LLM hand-writes these non-deterministically; the derive makes them deterministic, and the
  existing `reconcile` ops then patch in the asset/model manifest `status`/`path` (order: derive → reconcile).
- CORE needs: a `union` op kind in the project executor + a `runProjection(genreRecord.projections, …)` reader
  that resolves the map from `genres.json` (core's `project.ts` ports copy/assemble/merge but its SCOPE NOTE
  drops `union`, and there is no genre-record reader). Both already exist as tested `.mjs` to translate from.

## The parallel-merge fix (fold race → fragments + append + assembly)

Today shell/guidance/sound EACH carry a `merge.fold` post-hook that read-modify-writes `spec/blueprint.json`.
In the parallel `producers` phase that is three concurrent read-modify-writes into one file — a lost-update race
regardless of scheduler luck. D10's canonical shape removes it by construction:

1. each lane writes its own disjoint `*.fragment.json` (already does) and `append`s `{section, path}` to the
   `fragments` channel (barrier-serialized, conflict-guarded by D6 `barrierMerge`);
2. a single **assembly** step after the barrier folds every fragment into `blueprint.{shell,guidance,sound}`
   and re-emits the `blueprint` handle.

The merge discipline lives on the `fragments` handle channel (checkpointed); the bytes stay in fragment files.
This is the generic fan-out → fragment → append → fan-in pattern from D10, not a per-lane hook.

## P4 — companion mode as a static DAG selection

`mode` is a run-input VALUE resolved at template instantiation (before any node runs), selecting the DAG:
`companion` drops `verify-1-design` + every `verify-2-m<k>` (both PURE — they create nothing the build binds
to, so dropping is safe; the orchestrator + human are the verifier). This is a STATIC input branch, never a
result-dependent route (D6: state drives values, never routing) — so the realized DAG stays extractor-visible
per mode.

## Implementation deltas (what core needs)

| Gap | Core delta | Oracle |
|---|---|---|
| **P2** | a `deriveContracts` op + a `contracts` value channel; producers gain `reads: [contracts.<self>]` | port `pi-runner/hooks/test/seed-contract.test.mjs` |
| **P3** | a `union` op kind in the project executor + a `runProjection` genre-record reader | port `pi-runner/hooks/test/project.test.mjs` |
| **parallel merge** | move the 3 producer `fold`s into one post-barrier `assembly` step over the `fragments` channel | a new test: 3 fragments → merged blueprint, order-independent |
| **P4** | a `mode` input channel + instantiate-time DAG filter dropping the verify phase | DAG-extraction test per mode |
| **P1** | infra only (gen scripts + venv + keys) — unchanged by D10; the `run` derives already faithful | the real prompt→asset E2E |

All four are now expressible in the D10 vocabulary — derives over the `blueprint` handle + `${WORKSPACE}` config,
and channels with the right reducer — rather than bespoke filesystem hooks. The implementation order (cheapest
first) is unchanged: P4 → P2/P3 → run with verify off → P1.
