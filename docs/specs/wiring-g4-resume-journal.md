# Wiring G4 — true journal/replay resume (content-hash, mid-DAG)

> Status: design only (no source touched). Created 2026-06-25. Companion to
> `docs/specs/competitive-gaps-vs-pi-dynamic-workflows.md` §G4. Every existing-code claim cites a
> `file:line` read while writing this. Where the cited line/behavior diverges from reality it is
> recorded under **⚠️ Discrepancies** and the design proceeds from what is on disk.

---

## 1. Objective

Replace today's coarse "stage-window + artifact-exists" resume with a **per-node content-hash journal**:
on resume, SKIP a node whose work is provably unchanged (envelope hash + every input hash match the
recorded run) and RE-RUN a node plus **all its DAG descendants** when its envelope or any input changed
— so a stale output can never be wrongly reused.

---

## 2. Current state

### 2a. The three mechanisms today

- **Stage-window selection** — `selectWindow(wf, from, until)` returns `{fromIdx, untilIdx}` by matching
  `--from`/`--until` against a stage's `phase`, or any member node's `id`/`label`
  (`packages/core/src/runner/runner.ts:276`, matcher `stageMatches` at `:267`). Stages before `fromIdx`
  are sliced into `skipped`; `[fromIdx..untilIdx]` is `selected`
  (`runner.ts:938-940`).
- **Seed of `reused`** — every skipped stage's nodes are seeded `status:'reused'`, every selected node
  `pending` (`runner.ts:943-950`). `reused` is a first-class node status (`runner/status.ts:25`).
- **Artifact-stat preflight** — when `fromIdx > 0`, the runner stats every skipped node's declared
  artifacts on the host; **any** missing artifact HALTs the run with a synthetic `__resume__` blocked
  node (`runner.ts:962-988`). It only checks **existence** (`artifactState` → `{exists, bytes}`,
  `status.ts:151`), never content or freshness.
- **RunState checkpoint** — `RunState` (`{{state.*}}` channels) is loaded once at run start
  (`runner.ts:907` → `loadState`, `workflow/state.ts:66`) and persisted at each **stage barrier** after
  the promote-merge (`runner.ts:1029` → `persistState`, `state.ts:76`), to
  `${RUN}/.pi/state.json` (`runner/layout.ts:21`). The run digest `.pi/run.json` is rewritten on every
  node transition (`status.ts:129` `writeStatus`, serialized + atomic temp-rename).

There is **no per-node journal and no hashing anywhere** today. `--from/--until` is the *entire* resume
surface; it threads CLI → `runFromTemplate` → `runWorkflow` (`cli/src/run.ts:253-254`,
`runner/entry.ts:94`, `runner.ts:141-143`).

### 2b. The staleness bug (concrete)

DAG: `A → B → C` (`B.reads` an output of `A`; `C.reads` an output of `B`). Run once; all green; artifacts
on disk.

Now **edit A's prompt** (or change A's tool set, or hand-edit A's input file) and resume with
`--from <B's stage>`:

1. `selectWindow` puts A in `skipped`, B/C in `selected` (`runner.ts:938-940`).
2. The preflight stats A's artifact — **it exists** (the stale one from the first run) — so the preflight
   passes (`runner.ts:974`). A is marked `reused`.
3. B and C re-run, but they **stage A's stale artifact** as their input (`runner.ts:568-571` copies the
   on-disk file into B's sandbox). B's new output is computed from A's **old** bytes.

The edit to A is silently dropped. The only knob — `--from` — cannot express "A changed, re-run A and
everything downstream": `--from` is a manual stage cursor, not a change detector, and the preflight's
existence-only check **cannot** tell a fresh artifact from a stale one. This is exactly the wrong-reuse
G4 must kill.

A second, subtler instance: `--from` requires the human to know *which* stage to resume from. Resume from
too late → stale reuse (above); resume from too early → wasted tokens re-running unchanged nodes. The
journal removes the human from that decision.

---

## 3. Reference (competitor) — adopt vs reject

The competitor (`vendor/pi-dynamic-workflows`, "PDW") resumes a **linear `agent()` call sequence in one
process** with in-memory results:

- **Call-identity hash** — `hashAgentCall(prompt, model, phase, options, agentDefKey)` → `sha256` of
  `JSON.stringify({prompt, model, tier, phase, agentType, agentDef, schema})`
  (`vendor/pi-dynamic-workflows/src/workflow.ts:1040-1058`). The `agentDef` field is the **resolved**
  agentType definition (tools/model/prompt) so editing a `.pi/agents/*.md` invalidates the call
  (`workflow.ts:1053-1055`).
- **Journal entry** — `{ index, hash, result }` keyed by a monotonic **`callSeq`** assigned at lexical
  call time (`JournalEntry`, `workflow.ts:37-42`; `callSeq`/`firstMiss`, `workflow.ts:199-207`).
- **Longest-unchanged-prefix replay** — a cached result is replayed only while `callIndex < firstMiss`
  AND its hash matches; the first miss sets `firstMiss = min(firstMiss, callIndex)`, so that call **and
  everything after** run live (`workflow.ts:402-417`).
- **Crash safety** — atomic `tmp`+`rename`, a `.bak` fallback, and a cross-process **lock lease** (`wx`
  open, PID liveness check, stale-lock reclaim) (`vendor/.../src/run-persistence.ts:172-187`,
  `:253-285`, `load` falls back to `.bak` at `:189-202`).
- **Determinism guard** — PDW neuters `Date.now`/`Math.random` in the vm so a re-run reproduces the
  cached value (`workflow.ts:227-244`). Not portable to us (no vm; each node is a real `pi`).

| PDW mechanism | piflow decision |
| --- | --- |
| Call-identity **sha256 of the resolved envelope** | **ADOPT** — our node hash mirrors it (resolved prompt + tools + model + agentType-def + schema/contract). |
| "**first miss → it + everything after run live**" | **ADOPT the idea, TRANSLATE the topology**: "after" is not a linear `callSeq` suffix — it is the set of **DAG descendants** of the changed node (`dag.ts` reachability). |
| **`callSeq`** linear index as the journal key | **REJECT** — our results are FILES across parallel stages, not a linear in-memory sequence. The journal key is the stable **`nodeId`**. |
| Atomic write + `.bak` + lock lease | **ADOPT**, adapted to our run dir (`${RUN}/.pi/`); we already have a serialized atomic `writeStatus` to reuse the pattern (`status.ts:129`). |
| **Input = the prior agent's in-memory result** | **TRANSLATE**: our input is the **content hash of each file the node reads** off disk — the data-flow analogue of "the upstream result". |
| Determinism vm guard | **REJECT** (no vm). Handled instead by the **descendant-invalidation rule** + an "input-hash" check, and acknowledged in §5 (a non-deterministic node). |

---

## 4. Design

### 4a. The per-node content hash — exact inputs + their source module

A node re-runs iff its **envelope hash** OR any **input-file hash** differs from the journaled run. The
envelope hash is `sha256` over a canonical `JSON.stringify` of the fields below. Each field has a named
source module that already computes it:

| Field | What it captures | Source (already computed) |
| --- | --- | --- |
| `prompt` | the **realized** prompt text (prose + DRIVER-* marker tail, tokens **resolved** at launch) | the runner resolves it: `resolvedPrompt = resolveTokens(node.prompt, resolveCtx)` then appends `emitMarkers(markersFromNode(node, resolved))` (`runner.ts:592,599`). Hash the **same string staged to `prompt.md`** (`runner.ts:601`) — so any prompt edit, marker change, or `{{arg}}`/`{{state}}` value change flips it. |
| `piTools` | the bare tool names pi sees | `resolved.piTools` from `ctx.registry.resolve(node.tools)` (`runner.ts:506`; shape `ResolveResult.piTools`, `types.ts:469`). |
| `excludeTools` | denied tools | `resolved.excludeTools` (`types.ts:479`). |
| `extension` | the generated `-e` tool-binding source (MCP/sdk wiring) | `resolved.extension` (`types.ts:472`; produced by `compileToolExtension`, `tools/compile.ts:241`). Hashing the **source string** captures a tool's schema/binding change. |
| `model` | the model pin | `ctx.model` today (run-level, `runner.ts:626`). **G1 dependency**: once per-node `node.model`/`node.tier` land (§G1), hash the **resolved per-node model**, not the run-level one — otherwise a per-node model swap won't invalidate. Until G1, hash `ctx.model` (run-level) and note the limitation. |
| `agentTypeDef` | the resolved agentType (role prompt/tools/model) | **G6 dependency**: `node.agentType` is carried but unconsumed today (`types.ts:31`; gap §G6). When G6 resolves it into the envelope, fold the resolved def into the hash (mirrors PDW's `agentDef`, `workflow.ts:1053`). Until then, hash the raw `node.agentType` string (cheap, still flips on a retarget). |
| `returnSchema` + `returnMode` | the structured-return contract | `node.io.returnSchema`, `node.io.returnMode` (`types.ts:216-218`). |
| `artifactsContract` | declared artifacts + their schema refs + checks + policy + fillSentinel | `node.io.artifacts` / `node.io.checks` / `node.io.policy` / `node.io.fillSentinel` (`types.ts:197-223`). A contract tightening must re-verify ⇒ re-run. |
| `ops` | seed/project/merge/promote (derive-from-input behavior) | `node.ops` (`types.ts:48`, shape `NodeOps` `types.ts:56`). |

**Input-file hashes** are SEPARATE from the envelope hash (so the journal can report *which* changed):
for each path the node consumes, record `sha256(file bytes)`. The consumed set is:

- `node.io.reads` — files staged into the sandbox (`runner.ts:568`). **⚠️ Discrepancy (load-bearing):**
  in the **template path** `io.reads` is hardcoded `[]` (`workflow/template/loader.ts:121`) — template
  edges come from `deps`/`dependsOn`, NOT inferred reads (the loader sets `dependsOn: n.def.deps`,
  `loader.ts:124`). So for a template run, "the files this node reads" must be derived from its
  **upstream producers' artifacts** via the DAG edges, not from `io.reads`. See §4c.
- `node.ops.seed[].from` resolved sources (staged at `runner.ts:579-581`), when they resolve to a host
  file under `{{RUN}}`.

The hashing helper is **new** (`runner/journal.ts`); the *inputs* it consumes are all already produced by
the runner before exec (`runner.ts:504-616`), so hashing is a pure read of values in hand.

### 4b. Extended RunState/journal schema — where it's written

Extend the existing run dir, not a new global file (SDK stays product-agnostic; per-run state lives in
the run dir per `CLAUDE.md`). Two options were considered; **chosen: a sibling `${RUN}/.pi/journal.json`**
(keeps `state.json` semantics — the `{{state.*}}` channels — uncontaminated; `loadState`/`persistState`
already own `state.json` shape, `state.ts:66-79`).

```jsonc
// ${RUN}/.pi/journal.json   (NEW file; layout helper journalFile(run) in runner/layout.ts)
{
  "version": 1,
  "runId": "flaky-pecan",
  "source": "game-omni",          // wf.meta.name, for a sanity check on resume
  "nodes": {
    "node-a": {
      "hash": "sha256:…",          // the envelope hash (§4a)
      "inputHashes": { "spec/in.json": "sha256:…" },  // path -> content hash of each consumed file
      "outputHashes": { "spec/a.json": "sha256:…" },  // content hash of each produced artifact (post-run)
      "status": "ok",              // ONLY a terminal-good status is journaled (ok | warn-equivalent)
      "producedAt": "2026-06-25T…Z"
    }
  }
}
```

- A new layout helper `journalFile(run) = path.join(piDir(run), 'journal.json')` next to `stateFile`
  (`runner/layout.ts:21`).
- `loadJournal(run)` / `writeJournalEntry(run, nodeId, entry)` mirror `loadState`/`persistState`
  (`state.ts:66-79`) but with the **atomic temp+rename + serialized chain** of `writeStatus`
  (`status.ts:129-148`) — see §4d. A node's entry is written **only** at a terminal **good** verdict
  (inside `finishNode`, `runner.ts:830`, gated on `status === 'ok'`/`'gap'`-clean), never on
  `running`/`error`/`blocked`.
- `outputHashes` lets a downstream node decide reuse from the *content* of its inputs, not from "did the
  upstream re-run" alone — so a node whose output is byte-identical across runs (a legitimately
  idempotent node) does NOT force its descendants to re-run (see §5 last case).

### 4c. The resume algorithm (pseudocode)

Computed once, before the stage loop, then consulted per node. Reachability uses the compiled
`wf.edges` (`dag.ts:53` `inferEdges`; `Edge {from,to,files}`, `types.ts:558`).

```text
# INPUTS: wf (compiled DAG), journal (prior run's nodes), the run dir
# OUTPUT: decision[nodeId] ∈ { REUSE, RUN }

# 1. Build the descendant map from wf.edges (forward adjacency, transitive closure).
descendants = transitiveClosure(wf.edges)        # nodeId -> set of all reachable nodeIds

# 2. Resolve each node's envelope (the SAME work the runner does pre-exec) to get its hash + the
#    set of files it consumes. For a TEMPLATE run, the consumed set = the artifacts of its DAG
#    PARENTS (edges into it), because io.reads is [] there (§4a ⚠). For an inferred-edge run, it
#    is node.io.reads. Either way it is "the files that feed this node".
for n in topoOrder(wf):
    envHash[n]   = sha256(canonical(envelopeFields(n)))      # §4a
    consumed[n]  = inputFilesOf(n, wf)                       # parents' produces  OR  n.io.reads

# 3. First pass — INTRINSIC staleness (envelope changed, or a consumed file changed on disk vs journal).
mustRun = {}
for n in topoOrder(wf):
    j = journal.nodes[n]
    if j is None:                      mustRun[n] = "no journal entry"          # new node
    elif j.hash != envHash[n]:         mustRun[n] = "envelope changed"          # prompt/tools/model/contract edit
    else:
        for f in consumed[n]:
            if sha256(read(f)) != j.inputHashes[f]:                            # input file content changed
                mustRun[n] = "input changed: " + f; break

# 4. Second pass — PROPAGATE: a changed node taints every DAG descendant (the "first-miss → everything
#    after" idea, translated to reachability). This is what makes "edit A → A + B + C re-run".
for n in keys(mustRun):
    for d in descendants[n]:
        mustRun[d] = mustRun.get(d, "upstream re-ran: " + n)

# 5. Decide. A node NOT in mustRun is provably unchanged ⇒ REUSE (status 'reused'); else RUN.
for n in topoOrder(wf):
    decision[n] = RUN if n in mustRun else REUSE
```

Why it satisfies the bar ("edit one node → it + descendants re-run, unrelated nodes reused"):

- Editing **B's prompt** flips `envHash[B]` (step 3, `envHash` includes the realized prompt, §4a) →
  `mustRun[B]`. Step 4 taints `descendants[B]` (C) → `mustRun[C]`. A has an unchanged envelope and an
  unchanged input set (it consumes only external inputs), and is **not** a descendant of B → REUSE. A
  sibling D off B's subgraph (`A → D`, no path B→D) is likewise untainted → REUSE. ✓
- Editing **A's prompt** flips `envHash[A]` → `mustRun[A]`; step 4 taints A's descendants (B, C) →
  both RUN. The §2b stale-reuse bug cannot occur: the journal never reports A's edit as "reused". ✓
- Hand-editing **A's input file** (an `externalInput`) flips the file's content hash → A's
  `inputHashes` miss → `mustRun[A]` → descendants re-run. ✓

This **replaces** the `selectWindow` slice as the default skip decision. The artifact-stat preflight is
**subsumed**: a `REUSE` node must still have its artifacts on disk to feed downstream, so the journal
path keeps the existence check but now ALSO checks the content hash (a missing OR content-changed
artifact under a node we wanted to reuse forces that node — and its descendants — to RUN, instead of the
old hard HALT). Where a reused node's artifact is genuinely gone (deleted on disk), re-running it
regenerates it — strictly safer than today's HALT.

### 4d. Atomic-write / crash safety

A node that started but did not finish must NEVER be journaled as done. Concretely:

1. **Write only on a terminal-good verdict.** The journal entry is written inside `finishNode`
   (`runner.ts:830`) ONLY when `status ∈ {ok}` (and the clean `gap` path if we choose to journal gaps).
   `running`/`error`/`blocked`/killed verdicts write **nothing** to the journal — a crash mid-exec
   leaves the prior (or absent) entry, so the next resume sees "no/old entry" and re-runs the node.
   This mirrors PDW only journaling a completed `agent()` (`workflow.ts:419+`, after the limiter run).
2. **Atomic publish.** `writeJournalEntry` serializes per-dir and writes `tmp`+`rename` (reuse the
   exact `writeStatus` pattern, `status.ts:129-148`) so a crash mid-write can't corrupt
   `journal.json`, and a concurrent reader (a watcher) never sees a torn file. A `.bak` of the prior
   good journal is the fallback on a truncated primary (PDW `run-persistence.ts:183`, `:189-202`).
3. **Output-hash AFTER collect.** `outputHashes` is computed after `downloadDir` + the verify gate
   (`runner.ts:643,677`), so a half-produced artifact (node errored before writing) is never recorded
   as a good output.
4. **Single-writer-per-run lock (optional, recommended).** Adopt PDW's lease (`wx` open + PID liveness,
   `run-persistence.ts:253-285`) as `${RUN}/.pi/run.lock` so two concurrent `piflowctl run --resume <same
   dir>` processes can't interleave journal writes. Lower priority than 1-3 (a single console drives a
   run today) but cheap and copied wholesale.

### 4e. Precedence vs `--from/--until`

Keep `--from/--until` as a **manual override**, layered ON TOP of the journal:

```
1. PROFILE elision (unchanged — applied before compile, runner.ts:146).
2. JOURNAL decision (new default): each node REUSE | RUN per §4c.
3. --from / --until WINDOW (manual override of the journal):
     - --from  : force every node in stages < fromIdx to REUSE even if the journal says RUN
                 (escape hatch: "I know the upstream is fine, don't re-run it").
     - --until : force every node in stages > untilIdx to be skipped (not run, not reused — a
                 partial run, same as today).
     - Neither flag ⇒ the journal decision stands for every node (the new, safe default).
4. SAFETY OVERRIDE: a node forced REUSE (by --from) whose artifacts are MISSING on disk → it (and its
   descendants) flip back to RUN, NOT a hard HALT. (Strictly safer than today's __resume__ HALT.)
```

Net: with **no flags**, resume is fully automatic and correct (the headline G4 win). `--from` becomes
"trust the prefix, skip the hashing for it" — useful when an input is intentionally non-deterministic and
the human wants to pin it. `--until` stays "stop early". Rule of thumb: **the journal can only ADD
re-runs the human didn't ask for (safety); the flags can only SUBTRACT them (override).**

---

## 5. Edge cases & failure modes

1. **Partial run / crash mid-node.** Not journaled as done (§4d.1) ⇒ re-runs on resume. ✓ No stale entry.
2. **Input file edited by hand** (an `externalInput` or a produced file touched between runs). Its
   content hash misses ⇒ the consuming node + descendants re-run (§4c step 3). This is the case
   today's existence-only preflight (`runner.ts:974`) silently misses.
3. **Tool or model change.** Tool change flips `resolved.piTools`/`extension` in the envelope hash;
   model change flips `model` — both re-run the node + descendants. **Caveat (G1):** until per-node
   model lands, a per-node model swap is invisible to the hash (run-level `ctx.model` only). Documented
   dependency; not a regression (today nothing re-runs on a model change).
4. **Non-deterministic node** (a node whose output legitimately varies run-to-run with an unchanged
   envelope + inputs). The journal will REUSE it (envelope + inputs match) — correct by the contract
   ("provably unchanged WORK"), but a user who *wants* a fresh roll must use `--from` to NOT skip it, or
   we expose a per-node `resume: 'always-run'` opt-out (Open decision). We do NOT add a vm determinism
   guard (PDW `workflow.ts:227`) — irrelevant to a real-process node.
5. **Per-node `retries` WIP interaction.** `runNodeWithRetries` (`runner.ts:479`) re-runs a fresh
   attempt on `error`/`blocked`; the **last** attempt's record wins. The journal entry is written by
   `finishNode` on the FINAL verdict only — so a node that failed N times then succeeded is journaled
   once, as the success. A node that exhausts retries ends `error` ⇒ NOT journaled ⇒ re-run on resume.
   `retries` and resume compose cleanly: retries is *within* a run, the journal is *across* runs.
6. **A produced file legitimately identical across runs.** Node A re-runs (its envelope changed) but
   emits byte-identical output. Because B's reuse decision compares B's input **content hash** to the
   journal (§4c step 3 over `consumed[B]` = A's artifact), and A's `outputHashes` are unchanged, B's
   input hash still MATCHES — so the §4c propagation must use **content equality, not "A re-ran"**, to
   let B reuse. *(This is why `outputHashes` exists in the schema — step 4's taint should be refined to
   "taint a descendant only if a consumed file's content actually changed", with the pure topological
   taint as the conservative fallback. Open decision: strict-content vs conservative-topological
   propagation.)*
7. **DAG shape changed between runs** (a node added/removed/re-wired). A new node has no journal entry ⇒
   RUN (§4c step 3). A removed node's stale entry is ignored (no node references it). A re-wired edge
   changes `consumed[n]` ⇒ likely an input-hash miss ⇒ RUN. The `source` field guards a wholesale
   template swap (refuse to honor a journal whose `source` ≠ `wf.meta.name`).

---

## 6. Test plan (each FAILS on a stale-reuse bug)

The **observable seam** is the per-node `status` in `.pi/run.json` (`reused` vs `ok`) — already asserted
by the existing resume test (`packages/core/test/runner.test.ts:190`,
`expect(status.nodes.stage1.status).toBe('reused')`) — PLUS the new `${RUN}/.pi/journal.json` content.
Tests use the injected `buildCommand` stub (no live `pi`) the runner tests already use
(`runner.test.ts:187`).

1. **Stale-reuse is killed (the headline).** Build `A → B → C`. Run once (journal written). Edit B's
   prompt; resume with NO flags. ASSERT: `A.status === 'reused'`, `B.status === 'ok'` AND `C.status ===
   'ok'` (B + descendants re-ran), and a sibling `D` (off B's subgraph) `=== 'reused'`. **FAILS today**
   (today there is no journal; without `--from`, B/C wouldn't run at all, and with `--from B` C would
   consume B's NEW output but A-edits would leak). The discriminating assertion: edit **A** instead of B
   and assert B re-ran on A's NEW output bytes — verify B's produced artifact reflects the new input
   (read the file), not the stale one. This is the assertion that fails on the §2b bug.
2. **Unchanged node is reused (no wasted tokens).** Run `A → B`; resume with NOTHING changed. ASSERT
   both `reused`, and the `buildCommand` stub's exec was invoked **zero** times (spy the builder /
   `execRunner`). FAILS if the hash logic spuriously re-runs.
3. **Hand-edited input file invalidates** (kills the existence-only-preflight bug). Run `A → B`; between
   runs, overwrite A's produced artifact on disk with different bytes (simulating a hand edit); resume.
   ASSERT `B.status === 'ok'` (re-ran) because its input content hash missed. FAILS today — the existing
   preflight only stats existence (`runner.ts:974`) and would mark B reusable.
4. **Tool change invalidates.** Run a node; resume after changing its `tools.allow`. ASSERT it + its
   descendants re-run (envelope hash flipped via `resolved.piTools`).
5. **Crash safety — a non-terminal node is never journaled.** Inject a `buildCommand`/`execRunner` that
   makes B end `error`. Run (B + C never complete). Inspect `journal.json`: ASSERT `journal.nodes.B` is
   absent (and C absent). Resume after fixing B; ASSERT B + C run. FAILS if the journal records a
   running/errored node as done.
6. **`--from` override still works.** Run `A → B → C`; edit A's prompt; resume with `--from <B's
   stage>`. ASSERT A is `reused` despite the edit (manual override honored) — documents the precedence
   in §4e. (This is the one case where the human accepts the stale prefix on purpose.)

No coverage-only tests — every test above asserts a **behavioral** seam (`reused`/`ok` status, exec
invocation count, or the produced file's bytes) that flips when resume reuses stale work.

---

## 7. Files to touch (checklist)

| Path | Change | Rough size |
| --- | --- | --- |
| `packages/core/src/runner/journal.ts` | **NEW.** `envelopeHash(node, resolved, model)`, `hashFile`, `loadJournal`, `writeJournalEntry`, `decideResume(wf, journal, runDir)` (the §4c algorithm incl. the transitive-closure descendant map over `wf.edges`). Pure + I/O split, atomic writer copied from `status.ts`. | ~180 lines |
| `packages/core/src/runner/layout.ts` | Add `journalFile(run)` + `journalBakFile(run)` (pure joins next to `stateFile`, `:21`). | ~4 lines |
| `packages/core/src/runner/runner.ts` | Load the journal at run start (next to `loadState`, `:907`); call `decideResume` after `selectWindow` (`:938`) to seed `reused` vs `pending` from the journal instead of the raw stage slice; layer `--from/--until` as the override (§4e); compute `outputHashes` + `writeJournalEntry` in `finishNode` (`:830`) on a good verdict; soften the preflight HALT (`:962-988`) into "force-run on missing". | ~70 lines changed/added |
| `packages/core/src/runner/runner.ts` (RunOptions) | Add `resume?: boolean` (default ON when a journal exists) and/or `noResume?: boolean` to force a full re-run; thread through. | ~6 lines |
| `packages/cli/src/run.ts` | Parse `--resume`/`--no-resume` (the run dir is already the existing `outDir`, so "reuse the existing run dir" is implicit — `cli/src/run.ts:221`); thread to `runFromTemplate`. | ~8 lines |
| `packages/core/src/runner/entry.ts` | Pass the new resume options through `runFromTemplate` (`:82-95`). | ~3 lines |
| `packages/core/test/journal.test.ts` | **NEW.** The §6 test plan. | ~200 lines |
| `docs/specs/competitive-gaps-vs-pi-dynamic-workflows.md` | Update §G4 from "how we'd close it" to "wired" once landed. | ~3 lines |

The hash inputs are all **already produced** by the runner before exec
(`runner.ts:506,592,599,606,626`), so no new resolution work — `journal.ts` reads values in hand.

---

## 8. Open decisions

1. **Hash algorithm / granularity.** `sha256` (matches PDW, `workflow.ts:1037`) vs a faster non-crypto
   hash. One envelope hash per node + N input-file hashes. Do we hash the **bundled** extension
   (`bundleExtension`, `tools/compile.ts:303`) or the **rendered** source (`compileToolExtension`,
   `:241`)? Rendered is cheaper and sufficient (the binding, not the bundler output, is the identity).
2. **Input hashing strictness: mtime vs content.** Content hash is correct (catches a same-mtime
   overwrite, the §2b/§5.2 bug) but reads every input file. mtime+size is cheaper but spoofable. Default
   **content**; optionally short-circuit with mtime+size when it MATCHES the journal (re-hash only on a
   stat change). Recommend content-with-mtime-shortcut.
3. **Propagation: strict-content vs conservative-topological** (§5.6). Strict (taint a descendant only
   when a consumed file's bytes actually changed) saves tokens on idempotent nodes but needs
   `outputHashes` plumbed into the parent's decision; topological (taint every descendant of any changed
   node) is simpler and always-safe but may over-run. Recommend ship topological, refine to content.
4. **Keep `--from/--until`?** Yes — as the documented manual override (§4e), not the default. (Could
   later deprecate `--from` if the journal proves sufficient.)
5. **`journal.json` vs extend `state.json`.** Chosen separate file (§4b) to keep `{{state.*}}` channel
   semantics clean; revisit if a unified `.pi/run-state` blob is preferred.
6. **Journal `gap` verdicts?** Journal only `ok`, or also a clean self-reported `gap`? Conservative:
   journal only `ok` (a `gap` node re-runs on resume).
7. **G1/G6 ordering.** The model + agentType hash fields are only fully correct after G1 (per-node
   model) and G6 (agentType consumption) land. Until then the hash uses run-level `ctx.model` + the raw
   `agentType` string — note the limitation in the journal `version`.

---

## ⚠️ Discrepancies (recorded, design proceeds from reality)

- **`io.reads` is empty in the template path.** The architecture invariant says "edges are inferred from
  `reads`/`produces`" (`types.ts:187-191`), and `dag.ts:71-79` does infer them — BUT the **template
  loader hardcodes `reads: []`** and routes edges through `dependsOn: n.def.deps`
  (`workflow/template/loader.ts:121,124`). So for the canonical template run, a node's consumed-file set
  must be derived from its **DAG parents' `produces`/artifacts** (via `wf.edges`), not from `io.reads`.
  The §4c algorithm's `inputFilesOf(n, wf)` handles both: `n.io.reads` when non-empty (the inferred-edge
  path), else the union of `wf.edges`-parents' artifacts (the template/deps path). This is load-bearing —
  hashing only `io.reads` would hash an empty set for every template node and miss every input change.
- **Run identity vs run dir.** A resume reuses the SAME `outDir`/run dir (`cli/src/run.ts:221`,
  `runner/entry.ts:94`); `instantiateRun` already **preserves an existing `state.json`** on re-run
  (`instantiate.ts:110-115`). The journal must be preserved identically (do NOT re-stub it on
  re-instantiate). Confirmed `instantiateRun` only seeds the empty `state.json` stub when absent
  (`:115`) — apply the same guard to `journal.json`.

---

## Self-check (Required bar)

| Bar item | Verdict | Evidence |
| --- | --- | --- |
| (1) every existing-code claim cites a `file:line` READ | PASS | All citations (`runner.ts:276/938/962/1029`, `state.ts:66/76`, `status.ts:129/151`, `compile.ts:241`, `loader.ts:121/124`, `entry.ts:94`, `cli/run.ts:221`, PDW `workflow.ts:402/1040`, `run-persistence.ts:172/253`) are from files read in this session. |
| (2) hash inputs enumerated, each with a named source module | PASS | §4a table: prompt (`runner.ts:592/599/601`), piTools/excludeTools/extension (`registry.resolve`/`types.ts:469-479`), model (`runner.ts:626`, G1 dep), agentTypeDef (G6 dep, `types.ts:31`), returnSchema/Mode/contract/ops (`types.ts:48/197-223`). |
| (3) algorithm: edit one node → it + descendants re-run, unrelated reused, with WHY | PASS | §4c pseudocode + the three worked traces (edit B / edit A / edit input) below it; descendants via `wf.edges` transitive closure (`dag.ts:53`). |
| (4) crash safety addressed concretely | PASS | §4d: journal only on terminal-good verdict in `finishNode` (`runner.ts:830`); atomic tmp+rename + `.bak` (copied from `status.ts:129`); output-hash after collect; optional lock lease (PDW `run-persistence.ts:253`). |
| (5) test plan names a seam that FAILS on stale-reuse | PASS | §6: the seam is `status.nodes.<id>.status` (`reused` vs `ok`, existing assertion `runner.test.ts:190`) + the produced file's bytes; tests 1 & 3 fail on exactly the §2b stale-reuse bug. |
| Must NOT implement/edit source | PASS | Only this doc written; no source touched. |
| Must NOT invent lines/APIs | PASS | Unverified-future fields (G1 model, G6 agentType) explicitly flagged as dependencies, not asserted as present. |
| Must NOT copy linear callSeq | PASS | §3 table REJECTS `callSeq`, translates "first-miss → after" to DAG descendants (§4c step 4). |
