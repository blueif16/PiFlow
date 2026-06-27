# `op[]`-only Unification — Migration Plan (op ⊖ ops)

> **Audience:** the fleet coordinator + the executor agents who will land the units below.
> **Status:** DESIGN / READY-TO-DECOMPOSE. Source-mapped against the worktree
> `/.claude/worktrees/scaffold-hooks` on 2026-06-27. Every claim carries a `file:line`.
> **Scope fence:** this doc plans the runtime/validator switch from the legacy `node.ops` rep to the
> unified `node.op` (`OpSpec[]`) rep. It does NOT touch the scaffolder, the authoring schema, or any
> deprecated authoring KEY. No source was edited to write this.

---

## 1. Goal & invariant

**Goal.** Make `node.op` (`OpSpec[]`, `types.ts:87`/`:117`) the SOLE runtime representation of a node's
side-effects. Retire `node.ops` (`NodeOps`, `types.ts:61`/`:198`) and the bridging code
(`opsToNodeOps`, `lower.ts:97`; the loader's `intent.ops` back-fill, `loader.ts:171`/`:182`; `toNodeOps`,
`loader.ts:96`). Every consumer — the 5 derive executors across BOTH runner lanes, the codec, the channel
validator, the journal envelope hash, the fusion judge clone — reads `op[]`.

**HARD INVARIANT — ADDITIVE / byte-identical.** The `hooks` / `checks` / `inject` / `policy` AUTHORING
keys (`TemplateNode`, `types.ts:38,57,58,59,67`) STAY supported. The loader KEEPS lowering them into
`op[]` (`lowerToOps`, `lower.ts:44`, called at `loader.ts:120`). Only the INTERNAL/runtime rep unifies.
Every existing template must load + run byte-identically; the migration is invisible to authors. This
invariant is the per-unit gate: each unit lands behind a parity oracle (a `hooks`-authored template and
its `op[]`-authored twin produce a byte-identical compiled spec AND byte-identical run), and the
`node.ops`-retirement unit is ORDERED LAST — after every read has been switched to `op[]`.

---

## 2. Current-state inventory (the load-bearing artifact)

### 2.0 Greps run (the evidence floor)

```
$ grep -rn "node\.ops"  packages/core/src --include='*.ts'        # 24 hits (incl. comments)
$ grep -rn "node\.op\b" packages/core/src --include='*.ts' \
    | grep -v "node\.ops"                                          # 10 hits (incl. comments)
$ grep -rn "def\.hooks" packages/core/src --include='*.ts'        # 9 hits (lower.ts ×6, loader ×1, checks ×2)
$ grep -rn "\.ops\b|\.op\b" packages/core/src --include='*.ts'    # sweep → also surfaced fusion/expand.ts:184 (x.ops carry)
$ grep -rn "node\.ops" packages/core/src/runner/journal.ts        # journal.ts:111 (envelope hash)
```

**Legacy READ/CARRY sites that drive a runtime effect (the migration target set): 17.** Of these,
**5 are in the prompt's "known sites" list verbatim, 12 are confirmed or newly-found** (the codec dual-read,
the journal envelope hash, and the fusion judge carry being the three NOT in the known-sites list — see
§2.3 ⚠ Divergences). Pure-comment matches and unrelated `.ops`/`.op` (e.g. `merged.ops`, `op.op`
projection-name discriminator, `spec.ops` inside `runMerge`) are excluded — they are the executors'
internal shapes, not reads of the node rep.

### 2.1 The derive executors — BOTH lanes (the core of the migration)

Two lanes execute the SAME derive families with the SAME executors: the pi-node lane `runNode`
(`runner.ts:1214`) and the no-pi lane `runProgrammatic` (`runner.ts:967`). Every derive site reads
`node.ops?.{…}`; every site must read the corresponding `op[]` `transform` body instead.

| # | Site (file:line) | reads today | should read post-migration | lane |
|---|---|---|---|---|
| 1 | `runner.ts:999` (`for seed of node.ops?.seed`) | `node.ops.seed[]` `{to,from}` | `node.op` where `o.transform.kind==='seed'` → adapt to `{to:o.writes[0], from:transform.from}` | programmatic |
| 2 | `runner.ts:1356` (`for seed of node.ops?.seed`) | `node.ops.seed[]` | same seed adapter from `op[]` | pi |
| 3 | `runner.ts:1048` (`for rawOp of node.ops?.project`) | `node.ops.project[]` (loose op obj) | `node.op` where `transform.kind==='project'` → the loose op obj `applyProjectionOp` consumes | programmatic |
| 4 | `runner.ts:1537` (`for rawOp of node.ops?.project`) | `node.ops.project[]` | same project adapter from `op[]` | pi |
| 5 | `runner.ts:1056` (`if node.ops?.registryProject`) | `node.ops.registryProject` | `node.op` where `transform.kind==='projectRegistry'` (the `else` at `:1060` ALREADY does this) | programmatic |
| 6 | `runner.ts:1545` (`if node.ops?.registryProject`) | `node.ops.registryProject` | same; the `else` at `:1554` ALREADY does this (`#12` fallback) | pi |
| 7 | `runner.ts:1069` (`if node.ops?.merge`) | `node.ops.merge` `{ops}` | `node.op` where `transform.kind==='merge'` → `{ops:transform.ops}` (the onFailure lookup at `:1070` ALREADY reads `op[]`) | programmatic |
| 8 | `runner.ts:1564` (`if node.ops?.merge`) | `node.ops.merge` | same; onFailure lookup at `:1565` ALREADY reads `op[]` | pi |
| 9 | `runner.ts:1161` (`if st==='ok' && node.ops?.promote?.length`) + `:1164` (`for raw of node.ops.promote`) | `node.ops.promote[]` `{from,to,merge}` | `node.op` where `transform.kind==='promote'` → `{from,to,merge:transform.reducer}` (the NAME FLIP `reducer`→`merge`, `lower.ts:109`) | programmatic |
| 10 | `runner.ts:1795` + `:1798` (promote) | `node.ops.promote[]` | same promote adapter from `op[]` (note this lane drills `@return` via `parsed`, `:1800`) | pi |

### 2.2 The non-derive consumers (gate / check / codec / journal / expand)

| # | Site (file:line) | reads today | should read post-migration | lane |
|---|---|---|---|---|
| 11 | `runner.ts:1009` (`preGates = node.op.filter(when==='pre' && gate)`) | `node.op` (gate ops) | UNCHANGED — already op[]-native | programmatic |
| 12 | `runner.ts:1369` (pre-gate) | `node.op` | UNCHANGED — already op[]-native | pi |
| 13 | `runner.ts:1078` (`for o of node.op` — authorable `run` body) | `node.op` (`run` ops) | UNCHANGED — already op[]-native | programmatic |
| 14 | `runner.ts:1574` (authorable `run` body) | `node.op` | UNCHANGED — already op[]-native | pi |
| 15 | POST-CHECK gate: `runner.ts:1114-1121` (`evaluateChecks(effectiveChecks(node.io.checks,…))`) | `node.io.checks` (collapsed list) | DECISION (§3): keep reading `io.checks` — gates were lowered into `op[]` AND collapsed into `io.checks` by the loader; the runner's post-check gate runs the `io.checks` list, NOT the `op[]` gates. See ⚠ Divergence D2. | programmatic |
| 16 | POST-CHECK gate: `runner.ts:1615-1622` (same) | `node.io.checks` | same as #15 | pi |
| 17 | `checks.ts:179` (`for s of n.def.hooks?.seed` — channel consumer) | `def.hooks.seed[].from` | must derive seeds from `lowerToOps(def)` op[] (`transform.kind==='seed'` → `transform.from`) so an `op[]`-authored seed's `{{state.*}}` consumption is seen | check (loader) |
| 18 | `checks.ts:186` (`for p of …def.hooks?.promote` — channel producer) | `def.hooks.promote[].to` | must derive promotes from `lowerToOps(def)` op[] (`transform.kind==='promote'` → `transform.to`) so an `op[]`-authored promote registers as a channel producer | check (loader) |
| 19 | `contract.ts:214` (`if node.op?.length) m.op = node.op`) | `node.op` | UNCHANGED — codec already emits `op[]` (DRIVER-OP) | codec |
| 20 | `contract.ts:210` (`if node.io.checks?.length) m.checks = node.io.checks`) + `:213` (`m.policy`) | `node.io.checks` / `node.io.policy` | UNCHANGED — see ⚠ D2; codec round-trips both the lowered `op[]` AND the byte-identical legacy `checks`/`policy` markers (by design, `contract.ts:47`) | codec |
| 21 | `journal.ts:111` (`ops: node.ops ?? null` in `envelopeHash`) | `node.ops` | MUST switch to `op: node.op ?? null` AND bump `JOURNAL_VERSION` — else retiring `node.ops` silently changes every node's envelope hash → a spurious full re-run on the next resume. See ⚠ D3. | both (journal) |
| 22 | `fusion/expand.ts:184` (`...(x.ops ? { ops: x.ops } : {})` — judge clone carry) | `x.ops` (intent) | MUST carry `x.op` (`...(x.op ? { op: x.op } : {})`) so a fusion-activated node's derives survive onto the judge. NOT in the known-sites list. See ⚠ D4. | loader/expand |

### 2.3 ⚠ Divergences (recorded, not guessed)

- **D1 — doc §5 says `NodeSpec` SHEDS `ops`; as-built it does NOT.** `node-action-protocol.md:351,361`
  asserts "the dense `NodeSpec` … SHEDS the two prior extension fields" and "the old keys lower to `op[]`
  AT THE LOADER (never retained on the dense `NodeSpec`)." **As-built, `NodeSpec.ops?` STILL EXISTS**
  (`types.ts:61`), `NodeIntent.ops?` still exists (`types.ts:834`), and the loader STILL sets it
  (`loader.ts:171,182`). The §5 prose describes the migration TARGET, not the shipped reality — this plan
  IS the work that makes §5 true. (The doc's own Reconciliation log, `:7-21`, never reconciled this row;
  flagged for the doc owner as a separate edit once Unit U6 lands.)

- **D2 — gates: the POST-check gate reads `io.checks`, NOT `op[]` (intentional dual-rep, keep).** The
  loader lowers `checks` BOTH into `op[]` (`lower.ts:13-14,32-37,57-58,78-79`) AND, via `collectChecks`
  (`render.ts:20`), into the collapsed `io.checks` (`loader.ts:148`). The runner's POST gate consumes
  `io.checks` (`runner.ts:1114,1615`), NOT the `op[]` `gate` bodies; only the PRE gate reads `op[]`
  (`runner.ts:1009,1369`). **Verdict: KEEP `io.checks` as the post-gate rep** — it is a SEPARATE,
  already-unified concern (`Check[]`, the checks⊥policy split, `types.ts:309/292`), NOT part of the
  `ops`/`op` duplication this migration retires. Migrating the post-gate to read `op[]` gates is
  out-of-scope here and would risk the parity bar (pre/post ordering, advisory handling). The codec's
  `io.checks`/`io.policy` reads (#20) stay for the same reason. Recorded so a future unit can pick it up,
  but this plan does NOT touch it.

- **D3 — the journal envelope hash hashes `node.ops` (`journal.ts:111`).** Retiring `node.ops` without
  touching this would make `node.ops` resolve `undefined` → the hashed `ops:null` value would change for
  every node that has derives → every such node's envelope hash flips → a spurious full re-run on the next
  resume of an existing run dir. Two options: **(a)** switch the hashed field to `op: node.op ?? null` AND
  bump `JOURNAL_VERSION` (a one-time forced re-run on the FIRST resume after upgrade, then stable — the
  honest, additive-respecting choice, since `op[]` is a superset and the hash SHOULD track it); **(b)**
  keep hashing a `NodeOps`-shaped projection derived from `op[]` to preserve byte-identical hashes across
  the upgrade (no forced re-run, but re-introduces a `NodeOps` shape we are retiring). **Recommended: (a)**
  — a JOURNAL_VERSION bump is the designed mechanism for exactly this (`journal.ts:90-92` flags G1/G6 as
  the same kind of envelope change), and a one-time re-run is acceptable; (b) is recorded as the
  zero-re-run fallback if a live run dir must survive the upgrade untouched.

- **D4 — `fusion/expand.ts:184` carries `x.ops` but NOT `x.op` onto the judge clone.** A fusion-activated
  node authored with derives today survives ONLY because the loader's back-fill guarantees `intent.ops`
  is populated (`loader.ts:171,182`), and the judge clone copies `x.ops`. Once `node.ops` is retired, the
  judge would LOSE its derives unless the clone carries `x.op`. This site is NOT in the prompt's
  known-sites list — it is exactly the kind of silent-no-op regression the inventory exists to catch.
  Verdict: add `x.op` carriage (Unit U5). (The reroute/subworkflow expands carry no ops at all — they
  clone different fields — so they need no change; confirmed by grep, §2.0.)

- **D5 — the codec is already op[]-native; the executors are NOT.** `markersFromNode` emits `node.op`
  (`contract.ts:214`) and `parseMarkers` reads DRIVER-OP back into `op[]` (`contract.ts:181-185`). The
  realized-prompt renderer lowers to `op[]` and emits DRIVER-OP (`render.ts:46,69`). So the codec/prompt
  layer NEEDS NO CHANGE — the gap is purely the runtime executors (§2.1) reading the legacy `ops` side.

### 2.4 Executor input-shape facts (what the dispatch must adapt to)

The 5 executors are REUSED UNCHANGED (`runner.ts:963` comment confirms). Their input shapes decide the
per-transform adapter the switched dispatch must construct from an `OpSpec`:

| executor (file:line) | input shape it takes | adapter from `OpSpec o` |
|---|---|---|
| `stageSeed` (`seed.ts:93`) | one `Seed {to,from}` | `{ to: (o.writes??[])[0], from: o.transform.from }` |
| `applyProjectionOp` (`project.ts:73`) | loose op obj `{to, op?, from?, copy?, assemble?, merge?, union?}` | the `node.ops.project[]` entry IS this loose obj today; an `op[]`-authored project carries only `{kind:'project', from}` — see ⚠ D6 below |
| `runProjection` (`project.ts:261`) | `{source, mapRef, key}` | `{ source, mapRef, key }` from `transform` (the `:1554/:1060` else already does this) |
| `runMerge` (`merge.ts:231`) | `MergeSpec {ops}` | `{ ops: o.transform.ops }` |
| `parsePromote`+`extractPromoteValue` (`promote.ts:69,79`) | `{from,to,merge?}` | `{ from: o.transform.from, to: o.transform.to, merge: o.transform.reducer }` |

- **D6 — the `project` transform CANNOT round-trip the full `applyProjectionOp` op shape.** `applyProjectionOp`
  consumes a RICH loose object (`copy`/`assemble`/`merge`/`union` op-vocabularies with `to`, `spread`,
  `fields`, `from`, `envelope`, …; `project.ts:84-228`). But `TransformBody{kind:'project'}` carries only
  `{ops?, from?}` (`types.ts:145`), and `opsToNodeOps` reconstructs `node.ops.project` as just
  `{to:writes[0], from}` (`lower.ts:104-105`) — the rich op-vocabulary fields (`copy`/`assemble`/`union`/`merge`)
  are **NOT preserved through the lowering today.** So a `hooks.project` authored with a `copy`/`assemble`/`union`
  body is ALREADY lossy through `op[]` (the parity test `op-derive-ops-parity.test.ts:78` only exercises a
  bare `{to,from}` project). **Both options, no guess:**
  **(opt-A)** the migration's project dispatch reads `transform.ops` (`types.ts:145` already reserves
  `ops?: Record<string,unknown>[]`) and iterates those loose op objs through `applyProjectionOp` — requires
  `lowerToOps` to carry the rich op set into `transform.ops` (a lowering change, possibly out of the
  byte-identical envelope if `lower.ts:61-64` is widened);
  **(opt-B)** keep the `project` dispatch reading the `node.ops.project` loose obj for the rich case and
  only switch the bare `{to,from}` case — i.e. `node.ops` is NOT fully retired for `project`.
  **This is the one genuinely-ambiguous executor.** RECORDED, not decided — Unit U2 must RESOLVE D6 first
  (read `lower.ts:61-64` + `project.ts:84` + every shipped template's `hooks.project` author shape) before
  switching site #3/#4; if opt-A widens the lowering, that is an ADDITIVE change to `lower.ts` gated by the
  parity oracle, not a silent behavior shift.

  - **D6 — RESOLVED in U0 (2026-06-27): opt-B** (the conservative, smaller-surface choice). The rich
    `project` case is EXPLICITLY OUT OF op[]-only scope for now; the `project` dispatch reproduces ONLY the
    bare `{to: writes[0], from}` obj (byte-identical to `opsToNodeOps`, `lower.ts:104-105`).
    EVIDENCE (grepped over the whole repo):
    - the ONLY shipped `hooks.project` author shape is the BARE `{to, from}` form
      (`packages/core/test/fixtures/template-min/nodes/w2b-assets/node.json`) — `grep -rln '"(copy|assemble|union)"'`
      over every `node.json` returns ZERO. No rich `copy`/`assemble`/`union`/`merge` project op-vocabulary is
      authored in ANY shipped `hooks.project`.
    - the rich `applyProjectionOp` vocabulary (`project.ts:84-228`) is reached EXCLUSIVELY through a
      registry-record `projections` map via `projectRegistry`/`runProjection` (`union-projection.test.ts`),
      NEVER through `hooks.project`. `lower.ts:61-64` lowers `hooks.project` to `{kind:'project', from}` only.
    - a bare `{to, from}` project op carries no `copy/assemble/merge/union` key, so `applyProjectionOp` hits
      its "no recognized op" fall-through (`project.ts:230`) — the inline `hooks.project` derive is itself a
      graceful executor-level NO-OP today (reads the source, writes nothing).
    CONSEQUENCE: the rich `project` case was never lossy through `op[]` because it never ENTERED `op[]` via
    `hooks.project`. opt-A (widen the lowering to carry the rich op set into `transform.ops`) is UNNECESSARY
    — there is no rich `hooks.project` author shape to carry. U1b's `project` site (#3/#4) switches the bare
    `{to,from}` case to `derivesFromOp(node.op).projects` with NO lowering change. If a rich `hooks.project`
    author shape is EVER introduced, reopen D6 and re-evaluate opt-A.
    Pinned by the U0 oracle: `op-derive-ops-parity.test.ts` (header comment + the `derivesFromOp` project-adapter
    assertion + the runtime-parity `project` family riding the byte-identical run).

---

## 3. Target end-state (per consumer)

**Dispatch (the derive lane, both `runNode` and `runProgrammatic`).** Replace each `node.ops?.{seed,project,
merge,promote}` read with a single canonical iteration over `node.op` POST/PRE `transform` bodies, in the
loader's STABLE order (`lower.ts:18`: pre reads → pre seeds → pre gates → post transforms → post gates),
calling the SAME executors via the §2.4 adapters. Concretely, introduce ONE pure helper (e.g. in
`workflow/template/lower.ts` or a new `runner/op-dispatch.ts`) — `derivesFromOp(op): { seeds, projects,
registryProjects, merges, promotes }` — that is the SINGLE place the `OpSpec → executor-input` adapters
live, replacing both `opsToNodeOps` (the bridge) and the per-site `node.ops?.{…}` reads. Each runner site
then reads from this helper's output. `registryProject` and `merge.onFailure` already read `op[]`
(`:1060/:1554`, `:1070/:1565`) — those stay.

**`io.checks` / `io.policy` (post-gate + codec).** UNCHANGED. Kept as the post-check rep (⚠ D2) — they are
a separately-unified concern, not the `ops` duplication. The loader keeps producing `io.checks` via
`collectChecks` (`loader.ts:148`, `render.ts:20`).

**`checkChannels` (the validator).** Switch both reads (`checks.ts:179,186`) to derive seeds/promotes from
`lowerToOps(n.def)` (or from the already-computed intent `op[]`) so an `op[]`-authored seed/promote
participates in the dangling-channel check exactly like a `hooks`-authored one. This is the validator half
of "authoring directly in `op[]` silently fails in each unmigrated consumer."

**The journal envelope hash.** Switch `journal.ts:111` to hash `node.op` and bump `JOURNAL_VERSION` (⚠ D3,
opt-a).

**The fusion judge clone.** Carry `x.op` (⚠ D4).

**DELETE vs `@deprecated`-alias decision.**
- **`node.ops` / `NodeOps` / `toNodeOps` / `opsToNodeOps` / `intent.ops` back-fill:** DELETE (the last unit,
  U6). `NodeOps` is the legacy rep this migration exists to retire; nothing should read it post-U5.
- **The `hooks`/`checks`/`inject`/`policy` AUTHORING keys + `lowerToOps`:** KEEP (the invariant). `lowerToOps`
  remains the sole lowering; `TemplateNode.hooks/checks/inject/policy` (`types.ts:38,57,58,59`) stay; the
  node.json schema stays. `collectChecks`/`toPolicy` stay (they feed `io.checks`/`io.policy`, kept per D2).
- **`io.checks`/`io.policy`:** KEEP (D2).

---

## 4. Work units — decomposed, ordered, parallelizable

Each unit is test-first: the named oracle MUST go RED under the stated mutation BEFORE the unit's edit, and
GREEN after. Every unit preserves the invariant by gating on the §5 GOLDEN parity oracle (extended
`op-derive-ops-parity.test.ts`) + full-suite-green.

---

**U0 · Additive parity + dispatch-helper scaffolding (lands FIRST).**
- scope: `packages/core/test/op-derive-ops-parity.test.ts` (extend), a NEW `runner/op-dispatch.ts` (pure
  helper `derivesFromOp` + the §2.4 adapters; not yet wired into the runner).
- oracle: extend the parity test to a RUNTIME-parity case (run a `hooks`-twin and an `op[]`-twin through
  `runWorkflow` with the in-memory provider; assert byte-identical produced artifacts + promoted state +
  status records) AND a direct unit test of `derivesFromOp` asserting it reproduces, for all 5 families,
  the SAME executor inputs the current `node.ops?.{…}` sites pass. Red mutation: have `derivesFromOp` drop
  the `promote.reducer→merge` flip → the promote adapter assertion fails. Resolve ⚠ D6 here (decide opt-A
  vs opt-B for `project`; record the verdict in the test's header comment + amend §2.4/D6).
- depends-on: none.
- parallel-safe-with: U1c (validator), U1d (journal) — disjoint files.

**U1a · Switch the `seed` derive dispatch (both lanes).**
- scope: `runner.ts:999` (programmatic), `:1356` (pi). Read seeds from `derivesFromOp(node.op).seeds`.
- oracle: the U0 runtime-parity test, restricted to a seed-only twin; red mutation: revert one lane to
  `node.ops?.seed` while authoring the twin in `op[]` only → that lane stages nothing → artifact missing →
  RED. A focused `runProgrammatic`/`runNode` seed test asserting the staged file exists from an `op[]`-only
  node.
- depends-on: U0.
- parallel-safe-with: U1b (different sites/families, same file — coordinate edits or land serially within
  one agent; see the wave note).

**U1b · Switch the `project` + `merge` + `promote` derive dispatch (both lanes).**
- scope: `runner.ts:1048,1069,1161,1164` (programmatic), `:1537,1564,1795,1798` (pi). (registryProject
  `:1056/:1545` is folded in: delete the legacy `if` arm, keep the `else` op[] arm at `:1060/:1554`.)
  Honor the D6 verdict from U0 for `project`.
- oracle: the U0 runtime-parity test across project/merge/promote/registryProject twins; red mutation:
  author an `op[]`-only twin with a `promote` whose `reducer:'append'` — revert the promote site to
  `node.ops?.promote` (which an `op[]`-only node leaves `undefined`) → no state promoted → the
  state-equality assertion goes RED. Plus a registryProject twin asserting `index.json` is written from an
  `op[]`-only node (the `#12` path, `runner.ts:1551` comment).
- depends-on: U0.
- parallel-safe-with: U1a only by FILE-DISJOINT discipline (both edit `runner.ts`). RECOMMENDATION: land
  U1a+U1b as ONE agent's serial sub-steps (same file, adjacent regions) OR via `git add -p` hunks — do NOT
  run two agents concurrently editing `runner.ts`. Treat {U1a,U1b} as one wave-slot.

**U1c · Switch the channel validator (`checkChannels`).**
- scope: `checks.ts:179,186`. Derive seeds/promotes from `lowerToOps(n.def)`.
- oracle: a new `checks.test.ts` case: an `op[]`-authored node that promotes channel `X` and a downstream
  `op[]`-authored node whose `readScope` consumes `{{state.X}}`. Red mutation: keep the `def.hooks?.promote`
  read → the producer is invisible → a false `dangling channel` error is RAISED (the test asserts NO
  error). Symmetric case for an `op[]`-authored seed consuming a channel.
- depends-on: none (independent file).
- parallel-safe-with: U0, U1a/U1b (runner), U1d (journal), U5 (fusion) — all file-disjoint.

**U1d · Switch the journal envelope hash + bump JOURNAL_VERSION (⚠ D3).**
- scope: `journal.ts:111` (hash `node.op` not `node.ops`), the `JOURNAL_VERSION` constant.
- oracle: a journal test: two nodes whose ONLY difference is `op[]` derive content produce DIFFERENT
  envelope hashes; and a `hooks`-twin vs `op[]`-twin of the SAME derives produce the SAME hash (the parity
  half). Red mutation: hash `node.ops` (which is `undefined` for an `op[]`-only node) → both twins hash
  identically AND two different-derive nodes also collide on `ops:null` → the "different ⇒ different hash"
  assertion goes RED.
- depends-on: none (independent file). (Logically pairs with U6 but can land early — hashing `op[]` is
  correct the moment `op[]` is populated, which is already true.)
- parallel-safe-with: U0, U1a/U1b, U1c, U5.

**U5 · Carry `x.op` onto the fusion judge clone (⚠ D4).**
- scope: `fusion/expand.ts:184` — add `...(x.op ? { op: x.op } : {})`.
- oracle: a fusion-expand test: a fusion-activated node authored with an `op[]` promote → after
  `expandFusion`, the JUDGE node carries that `op` (assert `judge.op` deep-equals `x.op`). Red mutation:
  omit the carry → `judge.op` is `undefined` → RED. (Today this passes only via `x.ops`; the test must
  author the node in `op[]` so it fails without the new carry.)
- depends-on: none (independent file).
- parallel-safe-with: U0, U1c, U1d. (Can also run before U6.)

**U6 · RETIRE `node.ops` / `NodeOps` / the bridge (LANDS LAST).**
- scope: DELETE `NodeSpec.ops?` (`types.ts:61`), `NodeIntent.ops?` (`types.ts:834`), `NodeOps` (`types.ts:198`);
  DELETE `toNodeOps` (`loader.ts:96`) + its call (`:116`) + the two `intent.ops` assignments (`:171,182`);
  DELETE `opsToNodeOps` (`lower.ts:97`); remove the now-dead `node.ops` reads' legacy arms that U1a/U1b left
  (any residual `if (node.ops…)` guards). Update the §5 doc row (⚠ D1) + the back-fill commit's comments.
- oracle: (a) the FULL parity suite + runtime-parity oracle stays GREEN (the proof that every read was
  already switched — if any consumer still needed `node.ops`, deleting it breaks a test RED). (b) a
  `tsc --noEmit` / typecheck gate: deleting `NodeOps` must produce ZERO type errors → proves no source
  still references it. Red mutation FOR THE TEST-THE-TEST: temporarily re-add a `node.ops?.seed` read in
  one lane → typecheck fails / a parity case goes RED → confirms the suite actually pins the absence.
- depends-on: U1a, U1b, U1c, U1d, U5 (every read switched first).
- parallel-safe-with: NONE — terminal unit.

### 4.1 Dependency graph (text)

```
            U0 (parity + dispatch helper; resolves D6)
           /   \
        U1a     U1b        U1c        U1d        U5
      (seed)  (proj/      (channel   (journal   (fusion
        \      merge/      validator) hash+ver)  judge op)
         \     promote)       \          |        /
          \      /             \         |       /
           \    /               \        |      /
            \  /                  \       |     /
             U6  ◄──────────────── all of {U1a,U1b,U1c,U1d,U5} ────►
        (retire node.ops / NodeOps / bridge — LAST)
```

- U1a + U1b both edit `runner.ts` → treat as ONE wave-slot (serial within a single agent), NOT two
  concurrent agents.
- U1c, U1d, U5 are each in their own file → fully concurrent with each other and with the U1a/U1b slot.
- U6 is a hard barrier: it lands only after the entire set above is green.

### 4.2 Parallelization table (waves a coordinator can spawn from directly)

| Wave | Units (concurrent) | Files touched (disjoint) | Gate to advance |
|---|---|---|---|
| **W0** | **U0** | `op-dispatch.ts` (new), parity test | runtime-parity oracle authored + RED→GREEN for the helper; D6 verdict recorded |
| **W1** | **{U1a+U1b}** (one agent, serial), **U1c**, **U1d**, **U5** — 4 agents | `runner.ts` ‖ `checks.ts` ‖ `journal.ts` ‖ `fusion/expand.ts` | each unit's oracle RED→GREEN; full suite green; runtime-parity oracle green |
| **W2** | **U6** | `types.ts`, `loader.ts`, `lower.ts` | full suite + runtime-parity + typecheck green with `NodeOps` DELETED; live-pi E2E green |

Three waves. Max concurrency in W1 = 4 agents. The W0→W1→W2 ordering is the load-bearing constraint
(additive helper + oracle first; every read switched in the middle; retirement last).

---

## 5. Risks & verification

**R1 — the runner hot-path.** `runNode`/`runProgrammatic` are the per-node execution loop; a dispatch
mistake silently drops a derive (no error, just a missing side-effect) — the exact failure mode this
migration is curing. MITIGATION: the §2.1 table maps EVERY site by line; the single `derivesFromOp` helper
(U0) is unit-tested against the current executor inputs BEFORE any runner site is switched; the
runtime-parity oracle proves the run is byte-identical, not just the compiled spec.

**R2 — order constraints (must hold).** (i) U0 (additive helper + oracle) lands before any switch.
(ii) Every read-switch (U1a–U1d, U5) lands before U6 (retirement) — U6's typecheck+parity gate is the
mechanical proof. (iii) U1a and U1b do not run as concurrent agents (same file). (iv) The JOURNAL_VERSION
bump (U1d) is a one-time forced re-run on first resume — acceptable, flagged for the release note.

**R3 — the `project` D6 ambiguity.** The rich `copy`/`assemble`/`union` project op-vocabulary may not
round-trip through `op[]` today. U0 MUST resolve D6 (read the shipped templates' `hooks.project` shapes +
`lower.ts:61-64`) before U1b switches the project site. If opt-A (widen the lowering) is chosen, that
lowering change is itself gated by the parity oracle and is ADDITIVE (a `hooks.project` still lowers to the
same richer `op[]`).

**R4 — GOLDEN oracle (the invariant's proof).** Extend `packages/core/test/op-derive-ops-parity.test.ts`
(`op-derive-ops-parity.test.ts:1`, today a COMPILE-time `node.ops` parity over all 5 families,
`:51`/`:99`) to ALSO assert RUNTIME parity: for each derive family, a `hooks`-authored template and its
`op[]`-authored twin, run through `runWorkflow` (in-memory provider), produce byte-identical artifacts +
promoted `state.json` + status records. This is the single oracle every unit gates on; it is the
machine-checkable statement of the ADDITIVE/byte-identical invariant. (The current test only checks
`compiledOps` equality — it would NOT catch a runtime read-site regression once `node.ops` is gone; the
runtime extension is REQUIRED, not optional.)

**R5 — full-suite-green gate.** Every unit ends with the whole `packages/core` vitest suite green (the doc's
Reconciliation log cites `595 passed` as the baseline, `node-action-protocol.md:8`). A unit that drops the
suite count or flips a prior green to red is not done.

**R6 — live-pi E2E gate (U6 only).** `packages/core/test/runner-live-tool-e2e.test.ts`
(`runner-live-tool-e2e.test.ts:1`, 182 lines) exercises a real pi run with tool wiring; U6 (the retirement)
must keep it green — the proof that the dispatch switch holds on the real runner lane, not just the
in-memory provider.

**R7 — test-the-test discipline (per unit).** For EACH unit, before landing the edit, apply the named red
mutation and CONFIRM the oracle goes RED (a test that stays green under the mutation is asserting nothing).
This is called out inline in every U* oracle above (e.g. U1b: revert the promote site → state-equality
RED; U6: re-add a `node.ops` read → typecheck/parity RED).

---

## Self-check (the bar — each row with file:line evidence)

| # | Bar requirement | Verdict | Evidence |
|---|---|---|---|
| 1 | §2 inventory COMPLETE + grep-backed; every `node.ops`/`node.op`/`def.hooks` read mapped, both lanes | PASS | §2.0 greps (counts); §2.1 maps all 10 derive sites ×lanes (`runner.ts:999,1356,1048,1537,1056,1545,1069,1564,1161/1164,1795/1798`); §2.2 maps gate/check/codec/journal/fusion (`runner.ts:1009/1369/1078/1574/1114/1615`, `checks.ts:179/186`, `contract.ts:210/213/214`, `journal.ts:111`, `fusion/expand.ts:184`) |
| 2 | every unit has a concrete RED-mutation oracle + explicit deps/parallel-safe | PASS | §4 each U* has oracle + red mutation + depends-on + parallel-safe-with |
| 3 | explicit dependency graph + parallel-wave table a coordinator spawns from | PASS | §4.1 graph + §4.2 table (3 waves, max 4 concurrent) |
| 4 | ADDITIVE/byte-identical stated + every unit preserves it; retirement LAST | PASS | §1 invariant; §4 every unit gates on the parity oracle; U6 is the terminal unit, after all reads switched |
| 5 | every claim cites file:line; doc-vs-asbuilt + ambiguous-verdict divergences under ⚠ | PASS | §2.3 D1–D5, §2.4 D6 — D1 (doc §5 vs `types.ts:61`), D6 (the genuinely-ambiguous `project` executor, BOTH options, no guess) |
| 6 | found a read site NOT in the known-sites list | PASS | `fusion/expand.ts:184` (D4), `journal.ts:111` (D3), the codec dual-read `contract.ts:210/213` (D2/D5) — none in the prompt's known-sites list |
