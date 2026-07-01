# node: prod-impl — code-map
<!-- Leg B · OPTIMIZER-FACING · Tier 0 = exactly ONE OKF reference slice for prod-impl's scope.
     Records pointers + semantics, NEVER a copy of the source. NEVER injected into prod-impl's runtime prompt.
     OKF-standard; Tier 1 (opt-in codegraph) later adds slice@sha + a product-global index. -->

type: reference
scope: <the product code in prod-impl's io.reads / owns / readScope>

## What this code does
<!-- the functionality + the whole flow running inside prod-impl, end to end. -->

## Seams & contracts
<!-- entry points + key files (pointers, not copies) + the contracts between them. -->

## Gotchas
<!-- the non-obvious behavior — what bit us; nothing deducible from the source in 5s. -->

## Freshness
<!-- Tier 0: refresh lazily when prod-impl's scope-files change. -->
