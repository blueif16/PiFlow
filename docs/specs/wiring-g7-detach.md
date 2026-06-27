# Wiring G7 — Background + auto-continue delivery

> Status: DESIGN (research 2026-06-25). Closes §G7 of `competitive-gaps-vs-pi-dynamic-workflows.md`.
> Severity LOW–MED · effort LOW. All `file:line` verified against the working tree.

## TL;DR — the gap is much smaller than the doc implies

piflow runs are **already durable, detached, filesystem-coordinated** — they survive the controller
dying (the §3 thesis). PDW's hard problem (keeping an in-process run alive past the turn) **does not
exist for us**. The only genuinely-missing pieces are narrow: (1) the CLI cannot tell a run "you are
unattended, never park on a checkpoint," and (2) there is no liveness signal to tell a *crashed*
detached run from a *running* one. Everything else (durable completion fact + a live stream) is shipped.

## Verified current state

- **Foreground-only — TRUE, line ref stale.** The blocking call is `runFromTemplate(...)` at
  `packages/cli/src/run.ts:278-296` (awaited; returns only after the DAG halts); bin body
  `runRunCli` at `:318-338`. **No `--detach`/daemon/disown anywhere** (grep clean; the only
  `detached:true` hits are per-node child process-group leadership in `sandbox/{local,worktree,seatbelt}.ts`,
  unrelated). *(Doc §G7 cites `run.ts:243-288` — correct it to `:278-296`.)*
- **Completion is already a durable, pollable fact.** `runWorkflow` writes `.pi/run.json` atomically
  (temp+rename, `runner/status.ts:134-153`) with terminal `{done:true, ok:boolean}` set once at the end
  (`runner.ts:1593-1600`). `watchRun` (`observe/watch.ts:62`) is an async iterable polling that file at
  700ms and emits a `{kind:'done'}` delta (`:121-124`). Surfaced three ways: CLI `piflowctl watch`
  (`cli/watch.ts:60`; `--notify` is a **no-op stub** `:46-52`), CLI `piflowctl status`, and the GUI SSE
  bridge `GET /__piflow/stream/<run>` (`gui/vite.config.ts:90-156`, breaks on `done` at `:141`).
- **No liveness/heartbeat, no PID file.** "Is it finished?" = `run.json.done`. "Is it still alive?" has
  **no positive signal** — a crashed controller leaves `done:false` forever. (`run.json.updatedAt`
  advances on every `writeStatus`, `status.ts:135` — the cheap heartbeat candidate.) `piflowctl watch`
  already *parses* a `--dead-stall` flag but leaves it inert (`watch.ts:106`).
- **Stable run handle — YES** (the `fix/canonical-run-location` work). Every run has a canonical home
  `.piflow/<wf>/runs/<id>/` with an auto-minted name (`run.ts:231-253`); `--out` is ignored for a
  canonical template run.
- **G5 already shipped the "never hangs unattended" half.** `RunOptions.checkpointReply:
  'interactive' | 'default'` (`runner.ts:246`): a detached run passes `'default'` so checkpoints take
  their headless default immediately instead of parking (`runner.ts:662-694`, `1381`). **The CLI never
  sets this field** (grep: zero hits in `cli/run.ts`) — this is the load-bearing gap.
- **Companion talk-back is a commented stub** — `gui/src/components/Companion.tsx:55`; it already
  subscribes to live telemetry via `useRunStreamContext` (`:45`).

## PDW reference — and why it does NOT transfer

PDW is background-by-default *because it must be*: the workflow runs in-process inside the assistant's
turn (`workflow-tool.ts:206-217` → `manager.startInBackground`), kept alive by an in-memory
`WorkflowManager`, with an `installResultDelivery` hook injecting the result back into the chat
(`:203-205,351-352`). **piflow has the inverse property** — the run is already a durable multi-process
fleet that survives controller death. So the missing piece is NOT "keep it alive" and NOT an in-process
manager; it is only **(a) don't block the console, (b) signal completion** — both already solvable with
the shipped `run.json.done` + `watchRun`. Porting `WorkflowManager` would re-implement the in-process
lifecycle piflow deliberately replaced (doc §4).

## Options

- **A — Status quo, formalized: lean on Claude Code `Bash run_in_background` + poll.** The console *is*
  Claude Code; it already backgrounds `piflowctl run` and the harness re-invokes on completion;
  `run.json.done` is the durable truth either way. *Pro:* zero core change. *Con:* a bare-terminal human
  still blocks; no first-class "this run is unattended" marker, so a checkpoint node parks forever unless
  the caller remembers `checkpointReply:'default'` — which the CLI can't pass today.
- **B (recommended) — thin `--detach` flag.** (i) thread `checkpointReply:'default'`, (ii) redirect the
  log into the canonical run dir, (iii) optionally spawn+disown. *Pro:* makes "background, never hangs"
  a property of the *run*, not of how the console launched it; works for a bare terminal too. *Con:* the
  spawn+disown part is ~redundant with the harness; the real value is the `checkpointReply` thread.
- **C — full deliver-back (Companion talk-back).** Wire `sendToPi` + a completion push into the GUI.
  *Con:* highest effort, worst fit — the GUI is a static viewer (CLAUDE.md), and auto-continue is the
  harness's job. A UX nicety, not the missing capability.

## Recommendation — Option B, scoped to what's genuinely missing

~80% of G7's value is the `checkpointReply` thread + a real `--notify` + an `updatedAt`/dead-stall
liveness signal — all reusing shipped machinery. The spawn+disown is the most-redundant part; start
without it and add it only if a bare-terminal human workflow demands it.

**Touch-points (CLI only; core untouched):**
1. `cli/run.ts` — add `detach?: boolean` to `ParsedRunArgs` + `parseRunArgs` (`:87-144`). When `detach`,
   thread **`checkpointReply: 'default'`** into the `runFromTemplate(...)` opts at `:278-296` (the field
   already exists on `RunOptions`; `RunFromTemplateOpts extends RunOptions` at `entry.ts:82` and is
   spread into `runWorkflow` at `entry.ts:112`, so **no core change** — it just flows through). *This one
   line is the most important part.*
2. Detach mechanics (when `--detach`): `spawn` a re-exec of the argv minus `--detach`, `detached:true`,
   `stdio:['ignore', fd, fd]` → `<canonicalHome>/.pi/console.log` (run dir resolved at `run.ts:253`
   *before* launch), `.unref()`, print `{runId, runDir, "poll: piflowctl watch <runDir>"}`, return.
3. Wire the inert `piflowctl watch --notify` (`watch.ts:46-52`) to a real `osascript`/`notify-send`.
4. **(prerequisite for trustworthy monitoring)** expose `run.json.updatedAt` on the `RunModel`/`RunUpdate`
   so the existing-but-inert `--dead-stall` flag can declare a dead-stall when `updatedAt` stops advancing.

**Composition:** G2 — limiter is internal to `runWorkflow`; a detached child enforces its own cap (note:
N concurrent detached runs ⇒ up to N×8 `pi` children, the cap is per-run not per-host — document it).
G4 — a detached run journals to its own `.pi/journal.json`; resume is identical to foreground. G5 —
`--detach ⇒ checkpointReply:'default'` is *the* composition (an attended background run omits `--detach`
and keeps `'interactive'` so the console answers via the checkpoint courier). observe — zero change; the
GUI auto-discovers the run via the live index and streams it.

## Test strategy (FAILS if detach/deliver is broken)

1. **`checkpointReply` threading (load-bearing).** `parseRunArgs(['tpl','--detach'])` ⇒ `detach:true`;
   drive `runTemplate` with a spy `runFromTemplate` (the injectable `RunDeps.runFromTemplate` seam at
   `run.ts:73`) and assert it received `checkpointReply:'default'` with `--detach`, and did **not** set
   it otherwise. **Fails today** (the CLI never passes the field).
2. **"Never hangs."** A workflow with a `checkpoint` node, `runWorkflow({checkpointReply:'default',
   checkpointWait:<spy>})`: assert it reaches `done:true` **without `checkpointWait` ever called** and the
   declared default is journaled. Dropping the `'default'` branch makes it hang → FAIL.
3. **Completion-detection.** Feed `watchRun` a temp run dir whose `run.json` flips `done:false→true`;
   assert exactly one `{kind:'done'}` then return.
4. **Detach mechanics.** Factor the spawn behind an injectable `detachSpawn` dep (mirror `RunDeps`);
   assert `detached:true`, `.unref()`, log fd inside `<runDir>/.pi/`, argv with `--detach` stripped, and
   the parent returns without awaiting.

## Risks & open questions

- **No liveness signal (pre-existing).** A crashed detached controller is indistinguishable from a
  running one via `done`. The `updatedAt` heartbeat + `--dead-stall` is the real prerequisite — arguably
  more valuable than the spawn flag.
- **Over-subscription:** N detached runs ⇒ N×8 `pi` processes; no host-global cap. Document or add an
  advisory lock (out of scope).
- **Is the spawn worth it at all?** Honest call: a defensible minimal G7 = `--detach` as a pure alias
  that sets `checkpointReply:'default'` + redirects the log, letting `&`/the harness own backgrounding —
  skip self-re-exec until a bare-terminal need appears.
