# node: verify — code-map
<!-- Leg B · OPTIMIZER-FACING · Tier 0 = exactly ONE OKF reference slice for verify's scope.
     Records pointers + semantics, NEVER a copy of the source. NEVER injected into verify's runtime prompt.
     OKF-standard; Tier 1 (opt-in codegraph) later adds slice@sha + a product-global index. -->

type: reference
scope: <the product code in verify's io.reads / owns / readScope>

## What this code does
<!-- the functionality + the whole flow running inside verify, end to end. -->

## Seams & contracts
<!-- entry points + key files (pointers, not copies) + the contracts between them. -->

## Gotchas
<!-- the non-obvious behavior — what bit us; nothing deducible from the source in 5s. -->

## Freshness
<!-- Tier 0: refresh lazily when verify's scope-files change. -->
