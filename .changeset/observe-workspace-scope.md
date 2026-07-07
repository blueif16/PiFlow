---
"@piflow/core": minor
"@piflow/cli": patch
---

Ground-up observe rescope: one workspace = one `.piflow`, meta.id is the workflow identity.

- `discoverNamespaces` keys workflows by `meta.id`; sibling dirs sharing an id are variant
  homes of ONE workflow — merged into a single namespace emitted exactly once (fixes the
  duplicate-emission render bug), with the canonical `templatePath` taken from the main home
  (the dir named like the id). New additive `dirs: string[]` field lists every home.
- `buildSnapshot` files each run by the `meta.id` of the workflow dir it physically lives in;
  `run.json.source` parsing, cross-product template resolution, and the `unfiled` bucket are
  removed.
- `resolveScope` returns the single enclosing workspace root — no recursive nested-product
  down-discovery; `findProductRootsUnder` is removed from the public surface.
- Registry hygiene: `registerProductRoot` no-ops for roots under the OS temp dir and
  `saveRegistry` prunes entries whose root no longer exists, so `~/.piflow/products.json`
  self-heals instead of accumulating dead test/scratch entries.
- `piflowctl gui`/`tui` launch messaging reflects the single-root focus.
