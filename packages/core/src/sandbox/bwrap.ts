// ─────────────────────────────────────────────────────────────────────────────
// bwrap.ts — the LINUX filesystem-isolation backend for `--sandbox local`, the
// kernel-enforced peer of seatbelt.ts. It is the SECOND renderer of the shared
// scope policy (scope.ts computeScopeRoots): same read-roots / write-roots the
// macOS seatbelt jail grants, rendered here as bubblewrap bind-mount argv instead
// of SBPL allow rules.
//
// MECHANISM — selective bind-mount = scope by construction. bubblewrap builds a
// brand-new mount namespace whose root is an empty tmpfs invisible to the host;
// you then construct the filesystem the command sees ONE bind at a time, in
// argument order (later ops overlay earlier ones). An UNBOUND host path is simply
// ABSENT from the namespace — so granting read/write scope is purely a matter of
// which paths we bind and how:
//   --ro-bind SRC DEST  → SRC visible READ-ONLY at DEST   (toolchain/system + readScope)
//   --bind    SRC DEST  → SRC visible READ-WRITE at DEST  (workdir + writeScope/owns + scratch)
//   --proc /proc, --dev /dev → a fresh procfs + minimal devfs the toolchain needs
//   --tmpfs /tmp        → a private in-memory /tmp (host /tmp stays hidden)
//   --chdir <cwd>       → cd into the working dir inside the namespace
//   --die-with-parent   → SIGKILL the sandbox tree if the runner dies (no orphans)
// A read OR write of any path we did NOT bind returns ENOENT/EROFS/EPERM — the
// boundary is the namespace contents, kernel-enforced and inherited by every child.
//
// PIFLOW DIVERGENCE FROM CODEX (deliberate, load-bearing): we jail the AGENT (`pi`)
// itself, which MUST reach its model gateway and run its toolchain. So UNLIKE
// codex-linux-sandbox we do NOT pass `--unshare-net` (network stays ON) and we do
// NOT add a seccomp net filter or any process-exec restriction — exactly mirroring
// the macOS seatbelt path, where exec + network are left open and ONLY file
// read/write scope is the boundary. The ONLY thing bwrap bounds here is the
// filesystem view.
//
// AVAILABILITY: returns null (caller runs bare, UNSANDBOXED) when NOT linux, OR
// when `bwrap` is not on PATH — warning ONCE in the not-available case so a Linux
// box WITHOUT bubblewrap NEVER silently believes it is sandboxed. The probe is
// memoized (one PATH scan per process).
//
// STATUS: the argv CONSTRUCTION is unit-tested cross-platform (sandbox-bwrap.test.ts).
// The kernel EPERM enforcement is PENDING a Linux CI run — it CANNOT be verified on
// the macOS host this was authored on (`bwrap` is absent; namespaces are a Linux
// feature). The linuxIt-gated kernel test SKIPS off-linux by design.
//
// SOURCES (cited per the research-first contract):
//   - bubblewrap man page / containers/bubblewrap — flag semantics (--ro-bind,
//     --bind, --dev, --proc, --tmpfs, --chdir, --die-with-parent, argument-order
//     overlay, unbound-path-absent): https://github.com/containers/bubblewrap +
//     https://www.mankier.com/1/bwrap + ArchWiki Bubblewrap/Examples.
//   - OpenAI codex-linux-sandbox — the system bind baseline a toolchain needs
//     (--ro-bind / / then --bind <root> for writable roots; --proc /proc; it
//     adds --unshare-net + seccomp ONLY when network is restricted — which we do
//     NOT): codex-rs/linux-sandbox/README.md + codex-rs/linux-sandbox/src/bwrap.rs
//     (github.com/openai/codex). We adopt its system read set as the toolchain
//     baseline and DROP its network/exec hardening (piflow jails the agent, not a
//     network-free shell).
// ─────────────────────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import path from 'node:path';
import { computeScopeRoots, homeDir } from './scope.js';

// ── platform + availability gating ─────────────────────────────────────────────────────────────────

// Read live (NOT a module-load const): the dispatcher reads process.platform at call time too, and a
// test forces the platform per-case — capturing it once at import would desync the two and freeze the
// branch a test is trying to exercise.
function isLinux(): boolean {
  return process.platform === 'linux';
}

/**
 * Memoized `bwrap`-on-PATH probe. We scan each PATH entry for an executable `bwrap` (cheaper and side-
 * effect-free vs spawning `bwrap --version`, which would also need a working user namespace just to
 * answer). The result is cached for the process lifetime — a box's bubblewrap install does not appear or
 * vanish mid-run. Injectable via the `_probe` seam below so a test can force present/absent without a
 * real binary on the test host.
 */
let bwrapAvailableCache: boolean | undefined;
function probeBwrapOnPath(): boolean {
  const pathEnv = process.env.PATH ?? '';
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, 'bwrap');
    try {
      fsSync.accessSync(candidate, fsSync.constants.X_OK);
      return true;
    } catch {
      /* not here — try the next PATH entry */
    }
  }
  return false;
}

/**
 * Can `bwrap` actually BUILD a namespace here? On PATH is necessary but NOT sufficient — Ubuntu 24.04's
 * AppArmor clamp on unprivileged user namespaces lets bubblewrap install yet abort on every invocation.
 * So we probe CAPABILITY (spawn a no-op jail), not mere presence: a present-but-broken bwrap is treated
 * as UNAVAILABLE, so exec falls through to the SAME warn-once + bare path as a missing bwrap — never
 * masking the command's own exit code with bwrap's abort code. Skips the spawn when bwrap is absent.
 */
function probeBwrapUsable(): boolean {
  if (!probeBwrapOnPath()) return false;
  // Bind the WHOLE root read-only, not just /usr: this is a pure CAPABILITY probe ("can an unprivileged
  // user namespace be built here"), so it must NOT depend on a node-CLI-shaped filesystem. On a merged-usr
  // distro (Debian/Fedora) binding ONLY /usr leaves the ELF loader (/lib64 + the /lib symlink chain)
  // unreachable, so `true` aborts with `execvp ... No such file or directory` (exit 1) even though the
  // namespace built fine — a FALSE NEGATIVE that silently drops `--sandbox local` to UNSANDBOXED. `--ro-bind
  // / /` exposes the loader on every distro and is the distro-agnostic check (verified exit 0 on E2B Debian).
  const r = spawnSync('bwrap', ['--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', 'true'], {
    stdio: 'ignore',
    timeout: 5000,
  });
  return r.status === 0;
}

/** Indirection so tests can stub the probe (and the memo) without a real `bwrap` on the host. */
const _probe: { isAvailable: () => boolean } = {
  isAvailable(): boolean {
    if (bwrapAvailableCache === undefined) bwrapAvailableCache = probeBwrapUsable();
    return bwrapAvailableCache;
  },
};

/** TEST SEAM: force the availability verdict (or reset to re-probe with `undefined`). Returns a restore
 * fn. Used ONLY by sandbox-bwrap.test.ts to prove the not-available fallback branch without bubblewrap. */
export function __setBwrapAvailableForTest(value: boolean | undefined): () => void {
  const prev = bwrapAvailableCache;
  bwrapAvailableCache = value;
  return () => {
    bwrapAvailableCache = prev;
  };
}

let warnedNoBwrap = false;
function warnNoBwrapOnce(): void {
  if (warnedNoBwrap) return;
  warnedNoBwrap = true;
  // eslint-disable-next-line no-console
  console.warn(
    `[bwrap] --sandbox local wants the bubblewrap filesystem jail on linux, but \`bwrap\` is not on PATH ` +
      `or cannot build a user namespace (e.g. an AppArmor unprivileged-userns clamp) — running ` +
      `UNSANDBOXED (no read/write scope boundary). Install bubblewrap and allow unprivileged user ` +
      `namespaces to enforce per-node scope on this host.`,
  );
}

/** TEST SEAM: reset the warn-once latch so a test can assert the warning fires on its run. */
export function __resetBwrapWarningForTest(): void {
  warnedNoBwrap = false;
}

// ── the toolchain/system bind baseline (Codex-derived) ──────────────────────────────────────────────

/**
 * The SYSTEM read roots a node + node + its toolchain need to even boot, bound READ-ONLY. Adopted from
 * codex-linux-sandbox's baseline (it does `--ro-bind / /` then re-binds writable roots; we instead bind
 * the specific system dirs so an unbound host path is genuinely absent — tighter, and symmetric with the
 * seatbelt template's enumerated system subpaths). Only the ones that EXIST on the host are bound (a box
 * may lack /lib64 or /opt); a missing source would make bwrap error, so we filter to existing paths.
 */
const SYSTEM_READ_ROOTS = [
  '/usr', // the bulk of the toolchain (node, git, coreutils) + shared libs
  '/bin', // often a symlink to /usr/bin, but bound when a real dir
  '/sbin',
  '/lib', // shared libraries (the dynamic linker, libc) — node will not start without them
  '/lib64', // x86_64 dynamic linker (/lib64/ld-linux-x86-64.so.2)
  '/etc', // resolver config, ssl certs, passwd/group — pi reaches its gateway, needs DNS + CA bundle
  '/opt', // some toolchains (managed node, system pi) install here
];

/** Home-scratch dirs both backends grant: pi/npm/node state. READ + WRITE (pi reads its config AND
 * writes its own run state, npm writes its cache). Bound rw (a rw bind is inherently readable too). */
function homeScratchRoots(): string[] {
  const home = homeDir();
  return ['.pi', '.piflow', '.npm', '.cache', '.config', '.nvm'].map((d) => path.join(home, d));
}

// ── the argv builder (PURE — unit-tested cross-platform, no bwrap needed) ────────────────────────────

/** Filter to host paths that actually exist (bwrap errors if a bind SRC is missing). realpath-expanded
 * roots may include both a symlink and its target; binding a path that does not exist would abort the
 * whole sandbox, so we drop the absent ones here (and de-dup). */
function existing(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (seen.has(p)) continue;
    seen.add(p);
    try {
      fsSync.statSync(p);
      out.push(p);
    } catch {
      /* path does not exist on this host — binding it would abort bwrap; skip */
    }
  }
  return out;
}

/**
 * Build the bwrap argv for ONE command from the shared scope policy — the PURE construction, factored
 * out so it is unit-testable on ANY platform WITHOUT a real `bwrap` (the tests call this directly). The
 * resulting argv, prefixed by `bwrap`, runs `<cmd>` in a mount namespace whose ONLY contents are:
 *   - a private in-memory /tmp (host /tmp stays hidden),
 *   - the system read roots + the computed read-roots (toolchain + readScope), bound READ-ONLY,
 *   - the computed write-roots (workdir + writeScope/owns) + the home-scratch, bound RW,
 *   - a fresh /proc and /dev,
 * with `--chdir <cwd>` and `--die-with-parent`. NO `--unshare-net` (network stays on) and NO process-exec
 * restriction — `sh -c <cmd>` runs with the host's network + exec, only the filesystem is bounded.
 *
 * Bind ORDER matters (bwrap applies ops left-to-right, later overlays earlier): we lay down the `--tmpfs
 * /tmp` FIRST (so a write lane nested under /tmp overlays it and survives, instead of being overmounted),
 * then the broad system read roots, then the rw scope ON TOP (so a writable root nested under a ro system
 * path stays writable), then /proc and /dev. The bare host /tmp mountpoint is NEVER bound — the writable
 * /tmp is the tmpfs. The `cwd` is included as a read root so a node may exec in a workdir subdir even if
 * the caller passes a cwd outside the literal workdir.
 */
export function buildBwrapArgs(
  cmd: string,
  opts: { workdir: string; readScope: string[]; writeScope?: string[] },
): string[] {
  const { readRoots, writeRoots } = computeScopeRoots(opts);

  // READ-ONLY binds: the system baseline + the toolchain/readScope roots. Filter to existing paths and
  // EXCLUDE any path that is also a write root (a path bound rw must not be re-bound ro afterward, which
  // would clobber it back to read-only — the write binds come AFTER and must win for those paths).
  const writeSet = new Set(writeRoots);
  const roReadRoots = existing([...SYSTEM_READ_ROOTS, ...readRoots]).filter((p) => !writeSet.has(p));

  // READ-WRITE binds: the node's write lane (workdir + owns) + the home-scratch. DELIBERATELY NOT $TMPDIR
  // (the `tmp`/tmpDir() value): on Linux that is the bare `/tmp` mountpoint, and binding it is both
  // pointless (the `--tmpfs /tmp` below overmounts it) and harmful (it would shadow any write lane nested
  // UNDER /tmp). The private writable /tmp comes from `--tmpfs /tmp`, not from binding host /tmp. Filter to
  // existing host paths (a writeScope dir is created by the sandbox, but a home-scratch dir like ~/.nvm may
  // be absent on a given box).
  const rwRoots = existing([...writeRoots, ...homeScratchRoots()]);

  const argv: string[] = [];
  // A private in-memory /tmp (host /tmp stays hidden), emitted BEFORE the binds so a write lane nested
  // under /tmp (e.g. a workdir under /tmp) OVERLAYS the fresh tmpfs and survives — bwrap applies ops
  // left-to-right and a later bind overlays the earlier tmpfs. (If /tmp were tmpfs'd AFTER the binds it
  // would overmount them → `bwrap: Can't chdir … No such file or directory`.)
  argv.push('--tmpfs', '/tmp');
  // System + scope reads, read-only. DEST == SRC (identity mount) so absolute paths inside the namespace
  // match the host — the command sees the same paths it would unsandboxed, just narrowed to these.
  for (const p of roReadRoots) argv.push('--ro-bind', p, p);
  // The node's write lane + scratch, read-write. Bound AFTER the ro roots so a writable child of a ro
  // parent (e.g. a workdir under a ro-bound repo root) wins — and after the /tmp tmpfs so an under-/tmp
  // lane survives.
  for (const p of rwRoots) argv.push('--bind', p, p);
  // A fresh procfs + minimal devfs the toolchain needs (independent mountpoints; position is fine here).
  argv.push('--proc', '/proc');
  argv.push('--dev', '/dev');
  // cd into the working dir inside the namespace, and tie the sandbox lifetime to the runner.
  argv.push('--chdir', opts.workdir);
  argv.push('--die-with-parent');
  // DELIBERATELY ABSENT: --unshare-net (network stays on for the agent's gateway) and any process-exec /
  // seccomp restriction (the agent runs its toolchain). ONLY the filesystem view above is the boundary.
  // Finally, the command, run through a shell so `cmd` (a shell string) is interpreted as in the bare path.
  argv.push('sh', '-c', cmd);
  return argv;
}

// ── the exec plan (mirrors SeatbeltExecPlan; consumed by the dispatcher) ─────────────────────────────

/** The argv that runs `cmd` under the bwrap filesystem jail. Shape mirrors SeatbeltExecPlan so the
 * dispatcher and LocalSandbox.exec treat both backends uniformly. No `profilePath` — bwrap needs no
 * on-disk profile (the policy IS the argv), so there is nothing for the caller to unlink. */
export interface BwrapExecPlan {
  file: 'bwrap';
  argv: string[];
  /** Always absent for bwrap (no temp profile to clean up) — present in the type only for shape-parity
   * with SeatbeltExecPlan so the caller's `plan.profilePath` cleanup is a uniform no-op. */
  profilePath?: undefined;
}

/**
 * Build the `bwrap` wrapping for ONE command — the Linux peer of `seatbeltExecPlan`. Returns
 * `{file:'bwrap', argv:[…]}` on linux WITH bubblewrap available, or `null` (caller runs bare,
 * UNSANDBOXED) when NOT linux OR when `bwrap` is not on PATH — warning ONCE in the not-available case so
 * a Linux box without bubblewrap never silently believes it is sandboxed. `profileDir` is accepted for
 * signature-parity with `seatbeltExecPlan` (the dispatcher passes the same opts to both) but unused —
 * bwrap writes no profile.
 */
export function bwrapExecPlan(
  cmd: string,
  opts: { workdir: string; readScope: string[]; writeScope?: string[]; profileDir?: string },
): BwrapExecPlan | null {
  if (!isLinux()) return null; // off-linux: the dispatcher routes elsewhere; nothing to warn here.
  if (!_probe.isAvailable()) {
    warnNoBwrapOnce();
    return null; // linux WITHOUT bubblewrap → run bare, but LOUDLY (warned once) — never silent.
  }
  const argv = buildBwrapArgs(cmd, {
    workdir: opts.workdir,
    readScope: opts.readScope,
    writeScope: opts.writeScope,
  });
  return { file: 'bwrap', argv };
}
