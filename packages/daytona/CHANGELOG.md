# @piflow/daytona

## 0.2.0

### Minor Changes

- 08c153a: Extract the Daytona cloud-sandbox backend out of `@piflow/core` into a new choose-to-install extension `@piflow/daytona` (`npm i @piflow/daytona`; the CLI loads it dynamically on `--sandbox daytona`). One long-lived Daytona VM per run (per-node workdir subtrees, torn down once) behind `@piflow/core`'s existing sandbox seam — boot from a pre-built snapshot or a raw image ref, with the pi gateway credential allowlisted into the VM. This mirrors `@piflow/e2b`: both cloud providers are now extensions, and core keeps only the local/inmemory/seatbelt/worktree backends plus `NotImplementedProvider`. Daytona behavior is byte-for-byte unchanged (a MOVE). `@piflow/core` drops its `DaytonaSandbox`/`DaytonaSandboxProvider`/`createDaytonaProvider`/`realDaytonaSdk` exports and its `@daytona/sdk` dependency (pre-1.0, acceptable); the CLI's `--sandbox daytona` path now dynamic-imports the extension with a clear `npm i @piflow/daytona` install message.

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
