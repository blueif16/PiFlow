---
id: candidate-fusion-refine
description: the shape for "one artifact, but I don't trust a single model draft — panel to widen coverage, then best-of-n to harden it"
golden: .piflow/example-fusion/template/
params: []
---
# Blueprint: candidate-fusion → refine (MoA panel → best-of-n)

The shape for "one artifact, but I don't trust a single model draft — I want a PANEL to widen coverage, then N
samples of the best to harden it." You (the init agent) are stamping a linear pipeline where two of the four
nodes are **fusion nodes**: `draft` is a **Mixture-of-Agents** panel (one sibling per model tier → a judge
SYNTHESIZES across them) and `harden` is **best-of-n** (one model sampled N times → a judge SELECTS + repairs
the strongest). You author only 4 plain nodes with `--fusion*` flags; the loader MATERIALIZES the siblings +
judge into the real DAG at load ("the redrawn DAG"). Read this dir's `README.md` and `AUTHORING-GUIDE.md` first.

## Topology (4 stages — a linear spine; the fusion width is internal)

```
[ plan ] → [ draft ] → [ harden ] → [ publish ]
             │            │
   fusion=moa (panel)   fusion=best-of-n (n=N)
   siblings: one per     siblings: N samples of one tier
   panel tier → judge    → judge SELECTS + repairs the best
   SYNTHESIZES → out       → out
```
The spine (`plan · draft · harden · publish`) is FIXED — always exactly these 4 authored nodes. What is
PARAMETRIC lives INSIDE `draft` and `harden`: the panel tier-set, the best-of-n N, and WHICH stage(s) fuse.
`extract` shows the 4-node spine only (free DAG preview, no model); the siblings+judge appear at load/`--dry-run`.

## Parametricity rule — sizing the two fusion holes (and which stage fuses)

- **MoA panel tiers on `draft`** = one sibling per DISTINCT capability band you want coverage from — **2–4
  tiers** from `fast · balanced · deep` (the seed tiers). All three when breadth matters; 2 when a band is
  irrelevant. Never one sibling per keyword — a tier = a distinct model-strength lane.
- **best-of-n `--fusion-n` on `harden`** = independent samples of ONE tier to race — **2–5** (N=3 default;
  higher only when variance is high and the judge can tell samples apart). N is a COUNT, not "several".
- **Which stage(s) fuse** is itself a hole: fuse `draft` only, `harden` only, or BOTH (the golden). Fuse a stage
  ONLY when a single model draft is untrustworthy there — a plain node is cheaper.

## Lane → preset map (bind with `--agent-type`; fusion via `--fusion*`)

| role | base agent (`--agent-type`) | fusion flags | skill | extra `--tool` |
|---|---|---|---|---|
| **plan** | **general-purpose** | — (plain node) | — | `--deny bash --deny edit` (narrow the broad preset `read write edit bash submit_result` → `read write submit_result`) |
| **draft** | **author** (or `general-purpose`) | `--fusion moa --fusion-panel fast --fusion-panel balanced --fusion-panel deep --fusion-judge deep` | — | — |
| **harden** | **verify** (or `general-purpose`) | `--fusion best-of-n --fusion-n 3` (+ `--tier deep`) | — | — |
| **publish** | **general-purpose** | — (plain node) | — | `--deny bash --deny edit` |

Bind each node with `--agent-type <id>` — one flag folds the preset's tools + skill + `agentType` label via
`mergePreset`; the role is inherited BY REFERENCE, so each `prompt.md` holds ONLY its task. `--fusion-panel` is
REPEATABLE (one flag per tier); `--fusion-judge <tier>` must differ from any `--tier` you set (no self-judging).
The judge synthesizes (moa) or selects+repairs (best-of-n) automatically — you do NOT author a judge node; the
loader materializes `<id>__judge` + the siblings. (The golden binds `plan`/`publish` to `general-purpose` and
lets `draft`/`harden` inherit the default agent while carrying only fusion + `inject` — either binding is valid.)

## Per-node I/O seam (read-this → write-that; PROSE everywhere — all seams are LLM hand-offs)

- **plan** — reads `{{RUN}}`; writes ONE outline to `plan/outline.md` (PROSE): sections + must-cover terms the
  draft must honor. BOUNDARY seam (the fragment's first input is `{{RUN}}` / an `externalInput`).
- **draft** — `inject`s `{{RUN}}/plan/outline.md`; the MoA panel each drafts, the judge SYNTHESIZES one merged
  draft to `draft/draft.md` (PROSE, follows the outline).
- **harden** — `inject`s `{{RUN}}/draft/draft.md`; best-of-n samples N hardened versions, the judge SELECTS +
  repairs the strongest to `harden/hardened.md` (PROSE, same structure, tighter/corrected + a `## Changes` list).
- **publish** — `inject`s `{{RUN}}/harden/hardened.md`; assembles the final artifact to `out/explainer.md`
  (PROSE), dropping editorial scaffolding. BOUNDARY seam (the fragment's last output).

No strict-JSON boundary exists here — every seam feeds a reasoning consumer, so PROSE throughout. Siblings + the
judge write UNDER their parent's `owns` (materialized), so you author no extra owns glob for them.

## Wiring discipline (linear `--dep` chain; disjoint `--owns`; fusion flags do the expansion)

- **Linear spine:** `draft --dep plan`, `harden --dep draft`, `publish --dep harden`; `plan --dep` (none). The
  file-path wire also forms via `inject` of the upstream artifact — the `--dep` makes the stage order explicit.
- **Disjoint `--owns` per node** — `plan/**` · `draft/**` · `harden/**` · `out/**`. These are already disjoint
  (one namespace per node); the materialized siblings+judge write inside their parent's glob, so disjointness
  holds automatically. Never point two authored nodes at the same owns glob.
- **`--on-fail block` on EVERY node** — each emits a required artifact (`--artifact <path>` + a `non-empty`
  post-check), so a miss must block, not warn.
- The `--fusion*` flags are the ONLY expansion mechanism — do NOT hand-author sibling or `__judge` nodes;
  `extract`/load derives them.

## Golden pointer

`.piflow/example-fusion/template/` — the DAG-explainer pipeline (`plan → draft → harden → publish`).
`draft/node.json` carries `fusion:{mode:"moa", panel:["fast","balanced","deep"], judge:"deep"}`; `harden` carries
`fusion:{mode:"best-of-n", n:3}` with `tier:"deep"`; `plan`/`publish` are `general-purpose` consumers narrowed
via `deny:[bash, edit]` to `read·write·submit_result`. Each
node `inject`s the prior stage's artifact and `owns` its own namespace (`plan/** draft/** harden/** out/**`).
`extract` shows the 4-node spine; `run --dry-run` (or the GUI, F for Fusion mode) shows the siblings+judge
expansion. Inspect it for a concrete realization of every rule above.

## The bar (revise the stamped template until ALL pass)

1. `piflowctl extract <dir>` EXITS 0 and shows the 4-stage spine `plan → draft → harden → publish` (siblings +
   judge do NOT appear here — that is `--dry-run`, and is correct).
2. Every node dir has BOTH `node.json` AND a non-empty `prompt.md` (task-only; role from the preset).
3. `draft.node.json` has `fusion.mode: "moa"` with a `panel` array (+ `judge`); `harden.node.json` has
   `fusion.mode: "best-of-n"` with an integer `n`.
4. `--owns` globs are disjoint across the 4 nodes; every node has `policy.fail: block` + a `non-empty` post-check.
5. The panel tier-set, N, and which-stage-fuses were chosen by the parametricity rule (fuse only untrusted
   stages), not copied blindly.

## Self-check before returning

Stamp, then audit each of the five bar items PASS/FAIL with one line of evidence (for item 1, paste the literal
`extract` output — it MUST read `4 nodes · 4 stages`, NOT a sibling count). The most likely confusion is
expecting the siblings in `extract`; they are correct to be absent (extract is the model-free spine preview).
Fix every FAIL, re-audit, return only when all five PASS. If extract stays red for a cause you cannot resolve,
HALT and report the exact error — never claim green.
