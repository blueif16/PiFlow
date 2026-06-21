# Runner child-process lifecycle + streaming-JSON parsing — research brief (2026-06-21)

> Targeted leg for M1's runner. The orchestration logic is already proven in
> `templates/pi-runner/run.mjs`; this brief only resolves the genuinely-uncertain TS specifics
> for a long-running headless CLI spawn and its newline-JSON event stream. **Legs run:** Exa
> (`web_search_exa` ×2) + Reddit (`macrocosmos/reddit-scraper`, r/node, 12 posts). No YouTube.
> Where a `run.mjs` behavior already answers a question, the proven port wins.

## (a) Robust child_process lifecycle for a long-running headless CLI

**The zombie failure mode is real and is the thing to design against.** A near-exact prior-art
pattern (Exa: `nexus-substrate/nexus-agents` commit afc51ff, 2026-05-25) documents it precisely:
the timeout path fires `SIGTERM` and resolves the parent promise *immediately* so callers don't
wait on a hung child — but if the child ignores `SIGTERM` (Node/CLIs with graceful-shutdown
handlers, or that hold stdio), the `'close'` event never fires and the process zombifies, and
"under sustained timeout pressure zombies accumulate holding file descriptors, API session
tokens, PIDs." Their fix is the pattern to copy:

- A primary timer fires `SIGTERM` and resolves the caller's promise.
- An escalation timer `SIGKILL_GRACE_MS` later (they use 5000; `run.mjs` uses **3000** — we follow
  `run.mjs`) checks `child.exitCode === null && child.signalCode === null` (still running) and
  force-reaps with `child.kill('SIGKILL')`, logging a warn first.
- **The escalation timer is `.unref()`'d** so it doesn't keep the event loop alive — process
  shutdown wins over the wait.
- Both timers are cleared from the `'close'` handler so a child that exits in the grace window
  never sees the second signal.

This is byte-for-byte the `run.mjs` `killChild` seam (904–911): a `killing` latch makes a
double-trip a no-op, `SIGTERM` then a 3 s `setTimeout` → `SIGKILL`. **Proven port wins; no change.**

**AbortController is the idiomatic cancel handle.** Node's `child_process.spawn` accepts a
`signal` option; `controller.abort()` is "similar to calling `.kill()`" and surfaces an
`AbortError` (Node docs; AppSignal 2025-02). `execa`'s `forceKillAfterDelay` (default 5 s) is the
same SIGTERM→SIGKILL escalation, confirming it as the community-standard shape. We expose the
watchdog as an injectable **kill seam** rather than wiring `spawn({signal})` directly, because the
frozen `Sandbox.exec`/`ExecOpts` spine carries no `AbortSignal` field — the runner owns the race at
its own level (see "kill seam" in the runner) and the default kill is best-effort.

**Descendant processes.** With `shell:true` (the `InMemorySandbox.exec` default), the agent runs as
a child of a shell, so killing only the shell can orphan grandchildren. r/node practitioners reach
for `tree-kill` / `taskkill /T /F` to reap the whole tree; one post shows `kill()` "doesn't kill the
child" when only the direct pid is signalled. We note this as a **known limitation of the in-memory
baseline** (the Seatbelt/cloud providers own real process-group reaping, ROADMAP M1/M3); the runner
classifies a timed-out node as `error` and moves on regardless of whether the orphan is fully reaped,
exactly as `run.mjs` does.

**Backpressure / no data loss.** `nodejs/node#7184` and thenodebook (2026-02) confirm piped-stdout
data can be lost if the consumer is slow or if you re-`resume()` a stream post-exit. The safe
consumption pattern is `readline.createInterface({ input: child.stdout })` with a `'line'` handler
(or `for await … of rl`, which applies natural backpressure) — never manual `setImmediate(pipe)`
after exit. `run.mjs` already uses `createInterface` on `child.stdout`. For the runner we consume
via `ExecOpts.onStdout` (the spine's streaming seam), accumulating a partial-line buffer.

## (b) Parsing a streaming newline-JSON event protocol with stall detection

- **`readline` is the standard, dependency-free NDJSON reader** (Jsonic guide, 2026-05; the
  canonical SO answer). One `'line'` event per `\n`; `JSON.parse` per line inside a `try/catch`
  (a cheap model can emit a non-JSON line — skip it, don't crash). This is exactly `run.mjs`'s
  `rl.on('line', …)` with a `try { JSON.parse } catch { return }`.
- **Partial lines split across chunks.** The recurring SO warning: a `'data'` chunk "might not
  break evenly between lines." Since the runner consumes via `ExecOpts.onStdout` (chunk strings, not
  a readable we can wrap in `readline`), we keep a `buffer` string, split on `\n`, process all but
  the last segment, and carry the trailing partial into the next chunk — the documented
  `filterStdoutDataDumpsToTextLines` accumulator. Flush the final partial on close.
- **Stall detection = "time since last event," not stream internals.** `run.mjs` (1059–1065) and the
  headless-invariants doc treat *silence* as the signal: stamp `lastEventAt` on every line; a
  heartbeat interval kills the node when `now − lastEventAt` exceeds a stall threshold *while no tool
  is in flight*. We port the simpler core: a node-level **stall watchdog** (no event/output for
  `stallMs`) and a **node-timeout watchdog** (total wall-clock > `nodeTimeoutMs`), both routing
  through the one kill seam. The stuck-delta repeat-kill (1034–1037) is deferred (it needs pi's
  `message_update` delta shape; not required for M1's must-haves of watchdog+halt+resume+status).
- **`lastJsonBlock` return-parse** (670–698): the forgiving fenced-JSON recovery (closed ```json
  fence → unclosed fence → last balanced `{…}` carrying a node-return key) is ported as-is — cheap
  models botch the fence even when the JSON is valid, so a strict parse false-fails a working node.

## What we port vs defer (net)

| Behavior | Decision |
|---|---|
| `killChild` SIGTERM→SIGKILL (3 s grace), `killing` latch, `.unref()` escalation | **Port** (run.mjs 904–911) |
| node-timeout + silent-stall watchdogs via heartbeat | **Port** (run.mjs 1055–1065) |
| `readline`/buffered newline-JSON parse with `try/catch` per line + partial-line carry | **Port** |
| `lastJsonBlock` forgiving return-parse | **Port** (run.mjs 670–698) |
| stuck-delta repeat-kill, tool-thrash kill, per-turn token timeline | **Defer** (pi-event-shape specific; not an M1 must-have) |
| real process-group / tree reaping | **Defer to Seatbelt/cloud providers** (in-memory baseline limitation, noted) |

Sources: Node.js `child_process` docs (v24/v26); `nexus-substrate/nexus-agents` commit afc51ff;
execa `docs/termination.md`; AppSignal "AbortController" 2025-02; Jsonic "JSON Streaming" 2026-05;
thenodebook "Standard I/O" 2026-02; `nodejs/node#7184`; SO "parse output line by line" (9781214);
r/node (zombie/`tree-kill`, partial-line buffering, in-memory long-running-fn threads).

## Review findings (M1 runner, 2026-06-21) — fixed in the runner + spine recommendations

Adversarial review of the landed M1 runner (`packages/core/src/runner/*`) against this brief and
`run.mjs`. Three correctness bugs were fixed IN the runner (each with a regression test that fails
without the fix); two need a frozen-spine change and are left as recommendations.

**Fixed (runner-local, faithful to run.mjs):**
- **Lane isolation.** `provider.create()` (and the post-create body) could throw OUTSIDE `runNode`'s
  try, so a single parallel lane's failure rejected the stage's `Promise.all` and crashed the WHOLE
  run, discarding the sibling lanes' completed work. `run.mjs`'s `runNode` (851–1176) ALWAYS resolves
  to a record and never rejects its lane. Fixed by guarding `create()` and wrapping the body so any
  throw becomes an `error` record; the run then halts cleanly. (MDN "Promise.all fail-fast";
  javascript.info "Dangerous Promise.all": an uncaught rejection can crash a Node process.)
- **Concurrent status writes.** Parallel lanes + the loop all write the one `run-status.json` via
  un-ordered, non-atomic `fs.writeFile`, and `finishNode` used a fire-and-forget `void writeStatus`.
  A polling watcher saw torn/partial files (reproduced: ~3/472 reads) and intermediate records could
  reorder. `run.mjs` got this for free (single-threaded synchronous `writeFileSync`). Fixed by a
  per-dir serialize-chain + atomic temp-file-then-`rename` publish, and by awaiting the write in
  `finishNode`. (OTel run-record consistency under concurrent writers.)

**Spine recommendations (NOT made — frozen `types.ts` / `sandbox/index.ts`):**
- **Kill seam needs a real handle (no-zombie / dispose race).** After a watchdog trip the runner
  abandons the wait and `dispose()` rm's the temp dir while the child may still be running — on the
  in-memory baseline the kill is a no-op (no pid), so the orphan keeps running (writing into a deleted
  dir; harmless but unreaped). The proven fix (this brief §(a): systemd `KillMode`, dumb-init session
  kill, `tree-kill`) needs a process handle. RECOMMEND: add an optional `kill(signal)`/`pid` to
  `Sandbox` (or have `exec` accept an `AbortSignal` on `ExecOpts`) so the seam can SIGTERM→SIGKILL the
  child's process group and `dispose()` can await its exit before rm. Until then the no-op is
  honestly contained + documented in `runNode`'s finally.
- **Close stdin on the spawn (headless hang).** `provider-and-headless.md`'s #1 invariant — a headless
  CLI with an open stdin pipe and no TTY hangs forever — is unmet: `InMemorySandbox.exec` spawns with
  default stdio (stdin piped/open), and the command builder (a string) cannot set it. RECOMMEND:
  `InMemorySandbox.exec` (and every real provider) spawn with `stdio: ["ignore", "pipe", "pipe"]`.
  Harmless for the self-exiting test stubs; load-bearing for a live `pi` spawn.
