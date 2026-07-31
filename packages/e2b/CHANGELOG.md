# @piflow/e2b

## 0.2.0

### Minor Changes

- be2f36b: Add `@piflow/e2b` — the E2B open-egress cloud-sandbox backend, packaged as a choose-to-install extension (`npm i @piflow/e2b`; the CLI loads it dynamically on `--sandbox e2b`). One long-lived E2B sandbox per run (per-node workdir subtrees, killed once) behind `@piflow/core`'s existing sandbox seam; egress is open by default — the unblock for heterogeneous/remote MCP that Daytona's tier-gated egress can't serve. Establishes the providers-are-extensions pattern (Daytona stays in core for now).

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
