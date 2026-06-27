---
"@piflow/daytona": minor
"@piflow/core": patch
"@piflow/cli": patch
---

Extract the Daytona cloud-sandbox backend out of `@piflow/core` into a new choose-to-install extension `@piflow/daytona` (`npm i @piflow/daytona`; the CLI loads it dynamically on `--sandbox daytona`). One long-lived Daytona VM per run (per-node workdir subtrees, torn down once) behind `@piflow/core`'s existing sandbox seam — boot from a pre-built snapshot or a raw image ref, with the pi gateway credential allowlisted into the VM. This mirrors `@piflow/e2b`: both cloud providers are now extensions, and core keeps only the local/inmemory/seatbelt/worktree backends plus `NotImplementedProvider`. Daytona behavior is byte-for-byte unchanged (a MOVE). `@piflow/core` drops its `DaytonaSandbox`/`DaytonaSandboxProvider`/`createDaytonaProvider`/`realDaytonaSdk` exports and its `@daytona/sdk` dependency (pre-1.0, acceptable); the CLI's `--sandbox daytona` path now dynamic-imports the extension with a clear `npm i @piflow/daytona` install message.
