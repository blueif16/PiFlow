# Blueprints — the graph-level scaffolding contract

A **blueprint** is the GRAPH-level sibling of an agent-type preset. A preset seeds one **node** (a tool bundle
+ a role-prompt); a blueprint seeds a **shape** — a parametric topology + a wiring rule for a whole sub-DAG. It
is the recurring skeleton ("fan-out research → fuse → author") an init agent stamps when the task fits the
shape, so the DAG isn't reinvented each time.

A blueprint is **NOT loadable and NOT a template.** Its lane COUNT and lane CONTENT are HOLES the init agent
fills by reasoning about the target task — it is instructions for an author, not a `node.json`. It rides the
EXISTING scaffolder (`piflowctl new` / `add-node` + Write); it needs ZERO engine/core code.

| | seeds | loadable? | filled by |
|---|---|---|---|
| **template** | a concrete DAG | yes (`loadTemplate`) | already complete |
| **blueprint** | a parametric SHAPE | **no** (holes) | the init agent, at author time |
| **agent preset** | one node's tools+role | no | `mergePreset` at author time |
| **profile** | — | (run-time pruning of a built DAG) | the runner, at RUN time |

Blueprint ⟂ profile: a blueprint GENERATES nodes at author time; a profile PRUNES an already-built DAG at run
time. Different layers; never confuse them.

## Where blueprints live (boundary-clean, mirrors agent-presets)

- **Catalog (the one home):** `~/.piflow/blueprints/<id>.md` — global, user-extensible.
- **Seeds (bundled with this skill):** `references/blueprints/<id>.md`. On init, **materialize any missing seed
  into `~/.piflow/blueprints/` (create-if-absent only — NEVER overwrite a user-edited blueprint).**
- A user authors a new blueprint by dropping a `<id>.md` into `~/.piflow/blueprints/`; available immediately.
  Nothing blueprint-specific goes into `packages/*` or the GUI. The taxonomy is open, not fixed.

## The contract — when the init agent picks a blueprint

1. **Read** `~/.piflow/blueprints/<id>.md`. If absent: HALT — never invent a blueprint shape.
2. **Decide the parameters by REASONING about the target task** — above all the lane count N (the blueprint
   states its own heuristic; e.g. one research lane per distinct capability/unknown the workflow needs).
3. **Stamp the shape via the scaffolder:** `piflowctl new <dir>`, then one `piflowctl add-node` per node with
   the flags the blueprint's wiring rule prescribes (`--dep` for edges, disjoint `--owns` per parallel lane,
   `--artifact`, `--read`, `--on-fail block` on every PRODUCING node).
4. **Bind each lane to a base agent BY HAND** (there is NO `--agent-type` flag — replicate `mergePreset`): read
   the base agent at `~/.piflow/agents/<id>.md`; (a) add its `tools.allow` via `--tool` flags; (b) prepend its
   role-prompt BODY to the lane's `prompt.md`, then the lane's specific task below it; (c) if it declares a
   `skill`, pass `--skill`. The `agentType` LABEL cannot be set via flag — a known gap, note it to the author.
5. **Write each node's `prompt.md`** with the Write tool (the scaffolder never writes prose; a node with no
   prompt.md FAILS `checkRefs` as a dangling ref).
6. **`piflowctl extract <dir>` must EXIT 0** with the shape the blueprint implies (the loader-backed oracle, no
   model). Not green ⇒ fix the cause (missing prompt.md · dangling dep · non-disjoint parallel `owns`); never
   ship a red extract.

## Idempotence

Stamp **once, from the author's original intent + chosen N** — never re-stamp over an already-bound `prompt.md`
(the role body would double-prepend). On a re-init, start from the same task intent, not the previous output.

## Authoring a new blueprint (the format)

A single agent-facing `.md` to the bar of the `agentic-prompt-design` skill. It MUST state: the **topology**
(the node shape + which parts are parametric); the **parametricity rule** (the heuristic for each hole — give a
countable range, not "some"); the **lane→base-agent map** (which of the six base agents each role binds to, via
the by-hand binding above); the **per-node I/O contract** (read-this → write-that, and the output SHAPE — prose
for an LLM reader, strict only at a machine boundary); the **wiring discipline** (the exact deps + disjoint-owns
rule that makes the stages come out right); and a **pointer to a golden worked instance**. Keep it terse and
single-purpose (≤ ~90 lines), like this file.

## The blueprints that exist

- **`research-synthesize-author`** — fan-out of N parallel research lanes → one synthesize node → one author
  node. Golden instance: `.piflow/outbound-design/template/` (the cold-email outbound playbook designer).
