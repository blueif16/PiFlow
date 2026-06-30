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

**Fix — DONE (`75a3336`):** the capability probe now binds the whole root read-only — `bwrap --ro-bind / /
--proc /proc --dev /dev true` (a pure "can a user namespace be built here" check, exposes the loader on every
distro). Applied to both `probeBwrapUsable()` (bwrap.ts) and `bwrapCanBuildNamespace()` (sandbox-bwrap.test.ts).
**Re-verified live on E2B Debian (`igmova…`): the new probe exits 0** (`PROBE_CURRENT` ✅; the old `/usr`-only
and `/usr`+`/lib64` probes remain as expected-fail diagnostics, proving why the fix had to be `--ro-bind / /`).

### Finding B — the `kernelIt` test fixture under `/tmp` is shadowed by `--tmpfs /tmp`

`buildBwrapArgs` emits `--tmpfs /tmp` **after** the rw binds. A workdir under `/tmp` is therefore
overmounted by the fresh tmpfs and disappears from the namespace. The `tmp` battery confirmed it:

```
tmp.IN_READ  ✗  bwrap: Can't chdir to /tmp/bwrap-tmp-XXX/granted: No such file or directory
```

The repo's `kernelIt` test stages its fixture under `os.tmpdir()` (=`/tmp`), so **it will fail the moment
it runs on Linux** — not because the jail is broken, but because the fixture lives under the overmounted
`/tmp`. (The `$HOME` battery, workdir outside `/tmp`, passes cleanly — that's the real proof.)

**Fix — DONE (`75a3336`), at the source not the test:** `buildBwrapArgs` now emits `--tmpfs /tmp` **before**
the binds (so a write lane nested under `/tmp` overlays the tmpfs and survives) and **no longer binds the bare
host `/tmp`** (the tmpfs IS the private writable `/tmp`; binding host `/tmp` was dead and a re-exposure risk).
The `kernelIt`/`tmp`-battery fixture stays under `os.tmpdir()` — now a genuine regression test for the `/tmp`
case. **Re-verified live on E2B Debian: the `tmp` battery (workdir under `/tmp`) now passes 4/4** (was failing
`Can't chdir`); argv confirms `--tmpfs /tmp` is first and bare `/tmp` is never bound.

### Fail-closed posture — DONE (`c81c11f`)

With Finding A fixed (so a usable bwrap is correctly detected), `LocalSandbox.exec` is now **fail-CLOSED**:
when read-scope enforcement is requested but no kernel jail backend is available (unsupported OS, or Linux
without a usable bubblewrap → `localJailPlan` returns `null`), exec **refuses** — it resolves a failure
`ExecResult` (code 126, an actionable message) **without spawning** the command, instead of the old silent
bare run. The only way to run unsandboxed is the explicit `--sandbox danger-full-access` bypass. The
jail/bwrap warnings and docs were reworded from "running UNSANDBOXED" to "the jail is UNAVAILABLE → the run
will REFUSE." (Unit-tested by forcing an unavailable backend; the positive case — jail RUNS on a capable host
— is what the E2B run above proves.)

## Bottom line

The Linux kernel jail is real and enforces per-node read/write scope — **proven on E2B Debian, twice**: once
to find the bugs, once to confirm the fixes. Findings A + B are fixed (`75a3336`) and the posture is now
fail-closed (`c81c11f`); the re-run shows the new probe passing, the `/tmp` battery passing, and the jail
enforcing scope as the unprivileged user. E2B is a viable standing verification environment for the jail
where GitHub's hosted runners are not — `node deploy/e2b/bwrap-jail-live.mjs` reproduces this end-to-end.
