# pi-runner CLI — the complete, exact syntax (read this before operating a run)

Four executables. The driver runs a workflow; the monitors read its status; extract previews the DAG
for free. **You (the orchestrator) run all of them; the user runs nothing.** Every flag below is parsed
literally by the engine — this doc is the source of truth so node ranges + syntax are never guessed.

```
node pi-runner/run.mjs      # the driver — spawns one pi per node
node pi-runner/status.mjs   # dashboard — per-node table + rollup
node pi-runner/watch.mjs    # sentinel — silent until the run needs you
node pi-runner/extract.mjs  # free DAG preview — no model invoked
```

---

## 1. `run.mjs` — the driver

```
node pi-runner/run.mjs --run <id> [args…] [node-selection] [model] [mode] [isolation]
```

| Flag | Meaning |
|---|---|
| `--run <id>` (aliases `--id`, `--lesson`) | instance id — keys `out/<id>/` AND seeds `args.lessonId`/`args.id`. **Required.** |
| `--arg k=v` | a workflow arg → `args.k` (repeatable). e.g. `--arg prompt="…"` `--arg projectDir=out/<id>`. |
| `--arg-file k=path` | read file text into `args.k` (repeatable). |
| `--brief <file>` | alias for `--arg-file brief=<file>`. |
| `--style <value>` | alias for `--arg style=<value>`. |
| `--from <phase>` | **resume**: skip stages BEFORE the first match; reuse their artifacts (preflight-gated). §2. |
| `--until <phase>` | **truncate**: stop after the LAST matching stage. §2. |
| `--only <phase>` | sugar for `--from X --until X` — run exactly one stage. §2. |
| `--provider <name>` | provider pi resolves from `~/.pi/agent/models.json`. Default `$PI_RUNNER_PROVIDER` or `cp`. §3. |
| `--model <id>` | pin a model id (default `$PI_CP_MODEL`, else the provider's default model). §3. |
| `--extension <p>` / `-e <p>` | load a pi extension (custom-API/OAuth provider, or the node-contract ext). |
| `--status <path>` | override where `run-status.json` is written (default `out/<id>/run-status.json`). |
| `--dry-run` | extract + build prompts + print the exact `pi` commands; **invoke no model** (free). |
| `--debug` | heartbeats + stall detection + the forensic archive (`*.events.jsonl`, `*.debug.log`). **Always use while developing.** |
| `--worktree` / `--keep-worktree` | run inside a fresh per-run git worktree (parallel-fleet isolation). `worktree-isolation.md`. |
| `--sandbox` | macOS Seatbelt read-scope for nodes that declare `DRIVER-READ-SCOPE` (opt-in). `read-scope-sandbox.md`. |
| `--node-timeout <s>` | hard-kill a node after N s (default `$PI_RUNNER_NODE_TIMEOUT` or 1800). |

---

## 2. Node selection — "from which node to which node" (the part that confused us)

The driver runs an **inclusive window of stages** over the full DAG. Two boundaries, plus one shortcut:

- **`--until <substr>`** sets the END — runs from the start through the **LAST** stage whose **phase title,
  node label, or node id** contains `<substr>` (case-insensitive). *Bring-up*: prove the front first.
- **`--from <substr>`** sets the START — **skips every stage before the first match** and **reuses their
  on-disk artifacts** from a prior run. *Resume*: a node is a pure function of its frozen upstream, so the
  retest unit is one node.
- **`--only <substr>`** = `--from X --until X` — exactly that stage, in isolation.

Matching is a **substring** of phase / label / **id** — so you can copy a node id straight out of
`run-status.json` (e.g. `w2-scaffold`) into `--from`/`--only` and it just works. `--until` takes the LAST
match, `--from` the FIRST; if `--from` resolves after `--until`, `--from` is ignored (with a warning).

**Resume preflight (soundness).** When `--from` skips a prefix, the driver first `stat()`s every skipped
node's `DRIVER-ARTIFACTS` (no model spawn). If any is missing it **HALTs (exit 1)**, naming each missing
file + its owner node — a resume never runs on absent/stale inputs. Skipped nodes show as `reused` in the
digest; stage numbering stays **absolute** (`stage k/N` over the full DAG) under any slice.

Worked examples (DAG: `w0-classify · w1-spec · verify-1-design · w2-scaffold · w3-assets · w4-execute-m1 · …`):

```bash
# whole pipeline
node pi-runner/run.mjs --run g1 --arg prompt="…" --debug

# bring-up: front of the pipeline only (start → VERIFY-1)
node pi-runner/run.mjs --run g1 --arg prompt="…" --until verify-1 --debug

# resume after a halt at W2: rerun W2 onward, reusing the frozen W0/W1/VERIFY-1 artifacts
node pi-runner/run.mjs --run g1 --arg projectDir=out/g1 --from w2-scaffold --debug

# tight retest loop: re-run ONE node against frozen upstream (the edit→retest inner loop)
node pi-runner/run.mjs --run g1 --arg projectDir=out/g1 --only w2-scaffold --debug

# an inclusive RANGE: VERIFY-1 through W2
node pi-runner/run.mjs --run g1 --arg projectDir=out/g1 --from verify-1 --until w2-scaffold --debug

# preview ANY slice for free first (no model):
node pi-runner/run.mjs --run g1 --arg prompt="…" --from verify-1 --until w2-scaffold --dry-run
```

> When resuming (`--from`/`--only`) the project dir must already hold the upstream artifacts; pass the same
> `--arg projectDir=…` the original run used. The preflight will tell you (and halt) if anything's missing.

---

## 3. Model / provider — and the standing duty

Credential + models live ONCE in pi's machine-global `~/.pi/agent/models.json` (per-provider). The driver
only NAMES a provider; pi resolves the model. Precedence: `--model` > `$PI_CP_MODEL` > the provider's first
(default) model; `--provider` > `$PI_RUNNER_PROVIDER` > `cp`.

> **VERIFY THE MODEL BEFORE EVERY REAL RUN.** The driver defaults to `--provider cp`, so confirm `cp` (or
> whatever `PI_RUNNER_PROVIDER`/`--provider` selects) resolves to the model you intend — check
> `~/.pi/agent/models.json` and the run's first `message_start` event (`_pi/<node>.events.jsonl` → `"model"`).
> A provider added under a new name (e.g. `minimax`) does **nothing** until the driver is pointed at it.

Pin a repo's lane once in `pi-runner/.env`: `PI_RUNNER_PROVIDER=minimax` (→ MiniMax-M3), or override per run
with `--provider minimax`.

---

## 4. Wiring — `pi-runner/.env` (per-repo, gitignored, NO secret)

| Key | Effect |
|---|---|
| `PI_RUNNER_ROOT` | repo root (default = `pi-runner/`'s parent). |
| `PI_RUNNER_CWD` | where pi executes + relative artifact paths resolve (default = ROOT). |
| `PI_RUNNER_WORKFLOW` | path to the workflow `.js` (relative to ROOT). |
| `PI_RUNNER_PROVIDER` | default provider (e.g. `minimax`); `--provider` overrides. |
| `PI_RUNNER_FROM` / `PI_RUNNER_UNTIL` | default resume / truncation boundary; flags override. |
| `PI_RUNNER_NODE_TIMEOUT` | default hard-kill seconds (default 1800). |
| `PI_RUNNER_STALL_TIMEOUT` | silent-stall kill seconds, no tool in flight (default 300; 0 disables). |
| `PI_RUNNER_TOOL_REPEAT_KILL` | kill after N identical no-progress tool calls (default 5; 0 disables). |
| `PI_RUNNER_REPEAT_KILL` | kill after N identical output deltas — stuck token loop (default 400; 0 disables). |
| `PI_RUNNER_ESCALATE` (+`_MODEL`/`_PROVIDER`/`PI_RUNNER_MAX_RETRIES`) | escalation gate. `escalation.md`. |
| `PI_RUNNER_CONTRACT_EXT` | `1` loads the node-contract extension (typed `submit_result` + owns-block). |
| `PI_RUNNER_WORKTREE` / `PI_RUNNER_SANDBOX` | `1` = default-on for `--worktree` / `--sandbox`. |
| `PI_CP_MODEL` | pin a model id for this repo. |

`PI_RUNNER_ROOT/CWD/WORKFLOW` and the credential are the only required setup; everything else is optional.

---

## 5. Monitors + free preview

```bash
node pi-runner/status.mjs --run <id> [--every <s>] [--out out] [--status <path>]
#   one-shot per-node table + stage + token/cost rollup; --every <s> = live refresh-in-place.

node pi-runner/watch.mjs  --run <id> [--notify] [--verbose]
#   background sentinel — silent until the run finishes / a node errors / the driver goes stale /
#   a node DEAD-stalls (>10min, NOT the transient ~60–90s cp pause). --notify = desktop ping.

node pi-runner/extract.mjs [workflowPath]
#   FREE — prints the realized stages/DAG (node count + parallel lanes) without invoking a model.
#   Run it before any live run to prove the extraction matches the workflow you proved on Claude.
```

A node is `ok` only when its declared artifacts exist on disk — trust `run-status.json`'s verified `status`,
not the model's prose. `--debug` archives (`_pi/<node>.{events.jsonl,debug.log}`) exist only under `--debug`;
re-run one node (`--only <node> --debug`) to recover them.

---

## 6. Canonical recipes

```bash
# 1) shake down a new pipeline: free DAG check → free dry-run → live, one block at a time
node pi-runner/extract.mjs
node pi-runner/run.mjs --run g1 --arg prompt="…" --until verify-1 --dry-run
node pi-runner/run.mjs --run g1 --arg prompt="…" --until verify-1 --debug   # background; then watch.mjs

# 2) fix a node, retest efficiently, then propagate (the edit→retest→propagate loop)
node pi-runner/run.mjs --run g1 --arg projectDir=out/g1 --only <fixed-node> --debug   # one node, frozen upstream
node pi-runner/run.mjs --run g1 --arg projectDir=out/g1 --from <fixed-node> --debug   # then the downstream tail

# 3) monitor a backgrounded run
node pi-runner/status.mjs --run g1 --every 5     # live dashboard
node pi-runner/watch.mjs  --run g1 --notify      # wake-on-event sentinel
```
