# Enrich the ported template — the LLM's construction how-to (per-target recipes)

The mechanical port (`parse-claude-workflow.mjs`) gives prompts + DAG + artifacts/tools/sandbox. **This file is
the recipe for the rest — what the LLM constructs to make the template RUN.** Read it with
`parse-claude-workflow.md` → "What the LLM MUST CONSTRUCT" (the WHAT + the miss-nothing bar; this is the HOW).
Worked exemplar throughout: `game-omni` (`.piflow/game-omni/template/`), a 16-node port that runs green.

**The bar (do not declare done until):** a green dry-run (loadTemplate gate + compile, same stage count +
membership as the source) AND a live run where **every hook fires and every declared artifact lands**. A
template that compiles but drops a hook is a FAILED port.

## 1. Hooks — the deterministic-derive layer (the biggest construct)
Each `DRIVER-*` marker in the source `.js` is a `Hook` the text port drops. Re-express it as node.json `hooks`
DATA. Tokens the SDK resolves: `{{WORKSPACE}}` = the read-only consumer repo (skills/templates/registry),
`{{RUN}}`/`{project}` = the run/out dir, `{{state.X}}` = a promoted state channel, `{path:field}` = a value
read from an on-disk JSON.

| source marker | SDK hook (node.json `hooks.*`) | does |
|---|---|---|
| `DRIVER-SEED` (pre) | `seed: [{ to, from }]` | stage an input (skeleton/template/tree) before the model |
| `DRIVER-PROJECT` (post) | `registryProject: { source, mapRef, key }` *(or `project`)* | derive a runtime file from a frozen spec via a registry-keyed projection map |
| `DRIVER-MERGE` fold/concat/reconcile (post) | `merge: { ops: [{ fold|concat|reconcile }] }` | deterministic filesystem merges (fragment → section, etc.) |
| `DRIVER-MERGE run` / `DRIVER-SEED-CONTRACT` (post) | `merge: { ops: [{ run: { cmd, args } }] }` | run a script (generation / contract-seed / a gate); non-zero exit ⇒ node blocked |

**Exemplars (verbatim shapes from the green game-omni template):**
- `gameplay`: `seed` (blueprint template) **+** `merge.run` → `{{WORKSPACE}}/packages/skills/harden-blueprint/gen/seed-contracts.mjs --source {project}/spec/blueprint.json --catalog {{WORKSPACE}}/.agents/node-catalog.json`. ← note the cmd points at the CURRENT (relocated) script path, not the old one.
- `asset`: `merge.run` → `{{WORKSPACE}}/packages/skills/assets/gen/.venv/bin/python generate_assets.py --blueprint {project}/spec/blueprint.json --prompts {project}/asset-prompts.json --out {project}/public/assets`.
- `w2-scaffold`: `seed` (coreBase copy + module overlay) **+** `registryProject: { source: spec/blueprint.json, mapRef: {{WORKSPACE}}/templates/genres.json, key: {{state.archetype}} }` **+** `merge` (concat + reconcile + a check-event-bindings `run`).

## 2. State promotion — make `{{state.X}}` resolvable
Any token a downstream seed/project reads (`{{state.archetype}}`, …) needs a node that PROMOTES it. The port
has no state-channel awareness. Add a `promote` on the establishing node.
- Exemplar: `w0-classify` → `promote` reads `classification.json:archetype` → writes `state.archetype`. Every
  downstream `templates/genres/{{state.archetype}}.json` seed and the w2 `registryProject` key depend on it. No
  promote ⇒ those tokens resolve to nothing and the hooks read garbage.

## 3. SDK-vocabulary translation
The source `.js` speaks the Claude/pi-runner marker vocab; the SDK has its own op names. Translate so hooks
bind to `@piflow/core`'s op set, not the legacy monolith's:
- `project` → `registryProject`, `genre` → `key`. (game-omni: the source still says `project:{source,genre,mapRef}`; the template says `registryProject:{source,key,mapRef}` — the SDK shape. The migrate test asserts the SDK shape, not the source's.)
- Generic transforms (e.g. `union`) carry NO domain knowledge in code — the per-key transform DATA lives in the
  registry record (`templates/genres.json` per-archetype `projections`), which `registryProject` resolves.

## 4. Contract decisions — `policy` / `returnMode` / `checks` / `fillSentinel`
The Claude `contract()` emits only `artifacts`/`owns`/`readScope`/tools. Add the rest:
- **`policy.fail: "block"`** on EVERY producing node — the artifact gate (a clean exit that didn't produce a
  required artifact is `blocked`, not `ok`). game-omni: 16/16 nodes.
- **`returnMode`** only where the SDK default is wrong. Default = **optional when the node declares artifacts**
  (the file is the proof), **required for a zero-artifact gate** (its return is its only proof). Set explicitly
  if a node deviates.
- **`checks` / `fillSentinel`** where the workflow declared integrity checks (e.g. w1's fenced-tail milestones
  `minItems`) or a fill sentinel. Either default a small standard set or LLM-author per node from the source's
  intent — author them; don't leave a node the source gated as ungated.

## 5. Data-flow (optional upgrade) + the self-check
The port pins recorded order via `io.dependsOn`. To reveal real parallelism, replace it with each node's actual
`io.reads`/`io.produces` (keep `dependsOn` until you do). Then run the **miss-nothing self-check** from
`parse-claude-workflow.md`: every `DRIVER-*` → a hook · every `{{state.X}}` → a promoting node · every producer
→ `policy.fail` + artifact contract · dry-run stage-parity with the source · live run fires every hook and
produces every artifact.
