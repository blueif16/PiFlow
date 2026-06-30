# Blueprint: research → synthesize → author

The default shape for "go learn a domain, then design from what you learned." You (the init agent) are stamping
a workflow whose first stage gathers decision-grade knowledge in PARALLEL, a middle node fuses it into one
design, and a final node turns that design into the target artifact. Read the layer contract in this dir's
`README.md` first. This file tells you the topology, how to size it, and how to wire it so `piflowctl extract`
comes out green with the right stages.

## Topology (3 stages)

```
[ research-1  research-2  …  research-N ]   ← stage 1: N PARALLEL lanes (same deps, disjoint owns)
                  │  (all N)
              [ synthesize ]                 ← stage 2: depends on EVERY lane; fuses the briefs into one design
                  │
               [ author ]                    ← stage 3: depends on synthesize; emits the target artifact
```
N is the only parametric dimension; the spine (synthesize, author) is fixed.

## Parametricity rule — choosing N

**N = one research lane per DISTINCT capability or unknown the target workflow needs** — never one lane per
keyword, never a fixed number. Enumerate the distinct unknowns of the task FIRST, then map each to a lane; merge
two that share a source and a reader, split one that carries two disjoint investigations.
- **2–3 lanes** for a small/narrow task (one domain, a couple of unknowns).
- **5+ lanes** for a broad task (many independent capabilities, vendors, or sub-domains).
- A lane must be INDEPENDENT of its siblings (no lane reads another's output — that is what makes them one
  parallel stage). If lane B needs lane A's result, it is not a sibling; it belongs after synthesize, or the two
  collapse into one lane.

## Lane → base-agent binding (the by-hand mergePreset — there is no `--agent-type` flag)

| role | base agent | tools to add (`--tool …`) | skill |
|---|---|---|---|
| each research lane | **market-research** | `fs:read fs:write oc.firecrawl:firecrawl_search oc.tavily:tavily_search` | `--skill multi-source-research` |
| synthesize | **plan** + `write` | `read write submit_result` | — |
| author | **general-purpose** | `read write edit bash submit_result` | — |

For EACH node: read `~/.piflow/agents/<id>.md`, add its `tools.allow` via `--tool`, and PREPEND its role-prompt
BODY to the node's `prompt.md` (role first, the lane's specific task appended below). `plan` is read-only by
default — you ADD `write` so synthesize can persist the design doc. `author` keeps `bash` because it shells out
to `piflowctl` to scaffold the downstream template at run time. (The `agentType` LABEL cannot be set via a
scaffolder flag — note this gap to the human; the binding is otherwise complete.)

## Per-node I/O contract (read-this → write-that; shape = match the CONSUMER)

- **Each research lane** — reads `{{RUN}}` (and the open web via its tools); writes ONE brief to its own owned
  dir, e.g. `research/<lane>/brief.md`. Output is **PROSE** (an LLM — synthesize — reads it; never force JSON on
  a reasoning hand-off). The brief holds market-research's five required sections specialized to the lane, with
  concrete dated numbers and a closing "decisions this forces" list of the constraints downstream MUST honor.
- **synthesize** — reads ALL N briefs; writes ONE design doc to `design/<name>.md` (PROSE). It must RECONCILE
  cross-lane constraints (not summarize), and its design MUST contain a concrete, ACYCLIC proposed node DAG the
  author can scaffold (each node: id · role · deps · reads/writes).
- **author** — reads the design doc; scaffolds the target template under its owned `out/**` via
  `piflowctl new`/`add-node` + Write, and its required artifact is the emitted `…/template/meta.json`. It
  self-verifies with `piflowctl extract` (green) before returning. Strict structure lives only on this final
  machine boundary — the template files — never on the intermediate briefs.

## Wiring discipline (so the stages resolve correctly)

- **Research lanes are ONE parallel stage** ⟺ they share the SAME deps (all `[]` — no upstream) AND have
  WRITE-DISJOINT `owns` (each lane `--owns research/<lane>/**`, never the default `out/**` for more than one).
  Non-disjoint owns on same-level nodes = the loader will NOT parallelize them (or rejects the lane). This is
  the single most common extract failure — give every lane its own `owns` glob.
- **synthesize** `--dep`s on EVERY research lane (that is what places it in stage 2) and `--read`s the research
  tree.
- **author** `--dep`s on synthesize only.
- **`--on-fail block` on EVERY producing node** (all lanes, synthesize, author) — each emits a required
  artifact, so a miss must block, not warn.

## The bar (revise the stamped template until ALL pass)

1. `piflowctl extract <dir>` EXITS 0 and shows N research lanes in ONE parallel stage, then synthesize, then
   author (3 stages).
2. Every node dir has BOTH `node.json` AND a non-empty `prompt.md`.
3. Each research lane's `tools.allow` has market-research's four tools, and its `prompt.md` BEGINS with
   market-research's role body; synthesize's tools include `write`; author's include `bash`.
4. Every producing node has `policy.fail: block`.
5. N was chosen by the parametricity rule above (one lane per distinct unknown), not arbitrarily.

## Self-check before returning

Stamp, then audit against the five bar items — mark PASS/FAIL with one line of evidence each (for item 1, paste
the literal extract output). The most likely FAIL is item 1 from non-disjoint `owns` — fix the lane globs and
re-extract. Fix every FAIL, re-audit, return only when all five PASS. If extract stays red for a cause you
cannot resolve, HALT and report the exact error, do not claim green.

## Golden worked instance

`.piflow/outbound-design/template/` — the cold-email outbound playbook designer: 4 research lanes
(deliverability/warmup, Apollo+Prospeo enrichment, domain/inbox infra, biweekly analyzer) → synthesize → author.
Inspect it for a concrete realization of every rule above.
