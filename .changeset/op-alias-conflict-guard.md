---
"@piflow/core": patch
---

`loadTemplate` now REJECTS a node that authors `op[]` alongside the `inject`/`hooks` aliases.

When a node carries a directly-authored `op[]`, the loader's grammar-unification (`lowerToOps`) returns it
verbatim and never lowers the deprecated aliases — so an `inject`/`hooks.*` sitting next to it was SILENTLY
dropped (e.g. `DRIVER-INJECT` vanished and the model quietly stopped receiving the injected file, with no
error). This was only catchable by diffing resolved markers.

The new fail-closed §8 check names the node and the dropped alias(es) and tells the author to hand-lower each
into the same `op[]`. `checks`/`policy`/`return` are exempt — they keep their own channels
(`io.checks`/`io.policy`/`io.returnSchema`) and survive alongside an authored `op[]`, so they are not flagged.
