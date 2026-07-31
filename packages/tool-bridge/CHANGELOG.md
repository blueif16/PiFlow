# @piflow/tool-bridge

## 0.1.1

### Patch Changes

- b1dab77: Declare `engines.node >=22` on every published `@piflow/*` package.

  Node 22 is already the repo's dev/test/CI floor (the `openclaw` dev-tooling pins undici 8.x,
  which calls `worker_threads.markAsUncloneable`, present only on Node >=22.10). This makes the
  support floor uniform and explicit across the published surface rather than leaving the
  packages' `engines` unset — `npm`/`pnpm` now warn on Node <22 at install time. Code is unchanged.
