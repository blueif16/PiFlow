# @piflow/langgraph

## 0.1.1

### Patch Changes

- b1dab77: Declare `engines.node >=22` on every published `@piflow/*` package.

  Node 22 is already the repo's dev/test/CI floor (the `openclaw` dev-tooling pins undici 8.x,
  which calls `worker_threads.markAsUncloneable`, present only on Node >=22.10). This makes the
  support floor uniform and explicit across the published surface rather than leaving the
  packages' `engines` unset — `npm`/`pnpm` now warn on Node <22 at install time. Code is unchanged.

- Updated dependencies [3fc00ee]
- Updated dependencies [08c153a]
- Updated dependencies [41159ef]
- Updated dependencies [b1dab77]
- Updated dependencies [04072fe]
- Updated dependencies [132b524]
- Updated dependencies [991cb7f]
- Updated dependencies [596e6e0]
- Updated dependencies [d344ec5]
  - @piflow/core@0.2.0
