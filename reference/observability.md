# Run observability — `docker logs` for a pi-flow run

> See what every node is doing — live or after the fact — and diagnose a failure at a glance, instead
> of re-running blind. This is the layer that turned a multi-session "W0 never-writes" mystery into a
> two-run root-cause. Code: `@piflow/core` `src/runner/{events,logs,audit}.ts`, `src/cli.ts`.

## The model (two files, one join)

A run writes two things under its **outDir**; everything here reads them — nothing else is needed.

| File | What it is | Written by |
|---|---|---|
| `<outDir>/run-status.json` | the **state**: per-node status/exit/timing/declared-artifacts, run verdict | `runWorkflow` (always) |
| `<outDir>/_pi/<id>.events.jsonl` | the **behavior**: that node's `pi --mode json` stream, slimmed + clock-stamped | the event recorder, when `recordEvents` is on (default) |

The join key is the node id. `run-status.json` says *what the verdict is*; the events archive says *what
the model actually did to get there*. The readers below correlate the two.

> **Slimming (why the archive stays small).** pi re-embeds the whole accumulated transcript in a
> `message` snapshot on **every** delta. The recorder strips that snapshot from every event (and the
> `assistantMessageEvent.partial`), so a node that would otherwise produce a 20 MB+ archive of duplicated
> text stays under ~1 MB — with zero loss (the unique content is in the kept deltas). Providers also cap
> their raw stdout buffer (`tailAppend`, last 8 MB) so that snapshot bloat can't crash a node with
> `RangeError: Invalid string length`.

## CLI — `piflow logs`

The portable front door (the `piflow` bin ships with `@piflow/core`; `piflow --help` prints this). Any
consumer can also expose it with a 2-line wrapper (see *Per-project wrapper*).

```
piflow logs [dir|run] [options]

  dir|run        a run dir (holds run-status.json) or a bare id (→ out/<id>). Default '.'.
  -f, --follow   attach live: stream every started node, roll forward until the run is done
      --node <id>  just one node (live if running, replay if done)
      --summary    post-run DIAGNOSIS (see below)
      --raw        unslimmed event lines (the firehose); default is the distilled one-per-action view
      --poll <ms>  follow poll interval (default 700)
```

### The three things you actually use

1. **Watch it live** — `piflow logs out/<run> -f`
   Distilled, one line per meaningful action, prefixed by node:
   ```
   [w0-classify] ▸ read templates/genres.json
   [w0-classify]   … thinking (6956 chars): I have all the info I need. Let me classify…
   [w0-classify] ▸ write out/<run>/spec/classification.json
   [w0-classify] ▸ submit_result {node,status,outputArtifacts,…}
   ```
   `▸ <tool> <target>` = a tool call; `… thinking` / `␃ says` = a model turn summary; `✕` = stderr.

2. **Diagnose after** — `piflow logs out/<run> --summary`
   One line per node — the verdict correlated with what happened:
   ```
   run myrun — DONE ✓  (1 node(s))
   ✓ w0-classify  [ok exit 0 137s] — 1w/3r/8t · ok
   ```
   `1w/3r/8t` = writes / reads / total tool calls. On a failure it spells out *why*:
   ```
   ✕ w0-classify  [blocked exit 0] — 0w/3r/3t · never-write: emitted text but called NO write tool
       missing: spec/classification.json
       last said: All validation passes. The archetype `platformer` is byte-identical…
   ```

3. **Read one node** — `piflow logs out/<run> --node w0-classify` (replay if done, live if running). Add
   `--raw` for the full event stream when the distilled view isn't enough.

### Reading signatures (what a failure looks like)

| You see | It means |
|---|---|
| `␃ says …` then `submit_result`, **no `▸ write`** + `missing:` an artifact | **never-write** — the model answered in text but never called `write` (often a tool-binding problem) |
| `[error … killed: timeout]`, last event was a long `… thinking` | the model ran past `nodeTimeoutMs` (verbose model / too-tight cap) |
| `[error … killed: stall]` | no output for `stallMs`; raise it (the cp provider pauses 60–90 s transiently) |
| `stderr: RangeError: Invalid string length` | snapshot-bloat blow-up — make sure you're on a build with the bounded provider buffer |

## Pre-run — see the tool surface before spending a model call

The single cheapest debug: confirm each node binds the tools you think it does. The static audit
(`auditWorkflow`) flags the bindings that are otherwise invisible until the model complains mid-run:

- an **un-tokenized** allow/deny entry (whitespace inside one entry → pi binds only the first word and
  treats the rest as positional args → the node silently can't `write`);
- a tool **both allowed and denied**.

A consumer surfaces it in its dry-run (game-omni: `node pi-runner/sdk/run.mjs … --dry-run` prints a
`[tools: …]` line per node and a `⚠ TOOL BINDING` on any finding).

## RunOptions knobs (`runWorkflow`)

| Option | Default | Purpose |
|---|---|---|
| `recordEvents` | `true` | write the per-node `events.jsonl` archive (set `false` to disable) |
| `onEvent(nodeId, ev)` | — | live push of each parsed event — the seam a TUI/GUI subscribes to (the file archive is written regardless) |
| `nodeTimeoutMs` | 1_800_000 | hard wall-clock cap per node → `error` (`killed: timeout`) |
| `stallMs` | 0 (off) | silent-stall kill: no output for this long → `error` (`killed: stall`). Set well past the cp provider's ~60–90 s transient pauses (e.g. 300_000) |

## Programmatic API (`import … from '@piflow/core'`)

- `runWorkflow(wf, { recordEvents, onEvent, stallMs, … })` — recording is built in.
- `tailNode(outDir, id, {raw})` · `distillEvents(events)` · `makeDistiller()` — render a node's stream.
- `followRun(outDir, {node, raw, pollMs, print})` — the live follow loop.
- `diagnoseRun(outDir)` → `{run, done, ok, nodes: NodeDiagnosis[]}` · `renderDiagnosis(d)` — the `--summary` data + view.
- `auditWorkflow(wf)` → `NodeToolAudit[]` · `hasToolFindings(audits)` — the static pre-run tool audit.
- `recordingSandbox(inner, recorder)` · `NodeRecorder` · `slimEvent(ev)` · `tailAppend(buf, chunk, max)` — the capture primitives.

## Per-project wrapper

Logic lives in `@piflow/core`; each project gets a thin entry (sibling to `status.mjs`/`watch.mjs`):

```js
// pi-runner/logs.mjs
#!/usr/bin/env node
import { runLogsCli } from "@piflow/core";
runLogsCli(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
```

> **Note on run-dir location.** A consumer that sets `outDir` to the repo root (e.g. an in-place runner)
> writes `run-status.json` + `_pi/` at the repo root — so `piflow logs . -f` (cwd) follows it. The standard
> case (`outDir = out/<run>`) is `piflow logs out/<run> -f`.

## Case study — the gate-3 W0 "never-write" (why this layer exists)

Two sessions chased a prompt-parity theory. With the event archive on, two guarded runs found the truth:
1. **The never-write:** `parseMarkers` tokenized `DRIVER-TOOLS` on commas, but it's authored
   space-separated → the allowlist collapsed to one token, pi bound only `read`, and the model — visible
   in `--summary` as `0 writes · never-write` with *"I only have the `read` tool"* in `last said` — could
   never write the artifact. Fixed: tokenize on whitespace **and** comma.
2. **A crash that masked it on a verbose model:** unbounded raw-stdout buffering blew past V8's string
   cap (`RangeError`). Fixed: `tailAppend` bounds every provider's capture; `slimEvent` keeps the archive small.
