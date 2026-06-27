# Fusion nodes — author how-to

> Add a `fusion` block to any node and it becomes a **panel of agents whose answers a judge fuses into
> one**. The design contract (where every knob lives, the precedence, the judge structure we port from
> pi-fusion) is [`specs/per-node-routing-and-fusion.md`](specs/per-node-routing-and-fusion.md) §4 — read it
> for the *why*. This page is the *how*: the block, the two modes, and what it expands into.

## TL;DR

```jsonc
// nodes/<id>/node.json — add ONE block; everything else stays the same
"fusion": {
  "mode": "moa",                 // "moa" | "best-of-n"   (required)
  "panel": ["fast", "deep"],     // moa: one sibling per entry (model id OR tier alias)
  "judge": "deep",               // judge model/tier      (default: the node's own model)
  "obligations": true,           // derive a coverage checklist first (default false)
  "verify": true                 // judge verify→revise loop (default true)
}
```

That node now runs as **`deps → (panel ‖) → judge → original successors`**. You change nothing else: the
node keeps its id, its artifacts, and every downstream edge. Per-node `model`/`tier` routing (G1) and the
fusion panel compose — a panel entry is just a model id or a tier alias resolved the same one way.

## The two modes

| Mode | What the siblings are | What the judge does | Use when |
| --- | --- | --- | --- |
| **`moa`** (mixture-of-agents) | one sibling per `panel` entry, **each a different model** | **synthesizes** a fresh answer across the panel — never picks a winner, never averages | you want diverse models' strengths combined (the default for "best quality") |
| **`best-of-n`** | `n` siblings, **all the node's own model** (diversity from sampling) | **selects** the strongest candidate and lightly repairs it | one strong model, you want the best of several samples |

`best-of-n` ignores `panel` and uses `n` (default 3); `moa` ignores `n` and uses `panel` (required — a `moa`
node with no panel is a loud `FusionConfigError`).

## What it expands into

A `moa` node `draft` with `panel: ["fast","deep"]` (and a downstream `publish` that reads `draft`'s output):

```
            ┌── draft__p1  (model: fast)  → fusion-draft-p1/partial.json ──┐
draft.deps ─┤                                                              ├─→ draft (JUDGE) → spec/answer.md → publish
            └── draft__p2  (model: deep)  → fusion-draft-p2/partial.json ──┘
```

- **Siblings** `draft__p1 … draft__pN` clone `draft`'s original prompt + read-scope + deps; each owns and
  produces a distinct partial in its **own top-level dir** `fusion-<id>-p<i>/partial.json` (disjoint dirs so
  the parallel-stage output collection never collides). Write-disjoint ⇒ they run as **one parallel stage**.
- **The judge IS `draft`** (same id): its prompt is replaced by the mode's judge prompt, it reads the
  partials, and it keeps `draft`'s **original `produces`/artifacts/integrity-contract** — so `publish` (and
  every other downstream edge, data-flow *or* `deps`) is preserved untouched.
- The expansion runs **before `compile`**; the existing compiler draws the picture from `produces ⋈ reads`.
  No new DAG concepts — a fusion node is just sugar for a sub-graph.

With `obligations: true`, a `draft__obl` pre-node derives a coverage checklist
(`fusion-<id>-obl/obligations.json`) that the judge consumes, so the final answer is audited against every
requirement the task named.

## They're preset agents

The judge and obligations nodes are first-class **G6 preset agents** — they carry an `agentType`
(`fusion-judge-moa` / `fusion-judge-best-of-n` / `fusion-obligations`), so observe and the GUI brand them
with the fusion icon like any other preset node. The verbatim judge/obligations prompts (authored to the
`agentic-prompt-design` bar — Appendix A of the spec) are the preset bodies in
[`packages/core/src/workflow/fusion/`](../packages/core/src/workflow/fusion/) (`prompts.ts` + `presets.ts`).

## Global defaults — `~/.piflow/fusion.json`

Every `fusion.<param>` falls back to a global default, then a built-in:

```jsonc
// ~/.piflow/fusion.json   (optional, read-only; absence is graceful)
{
  "active": true,                 // lets `piflow-init` auto-mark best-quality nodes as fusion
  "mode": "moa",
  "panel": ["fast", "balanced", "deep"],
  "judge": "deep",
  "obligations": true,
  "verify": true
}
```

Precedence (spec §2): `node.fusion.<param>` › `~/.piflow/fusion.json` › built-in (`n=3`, `verify=true`,
`obligations=false`). Panel/judge entries that name a **known active tier** resolve through
`~/.piflow/model-tiers.json` (G1); anything else is treated as a literal model id.

## Status

Implemented end-to-end: the `fusion` template block (schema + loader), `expandFusion` (both modes,
obligations, tier-classification), the preset agents, the `~/.piflow/fusion.json` reader, and the **run-path
wiring** — a live run (`runFromConfig`/`runFromTemplate`) and `piflowctl run … --dry-run` both honor fusion
(expand AFTER profile, BEFORE compile). Exercised by `fusion-expand` / `fusion-config` / `entry` tests.
Optional, deferred: per-participant objective-failure fallback (`T2.5`).
