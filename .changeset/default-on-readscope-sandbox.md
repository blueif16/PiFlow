---
"@piflow/core": minor
"@piflow/cli": minor
---

Read-scope isolation is now SECURE BY DEFAULT on the real-run path.

`piflowctl run --sandbox local` previously executed each node with NO OS enforcement of the
node's declared `contract.readScope` — a node's shell could read the entire filesystem
(`~/.ssh`, `.env`, sibling lanes). The Seatbelt provider that enforces read scope existed but
was unreachable from the CLI.

Now the in-place `LocalSandbox` wraps every node exec in the shared `seatbeltExecPlan` jail on
macOS, kernel-enforced and SYMMETRIC: reads are bound to `readScope` + toolchain, and WRITES are
bound to the node's `owns` (write scope) + workdir + toolchain scratch (the writable set is adopted
from OpenAI Codex's `workspace-write` profile). Because the Seatbelt profile inherits to every
child, a node's `bash` can neither read nor write outside its declared lane — it gets exactly its
prepared context and writes only its own outputs. `process-exec` and network stay open (the `pi`
agent must run tools and reach its model gateway — unlike Codex, which jails shell sub-commands
that need no network).

- New `--sandbox danger-full-access` value: the loud, explicit escape hatch that disables the
  jail (`LocalSandboxProvider({ enforceReadScope: false })`).
- A typo'd `--sandbox` value now errors loudly instead of silently degrading to `inmemory`.
- The Seatbelt profile auto-grants the resolved node binary dir + version-manager roots
  (NVM_DIR/FNM_DIR/MISE_DATA_DIR/VOLTA_HOME/PNPM_HOME) and `~/.piflow`, so `pi` boots under the
  jail regardless of how node was installed.

BEHAVIOR CHANGE: a `--sandbox local` run that previously relied on reads outside its declared
`readScope` will now hit EPERM for those paths. Declare the path in the node's `readScope`, or
use `--sandbox danger-full-access`. On non-macOS, `local` still runs unsandboxed (with a warning)
until the Linux bubblewrap backend is wired.
