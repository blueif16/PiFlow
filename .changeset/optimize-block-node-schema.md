---
"@piflow/core": minor
"@piflow/cli": minor
---

Add the optimizer-facing `optimize` block to `node.json` (M0 of the per-node optimization substrate).

A node can now author a top-level `optimize: { measure, judge }` block — `measure` reuses the existing
`$defs/op` shape byte-for-byte (post-run measurement ops), `judge` a token-resolved path to a soft-judge
file. This block is deliberately NOT read by the loader's `toNodeIntent` (it never reaches the compiled
NodeSpec) — the out-of-band optimize substrate reads it straight off `node.json` via fs, the same way
`memory.md` is read today. `node.schema.ts`'s `additionalProperties:false` still bites: an unknown key
inside `optimize` fails the whole template load. `piflowctl add-node`'s `buildNode` gained a matching
`opts.optimize` passthrough (emitted verbatim, only when authored).
