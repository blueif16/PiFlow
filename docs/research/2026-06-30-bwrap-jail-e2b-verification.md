# Verifying the bwrap filesystem jail in an E2B sandbox (2026-06-30)

## Question

The `--sandbox local` Linux backend (`packages/core/src/sandbox/bwrap.ts`) was unit-tested for argv
construction, but its **kernel EPERM enforcement was never run** — GitHub's hosted Ubuntu runners can't
build an unprivileged user namespace (the 24.04 AppArmor clamp), so the `kernelIt`-gated test
skips-with-reason. Can we prove the jail in our **E2B** cloud sandbox instead?

## Answer: yes — and E2B is well-suited

E2B sandboxes are Firecracker microVMs (own kernel, we have root). The piflow-node-runtime template is
**`node:22-trixie-slim` — Debian 13, which has NO Ubuntu-24.04 AppArmor userns clamp.** A `--ro-bind / /`
namespace builds cleanly as the unprivileged default `user`.

Harness (boots one VM, installs bubblewrap, runs piflow's **real** `buildBwrapArgs` from built `dist`
against a real namespace, kills the VM in `finally`):

- `deploy/e2b/bwrap-jail-live.mjs` — host orchestrator
- `deploy/e2b/bwrap-proof-driver.mjs` — runs inside the VM; replicates the repo's `kernelIt` assertions

```
pnpm --filter @piflow/core build       # the proof runs the BUILT argv builder
set -a; source ~/.zshenv; set +a; node deploy/e2b/bwrap-jail-live.mjs
```

(`e2b` resolves from `packages/e2b/node_modules` only — same as the sibling `smoke-live.mjs`; a transient
root `node_modules/e2b` symlink bridges it for a repo-root run.)

## What the live run proved (sandbox `icx10…`, Debian 13 trixie, node v22.23.1, bwrap 0.11.0)

**VERDICT: JAIL-PROVEN** — the real jail enforces the boundary, kernel-side, as the unprivileged user:

| check (`$HOME` fixture, real `buildBwrapArgs` argv) | result |
|---|---|
| in-scope read returns the file | ✅ exit 0, `IN_SCOPE` |
| in-scope write lands on the host | ✅ exit 0, file present |
| out-of-scope read denied + secret never leaks | ✅ `No such file or directory` (path absent from namespace) |
| out-of-scope write denied + nothing lands | ✅ `Directory nonexistent` |
| network NOT unshared (the piflow divergence) | ✅ no `--unshare-net` |

## Two bugs the run surfaced

### Finding A — `probeBwrapUsable()` false-negatives on merged-usr Debian (fail-open security hole)

`bwrap.ts` decides availability by spawning `bwrap --ro-bind /usr /usr --proc /proc --dev /dev true`.
On Debian this returns **exit 1: `bwrap: execvp true: No such file or directory`** — the namespace builds
fine, but `true` can't exec because its ELF interpreter (`/lib64/ld-linux-x86-64.so.2`, and the
`/lib`→`/usr/lib` symlink chain) and `/bin` are NOT bound by the `/usr`-only probe. Adding only `/lib64`
still fails (the loader symlink chain also needs `/lib`); `--ro-bind / /` passes.

**Consequence:** on a Debian (merged-usr) host, `probeBwrapUsable()` → `false` → `bwrapExecPlan` returns
`null` + warns → the node runs **UNSANDBOXED** with no read/write-scope enforcement — even though the real
jail (which binds the full `SYSTEM_READ_ROOTS`) works perfectly. This is fail-open on a major distro.

**Fix (recommended):** make the capability probe faithful — `bwrap --ro-bind / / --proc /proc --dev /dev
true` (proven to pass). Apply to both `probeBwrapUsable()` (bwrap.ts) and `bwrapCanBuildNamespace()`
(sandbox-bwrap.test.ts). Converges with the open **fail-closed vs warn-and-degrade** posture decision.

### Finding B — the `kernelIt` test fixture under `/tmp` is shadowed by `--tmpfs /tmp`

`buildBwrapArgs` emits `--tmpfs /tmp` **after** the rw binds. A workdir under `/tmp` is therefore
overmounted by the fresh tmpfs and disappears from the namespace. The `tmp` battery confirmed it:

```
tmp.IN_READ  ✗  bwrap: Can't chdir to /tmp/bwrap-tmp-XXX/granted: No such file or directory
```

The repo's `kernelIt` test stages its fixture under `os.tmpdir()` (=`/tmp`), so **it will fail the moment
it runs on Linux** — not because the jail is broken, but because the fixture lives under the overmounted
`/tmp`. (The `$HOME` battery, workdir outside `/tmp`, passes cleanly — that's the real proof.)

**Fix (recommended):** stage the `kernelIt` fixture outside `/tmp` (mkdtemp under `$HOME` or the repo).
**Design note:** the `--bind /tmp /tmp` then `--tmpfs /tmp` pair means the rw `/tmp` bind is immediately
dead; and any node `owns`/workdir legitimately under `/tmp` would silently break. Consider emitting
`--tmpfs /tmp` **before** the rw binds (so a `/tmp`-nested write lane survives), or documenting that node
write lanes are never under `/tmp` (true today: runs live under the product `.piflow/…`).

## Bottom line

The Linux kernel jail is real and enforces per-node read/write scope (proven on E2B Debian). Before it
can be trusted on Linux hosts, fix Finding A (else Debian silently runs unsandboxed) and Finding B (else
the gating test fails on first Linux run). E2B is a viable standing verification environment for the jail
where GitHub's hosted runners are not.
