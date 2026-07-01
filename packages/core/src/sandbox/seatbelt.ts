// SeatbeltSandbox — the macOS read-scope SandboxProvider (ROADMAP M1). A faithful port of
// templates/pi-runner/run.mjs `buildSandboxProfile` onto the @piflow/core spine, honoring the exec
// contract (ExecOpts.signal process-group kill + closed stdin) EXACTLY as InMemorySandbox does.
//
// MECHANISM: identical lifecycle to InMemorySandbox (a temp working dir; putFiles/writeFile/readFile/
// downloadDir/dispose are byte-for-byte the same), BUT `exec` wraps the command as
//   sandbox-exec -f <generated .sb> sh -c <cmd>
// with a per-exec Seatbelt profile generated from the UNION of {CreateOpts.readScope (resolved
// absolute), the working dir, the toolchain/system grants node needs}. The profile is deny-all-file-
// reads, then re-allow that union (every grant expanded to {itself, its realpath}, cwd as a (literal)).
// A read of any path OUTSIDE the union returns EPERM (kernel-enforced, inherited by every child).
//
// PLATFORM GATING: only darwin gets wrapped with sandbox-exec; on every other platform we WARN ONCE
// and run UNSANDBOXED (byte-identical to InMemorySandbox) — matching run.mjs. The Linux equivalent is
// bubblewrap (see the NOTE at SeatbeltSandboxProvider) — typed but not wired.
//
// Why port `buildSandboxProfile` and not just call run.mjs: run.mjs is a generic CLI driver bound to a
// repo (RUN_CWD/ROOT/extensions/worktree); the provider only knows {readScope, workdir} from CreateOpts,
// so the toolchain grants are reduced to what a node+toolchain need (node_modules of cwd, the workdir's
// own _pi dir, $TMPDIR, ~/.pi, the system roots). Rationale + sources: docs/research/seatbelt-sandbox-2026-06-21.md.

import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tailAppend } from './capture.js';
import { computeScopeRoots, expandRealpath } from './scope.js';
import type {
  Sandbox,
  SandboxProvider,
  SandboxProviderKind,
  CreateOpts,
  ExecOpts,
  ExecResult,
} from '../types.js';

// ── profile template loading ────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The deny-all-reads Seatbelt profile template (read-scope.sb sibling). `@HOME@`/`@TMPDIR@` are
 * substituted with the home + tmpdir; `@SCOPE_ALLOWS@` with the per-exec allow rules. We read the
 * committed `.sb` (the canonical, human-editable profile + its two hard rules) at module init; under
 * `tsc` the asset is NOT copied to dist, so we fall back to the src copy via the package layout
 * (dist/sandbox → ../../src/sandbox) and finally to an embedded minimal template, so the provider works
 * whether it runs from src (tests) or dist (published).
 */
const PROFILE_TEMPLATE = ((): string => {
  const candidates = [
    path.join(HERE, 'read-scope.sb'), // src (vitest) or dist (if an asset-copy step ever runs)
    path.join(HERE, '..', '..', 'src', 'sandbox', 'read-scope.sb'), // dist/sandbox → src/sandbox
  ];
  for (const c of candidates) {
    try {
      return fsSync.readFileSync(c, 'utf8');
    } catch {
      /* try next */
    }
  }
  // Embedded fallback (kept in sync with read-scope.sb; the two hard rules apply here too: ASCII
  // comments, each @TOKEN@ once at its rule site). Used only if the .sb asset is missing from a build.
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-read*)',
    '(allow file-read-metadata)',
    '(allow file-read*',
    '  (subpath "/usr")',
    '  (subpath "/bin")',
    '  (subpath "/sbin")',
    '  (subpath "/System")',
    '  (subpath "/Library")',
    '  (subpath "/opt")',
    '  (subpath "/private/var")',
    '  (subpath "/private/tmp")',
    '  (subpath "/private/etc")',
    '  (subpath "/dev")',
    '  (subpath "@TMPDIR@")',
    '  (subpath "@HOME@/.pi")',
    '  (subpath "@HOME@/.piflow")',
    '  (subpath "@HOME@/.npm")',
    '  (subpath "@HOME@/.cache")',
    '  (subpath "@HOME@/.config")',
    '  (subpath "@HOME@/.nvm")',
    '  (literal "/")',
    '  (literal "/etc")',
    '  (literal "/tmp")',
    '  (literal "/var"))',
    '(allow file-read*',
    '@SCOPE_ALLOWS@)',
    // --- write jail (symmetric; toolchain writable set from Codex workspace-write, see read-scope.sb) ---
    '(deny file-write*)',
    '(allow file-write*',
    '  (subpath "@TMPDIR@")',
    '  (subpath "/private/tmp")',
    '  (subpath "/private/var/folders")',
    '  (subpath "@HOME@/.pi")',
    '  (subpath "@HOME@/.piflow")',
    '  (subpath "@HOME@/.npm")',
    '  (subpath "@HOME@/.cache")',
    '  (subpath "@HOME@/.config")',
    '  (literal "/dev/null")',
    '  (literal "/dev/zero")',
    '  (literal "/dev/stdout")',
    '  (literal "/dev/stderr")',
    '  (literal "/dev/tty")',
    '  (subpath "/dev/fd")',
    '  (literal "/tmp")',
    '  (subpath "/private/var/tmp"))',
    '(allow file-write*',
    '@WRITE_SCOPE_ALLOWS@)',
    '',
  ].join('\n');
})();

// ── platform gating: warn once on non-darwin ─────────────────────────────────────────────────────

const IS_DARWIN = process.platform === 'darwin';
let warnedNonDarwin = false;
function warnNonDarwinOnce(): void {
  if (warnedNonDarwin) return;
  warnedNonDarwin = true;
  // eslint-disable-next-line no-console
  console.warn(
    `[seatbelt] SeatbeltSandbox is a macOS sandbox-exec read-scope sandbox; on ${process.platform} ` +
      `the equivalent is bubblewrap (not wired) — running UNSANDBOXED (byte-identical to InMemorySandbox).`,
  );
}

// ── the profile generator (port of run.mjs buildSandboxProfile 262–306) ───────────────────────────

/** quote a string as an SBPL string literal (JSON quoting matches SBPL's escape needs for paths). */
function sbplString(p: string): string {
  return JSON.stringify(p);
}

/**
 * Generate the per-exec Seatbelt profile from the union of:
 *   - the declared `readScope` (resolved absolute),
 *   - the declared `writeScope` (resolved absolute; = the node's `owns`),
 *   - the working dir + its own output/_pi dirs,
 *   - the toolchain/system grants a node+toolchain need (node_modules of the workdir, $TMPDIR, ~/.pi
 *     — the system roots /usr,/System,… and the Codex-derived write-scratch roots live in the template).
 * Every root is `{itself, realpath}`-expanded and granted as a recursive `(subpath …)`; the workdir is
 * ALSO granted as a non-recursive `(literal …)` so getcwd/uv_cwd can read the cwd dir ENTRY even when
 * the dir itself is the boundary (a bare subpath already covers it, but the literal mirrors run.mjs and
 * is harmless). The WRITE allow block grants the workdir (recursive) + the declared writeScope; the
 * read-only toolchain scratch (/tmp, $TMPDIR, /dev/null, ~/.npm, …) lives in the template. Returns the
 * rendered SBPL text.
 */
export function buildSeatbeltProfile(opts: {
  workdir: string;
  readScope: string[];
  writeScope?: string[];
  execCwd?: string;
  execReads?: string[];
}): string {
  const workdir = path.resolve(opts.workdir);
  // E10 — a node whose build runs from a PROJECT ROOT outside the run dir (`execCwd`) and imports SIBLING
  // kits (`execReads`) needs both readable. Fold them into the declared read scope so the shared policy
  // renders them as recursive read subpaths (execCwd ALSO gets a getcwd `(literal)` below).
  const execReadRoots = [...(opts.execReads ?? []), ...(opts.execCwd ? [opts.execCwd] : [])];
  // The SHARED policy: compute the read-roots (workdir + node_modules + node toolchain + readScope +
  // execReads/execCwd) and write-roots (workdir + writeScope/owns), realpath-expanded + de-duped. This is
  // the SAME helper the bwrap backend consumes, so the macOS and Linux jails grant an identical set. The
  // system read roots (/usr,/System,…) and the write-scratch roots (/tmp,$TMPDIR,~/.npm,…) live in the
  // template below.
  const { readRoots, writeRoots } = computeScopeRoots({
    ...opts,
    readScope: [...opts.readScope, ...execReadRoots],
  });
  const subpaths = readRoots.map((p) => `  (subpath ${sbplString(p)})`).join('\n');
  // getcwd needs file-read DATA on the cwd dir ENTRY, not just metadata; grant the workdir as a (literal)
  // too (expanded to {itself, realpath}) so a symlinked workdir matches. `execCwd` (the build's project-
  // root cwd, OUTSIDE the run dir) gets the SAME literal — THIS is the `EPERM: uv_cwd` fix (E10): the
  // build child's getcwd reads the execCwd dir entry, which a bare (subpath) grant alone does not cover.
  const cwdLits = [
    ...new Set([workdir, ...(opts.execCwd ? [opts.execCwd] : [])].flatMap(expandRealpath)),
  ]
    .map((p) => `  (literal ${sbplString(p)})`)
    .join('\n');
  const allows = `${subpaths}\n${cwdLits}`;
  // WRITE allows: the workdir + declared writeScope (== owns), from the shared policy. The toolchain
  // write-scratch roots (/tmp, $TMPDIR, /dev/*, ~/.npm, …) live in the template, so this block is ONLY
  // the node's own lane — a write outside {this block, the template scratch} EPERMs.
  const writeAllows = writeRoots.map((p) => `  (subpath ${sbplString(p)})`).join('\n');
  return PROFILE_TEMPLATE.replaceAll('@HOME@', os.homedir())
    .replaceAll('@TMPDIR@', os.tmpdir().replace(/\/+$/, ''))
    .replace('@SCOPE_ALLOWS@', allows)
    .replace('@WRITE_SCOPE_ALLOWS@', writeAllows);
}

// ── the shared exec-wrap seam (reused by SeatbeltSandbox AND the in-place LocalSandbox) ─────────────

/** Monotonic suffix so two concurrent execs in the same process+ms get distinct profile filenames. */
let execSeq = 0;

/** The argv that runs `cmd` under a per-exec read-scope Seatbelt profile, plus the temp profile to clean up. */
export interface SeatbeltExecPlan {
  file: 'sandbox-exec';
  argv: string[];
  /** The on-disk per-exec `.sb`; the caller MUST unlink it after the child closes. */
  profilePath: string;
}

/**
 * Build the `sandbox-exec` wrapping for ONE command — the single place the read-scope jail is applied,
 * so EVERY provider that wants kernel-enforced reads (the throwaway-temp `SeatbeltSandbox` AND the
 * in-place `LocalSandbox`) shares one implementation. Writes the rendered profile under `profileDir`
 * and returns the argv `sandbox-exec -f <profile> sh -c <cmd>`. Returns `null` on non-darwin (warning
 * ONCE) — the caller then runs the bare command, unsandboxed. This is the seam a future Linux backend
 * mirrors: a `bwrapExecPlan` returning `bwrap … sh -c <cmd>` from the SAME `{workdir, readScope}` policy.
 */
export function seatbeltExecPlan(
  cmd: string,
  opts: {
    workdir: string;
    readScope: string[];
    writeScope?: string[];
    execCwd?: string;
    execReads?: string[];
    profileDir: string;
  },
): SeatbeltExecPlan | null {
  if (!IS_DARWIN) {
    warnNonDarwinOnce();
    return null;
  }
  const profile = buildSeatbeltProfile({
    workdir: opts.workdir,
    readScope: opts.readScope,
    writeScope: opts.writeScope,
    execCwd: opts.execCwd, // E10 — the getcwd literal + a read root for the out-of-tree build's cwd
    execReads: opts.execReads, // E10 — extra read roots the build imports
  });
  const profilePath = path.join(opts.profileDir, `piflow-sb-${process.pid}-${Date.now()}-${execSeq++}.sb`);
  fsSync.writeFileSync(profilePath, profile);
  return { file: 'sandbox-exec', argv: ['-f', profilePath, 'sh', '-c', cmd], profilePath };
}

// ── the sandbox ──────────────────────────────────────────────────────────────────────────────────

export class SeatbeltSandbox implements Sandbox {
  readonly kind = 'seatbelt' as const;

  private constructor(
    public readonly root: string,
    public readonly workdir: string,
    private readonly env: Record<string, string>,
    private readonly readScope: string[],
    private readonly writeScope: string[],
    /** E10 — the dir the build runs from (project root outside the workdir); exec cwd + read root + getcwd
     * literal. Undefined ⇒ cwd = the workdir. Parity with LocalSandbox. */
    private readonly execCwd: string | undefined,
    /** E10 — extra external read roots the build imports (a sibling kit), resolved absolute + granted read. */
    private readonly execReads: string[],
  ) {}

  static async create(opts: CreateOpts): Promise<SeatbeltSandbox> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-seatbelt-'));
    const workdir = path.resolve(root, opts.workdir || '.');
    await fs.mkdir(workdir, { recursive: true });
    await fs.mkdir(path.resolve(workdir, opts.outputDir || 'out'), { recursive: true });
    if (!IS_DARWIN) warnNonDarwinOnce();
    // Resolve the declared read scope to absolute (CreateOpts.readScope entries are absolute by
    // contract, but a relative entry resolves vs the workdir to stay self-consistent).
    const resolveScope = (s: string[] | undefined): string[] =>
      (s ?? []).map((p) => (path.isAbsolute(p) ? p : path.resolve(workdir, p)));
    const resolveOne = (p: string | undefined): string | undefined =>
      p === undefined ? undefined : path.isAbsolute(p) ? p : path.resolve(workdir, p);
    return new SeatbeltSandbox(
      root,
      workdir,
      opts.env ?? {},
      resolveScope(opts.readScope),
      resolveScope(opts.writeScope),
      resolveOne(opts.execCwd), // E10 — exec cwd (a project root outside the workdir); undefined ⇒ workdir
      resolveScope(opts.execReads), // E10 — extra read roots the build imports
    );
  }

  private abs(p: string): string {
    return path.resolve(this.workdir, p);
  }

  async putFiles(files: { path: string; data: Uint8Array | string }[]): Promise<void> {
    for (const f of files) await this.writeFile(f.path, f.data);
  }

  async writeFile(p: string, data: Uint8Array | string): Promise<void> {
    const target = this.abs(p);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
  }

  /**
   * Run a command. On darwin, wrap it as `sandbox-exec -f <profile> sh -c <cmd>` with a per-exec
   * read-scope profile (the sandbox grants the workdir + declared readScope + toolchain roots; any read
   * outside EPERMs). On non-darwin, run UNSANDBOXED — byte-identical to InMemorySandbox. EITHER WAY the
   * process-group kill + closed-stdin handling matches InMemorySandbox EXACTLY (the exec contract).
   */
  exec(cmd: string, opts: ExecOpts = {}): Promise<ExecResult> {
    return new Promise((resolve) => {
      // E10 — a node declaring `execCwd` runs FROM that project root (outside the temp workdir); else the
      // workdir. An explicit ExecOpts.cwd still wins. Parity with LocalSandbox.
      const cwd = opts.cwd ? this.abs(opts.cwd) : (this.execCwd ?? this.workdir);
      // The shared seam: wrap in `sandbox-exec -f <profile> sh -c <cmd>` on darwin (granting the cwd too,
      // so a node may exec in a workdir subdir), or `null` off-darwin ⇒ bare `cmd` via shell, byte-
      // identical to InMemorySandbox. The per-exec profile is written under this.root (a temp dir).
      const plan = seatbeltExecPlan(cmd, {
        workdir: this.workdir,
        readScope: [...this.readScope, cwd],
        writeScope: this.writeScope,
        execCwd: this.execCwd, // E10 — read root + getcwd literal for the out-of-tree build's cwd
        execReads: this.execReads, // E10 — extra read roots the build imports
        profileDir: this.root,
      });
      const child = spawn(plan ? plan.file : cmd, plan ? plan.argv : [], {
        cwd,
        env: { ...process.env, ...this.env, ...opts.env },
        shell: plan ? false : true,
        // detached → the command is its own process group leader, so on cancel we can kill the WHOLE
        // tree (sandbox-exec, the wrapped sh, AND any grandchildren), not just the leader — no orphans.
        detached: true,
        // Close stdin: a headless CLI with an open stdin pipe and no TTY blocks forever waiting for EOF.
        // Pipe stdout/stderr for the event stream.
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let done = false;
      const signal = opts.signal;
      // On cancel, SIGTERM the process group then SIGKILL-escalate (`-pid` targets the group).
      const onAbort = (): void => {
        const pid = child.pid;
        if (pid === undefined) return;
        try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
        const esc = setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* reaped */ } }, 2000);
        esc.unref?.();
      };
      const cleanup = (): void => {
        signal?.removeEventListener('abort', onAbort);
        if (plan) { try { fsSync.unlinkSync(plan.profilePath); } catch { /* already gone */ } }
      };
      const finish = (r: ExecResult): void => { if (done) return; done = true; cleanup(); resolve(r); };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      child.stdout?.on('data', (d: Buffer) => {
        const s = d.toString();
        stdout = tailAppend(stdout, s);
        opts.onStdout?.(s);
      });
      child.stderr?.on('data', (d: Buffer) => {
        const s = d.toString();
        stderr = tailAppend(stderr, s);
        opts.onStderr?.(s);
      });
      child.on('error', (err) => finish({ stdout, stderr: stderr + String(err), code: 1 }));
      // A signal-killed child reports code=null + a signal name → surface a nonzero (124) so the runner
      // classifies it as a failure even before the watchdog's own `killed` verdict.
      child.on('close', (code, sig) => finish({ stdout, stderr, code: code ?? (sig ? 124 : 0) }));
    });
  }

  async readFile(p: string, opts: { encoding?: 'utf8' } = {}): Promise<Uint8Array | string> {
    return opts.encoding === 'utf8' ? fs.readFile(this.abs(p), 'utf8') : fs.readFile(this.abs(p));
  }

  async downloadDir(remote: string, local: string): Promise<void> {
    await fs.cp(this.abs(remote), path.resolve(process.cwd(), local), { recursive: true });
  }

  async dispose(): Promise<void> {
    await fs.rm(this.root, { recursive: true, force: true });
  }
}

export class SeatbeltSandboxProvider implements SandboxProvider {
  readonly kind: SandboxProviderKind = 'seatbelt';
  create(opts: CreateOpts): Promise<Sandbox> {
    return SeatbeltSandbox.create(opts);
  }
}

// ── WORKTREE — now LANDED elsewhere (per-run git WRITE isolation) ──────────────────────────────────
//
// The `WorktreeSandboxProvider` (per-run git worktree on branch pi/<run>, a port of run.mjs
// setupWorktree/finishWorktree) now lives in `./worktree.ts` — it was promoted once the run-level seam
// it needed (RunScope/openRun on types.ts) landed and got wired through the runner.
//
// Composability note (KEPT): --worktree and --sandbox COMPOSE in run.mjs — the BASE_ROOT→wtRoot rewrite
// runs before scope extraction, and Seatbelt grants the node_modules symlink TARGET realpath, so a
// Seatbelt read scope auto-follows into the worktree. A future composed provider can therefore delegate
// exec to a SeatbeltSandbox whose workdir is the WorktreeRunScope's worktree.
