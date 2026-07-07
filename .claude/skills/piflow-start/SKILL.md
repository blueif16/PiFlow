---
name: piflow-start
description: >-
  Pi Flow · START — run & monitor an already-created pi-flow workflow on the pi fleet via the SDK CLI, with
  Claude Code as the single console. LOAD THIS SKILL BEFORE running ANY piflow/pi command — it pins the
  canonical invocation: the npm-linked global `piflowctl run <templateDir>` bin (NOT `node …/dist/cli.js` nor
  `pi-runner/run.mjs`, both non-canonical) with `--provider <gw> --thinking low --sandbox local` +
  `--from`/`--until`. Do NOT reconstruct the command from memory. Triggers — load on ANY of: "run / kick off /
  start / resume my piflow workflow", "do a live run on pi", "run game-omni on pi", "companion-mode run",
  "monitor / follow / poll a run", "diagnose a stalled / never-wrote / blocked node", or the words
  "piflow" / "pi-runner" / "pi fleet" / "pi run" appearing at all. The run is ALWAYS: pull the next prompt
  from the bank → dry-run (free) → live background → poll. To CREATE or PORT the template first use
  piflow-init; to IMPROVE a node/the chain use piflow-enhance.
---

# Pi Flow · START — run & monitor a workflow on the pi fleet

**You are the operator — you run every command; the user runs nothing.** A workflow is a structured TEMPLATE
(`.piflow/<wf>/template/`); the `@piflow/core` SDK loads it (`loadTemplate → instantiateRun → compile →
runWorkflow`) and runs one `pi` per node. **The entrypoint is the `piflowctl` bin (from `@piflow/cli`,
npm-linked onto PATH — confirm with `which piflowctl`). The canonical command is `piflowctl run <templateDir> …` —
NOT `node <piflow>/packages/cli/dist/cli.js run …` (the same code, but the bare-node form is the fallback only
when the link is missing) and NEVER `node pi-runner/run.mjs` (the deleted legacy monolith).** Every command
below (`run` · `inspect` · `extract` · `status` · `watch` · `logs`) is a `piflowctl` subcommand.

## The run contract (read before every run)
- **INPUT IS THE PROMPT BANK, NEVER TYPED.** A run's `prompt` is the next `pending` entry of the consumer's
  bank (game-omni: `eval/prompt-suite.json` / the per-archetype sibling), pulled **by id**. NEVER invent, type,
  or paste an ad-hoc prompt — if the prompt you want isn't in the bank, ADD it (status `pending`) first, then
  consume it. On a clean run: flip its `status` → `running` and append a `runs[]` record (flow commit · pi
  model · node reached · verdict). Never reuse a prompt across two from-scratch runs.
- **PROVIDER = pi's NATIVE DEFAULT — do not inject it.** pi resolves the model itself from
  `~/.pi/agent/models.json` (the first auth-resolved provider = `availableModels[0]`). Pin it deterministically
  with pi's OWN mechanism — `~/.pi/agent/settings.json` → `{ "defaultProvider": "<gw>", "defaultModel":
  "<id>" }` — NOT by layering provider logic in the runner. The pinned default IS ground truth; a stray shell
  export (`PI_RUNNER_PROVIDER`) or a flag must never silently override it. (`--provider <gw>` on the CLI is the
  one allowed EXPLICIT override; passing only `--provider` with no `--model` is a pi no-op — it still resolves
  to the default model — so prefer pinning `settings.json`.)
- **`--workspace` MUST point at the CONSUMER repo** (where the skills/templates/registry the node prompts read
  live, e.g. `/Users/tk/Desktop/game-omni`). It resolves the `{{WORKSPACE}}` tokens in every seed/hook path; a
  wrong workspace makes hooks read nothing. The TEMPLATE may live in a different repo (e.g.
  `piflow/.piflow/game-omni/template`) — that's fine; `--workspace` is what binds the run to the content.
- **NEVER pass `--out` — the run's home is SDK-derived and canonical.** A template at `.piflow/<wf>/template/`
  makes the SDK land every run in `.piflow/<wf>/runs/<id>/` (`{{RUN}}`/`{project}`) — the single place discovery,
  the global index, and `status`/`watch` read. `--out` cannot relocate that (it is IGNORED, with a warning, when
  a canonical home resolves; it applies only to a loose template that has no `.piflow/<wf>/template/` layout). To
  keep a copy elsewhere, EXPORT a copy — never redirect the original, or observation splits across two homes.

## The procedure
1. **Dry-run (free, no model) — always first.** Confirms the template loads, the DAG compiles, args resolve,
   and prints each realized `pi` command:
   ```bash
   piflowctl run <templateDir> \
     --workspace <consumerRepo> --run <id> \
     --provider <gw> --arg prompt="<the bank entry's prompt>" --dry-run
   ```
   (`piflowctl` is the global linked bin — the consumer repo needs no install; `--workspace` points it at the
   consumer's content. If `which piflowctl` is empty, fall back to `node <piflow>/packages/cli/dist/cli.js run …`.)
   **CAVEAT: the dry-run prints the FULL DAG; it does NOT show the `--from`/`--until` window.** The window
   applies only at runtime — verify it by reading the matcher, not the dry-run output.
2. **Live (background) — never block on it.** Drop `--dry-run`, add `--sandbox local` (real in-place pi exec;
   **omit it and NO model runs — it goes in-memory**) and **`--thinking low`** (the proven default — omit it
   and pi defaults to `medium` → over-deliberation / stall risk on the headless loop). Redirect to a log and
   run in the background:
   ```bash
   piflowctl run <templateDir> \
     --workspace <consumerRepo> --run <id> \
     --provider <gw> --thinking low --sandbox local \
     --arg prompt="…" [--from <node>] [--until <node>] \
     > /tmp/piflow-<id>.console.log 2>&1   # launch in the background
   ```
   (The console log goes to `/tmp` — a path that exists before the run; the AUTHORITATIVE per-node logs live
   in the canonical run dir. Proven game-omni invocation: `--provider mmgw --thinking low --sandbox local`,
   template `<game-omni>/.piflow/game-omni/template`, `--workspace <game-omni>` — the run lands in
   `<game-omni>/.piflow/game-omni/runs/<id>/`, no `--out`.)
3. **Monitor — poll, don't block.** The run writes `<runDir>/.pi/{run.json,state.json}` + per-node
   `<runDir>/.pi/nodes/<node>/{events.jsonl,io.json,node.json}` (where `<runDir>` = the canonical
   `.piflow/<wf>/runs/<id>/`); produced artifacts land under `<runDir>/` (e.g. `spec/*.json`). Watch with
   `piflowctl status <runDir>` / `piflowctl watch <runDir>` / `piflowctl logs`, or
   tail a node's `events.jsonl`. Confirm liveness by the **artifact on disk + the VCS/file evidence**, never a
   self-report.

## Monitor & diagnose live
**NEVER hand-roll polling with `sleep` + `cat`/`tail -f` on a node's `events.jsonl` — the SDK ships live
views; a `sleep` loop burns turns, misses the terminal event, and re-improvises a tested surface.** Use the
`piflowctl` bin (never `node …/dist/cli.js`):
- `piflowctl watch <rundir> [--notify]` — the wake-on-event SENTINEL: it blocks on the live stream and prints
  ONE line when the run finishes / a node fails / it dead-stalls. Reach for this to await a background run.
- `piflowctl status <rundir> --every <s>` — the per-node table, refreshed in place every `<s>` seconds (omit
  `--every` for a one-shot snapshot). The human dashboard.
- `piflowctl telemetry <rundir> [nodeId] --watch` — the agent-facing digest streamed live (verdicts · cost
  spine · loop signals · anomaly worklist · failure-onset root cause), then the final record.
- **The optimize loop streams too:** `piflowctl optimize --fix <rundir> --binding <module> --watch` emits the
  FIX→GATE→LAND events in order — **`triaged → candidate-prepared → fixer-started → fixer-trace* → fixer-done
  → scored → gated → landed → stopped`** (`fixer-trace*` repeats per fixer step; `--watch-json` = JSONL). Use
  this to follow an autonomous fix round; the loop itself lives in **piflow-enhance**.

Confirm liveness by the artifact on disk + the VCS/file evidence, never a self-report. (Deep status/event
contract: piflow-init's `reference/observability.md`.)

## Windowing the DAG (`--from` / `--until`)
A needle matches a stage by substring against its **phase, node-id, or node label** (`stageMatches` in
`@piflow/core`). Two rules that bite:
- **Use a node-id needle, not a space-separated phase title.** `--until w2-scaffold` (the node id) matches;
  `--until "W2 Scaffold"` matches NOTHING when `stage.phase` is unset → the window silently runs to the END.
- **`--until X` runs through the LAST stage containing X; `--from X` resumes AT X** (reusing upstream artifacts
  via a stat preflight). `--only X` = both.

## Profiles — match the user's intent to a declared profile, then run
A template may declare named run PROFILES in its `meta.json` (`profiles` + `defaultProfile`); each ELIDES a
subset of nodes so one workflow has several run shapes — e.g. a full `production` flow with verify gates and a
dev `companion` flow that elides them (`docs/design/profiles-and-resume-robustness.md`). Selecting one is the
whole job, and it is short:
1. **Read the declared profiles** (`meta.json` `profiles` keys) — those are the ONLY valid names; never invent one.
2. **Match the user's stated intent to one** → `--profile <name>`: "just build it / dev run / skip the gates" →
   the gate-eliding profile (e.g. `companion`); "full / unattended / validated" → the default (e.g.
   `production`); a profile they name → use it. No flag → the template's `defaultProfile`. An unknown name
   ERRORS loudly, listing the declared ones (a typo can't silently run the wrong shape).
3. Done — the profile compiles the reduced, gateless DAG; `--from`/`--until` still window WITHIN it.

When a profile elides the verify gates, **the orchestrator IS the verifier** — judge each node's artifact
against the criteria fixture as it lands (piflow-enhance / hermes-skill-system's node-validation loop).
(Obsolete: hand-windowing gates out with `--until <last producer>` — use `--profile`; it rewires deps so a
`--from` resume never blocks on an elided gate's missing artifact, the failure that motivated this.)

## Triage a misbehaving run (failure signatures)
- **never-wrote** (clean exit, required artifact absent) → read the node's `events.jsonl`: explore-forever /
  in-head work / a missing input the prompt needed. Fix at the node's SKILL or the seed, not by re-running.
- **stall** (no events for minutes) → a silent headless hang, usually over-deliberation. FIRST check you
  passed **`--thinking low`** — the CLI now forwards it to `pi --thinking`, but if you OMIT it pi defaults to
  `medium` and over-thinks (the #1 cause of a slow/never-finishing node). The `-e` node-contract extension
  (the write-first gate) is still not auto-passed by the SDK CLI — note that as an enhancement target; do not
  fake around it.
- **hook failed** (node ok but a `run` post-hook non-zero) → the deterministic step (gen / seed-contract /
  merge) failed: check the hook cmd path resolves under `{{WORKSPACE}}` and `{project}`, and its exit/stderr.

## Scope fence
- CREATE / PORT a template, or it's missing/incomplete → **piflow-init** (the LLM constructs the full
  run-ready template: prompts+DAG + hooks/policy/returnMode/state/vocab). Do NOT hand-author a template here.
- A node produced a BAD artifact / a recurring flaw → **piflow-enhance** / **hermes-skill-system** (fix the
  SKILL or the chain; the human is the eye). Do NOT patch a prompt mid-run.
- The deep specs (the run-status/event contract, the `RunOptions` knobs, headless invariants) live in
  piflow-init's `reference/observability.md` + `reference/provider-and-headless.md` — read them when a run
  misbehaves; do not duplicate them here.
