# Read-scope sandbox (`--sandbox`, macOS) — kernel-enforced READING LAW

`--worktree` (see `worktree-isolation.md`) makes a node's *writes* physically isolated. It does
**not** stop a node *reading* files outside its lane. A cheap model that can't find a component will
`grep -rn` the whole repo and `cat` other units' source "for reference" — bloating its context (one
real composer node read 3 sibling units' source and hit 116k tokens, then stalled). A prompt-level
"only read your own inputs" rule is unenforceable on a weak model. `--sandbox` moves that boundary
into the OS.

## What it does

A node that DECLARES its read scope — a `DRIVER-READ-SCOPE:` marker in its prompt (space-separated
absolute roots, rendered by the same `contract()`/marker family as `DRIVER-ARTIFACTS`) — is wrapped
in macOS `sandbox-exec` with a per-node Seatbelt profile. The profile is **deny-all-file-reads**,
then re-allow exactly:

1. the toolchain/system roots node + pi + npm need (`/usr`, `/System`, `~/.pi`, `$TMPDIR`, …),
2. the node's DECLARED scope (its own inputs + shared libs + the catalog the workflow points it at).

Any read outside that union — another unit's source, a `grep` from `/` — returns
`Operation not permitted`. The denial is **kernel-enforced and inherited by every child process**, so
a spawned `grep`/`find`/`cat` is bound too and cannot be lifted from inside the sandbox.

Scope is READS only (the incident was a read leak). `exec` and `network` are left open so the
toolchain is unaffected.

- **Opt-in, non-breaking.** Default OFF. Only a node carrying a `DRIVER-READ-SCOPE` marker is wrapped;
  every other node spawns plain `pi`, byte-identical to a non-sandbox run. Turn on with `--sandbox`
  or `PI_RUNNER_SANDBOX=1`.
- **macOS only.** Seatbelt/`sandbox-exec`. On Linux the equivalent is `bubblewrap` (not wired); on a
  non-darwin platform the driver warns and runs the node UNSANDBOXED.

## The profile must grant the FULL runtime read surface

The single biggest pitfall: a profile that passes a static demo can still `EPERM` on the first real
toolchain call, because the toolchain reads more than the declared lesson scope. `buildSandboxProfile`
(in `run.mjs`) therefore auto-grants, beyond the declared scope:

- **`node_modules`** (run-cwd + repo-root) — modules must resolve.
- **process cwd as a non-recursive `(literal …)`** — `getcwd`/`uv_cwd` needs file-read DATA on the cwd
  directory ENTRY (metadata is not enough); if cwd is outside every granted root the process EPERMs on
  `uv_cwd` *before pi even runs*. Granting it as a `(literal)` (not a `(subpath)`) lets the dir entry
  read while its subdirs stay denied — a `(subpath cwd)` would re-expose the whole repo and defeat the
  isolation.
- **every `-e` extension's dir** — the bundled `node-contract.ts` (from `PI_RUNNER_CONTRACT_EXT`) and
  any explicit `--extension` live outside the repo scope; pi EPERMs loading the extension and never
  boots without the grant.
- **the realpath TARGET of every workspace-linked dep** (`linkedPkgTargets`) — `@scope/*` and other
  linked packages are SYMLINKS inside `node_modules` pointing OUTSIDE it (e.g. a monorepo sibling).
  Seatbelt checks the symlink TARGET realpath, so granting `node_modules` alone makes `tsc`/`webpack`/
  `node` EPERM with `Cannot find module @scope/x` — which derails the agent into a phantom module-hunt.
  The fix grants each linked package's resolved realpath target.

Every granted root is expanded to `{itself, its realpath}`, because Seatbelt matches file-read on the
resolved realpath, not the lexical path. Two consequences: a model **cannot** escape via a self-made
symlink (the target realpath is what is checked), and the read-scope **auto-follows a worktree** (under
`--worktree`, `node_modules` is a symlink into the main checkout; granting its target realpath makes
modules load). The `BASE_ROOT→wtRoot` prompt rewrite runs before scope extraction, so a declared scope
under the repo is rewritten into the worktree automatically — `--sandbox` and `--worktree` compose.

## Declaring a node's read scope (in the workflow)

**Every producing node declares its read-scope; it is part of the contract, not an afterthought** —
authored at node creation time exactly like `owns`/`artifacts`, in the same `contract({...})` call.
The helper renders the `DRIVER-READ-SCOPE:` marker from a `readScope` array (the entries are absolute
and joined AS-IS — unlike `artifacts`/`owns`, which are REPO-relative and `abs()`-prefixed):

```js
contract({
  artifacts: [ /* … */ ],
  owns:      [ /* … */ ],
  readScope: [
    `${REPO}/${data}`,     // this unit's own data dir
    `${REPO}/${out}`,      // this unit's own out dir
    `${ROOT}/.agents`,     // the shared skills/docs every node reads
    // + the shared src/catalog roots THIS node actually reads (code nodes only):
    //   `${REPO}/src`, `${REPO}/public`, `${REPO}/scripts`, `${REPO}/package.json`, …
  ],
})
```

**What to GRANT:** the node's own data/out dirs, the named skills/docs it reads (`${ROOT}/.agents`),
and the shared `src`/`public`/`scripts`/catalog roots it legitimately reads (a self-check that bundles
the project pulls sibling source into the bundle graph, so the shared `src` root is unavoidable for a
code-touching node). **What to EXCLUDE:** every OTHER unit's *design inputs* (the hidden-hard-coding
surface) and the wider tree. The motive to read a sibling should also be removed in the node's SKILL —
the sandbox is the backstop, not the only line of defense.

This used to be framed as something you bolted onto "the node that spelunks." That was the bug: in the
reference workflow only the **composer** carried a `DRIVER-READ-SCOPE`, hand-rolled as a raw string
(the helper had no `readScope` field), so every OTHER node ran unsandboxed — and a cheap model
(MiniMax-M3) read-thrashed an un-scoped node (120 reads, `find / -name`, a contaminating proposal file
read 5×) until it timed out. The fix is to make read-scope a first-class `contract()` field that every
producing node fills in.

> **Run the fleet with `--sandbox`** (or `PI_RUNNER_SANDBOX=1`) so the declared scopes are actually
> enforced. Without it, the `DRIVER-READ-SCOPE` markers are inert text — present in the prompt, but no
> OS boundary is applied. Declaring the scope is necessary; turning the sandbox on is what makes it law.

## The two behavioral watchdogs (pair with `--sandbox`)

The OS boundary stops the over-READ; two driver-side kills stop the degenerate loops the prompt can't,
both routed through one `killChild` (alongside the existing node-timeout and stuck-delta `REPEAT_KILL`):

- **`PI_RUNNER_STALL_TIMEOUT`** (default 300s) — silent-death kill: a model can stop emitting events
  ENTIRELY after a tool returns and sit dead to the node-timeout. If NO event arrives for this many
  seconds **while no tool is in flight**, the node is killed. The "no tool in flight" gate exempts a
  long silent bash (TTS/render). `0` disables.
- **`PI_RUNNER_TOOL_REPEAT_KILL`** (default 5) — no-progress tool-thrash kill: the SAME `(tool+args)`
  signature repeated this many times with NO `write`/`edit` between is a thrash (the composer spelunk
  fired identical `grep -rn` ×7 with zero files written). The per-signature counters RESET on any
  write/edit/submit_result, so a node that legitimately re-runs an identical `:check` after each edit
  never trips. `0` disables.

Both feed the escalation gate: `killedStall`/`killedToolLoop` classify as `ESCALATE` (a same-model
retry would thrash the same way), with the evidence passed in the consult preamble.

## Verify the mechanism

`sandbox/demo.sh` renders `read-scope.sb` with the SAME substitution the driver uses and runs a
handful of reads under `sandbox-exec` — in-scope ALLOWED, sibling-source + repo-root + `grep /tree`
DENIED, node BOOTS under the sandbox — with no pi/model call. Point it at your repo via the `CONFIG`
block (or the `PI_RUNNER_DEMO_*` env vars).

## Editing `read-scope.sb` — two hard rules

1. Comments are PURE ASCII. The SBPL/TinyScheme reader miscounts multibyte UTF-8 (em-dashes,
   ellipses) and then parses comment text as code (an "unbound variable" error).
2. NEVER write a driver placeholder token (`@HOME@`, `@TMPDIR@`, `@SCOPE_ALLOWS@`) in a comment — the
   driver string-substitutes those, and a value spilled into a comment becomes live code. Each token
   appears ONCE, only at its rule site.
