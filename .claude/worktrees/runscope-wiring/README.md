# Pi Flow

> *Repo + Claude Code skill name: `transform-workflow-to-pi`. The product/library surfaces as **Pi Flow** (`piflow`).*

## Your next ultracode can be on a Pi fleet.

**Pi Flow is a self-designing, durable, self-improving orchestration substrate** — a graph of
**full-agent (`pi`) nodes** that a planner *designs*, a non-Claude fleet *runs*, and a learning loop
*improves*, all coordinated through the filesystem. Prove a workflow once on Claude Code (ultracode);
run the **identical DAG** on a Pi fleet of **non-Claude / GPT / efficient** models — no rewrite, no
codegen, no drift.

**Keywords:** auto-design · self-improving · durable · per-node sandbox isolation · declarative
per-node tools · OpenClaw + Hermes tool ecosystem · clean context isolation · long-horizon
system-enhancement loops · Claude Code workflow migration · non-Claude pi fleet.

> Everything a production-grade agent harness (e.g. OpenHive) ships — auto-design, self-improvement,
> durability — **Pi Flow matches, and goes further.** Performance is led by the **Pi harness**, whose
> function/tool connectivity is far more scalable and extensible than a Python-based runtime, with the
> entire **OpenClaw / Hermes** tool community wired in per node. We miss out on nothing they have; we
> do each of them better.

```
Claude Code (you) ── 1 driver per instance ─► run.mjs (owns the DAG)
                                               │ extract.mjs runs workflow.js under recording stubs
                                               │ → exact prompts + parallel lanes
                                               ▼  one `pi` per node (non-Claude coding-plan model)
                              <repo>/* artifacts + out/<id>/run-status.json  (you poll)
```

## Capabilities — and how

| Capability | How Pi Flow does it |
|---|---|
| **Auto-design** | A planner designs the DAG with **tool-awareness** — it knows the available agents/tools and splits the task into the right tool-wired nodes and parallel lanes. |
| **Self-improve** | **Hermes-style global memory** + **trace observation + optimization**: each run's traces are observed, credit-assigned, and folded back to improve the skills/graph for the next run. |
| **Durability** | **Per-node isolation in a sandbox** + full control via **declarative tool calls wired in per node** + always-on **background runtimes and watchdogs** (timeouts, stall/loop guards, `--from` resume). |
| **Performance** | Led by the **Pi harness** + the full **OpenClaw / Hermes** tool ecosystem wired in + **clean context / task isolation** per node + **long-horizon tasks with system-enhancement loops**. |
| **Easy migration & setup** | **Lift a Claude Code (ultracode) workflow verbatim** — `extract.mjs` records the realized prompts + DAG from the same `.js` and replays them on the Pi fleet. One harness drop-in, no port. |

## Why

You prove a workflow on Claude Code (frontier, capable). Then you run the **identical pipeline** on a
Pi fleet of non-Claude models, at scale, **without rewriting it** — `pi-runner` *extracts* the realized
prompts + DAG from the same `.js` and replays them, one `pi` process per node, while Claude Code owns
the graph and polls `run-status.json`. New/removed/reordered waves propagate for free; the two
executors never drift. **No port, no codegen, no hand-sync.** That executor is the **producer node** of
the broader substrate.

## The two layers

| Layer | Where | What |
|---|---|---|
| **The product vision** | [`docs/`](docs/), [`ROADMAP.md`](ROADMAP.md) | The substrate Pi Flow is becoming — the design canon, the buildable architecture, the forward plan. **Start at [`docs/INDEX.md`](docs/INDEX.md).** |
| **The shipping skill + harness** | [`SKILL.md`](SKILL.md), [`reference/`](reference/), [`templates/pi-runner/`](templates/pi-runner/) | What runs *today*: the Claude Code skill that performs the transform, and the byte-identical engine you drop into any repo. |

**Status: Foundation.** The harness ships and runs today (extract → drive a Pi fleet → verify on disk).
The auto-design / self-improve / full control-plane capabilities above are the substrate's design and
build order — see [`ROADMAP.md`](ROADMAP.md) for what is GA vs in flight.

## Documentation

- **[`docs/INDEX.md`](docs/INDEX.md)** — start here: reading map + the vocabulary.
- **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** — the buildable mechanism (two node kinds, three
  modes/loops, the seam control plane) + **what is built today vs the gaps**.
- **[`docs/design/orchestration-substrate.md`](docs/design/orchestration-substrate.md)** — the deep design +
  strategy canon (positioning, competitive map, borrow-vs-build, white-space, the fork).
- **[`docs/research/substrate-multiagent-and-runtime-2026-06-21.md`](docs/research/substrate-multiagent-and-runtime-2026-06-21.md)**
  — the evidence base (multi-agent practice + runtime-language verdict).
- **[`ROADMAP.md`](ROADMAP.md)** — the build order, framework/library shape, and guardrails.
- **[`docs/pi-agent-notes.md`](docs/pi-agent-notes.md)** — the durable knowledge record about `pi` as a headless
  executor (capabilities, mechanics, sharp edges, codex-vs-pi, backlog).

## Install (the skill)

This is a Claude Code skill. Make it discoverable by placing (or symlinking) the folder under your
skills directory:

```bash
ln -s "$(pwd)" ~/.claude/skills/transform-workflow-to-pi
```

Claude Code surfaces it whenever someone asks to "run my workflow on pi", "run this on a non-Claude
model", "pi-runner", or "offload the workflow to a non-Claude fleet".

## Quickstart (the transform, condensed)

1. **Confirm the source of truth** — exactly one `.claude/workflows/<name>.js`, `export const meta`
   a pure literal, body uses only Workflow hooks. You edit and prove it on Claude; pi inherits it.
2. **Set the credential ONCE in pi's own global config** — `cp templates/models.json.example
   ~/.pi/agent/models.json`, edit `apiKey`/`baseUrl`/model ids, `chmod 600`, verify `pi --list-models cp`.
3. **Drop in the harness verbatim** — copy `templates/pi-runner/` next to `.claude/`; edit none of
   the engine files. `cp templates/pi-runner/.env.example pi-runner/.env` and set wiring only
   (`PI_RUNNER_WORKFLOW`, `PI_RUNNER_CWD`) — no secret.
4. **Sanity-check the DAG (free)** — `node pi-runner/extract.mjs` prints the realized stages.
5. **Dry-run (free), then live (background, `--debug`)**:
   ```bash
   node pi-runner/run.mjs --run <id> --arg <k=v> --until <phase> --dry-run
   node pi-runner/run.mjs --run <id> --arg <k=v> --until <phase> --debug
   ```
6. **Monitor as the console** — poll `out/<id>/run-status.json` (`ok` requires artifacts on disk).
   Fleet = one background driver per instance.

## The laws

- **Single source of truth = the workflow `.js`.** Improve a wave by editing its prompt/skill and
  re-proving on Claude; pi runs the new prompts automatically.
- **The engine files never diverge.** `run.mjs` / `extract.mjs` stay byte-identical across every
  repo; per-repo wiring lives in `.env`, the credential in pi's global `models.json`.
- **Extraction, not codegen.** `extract.mjs` runs the workflow under recording stubs and captures
  the exact prompts + grouping.
- **Driver owns the graph; pi owns the node.** Plain code decides stage order + parallel lanes +
  halt-on-failure; the model never decides control flow. Nodes coordinate via the filesystem.
- **Verified, not trusted.** Each node ends with one fenced ` ```json ` block; the driver `stat()`s
  every `outputArtifact`. `ok` ⇒ files exist on disk.
- **Headless invariants are non-negotiable.** Close stdin, `--offline`, `--no-extensions` + explicit
  `-e` provider, always `--debug` while developing.

## Security

No secrets ship in this repo. `.env.example` contains only placeholders (`sk-REPLACE_ME`,
`your-provider.example.com`); the bundled `.gitignore` excludes the real `.env`. Never commit a
filled-in `pi-runner/.env`.

## License

MIT
