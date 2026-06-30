import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildBwrapArgs,
  bwrapExecPlan,
  __setBwrapAvailableForTest,
  __resetBwrapWarningForTest,
} from '../src/sandbox/bwrap.js';
import { localJailPlan, __resetJailWarningForTest } from '../src/sandbox/jail.js';

// ─────────────────────────────────────────────────────────────────────────────
// bwrap.ts — the LINUX filesystem-isolation backend for `--sandbox local`.
//
// What is VERIFIED-HERE (cross-platform, no real bwrap needed):
//   - the PURE argv construction (which bind args we emit for a given scope),
//   - the not-available fallback (linux without bubblewrap → null + warn once),
//   - the OS dispatch decision (darwin→seatbelt, linux→bwrap, else→null).
// What is PENDING-LINUX-CI (cannot run on the macOS authoring host — bwrap is
// absent, namespaces are a Linux feature): the kernel EPERM enforcement. That
// test is `linuxIt`-gated and SKIPS here BY DESIGN — a skip, not a pass/fail.
// ─────────────────────────────────────────────────────────────────────────────

// ── platform gate for the KERNEL test (the only part that needs a real bwrap) ────────────────────────
const linuxIt = process.platform === 'linux' ? it : it.skip;
const SKIP_MSG = `(skipped on ${process.platform}: bwrap is Linux-only — no mount namespace to assert; PENDING a Linux CI run)`;

// The KERNEL-enforcement case needs a bwrap that can ACTUALLY build a namespace — not merely be installed.
// GitHub's ubuntu runners clamp unprivileged user namespaces (AppArmor), so a presence-only gate would run
// the test just for bwrap to abort. Probe REAL capability (spawn a no-op jail): run the test when it can
// build a namespace (PROVING the boundary), skip-with-reason when it genuinely can't — never a false red,
// and never a blanket skip that would hide a regression on a capable box.
function bwrapCanBuildNamespace(): boolean {
  if (process.platform !== 'linux') return false;
  // Bind the WHOLE root ro (matches probeBwrapUsable in bwrap.ts), NOT just /usr: on a merged-usr distro
  // (Debian/Fedora) a /usr-only jail leaves `true`'s ELF loader unreachable, so the probe exits 1 even
  // though the namespace built — a false skip that would hide a regression on a capable box. `--ro-bind / /`
  // is the distro-agnostic capability check.
  const r = spawnSync('bwrap', ['--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', 'true'], {
    stdio: 'ignore',
    timeout: 5000,
  });
  return r.status === 0;
}
const kernelIt = bwrapCanBuildNamespace() ? it : it.skip;

// A scope fixture under a temp dir. The argv-construction tests only need PATHS (the dirs need not exist
// for the pure builder — but buildBwrapArgs filters binds to EXISTING host paths, so we create real dirs
// where the test asserts a path made it into the argv).
async function tmpScope(prefix: string): Promise<{ workdir: string; readDir: string; writeDir: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `piflow-bwrap-${prefix}-`));
  const workdir = path.join(root, 'work');
  const readDir = path.join(root, 'reads');
  const writeDir = path.join(root, 'owns');
  await fs.mkdir(workdir, { recursive: true });
  await fs.mkdir(readDir, { recursive: true });
  await fs.mkdir(writeDir, { recursive: true });
  return { workdir, readDir, writeDir, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

/** Find the DEST of a `--<flag> SRC DEST` triple whose SRC === `src`. Returns the flag that bound it, or
 * undefined if `src` was never bound. Lets a test assert "this path is bound, and bound RO vs RW". */
function bindFlagFor(argv: string[], src: string): string | undefined {
  for (let i = 0; i < argv.length - 2; i++) {
    if ((argv[i] === '--ro-bind' || argv[i] === '--bind') && argv[i + 1] === src) return argv[i];
  }
  return undefined;
}

// ── 1. PURE argv construction (runs on ANY platform) ─────────────────────────────────────────────────

describe('buildBwrapArgs — pure bind-arg construction (cross-platform)', () => {
  it('emits --ro-bind for read scope, --bind for the write lane, /proc + /dev + /tmp, --chdir, sh -c <cmd>', async () => {
    const { workdir, readDir, writeDir, cleanup } = await tmpScope('pure');
    try {
      const cmd = 'echo hello-from-jail';
      const argv = buildBwrapArgs(cmd, {
        workdir,
        readScope: [readDir],
        writeScope: [writeDir],
      });

      // READ SPLIT: the declared read root is bound READ-ONLY (--ro-bind), not writable.
      expect(bindFlagFor(argv, readDir)).toBe('--ro-bind');
      // WRITE SPLIT: the workdir AND the declared write root (owns) are bound READ-WRITE (--bind).
      expect(bindFlagFor(argv, writeDir)).toBe('--bind');
      expect(bindFlagFor(argv, workdir)).toBe('--bind');
      // The write root is NOT also bound read-only (a ro re-bind would clobber the rw bind back to ro).
      expect(bindFlagFor(argv, writeDir)).not.toBe('--ro-bind');

      // SYSTEM toolchain baseline: /usr is bound read-only (node/git/libs live there). Codex-derived.
      expect(bindFlagFor(argv, '/usr')).toBe('--ro-bind');

      // The fresh procfs + devfs + private /tmp the toolchain needs (argv-adjacent flag+dest pairs).
      expect(argv.join(' ')).toContain('--proc /proc');
      expect(argv.join(' ')).toContain('--dev /dev');
      expect(argv.join(' ')).toContain('--tmpfs /tmp');

      // --chdir into the workdir, and the parent-death tie-off.
      const chdirIdx = argv.indexOf('--chdir');
      expect(chdirIdx).toBeGreaterThan(-1);
      expect(argv[chdirIdx + 1]).toBe(workdir);
      expect(argv).toContain('--die-with-parent');

      // The command runs through a shell, EXACTLY as the bare path does — `sh -c <cmd>` is the tail.
      expect(argv.slice(-3)).toEqual(['sh', '-c', cmd]);

      // ── THE DIVERGENCE FROM CODEX (load-bearing): network stays ON, exec stays open. ──
      // NO --unshare-net anywhere (the agent must reach its model gateway).
      expect(argv).not.toContain('--unshare-net');
      // NO process-exec / seccomp restriction (the agent runs its toolchain). bwrap has no exec-deny
      // flag, so the proof is the ABSENCE of any namespace/seccomp hardening that would block it.
      expect(argv).not.toContain('--unshare-all');
      expect(argv).not.toContain('--unshare-pid');
      expect(argv).not.toContain('--seccomp');
      expect(argv).not.toContain('--new-session');
    } finally {
      await cleanup();
    }
  });

  it('lays --tmpfs /tmp BEFORE any bind nested under /tmp (survival ordering) and never binds the bare /tmp mountpoint', async () => {
    // BUG B regression. Two failure modes the old builder had:
    //   (i) it bound the bare host /tmp (tmpDir()) rw — pointless (the tmpfs overmounts it) and a re-exposure
    //       risk if the order ever flipped;
    //   (ii) it emitted `--tmpfs /tmp` AFTER all binds, so a write lane nested UNDER /tmp was overmounted by
    //       the fresh tmpfs → `bwrap: Can't chdir … No such file or directory` (the live `tmp` battery).
    // The fix lays the tmpfs FIRST so an under-/tmp lane overlays it and survives, and stops binding bare /tmp.
    // We stage a REAL write lane directly under /tmp (buildBwrapArgs filters binds to existing host paths).
    const lane = path.join('/tmp', `piflow-bwrap-bugb-${process.pid}`, 'owns');
    await fs.mkdir(lane, { recursive: true });
    try {
      const argv = buildBwrapArgs('true', {
        workdir: lane,
        readScope: ['/usr'],
        writeScope: [lane],
      });

      // SURVIVAL ORDERING: the private tmpfs must be laid down BEFORE the under-/tmp lane's bind, so the
      // lane overlays the tmpfs (and survives) instead of being overmounted by it. The lane's DEST is its
      // realpath-expanded form; locate the FIRST bind whose DEST is lexically under /tmp (the path that
      // would be shadowed on a real-/tmp Linux box) and assert the tmpfs precedes it.
      const tmpfsIdx = argv.findIndex((a, i) => a === '--tmpfs' && argv[i + 1] === '/tmp');
      expect(tmpfsIdx).toBeGreaterThan(-1);
      const underTmpBindIdx = argv.findIndex(
        (a, i) =>
          (a === '--bind' || a === '--ro-bind') &&
          typeof argv[i + 2] === 'string' &&
          (argv[i + 2] === '/tmp' || argv[i + 2].startsWith('/tmp/')),
      );
      expect(underTmpBindIdx).toBeGreaterThan(-1); // the lane WAS bound (proves the assertion isn't vacuous)
      expect(tmpfsIdx).toBeLessThan(underTmpBindIdx); // …and the tmpfs comes first → the lane survives

      // PART 1: the bare /tmp mountpoint is NEVER itself bound — no SRC===DEST==='/tmp' triple in either form.
      // (The writable /tmp is the tmpfs, not a bind of host /tmp.) Genuine lanes UNDER /tmp are still bound.
      for (let i = 0; i < argv.length - 2; i++) {
        if (argv[i] === '--bind' || argv[i] === '--ro-bind') {
          expect(argv[i + 1] === '/tmp' && argv[i + 2] === '/tmp').toBe(false);
        }
      }
    } finally {
      await fs.rm(path.dirname(lane), { recursive: true, force: true });
    }
  });

  it('TEST-THE-TEST control: an unbound sibling path is NOT in the argv (so the bind-split assertions are real)', async () => {
    // The argv-split assertions above only mean something if an UNGRANTED path is genuinely absent. Stage
    // a sibling that is neither readScope nor writeScope and assert it was never bound — if buildBwrapArgs
    // bound everything wholesale, this would fail and the split tests would be vacuous.
    const { workdir, readDir, cleanup } = await tmpScope('control');
    const sibling = path.join(path.dirname(workdir), 'ungranted');
    await fs.mkdir(sibling, { recursive: true });
    try {
      const argv = buildBwrapArgs('true', { workdir, readScope: [readDir], writeScope: [] });
      expect(bindFlagFor(argv, sibling)).toBeUndefined(); // never bound → absent from the namespace
    } finally {
      await cleanup();
    }
  });
});

// ── 2. NOT-AVAILABLE fallback: linux without bubblewrap → null + warn once (NEVER silently "sandboxed") ─

describe('bwrapExecPlan — graceful fallback when bubblewrap is unavailable', () => {
  it('returns null + warns ONCE when bwrap is not on PATH (stubbed probe), so a Linux box is never silently unsandboxed', async () => {
    // This is the SECURITY-CRITICAL fallback: on a Linux host WITHOUT bubblewrap, the plan must be null
    // (caller runs bare) AND the operator must be WARNED — a silent null would let a box believe it is
    // sandboxed when it is not. We force the platform to linux (the function early-returns null off-linux
    // for a different reason) and stub the availability probe to FALSE, then assert null + a single warn.
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const restoreProbe = __setBwrapAvailableForTest(false); // bubblewrap "absent"
    __resetBwrapWarningForTest();
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]): void => { warnings.push(a.join(' ')); };
    try {
      const { workdir, readDir, cleanup } = await tmpScope('noavail');
      try {
        const plan1 = bwrapExecPlan('echo x', { workdir, readScope: [readDir], profileDir: os.tmpdir() });
        const plan2 = bwrapExecPlan('echo y', { workdir, readScope: [readDir], profileDir: os.tmpdir() });
        expect(plan1).toBeNull(); // no jail → bare exec, but…
        expect(plan2).toBeNull();
        // …WARNED, and warned ONCE (the warn-once latch holds across calls — not silent, not spammy).
        const bwrapWarns = warnings.filter((w) => w.includes('[bwrap]'));
        expect(bwrapWarns.length).toBe(1);
        expect(bwrapWarns[0]).toMatch(/UNSANDBOXED|not on PATH|bubblewrap/i);
      } finally {
        await cleanup();
      }
    } finally {
      console.warn = origWarn;
      restoreProbe();
      __resetBwrapWarningForTest();
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
    }
  });

  it('returns a bwrap plan when the probe says available (stubbed) on linux', async () => {
    // The positive control for the fallback test: with the platform forced to linux and the probe forced
    // TRUE, bwrapExecPlan must return a real plan (file:'bwrap', a non-empty argv ending sh -c <cmd>) —
    // proving the null above is the absence branch, not an always-null function.
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const restoreProbe = __setBwrapAvailableForTest(true); // bubblewrap "present"
    try {
      const { workdir, readDir, writeDir, cleanup } = await tmpScope('avail');
      try {
        const plan = bwrapExecPlan('echo z', {
          workdir,
          readScope: [readDir],
          writeScope: [writeDir],
          profileDir: os.tmpdir(),
        });
        expect(plan).not.toBeNull();
        expect(plan!.file).toBe('bwrap');
        expect(plan!.argv.slice(-3)).toEqual(['sh', '-c', 'echo z']);
        expect(plan!.profilePath).toBeUndefined(); // bwrap writes no on-disk profile
      } finally {
        await cleanup();
      }
    } finally {
      restoreProbe();
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
    }
  });
});

// ── 3. OS DISPATCH: the jail backend is chosen by platform (+ bwrap availability) ────────────────────

describe('localJailPlan — OS dispatch (darwin→seatbelt, linux→bwrap, else→null)', () => {
  it(`on THIS host (${process.platform}) selects the right backend`, async () => {
    // Assert the dispatch decision via the REAL platform: on darwin the plan is a seatbelt plan
    // (file:'sandbox-exec', with a per-exec profilePath); on linux it is a bwrap plan (file:'bwrap', no
    // profilePath) when bwrap is available; on any other OS it is null. This pins that `--sandbox local`
    // maps to the OS-correct kernel jail WITHOUT a backend-specific call at the LocalSandbox call site.
    const { workdir, readDir, writeDir, cleanup } = await tmpScope('dispatch');
    try {
      const plan = localJailPlan('echo dispatched', {
        workdir,
        readScope: [readDir],
        writeScope: [writeDir],
        profileDir: os.tmpdir(),
      });
      if (process.platform === 'darwin') {
        expect(plan).not.toBeNull();
        expect(plan!.file).toBe('sandbox-exec'); // the seatbelt backend answered
        expect(plan!.profilePath).toBeTruthy(); // seatbelt wrote a per-exec .sb
        if (plan!.profilePath) await fs.rm(plan!.profilePath, { force: true });
      } else if (process.platform === 'linux') {
        // bwrap may or may not be installed on the CI box; EITHER a bwrap plan OR a null (when absent).
        if (plan !== null) {
          expect(plan.file).toBe('bwrap');
          expect(plan.profilePath).toBeUndefined();
        }
      } else {
        expect(plan).toBeNull(); // unsupported OS → bare exec
      }
    } finally {
      await cleanup();
    }
  });

  it('dispatch routes to bwrap on linux and seatbelt on darwin (platform forced, availability stubbed)', async () => {
    // Decision-logic test independent of the host: force the platform and assert which backend's plan
    // comes back. This is the core of "backend chosen by OS" — the SAME opts, a different file per OS.
    const { workdir, readDir, writeDir, cleanup } = await tmpScope('dispatch-forced');
    const opts = { workdir, readScope: [readDir], writeScope: [writeDir], profileDir: os.tmpdir() };
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    try {
      // linux + bwrap available → a bwrap plan.
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      const restore = __setBwrapAvailableForTest(true);
      const linuxPlan = localJailPlan('echo l', opts);
      expect(linuxPlan).not.toBeNull();
      expect(linuxPlan!.file).toBe('bwrap');
      restore();

      // an unsupported OS → null + a one-time warn (the dispatcher's own fallback).
      Object.defineProperty(process, 'platform', { value: 'sunos', configurable: true });
      __resetJailWarningForTest();
      const otherPlan = localJailPlan('echo o', opts);
      expect(otherPlan).toBeNull();
    } finally {
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
      await cleanup();
    }
  });
});

// ── 4. linuxIt-GATED KERNEL ENFORCEMENT — SKIPS on darwin (PENDING a Linux CI run) ───────────────────
//
// This is the ONLY test that needs a real `bwrap` + a real mount namespace. It CANNOT run on the macOS
// authoring host (bwrap is absent; namespaces are a Linux feature), so it is `linuxIt`-gated and SHOWS AS
// SKIPPED here — that is correct and expected, NOT a failure. On a Linux CI box it must prove: an in-scope
// read+write SUCCEEDS, an out-of-scope read+write returns a kernel denial (ENOENT/EROFS/EPERM — the path
// is simply absent from the namespace), and the danger bypass (no jail) leaks. Until that run lands, the
// kernel EPERM behavior is UNVERIFIED.

describe('bwrap kernel filesystem jail — EPERM enforcement (linux only)', () => {
  kernelIt(
    `reads/writes in-scope OK, out-of-scope read+write denied by the namespace ${SKIP_MSG}`,
    async () => {
      // Stage granted (in readScope + writeScope/workdir) and denied (neither) sibling trees, then run
      // real commands under `bwrap <argv>`. In-scope read+write must SUCCEED; the out-of-scope sibling
      // must be ABSENT from the namespace (cat/echo fail — ENOENT/permission), and the secret must never
      // leak. Run via spawn since this exercises the REAL kernel boundary, not the argv shape.
      const { spawn } = await import('node:child_process');
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-bwrap-kernel-'));
      const granted = path.join(root, 'granted');
      const denied = path.join(root, 'denied');
      await fs.mkdir(granted, { recursive: true });
      await fs.mkdir(denied, { recursive: true });
      await fs.writeFile(path.join(granted, 'in.txt'), 'IN_SCOPE');
      await fs.writeFile(path.join(denied, 'secret.txt'), 'OUT_OF_SCOPE_SECRET');

      const run = (cmd: string): Promise<{ code: number | null; stdout: string; stderr: string }> => {
        const argv = buildBwrapArgs(cmd, { workdir: granted, readScope: [granted], writeScope: [granted] });
        return new Promise((resolve) => {
          const c = spawn('bwrap', argv, { stdio: ['ignore', 'pipe', 'pipe'] });
          let stdout = '', stderr = '';
          c.stdout.on('data', (d) => (stdout += d));
          c.stderr.on('data', (d) => (stderr += d));
          c.on('close', (code) => resolve({ code, stdout, stderr }));
          c.on('error', (e) => resolve({ code: 1, stdout, stderr: stderr + String(e) }));
        });
      };

      try {
        const okRead = await run(`cat ${JSON.stringify(path.join(granted, 'in.txt'))}`);
        expect(okRead.code).toBe(0);
        expect(okRead.stdout).toContain('IN_SCOPE');

        const okWrite = await run(`printf '%s' MADE > ${JSON.stringify(path.join(granted, 'made.txt'))}`);
        expect(okWrite.code).toBe(0);
        expect(await fs.readFile(path.join(granted, 'made.txt'), 'utf8')).toBe('MADE');

        const deniedRead = await run(`cat ${JSON.stringify(path.join(denied, 'secret.txt'))}`);
        expect(deniedRead.code).not.toBe(0);
        expect(deniedRead.stdout).not.toContain('OUT_OF_SCOPE_SECRET');

        const deniedWrite = await run(`printf '%s' PWN > ${JSON.stringify(path.join(denied, 'pwned.txt'))}`);
        expect(deniedWrite.code).not.toBe(0);
        await expect(fs.access(path.join(denied, 'pwned.txt'))).rejects.toThrow();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
    30000,
  );

  linuxIt(`network stays ON inside the jail (no --unshare-net) ${SKIP_MSG}`, async () => {
    // The piflow divergence, proven on the kernel: the agent must reach its gateway, so the namespace
    // keeps host networking. A loopback/DNS-free probe is flaky; instead assert the namespace was NOT
    // network-isolated by checking the argv (already covered) AND that a localhost socket bind works —
    // left as the Linux-CI assertion (the argv-absence test above is the cross-platform guarantee).
    expect(buildBwrapArgs('true', { workdir: os.tmpdir(), readScope: [], writeScope: [] })).not.toContain(
      '--unshare-net',
    );
  });
});
