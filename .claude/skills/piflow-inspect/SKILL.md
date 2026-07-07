---
name: piflow-inspect
description: >-
  Pi Flow · INSPECT — the instrument router for looking INTO a run or a node: performance, cost, timing,
  context composition, loop/stall anomalies, recurrence. LOAD THIS SKILL BEFORE debugging or analyzing ANY
  pi-flow run/node — it routes each question to the piflowctl verb that already answers it (status · telemetry
  · trace · logs · inspect · optimize · memory · understand), so you never hand-parse `.pi/` internals or
  write a throwaway analysis script for data an instrument already surfaces. Triggers — load on ANY of: "why
  is this node slow / expensive / looping / stalled", "where did the time/tokens go", "what did the model
  actually read / see / miss", "how many calls did it make", "dissect / profile / audit this run", "compare
  two runs of a node", "did this failure happen before", or any intent to open a `.pi/sessions/*.jsonl`,
  `run.json`, or node log by hand. To RUN a workflow use piflow-start; to judge/act mid-run use piflow-overlord.
---

# Pi Flow · INSPECT — instruments before parsing

## The law
The `.pi/` run layout is the canonical record, and **piflowctl verbs are the ONLY first-line way to read
it**. Hand-parsing session JSONL, grepping run internals, or writing an ad-hoc script is permitted ONLY
after the routing table below has no verb for the question — and then the gap itself is a finding (a missing
verb/flag to file or build), never a script that lives on. Inspection is READ-ONLY: never modify, re-run, or
resume anything under a run dir just to "see"; observe first, act through piflow-start after.

Run everything from the product repo. Runs live under `.piflow/<wf>/runs/<id>` (resolve foreign repos via
`~/.piflow/index.json`). `<rundir>` below = that path; a bare run id also resolves for `trace`.

## The routing table — ask the question, call the verb

| Your question | Verb | What comes back |
|---|---|---|
| Is the run healthy? which node/stage failed? | `piflowctl status <rundir>` | per-node table + stage rollup, verified on disk |
| Tell me the moment it finishes/dies | `piflowctl watch <rundir> [--notify]` | silent sentinel, one line on done/fail/dead-stall |
| Why is this node slow / expensive / looping? | `piflowctl telemetry <rundir> [nodeId]` | verdict · tokens in/out · ctx% · model+tool call counts · retry loops (`↻`) · anomalies · stop reason · **per-turn table: t+offset, duration, think-chars, tools** |
| What did the model actually see / read / miss? | `piflowctl trace <rundir> [nodeId] [--json]` | the element tree: injected prompt + every read/edit in order, range · coverage · sha · blind-spot rollup (advertised-but-unread) · re-reads (READ-ONCE violations). `--json` adds per-element `tMs` offsets |
| What events fired? replay the node | `piflowctl logs <rundir\|run> [options]` | stream / replay / diagnose per-node event archives |
| What was this node CONFIGURED to be? | `piflowctl inspect <templateDir> [nodeId] [--full]` | pre-run resolved view: sandbox · tools · ops · prompt |
| Which nodes need fixing, and why? | `piflowctl optimize <rundir> [--json]` | read-only Score + Triage: the LAPSE/SKILL/FUNCTIONALITY/ARCH worklist |
| Has this node failed THIS way before? | `piflowctl memory find <templateDir>` (+ `memory-slices` skill) | standing lessons + cross-run recurrence (Leg A) |
| How does the subsystem's code work? | `piflowctl understand [subsystem]` (+ `okf-slices` skill) | the canonical OKF code slice (Leg B) |

Live monitoring variants: `telemetry --watch` (stream then record), `status --every <s>`.

## The performance-forensics ladder (default reading order)
1. **`telemetry <rundir>`** (no nodeId) — the run-level rollup: which node holds the time/tokens/anomalies.
2. **`telemetry <rundir> <nodeId>`** — read the per-turn table and RANK the sinks before forming any theory
   (see "reading the turn table" below). Most "why 18 minutes" questions end here.
3. **`trace <rundir> <nodeId>`** — when the question is context composition: what was injected vs read,
   coverage, blind spots, re-read loops, failed-edit retries (`✗` rows).
4. **`logs` / raw record** — only for what no verb surfaces (e.g. the exact payload of one anomalous turn).
   The raw per-event record is `<rundir>/.pi/sessions/<ts>_<nodeId>.jsonl` (every line timestamped). Read it
   read-only, answer the one question, and if you needed it, note the missing verb/flag.
5. **Cross-run comparison** — same verb, both run dirs, diff the tables (calls · think-chars · sinks ·
   anomalies). Never compare run TOTALS alone: totals hide single-turn anomalies (see below).

**Effort ceiling: the verbs, then AT MOST ONE subagent.** The instruments are the warning system — they
answer most questions inline in 1–3 verb calls. Escalate to a subagent ONLY when a finding needs deep
per-event digging (e.g. "what exactly happened inside that one anomalous turn"), and send ONE agent with the
rundir + nodeId + the specific question — never a multi-agent workflow, panels, or per-run verifier fleets
for run inspection. Fan-out is for building/fixing, not for reading a run.

## Reading the telemetry turn table (what the numbers mean)
- `dur` high + `think` high → real generation. Sanity-check with the rate: think-chars ÷ dur ≈ the model's
  steady chars/sec (establish it from the node's own big turns). Rate-consistent turns are generation cost —
  the fix is upstream (less to think about), not infra.
- `dur` high + `think` near zero + no tools → **NOT generation: a stall/retry/rate-limit anomaly.** Treat it
  as infra, subtract it before judging an optimization's wall-clock effect, and check the same turn in
  `logs`/the raw record for the cause.
- Many short uniform turns → per-call overhead (prefill + TTFT) × call count; the lever is fewer round
  trips (batching edits), not shorter thinking.
- `↻ tool×N` + repeated `✗` edit rows in `trace` → retry loops; sum their turns before blaming the model.
- `calls: N model · M tool` answers "how many calls were invoked" — never grep for this.

## MUST NOT
- Open `.pi/` internals by hand before steps 1–3 of the ladder.
- Mutate a run dir, or rerun/resume a node, as a way of inspecting it.
- Report a wall-clock comparison without checking the turn table for stall turns first.
- Leave any ad-hoc parse script in a repo; a needed-twice script is a missing piflowctl flag — file or build it.

## Worked example (the shape of a correct inspection)
"Node ok but took 18 min — why?" → `telemetry <rundir> <node>`: 53 model calls, think 63k chars, largest
turn 143.7s/28k chars (rate ≈195 c/s → genuine generation) — but turn 49 = 220.6s with 844 chars and no
tool call → a stall, not thinking. Verdict: real work ≈ 860s; the 18-min headline was one infra anomaly +
one mega-think, each with a different owner. Total time: two verb calls, zero JSONL parsing.

## Self-check before reporting findings
- [ ] Every number I'm reporting came from a verb (or I named the verb gap that forced a raw read)
- [ ] Slow-node claims are decomposed per-turn, stalls separated from generation
- [ ] Comparisons are table-vs-table, not total-vs-total
- [ ] I changed nothing under any run dir
