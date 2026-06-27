# Wiring design — G5: journaled human checkpoint (HITL)

> Status: DESIGN ONLY (no source edited). Created 2026-06-25. Companion to
> `docs/specs/competitive-gaps-vs-pi-dynamic-workflows.md` §G5. Every existing-code claim cites a
> `file:line` read while writing this. Where a referenced line differed from reality it is recorded
> under **⚠️ Discrepancies**.

---

## 1. Objective

A **checkpoint** pauses a run at a node, asks the human a question (`confirm` / `input` / `select`),
and resumes on their reply; headless (no UI attached) it takes a declared `default` and **journals**
that, so a background run never hangs. **Explicit owner requirement:** the checkpoint is presented
through the CURRENT `observe` pipeline — the pending question surfaces as a field on the ONE run-view
stream, so the GUI renders a **notification + an HITL panel**, and the reply flows back to resume the
paused run. The design leaves a clean **forward path** to do the same in the TUI later.

---

## 2. Current state (each with file:line)

- **No HITL today.** stdin is deliberately closed in the headless `pi` command — `defaultPiCommand`
  documents "Closes stdin … an open stdin pipe with no TTY hangs a headless CLI forever"
  (`packages/core/src/runner/command.ts:54-56`). (⚠️ the actual `parts` array at
  `command.ts:61-77` builds the flags but does NOT emit a `< /dev/null` redirect — stdin closure is
  the runner/provider's job, not a flag; the comment describes intent. See **⚠️ Discrepancies**.)
- **Policy actions are automated, not human gates.** `PolicyAction = 'block' | 'warn' | 'stop'`
  (`packages/core/src/types.ts:152`) are verdict→consequence on integrity checks
  (`runner.ts:704-711,760`), never a human prompt.
- **observe is the single reader.** GUI + TUI + CLI + `watch` all consume `@piflow/core/observe`:
  `readRunModel` (`observe/read.ts:98`), `watchRun` (`observe/watch.ts:62`), `buildRunView`
  (`observe/runView.ts:179`). The run-view node shape is `RunViewNode` (`observe/runView.ts:29-65`);
  the live deltas are `RunUpdate` (`observe/types.ts:83-87`). No view re-derives run state
  (`observe/index.ts:1-4`).
- **GUI is one-way today.** The Vite dev middleware exposes only **GET** endpoints + a one-way SSE:
  `/__piflow/stream/<run>` pipes `watchRun` (`gui/vite.config.ts:90-155`), plus run-view, file, tree,
  index (`vite.config.ts:165-326`). There is **no POST / control path** anywhere in that file.
- **Companion talk-back is a stub.** `sendToPi(text, …) ← wire the pi chat spawn here (step 2)` is
  commented out; the send handler only echoes (`gui/src/components/Companion.tsx:55-62`). The LIVE
  Info-IN bridge (run→GUI over SSE) is DONE (`Companion.tsx:45-49`, `gui/src/data/runStream.ts:124-133`).
- **TUI is monitor-only.** It renders from the shared reader via `subscribeRun`/`buildModel`
  (`tui/model.mjs:53-67,283-310`); keys are read through Ink `useInput` (`tui/components.mjs:431-453`)
  but only for navigation/view-toggle — no write-back to a run.
- **RunState checkpoint exists.** The per-thread `RunState` is checkpointed to `.pi/state.json` at each
  stage barrier (`runner.ts:1029` `persistState`; `workflow/state.ts:76-79`; path
  `runner/layout.ts:21`). `.pi/run.json` (`status.ts:129-148`) + `.pi/workflow.json` (`runner.ts:957-960`)
  are the other run-dir state files. The `.pi/` layout is SDK-owned and per-run (`runner/layout.ts:1-11`).

---

## 3. Reference (competitor) — checkpoint semantics, with file:line

PDW's `checkpoint(promptText, options)` (`vendors/pi-dynamic-workflows/src/workflow.ts:788-828`):

- **`CheckpointOptions`** (`workflow.ts:173-185`): `kind?: "confirm" | "input" | "select"`,
  `choices?: string[]`, `default?: unknown`, `headless?: "default" | "abort"` (default `"default"`),
  `timeoutMs?`.
- **Journaled + replayable**: a `callIndex` + `callHash = hashCheckpoint(prompt, options)`; on resume a
  cached reply with a matching hash REPLAYS (`workflow.ts:803-810`), and every live reply is journaled
  via `onAgentJournal({ index, hash, result })` (`workflow.ts:826`).
- **Headless default never hangs**: with no `confirm` callback and `headless !== "abort"`, it takes
  `options.default ?? true` and journals THAT (`workflow.ts:822-827`); `headless: "abort"` throws.
- **UI seam**: the human reply arrives through an **in-process `confirm` callback** threaded from a
  UI-bearing tool context (`workflow.ts:91-96` `confirm?: (promptText, options) => Promise<unknown>`;
  called at `workflow.ts:814-815`).

**ADOPT** (semantics, translated to our model):
- the `kind` / `choices` / `default` / `headless` / `timeoutMs` vocabulary verbatim as the marker
  schema;
- the **journaled reply** idea — record the reply into `.pi/state.json` so a future content-hash
  resume (§G4) can replay it instead of re-asking.

**REJECT** (mechanism — does not fit a multi-process, filesystem-coordinated fleet):
- the **in-process `confirm` callback** — we have no shared process; the runner and the GUI live in
  different processes, so the reply must cross via the **filesystem**, not a function reference.
- the **TUI-only / single-surface** delivery — we surface through the ONE `observe` run-view stream so
  GUI **and** console **and** (later) TUI are interchangeable couriers.

---

## 4. End-to-end design — the labeled data-flow walk

The checkpoint is a **node** whose "work" is *ask a human*. It writes a marker, BLOCKS its own lane
watching for a reply file, validates the reply, journals it, and finishes `ok`. observe reads the
marker into the run-view; the GUI renders the panel; the GUI/console writes the reply file.

### Trigger — a `checkpoint` NODE KIND (decision: node, not hook, not policy)

**Choice: a new node kind**, carried as an optional `checkpoint` block on the node envelope. Rationale,
grounded in the code:
- A **hook** is deterministic and "never an LLM" and cannot block on outside input by contract
  (`types.ts:37,232,287-307`; `Hook.run` is a shell string or a pure fn). A wait-for-human is neither
  deterministic nor bounded — it does not belong in a hook.
- A **policy** is a verdict→consequence over integrity checks AFTER a node ran
  (`types.ts:152-155`, `runner.ts:704-711`) — it cannot *initiate* a question.
- A **node** already owns the lifecycle the checkpoint needs: a sandbox-free, no-`pi`-spawn branch in
  `runNode` that writes files, blocks, and resolves to a `NodeStatusRecord` (`runner.ts:488-828`). A
  checkpoint node has **no tools, no model spawn** — it is a runner-internal lane.

**Schema additions** (authoring + runtime), mirroring exactly how `timeoutMs`/`retries` were threaded
(template → schema → loader → `TemplateNode` → `NodeSpec`):

- `node.schema.ts` (`schema/node.schema.ts:23-158`): add an optional top-level `checkpoint` object —
  `{ kind: "confirm"|"input"|"select", prompt: string, choices?: string[], default?: <any>,
  headless: "default"|"abort" (default "default"), timeoutMs?: integer }`, `additionalProperties:false`.
  A `checkpoint` node makes `contract.artifacts` optional (its proof is the journaled reply, not a file).
- `TemplateNode` (`template/types.ts:15-47`): add `checkpoint?: { … }` to match.
- `NodeSpec` (`types.ts:17-49`): add `checkpoint?: CheckpointSpec` (a new exported interface alongside
  `NodeOps`), carried verbatim by the loader the way `ops` is (`types.ts:48`).
- The compiler treats a checkpoint node like any node for DAG/stage placement — its `deps` order it
  after the nodes whose output the human is reviewing (data-flow edges via `io.reads`,
  `types.ts:187-194`).

### Pause + checkpoint state — where the lane blocks (no deadlock)

In `runNode` (`runner.ts:488`), BEFORE the tool-bind check (`runner.ts:499`), branch on
`node.checkpoint`. The checkpoint branch:

1. Writes the **marker file** (below) into the run dir.
2. Records the pending state into `.pi/state.json` under a reserved `__checkpoints__` channel (via the
   same `persistState` used at the barrier, `runner.ts:1029` / `state.ts:76`) so a **crash mid-wait
   resumes the wait** — on restart the runner sees an unresolved entry and re-enters the wait instead
   of re-asking. Shape: `__checkpoints__: { [nodeId]: { status: "pending"|"resolved", hash, askedAt,
   reply? } }`.
3. **Blocks this lane only** by `await`ing a `waitForReply(runDir, nodeId, { timeoutMs })` that polls
   the reply file (reuse the `watchRun` poll cadence default 700ms, `watch.ts:63`) until the reply
   appears OR `timeoutMs` elapses. Because each node runs in its own `Promise` inside the stage's
   `Promise.all` (`runner.ts:1017`), an `await` here parks ONLY this lane; sibling lanes in the same
   stage keep running, and downstream stages stay gated behind the normal barrier. The DAG is respected
   because the checkpoint node's `deps` already placed it.
4. On reply: validate (below) → journal into `.pi/state.json` → `finishNode(… 'ok' …)`
   (`runner.ts:831`). On timeout with `headless:"default"`: take `default`, journal it, finish `ok`. On
   timeout with `headless:"abort"`: `finishNode(… 'error' …)` so the run HALTS at the barrier
   (`runner.ts:1041`).

A new run option `RunOptions.checkpointReply?: 'interactive' | 'default'` (default `'default'`) lets a
truly detached run skip the wait and take the default immediately; an attended run (GUI/console open)
uses `'interactive'` and waits up to `timeoutMs`.

### Marker file — schema + path

Lives in the **run dir** (per-repo data — honors the SDK/data boundary, CLAUDE.md). New layout helper
in `runner/layout.ts` (alongside `nodeIoFile` etc., `layout.ts:29-46`):

`${run}/.pi/checkpoints/<nodeId>.json` — written by the runner:

```json
{
  "nodeId": "approve-plan",
  "label": "Approve the plan",
  "kind": "select",
  "prompt": "Ship plan A or B?",
  "choices": ["A", "B"],
  "default": "A",
  "headless": "default",
  "status": "pending",
  "askedAt": "2026-06-25T12:00:00.000Z",
  "hash": "<sha256(prompt+kind+choices+default)>",
  "timeoutMs": 600000
}
```

The reply file lands **beside it**: `${run}/.pi/checkpoints/<nodeId>.reply.json` (written by the
courier — GUI or console):

```json
{ "nodeId": "approve-plan", "hash": "<echoed marker hash>", "value": "B",
  "by": "gui|console", "at": "2026-06-25T12:00:42.000Z" }
```

`hash` is echoed so the runner rejects a reply for a *different* question (stale run / re-asked
checkpoint). The runner deletes neither file; it flips `status` to `resolved` in `.pi/state.json` (the
journal), and the marker `status` is recomputed by observe from the journal (below) so a polling reader
sees the transition.

### Surface via observe — the load-bearing integration (named file + field shape)

The checkpoint becomes a **field on `RunViewNode`** in `buildRunView` (`observe/runView.ts:179-245`),
AND a derived **status** so existing status-driven UI lights up.

1. In `buildRunView`, after reading a node's record (`runView.ts:199-218`), read
   `${runDir}/.pi/checkpoints/<id>.json` if present, and cross-check `.pi/state.json`'s
   `__checkpoints__[id].status`. Attach to the pushed node (`runView.ts:234-244`):

   ```ts
   // RunViewNode (observe/runView.ts:29-65) — NEW optional field:
   checkpoint?: {
     status: 'pending' | 'resolved';
     kind: 'confirm' | 'input' | 'select';
     prompt: string;
     choices?: string[];
     default?: unknown;
     reply?: unknown;       // present once resolved (from the journal)
     askedAt?: string;
     hash: string;
   };
   ```

2. **Derived status `awaiting-input`.** Add `'awaiting-input'` to `NodeStatus`
   (`runner/status.ts:18-26`) and make a node read `awaiting-input` whenever its checkpoint marker
   `status === 'pending'`, computed in `deriveStatus` (`observe/read.ts:55-62`) — which both
   `readRunModel` (lean) and `buildRunView` honor. This is verified-not-trusted in spirit: the run-view
   shows `awaiting-input` because the marker exists on disk, not because a record claims it.

3. **`watchRun` streams it for free.** A pending→resolved transition is a DERIVED status change, so
   `watchRun` already yields a `{kind:'node-status', id, status}` delta when the node flips to/from
   `awaiting-input` (`observe/watch.ts:99-104`) — no new update kind needed for the *transition*. To
   carry the full panel payload, the GUI fetches the run-view (`/__piflow/run-view/<run>`,
   `vite.config.ts:165-201`) whose node now carries `checkpoint`, OR — leaner — the snapshot
   `RunModel.nodes[]` (`observe/types.ts:63-77`) gains the same optional `checkpoint` so the SSE
   `snapshot` carries it without a second fetch. (Decision: put it on BOTH `NodeView` and `RunViewNode`
   so the live SSE snapshot and the on-demand run-view agree — they are explicitly kept supersets,
   `observe/types.ts:5-9`.)

### GUI render — notification + HITL panel

The GUI already folds the SSE in `runStream.ts` (`reduce`, `runStream.ts:75-95`) and the Companion
reads the shared model (`Companion.tsx:45-49`).

1. **Detect**: in `runStream.ts`, when a node's status becomes `awaiting-input` (or the snapshot's node
   carries `checkpoint.status === 'pending'`), surface it in `RunStreamState` as a new
   `pendingCheckpoint: { run, nodeId, kind, prompt, choices, default, hash } | null` (computed in
   `reduce`, `runStream.ts:75`). `whereAreWe` (`runStream.ts:148-164`) gains an
   `awaiting input — <label>` branch so the Companion context line announces it.
2. **Notification**: the Companion header/launcher (`Companion.tsx:64-110`) shows a badge when
   `pendingCheckpoint != null` (a dot on the `ds-companion-launch` button, `Companion.tsx:104`).
3. **HITL panel**: render a new `<CheckpointPanel>` inside the Companion body (replacing the empty/log
   area, `Companion.tsx:79-88`) OR on the focused node's `NodeHud` (`NodeHud.tsx:97`) keyed off
   `data.rv.checkpoint` — a `confirm` → two buttons (Approve/Reject), `input` → a text field, `select` →
   a `choices` button group. NodeHud already renders the node's run-view (`NodeHud.tsx:98`), so a
   `checkpoint` field there is the natural home; the Companion badge is the run-level notification.
4. **Submit**: the panel POSTs to the new reply endpoint (below), then optimistically clears
   `pendingCheckpoint`; the next SSE status delta confirms `resolved`.

### Reply path — the step-2 talk-back (NEW POST endpoint)

A NEW Vite middleware in `gui/vite.config.ts` (a sixth plugin alongside the five at
`vite.config.ts:329`), `piflowCheckpointReply()`:

- **Route**: `POST /__piflow/checkpoint/<run>` (the existing GET handlers match `req.url` + `next()`;
  this one additionally gates on `req.method === 'POST'`, `vite.config.ts:91-94` pattern).
- **Body**: `{ nodeId, hash, value }` (read from the request stream; JSON-parse).
- **Resolve the run dir** via the SAME live-index helper the GETs use — `resolveRunDir(run)`
  (`vite.config.ts:40-53`) — honoring the data-boundary rule (no run path hardcoded; resolved from the
  global `~/.piflow` index).
- **Write** `${runDir}/.pi/checkpoints/<nodeId>.reply.json` with `{ nodeId, hash, value, by:"gui",
  at }`. The endpoint is a **dumb courier** — it does NO validation beyond "the run exists and nodeId is
  a safe slug"; it writes the file and returns `202 Accepted`. (Containment: reject a `nodeId` with
  `/`/`..` so the write stays inside `.pi/checkpoints/`, mirroring the realpath containment in
  `piflowFile`, `vite.config.ts:239-250`.)
- **Response**: `202 { ok: true }` immediately (the runner picks it up on its next poll). A `404` if the
  run is unknown.

### Resume — runner validates, journals, unblocks

`waitForReply` (in `runner.ts`, the checkpoint branch) on seeing the reply file:

1. **Validate** (the runner is the authority):
   - reply `hash` === marker `hash` (else: stale/re-asked → ignore the file, keep waiting);
   - `kind:"select"` ⇒ `value ∈ choices`; `kind:"confirm"` ⇒ `value` is boolean; `kind:"input"` ⇒
     `value` is a non-empty string;
   - a malformed/unparseable reply file is ignored (the wait persists) — never crashes the lane.
2. **Journal**: set `.pi/state.json` `__checkpoints__[nodeId] = { status:"resolved", hash, reply:value,
   resolvedAt }` via `persistState` (`state.ts:76`). This is the §G4 resume replay key.
3. **Unblock**: resolve the wait, `finishNode(… 'ok' …)` with `summary` = the chosen value; the lane
   returns and the stage barrier proceeds (`runner.ts:1017-1041`).
4. **Headless / no-reply**: on `timeoutMs` elapse with `headless:"default"` (or
   `RunOptions.checkpointReply === 'default'`), take `node.checkpoint.default`, journal THAT, finish
   `ok`. With `headless:"abort"`, finish `error` → the run HALTS cleanly at the barrier.

### Console-as-courier branch

The console (Claude Code in the terminal) resolves the SAME checkpoint by writing the SAME reply file —
`${runDir}/.pi/checkpoints/<nodeId>.reply.json` — directly (a one-line `Write`), or by hitting the same
POST endpoint. Because the runner only watches the file and validates it, GUI and console are
interchangeable couriers; neither is privileged. (A tiny `piflowctl reply <run> <nodeId> <value>` CLI verb
is the ergonomic console path; v1 can ship without it since a direct file write suffices.)

---

## 5. Monitor-only relaxation — the explicit justification

The GUI/TUI are "monitor-only twins." A reply-write is the FIRST sanctioned write-back from a viewer
into a run. It stays **verified-not-trusted** by construction:

- **The GUI/console is only a COURIER.** It writes a *reply file* — a request, not a state mutation. It
  touches `.pi/run.json` / `.pi/state.json` not at all; it writes one well-named file under
  `.pi/checkpoints/`. The POST endpoint does zero semantic validation (§4 reply path).
- **The RUNNER is the sole authority.** It independently re-validates every reply against the marker it
  itself wrote (hash match, kind/choices/shape, non-empty), and a failed/stale/malformed reply is
  IGNORED — the wait persists, the run state is never corrupted (`runner.ts` checkpoint branch, §4
  resume). This mirrors the existing "verified, not trusted" rule where status is RE-DERIVED on disk and
  a self-report never wins over reality (`observe/read.ts:50-62`, `status.ts:6-9`).
- **It honors the SDK/data boundary** (CLAUDE.md): the marker/reply/journal are per-run data in the RUN
  dir (`.pi/checkpoints/`, `.pi/state.json`), NEVER in `packages/*`; the GUI resolves the run dir
  through the global `~/.piflow` index (`resolveRunDir`, `vite.config.ts:40-53`), never a baked path.
  No collected data enters the repo.
- **Bounded**: the only writable surface is a reply to a question the runner *already asked* (a marker
  must exist). A reply with no matching pending marker is inert.

---

## 6. TUI forward path — the named seam only

No TUI UI is designed here; only the seam is named so the panel drops in later:

- **Data-in seam**: `subscribeRun` (`tui/model.mjs:283-310`) already folds the shared `watchRun` stream
  and `adaptModel` (`tui/model.mjs:135-201`) maps each node — add `checkpoint`/`awaiting-input`
  passthrough there (the `RunViewNode.checkpoint` field arrives via `overlayRichTelemetry`,
  `tui/model.mjs:77-94`). One field, no new reader.
- **Render seam**: the per-node inspector in `tui/components.mjs` (the node detail block around
  `components.mjs:200-229`) is where an "AWAITING INPUT — <prompt>" section renders.
- **Reply seam**: Ink `useInput` (`tui/components.mjs:431-453`) is the keypress hook; a future
  `c`-to-confirm / number-to-select handler writes the SAME `.pi/checkpoints/<id>.reply.json` (TUI runs
  in the repo, so a direct `fs.writeFile` is the courier — identical to the console path).

So the TUI seam = `{ subscribeRun field passthrough, components inspector section, useInput →
reply-file write }`. Same marker, same reply file, same runner authority.

---

## 7. Edge cases & failure modes

- **Crash mid-wait** → the wait is checkpointed in `.pi/state.json` `__checkpoints__[id].status:
  "pending"` (§4 pause step 2). On restart the runner re-enters the wait (re-reads the marker, does NOT
  re-ask); a reply written while it was down is still on disk and is picked up on the first poll.
- **Double reply** → idempotent: the journal flips to `resolved` once; a second reply file with the same
  hash for an already-resolved node is ignored (the runner only reads the reply while `status:pending`).
- **Late reply after default taken** → once the runner journaled the `default` (timeout/headless), the
  node is `resolved`; a reply arriving later finds a resolved journal entry and is inert (it does not
  re-open or re-run the node).
- **Malformed reply** (bad JSON, wrong shape, choice ∉ choices, empty `input`) → validation rejects it;
  the reply file is IGNORED and the wait persists (never crashes the lane, mirroring the lane-isolation
  rule `runner.ts:511-516`).
- **Multiple concurrent checkpoints** (≥2 checkpoint nodes in one parallel stage) → each is its own
  `<nodeId>.json` marker + `<nodeId>.reply.json`, its own `__checkpoints__[nodeId]` journal slot, its
  own awaiting lane. The GUI shows N pending panels keyed by nodeId. No collision because every path is
  nodeId-scoped (the same per-node isolation as `.pi/nodes/<id>/`, `layout.ts:27`).
- **GUI not running / headless** → no courier writes a reply; on `timeoutMs` (or immediately when
  `RunOptions.checkpointReply==='default'`) the runner takes the `default` and journals it — the run
  never hangs. `headless:"abort"` halts loudly instead.
- **Reply for a stale run** (a re-asked checkpoint after an edit; §G4 resume changed the question) → the
  marker hash changes, so an old reply's echoed `hash` no longer matches → rejected; the runner waits
  for a reply to the CURRENT question.

---

## 8. Test plan — tests that FAIL when HITL is wrong (named seams, no coverage-only)

Driven through the runner's injectable seams (`buildCommand`/`execRunner` are already stubbed offline,
`runner.ts:114-117`; checkpoint adds no `pi` spawn so it is fully offline-testable):

1. **Marker-written-and-blocks** (`runner.ts` checkpoint branch): run a workflow with one `checkpoint`
   node and `checkpointReply:'interactive'`, NO reply written. ASSERT: `.pi/checkpoints/<id>.json` exists
   with the right `kind/prompt/choices/default/hash`; the node status derives `awaiting-input`
   (`observe/read.ts deriveStatus`); the run does NOT complete within a short timeout. FAILS if the
   marker isn't written or the lane doesn't block.
2. **Reply unblocks with the right value**: while (1) waits, write
   `.pi/checkpoints/<id>.reply.json` with a valid `value` + matching `hash`. ASSERT: the node finishes
   `ok`, `summary`/journal carry that value, `__checkpoints__[id].status === "resolved"`, the run
   completes ok. FAILS if the runner ignores a valid reply or resumes with the wrong value.
3. **Headless takes the default and journals it**: run with `checkpointReply:'default'` (or a 1ms
   `timeoutMs`, `headless:"default"`), no reply. ASSERT: node `ok`, journal `reply === default`, run
   completes without hanging. FAILS if it hangs or journals something other than the default.
4. **Malformed/invalid reply is rejected and the wait persists**: write a reply with `value` NOT in
   `choices` (or empty for `input`, or a mismatched `hash`). ASSERT: node still `awaiting-input`, journal
   still `pending`, run still incomplete; THEN write a valid reply → it unblocks. FAILS if a bad reply
   resolves the node or corrupts state.
5. **`headless:"abort"` halts**: timeout with `headless:"abort"`. ASSERT: node `error`, run `ok:false`,
   downstream nodes never ran (`runner.ts:1041`).
6. **observe surfaces the field** (`observe/runView.ts` + `observe/read.ts`): build the run-view over a
   run dir with a pending marker. ASSERT: `RunViewNode.checkpoint.status==='pending'` and node
   `status==='awaiting-input'`; after resolution the SAME builder shows `resolved` + `reply`. A
   `watchRun` over the transition yields a `node-status` delta to/from `awaiting-input`
   (`observe/watch.ts:99-104`). FAILS if the field/derived-status is absent (the GUI would never light up).
7. **Crash-resume re-enters the wait**: write a pending marker + `__checkpoints__` entry, then run
   `--from` the checkpoint stage with no reply. ASSERT: it re-enters the wait (does NOT re-ask / does NOT
   double-journal); a reply then resolves it once.

**Observable seams named**: `.pi/checkpoints/<id>.json` (marker), `.pi/checkpoints/<id>.reply.json`
(reply), `.pi/state.json` `__checkpoints__` (journal), `RunViewNode.checkpoint` + `NodeStatus
'awaiting-input'` (observe surface), `POST /__piflow/checkpoint/<run>` (courier).

---

## 9. Files to touch — checklist (change · rough size)

**packages/core (runner + types + observe):**
- `src/types.ts` — add `CheckpointSpec` + `NodeSpec.checkpoint?` + `NodeIntent` passthrough. ~15 lines.
- `src/workflow/template/types.ts` — `TemplateNode.checkpoint?`. ~5 lines.
- `src/workflow/template/schema/node.schema.ts` — `checkpoint` object schema; make `artifacts` optional
  for checkpoint nodes. ~25 lines.
- `src/workflow/template/loader.ts` — carry `checkpoint` verbatim into the spec (mirror `ops`). ~5 lines.
- `src/runner/layout.ts` — `checkpointMarkerFile` / `checkpointReplyFile` / `checkpointsDir` helpers. ~10 lines.
- `src/runner/status.ts` — add `'awaiting-input'` to `NodeStatus`. ~1 line.
- `src/runner/runner.ts` — the checkpoint branch in `runNode` (write marker, persist pending journal,
  `waitForReply` w/ poll+timeout, validate, journal, finish) + `RunOptions.checkpointReply`. ~90 lines.
- `src/observe/runView.ts` — read the marker+journal, attach `RunViewNode.checkpoint`. ~25 lines.
- `src/observe/read.ts` — `deriveStatus` → `awaiting-input` when a pending marker exists; attach
  `NodeView.checkpoint`. ~15 lines.
- `src/observe/types.ts` — `NodeView.checkpoint?` + `'awaiting-input'` in the status union. ~8 lines.

**gui:**
- `gui/vite.config.ts` — `piflowCheckpointReply()` POST plugin + register it. ~45 lines.
- `gui/src/data/runStream.ts` — `pendingCheckpoint` in state + `reduce` detection + `whereAreWe`
  branch + a `submitCheckpoint(run,nodeId,hash,value)` POST helper. ~35 lines.
- `gui/src/components/Companion.tsx` — notification badge + `<CheckpointPanel>` (or delegate to NodeHud);
  wire submit. ~50 lines.
- `gui/src/components/NodeHud.tsx` — render `data.rv.checkpoint` as the HITL widget on the focused node.
  ~40 lines.

**tui (seam only — not built in v1):**
- `tui/model.mjs` — passthrough of `checkpoint`/`awaiting-input` in `adaptModel`/`overlayRichTelemetry`.
  ~6 lines. (Render + `useInput` reply handler deferred.)

---

## 10. Open decisions

1. **node-kind vs hook vs policy** — recommended: **node kind** (§4). Alternative kept on the table: a
   pre-node "gate hook" that blocks before a normal node runs — rejected because hooks are contractually
   deterministic/non-blocking (`types.ts:287-307`).
2. **Reply timeout default** — proposed `timeoutMs` default per node, and a run-level
   `RunOptions.checkpointReply` (`'interactive'` waits, `'default'` takes the default immediately).
   Open: the numeric default (10 min? infinite-until-killed for attended runs?).
3. **Where marker/reply files live** — proposed `${run}/.pi/checkpoints/` (per-run, beside the journal).
   Open: vs a single `${run}/.pi/checkpoints.json` map (simpler observe read, but loses per-node
   isolation that parallels `.pi/nodes/<id>/`).
4. **Console path in v1?** — proposed: YES for the raw file-write/POST courier (free, since the runner
   only watches the file); the ergonomic `piflowctl reply` CLI verb is OPTIONAL/post-v1.
5. **Snapshot vs run-view for the panel payload** — proposed: put `checkpoint` on BOTH `NodeView`
   (so the live SSE snapshot carries it) and `RunViewNode` (so the on-demand run-view agrees). Open: or
   keep it only on the run-view and have the GUI fetch on the `awaiting-input` status delta (one extra
   round-trip, less duplication).

---

## ⚠️ Discrepancies (referenced line ≠ reality)

- **stdin closure is a COMMENT, not a flag.** The task brief said stdin is "deliberately CLOSED in
  `command.ts` (~line 55)". Reality: `command.ts:54-56` is a doc-comment stating the *intent* ("Closes
  stdin … hangs a headless CLI forever"); the built `parts` array (`command.ts:61-77`) emits NO stdin
  redirect — closing stdin is the runner/provider's responsibility, not a `pi` flag. The claim "no HITL,
  stdin not available to a headless node" still holds; the mechanism is just not a flag in this file.
- **`types.ts:151` policy actions** — the `PolicyAction` union is at `types.ts:152` (the doc-comment is
  `:151`). Same content.
- **`runner.ts:1014` stage map / `:1026` checkpoint** — the actual per-stage `Promise.all` is
  `runner.ts:1017`; the `persistState` barrier checkpoint is `runner.ts:1029`. Off by ~3 lines from the
  brief; behavior as described.
- **`runView.ts:27` RunTokens** — confirmed exactly (`observe/runView.ts:27`).
- **GUI middleware lines** — the brief said "~lines 90-155" for the SSE; confirmed
  (`piflowRunStream` `vite.config.ts:90-155`). No POST path anywhere in the file (confirmed by reading
  all five plugins + the default export `vite.config.ts:328-331`).
- **Companion stub** — the brief said `~line 55`; confirmed exactly (`Companion.tsx:55`).
- **Competitor `confirm` callback / CheckpointOptions** — brief said "~91-96" and "~173-185"; confirmed
  exactly (`workflow.ts:91-96`, `:173-185`); `checkpoint()` body `:788-828` (brief said ~793-828).

---

## Self-check (Required bar — PASS/FAIL + evidence)

1. **Every existing-code claim cites a file:line read** — **PASS**. All citations
   (command.ts, types.ts, runner.ts, observe/*, status.ts, layout.ts, state.ts, vite.config.ts,
   Companion.tsx, NodeHud.tsx, runStream.ts, tui/model.mjs, tui/components.mjs, node.schema.ts,
   template/types.ts, vendors/…/workflow.ts) come from files read this session; discrepancies recorded.
2. **Surfaces through the ONE observe run-view stream (named file + field shape), not a side channel**
   — **PASS**. `RunViewNode.checkpoint` (+ `NodeView.checkpoint`) in `observe/runView.ts:29-65` /
   `observe/types.ts:19-38`, with a derived `NodeStatus 'awaiting-input'` in
   `observe/read.ts:55-62` streamed by `watchRun` (`observe/watch.ts:99-104`). No side channel.
3. **Full bi-directional path specified hop-by-hop with the file at each hop** — **PASS**. §4 walks
   trigger(runner.ts/types.ts/schema) → pause+state(runner.ts/state.ts) → marker(layout.ts) →
   observe(runView.ts/read.ts/types.ts) → SSE(watch.ts→vite.config.ts) → GUI(runStream.ts/Companion.tsx/
   NodeHud.tsx) → reply POST(vite.config.ts) → reply file → runner validate+journal+resume(runner.ts).
4. **Headless-default AND crash-mid-wait both handled concretely** — **PASS**. Headless: §4 + §7 take
   `default`, journal it (mirrors competitor `workflow.ts:822-827`). Crash: `__checkpoints__` in
   `.pi/state.json` (`state.ts:76`), re-enter wait on restart (§4 step 2, §7, test 7).
5. **Monitor-only relaxation justified as verified-not-trusted, runner = authority** — **PASS**. §5:
   GUI=courier (writes a reply file only), runner re-validates every reply (hash/kind/choices/shape) and
   ignores bad/stale/malformed ones; honors the SDK/data boundary.
6. **Test plan names seams that FAIL on a broken reply/validate/resume** — **PASS**. §8 tests 1–7 over
   `.pi/checkpoints/*`, `__checkpoints__`, `RunViewNode.checkpoint`/`awaiting-input`, the POST endpoint;
   each fails on a specific break (no marker, ignored valid reply, hang, accepted bad reply, missing
   observe field, no crash-resume).

**Must-NOT audit**: no source edited (this doc is the only Write); no invented line numbers (every cited
line verified, mismatches in **⚠️ Discrepancies**); no per-run data placed in `packages/*` (markers/
replies/journal live in the run dir).
