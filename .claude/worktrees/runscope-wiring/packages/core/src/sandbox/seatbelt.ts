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

/** Expand a path to {itself, its realpath} — Seatbelt matches the RESOLVED realpath, not the lexical
 * path. Granting both means a symlinked root (node_modules, $TMPDIR, a worktree dir) reads correctly,
 * AND a model cannot escape via a self-made symlink (the target realpath is what is checked). */
function expand(p: string): string[] {
  const a = path.resolve(p);
  try {
    const r = fsSync.realpathSync(a);
    return a === r ? [a] : [a, r];
  } catch {
    return [a];
  }
}

/**
 * Generate the per-exec Seatbelt profile from the union of:
 *   - the declared `readScope` (resolved absolute),
 *   - the working dir + its own output/_pi dirs,
 *   - the toolchain/system grants a node+toolchain need (node_modules of the workdir, $TMPDIR, ~/.pi
 *     — the system roots /usr,/System,… live in the template).
 * Every root is `{itself, realpath}`-expanded and granted as a recursive `(subpath …)`; the workdir is
 * ALSO granted as a non-recursive `(literal …)` so getcwd/uv_cwd can read the cwd dir ENTRY even when
 * the dir itself is the boundary (a bare subpath already covers it, but the literal mirrors run.mjs and
 * is harmless). Returns the rendered SBPL text.
 */
export function buildSeatbeltProfile(opts: { workdir: string; readScope: string[] }): string {
  const workdir = path.resolve(opts.workdir);
  // Auto-grants beyond the declared scope (the toolchain reads more than the lesson scope; a profile
  // that passes a static demo can still EPERM on the first real toolchain call — see the research brief).
  const auto = [
    workdir, // the node's own working tree (workspace + its out/_pi dirs live under here)
    path.join(workdir, 'node_modules'), // modules must resolve
    path.join(process.cwd(), 'node_modules'), // the host process cwd's modules (test toolchain, tsc)
  ];
  // Union, realpath-expanded + de-duped. (The system roots /usr,/System,… are in the template.)
  const roots = [...new Set([...auto, ...opts.readScope].flatMap(expand))];
  const subpaths = roots.map((p) => `  (subpath ${sbplString(p)})`).join('\n');
  // getcwd needs file-read DATA on the cwd dir ENTRY, not just metadata; grant the workdir as a
  // (literal) too (expanded to {itself, realpath}) so a symlinked workdir matches.
  const cwdLits = [...new Set(expand(workdir))].map((p) => `  (literal ${sbplString(p)})`).join('\n');
  const allows = `${subpaths}\n${cwdLits}`;
  return PROFILE_TEMPLATE.replaceAll('@HOME@', os.homedir())
    .replaceAll('@TMPDIR@', os.tmpdir().replace(/\/+$/, ''))
    .replace('@SCOPE_ALLOWS@', allows);
}

// ── the sandbox ──────────────────────────────────────────────────────────────────────────────────

export class SeatbeltSandbox implements Sandbox {
  readonly kind = 'seatbelt' as const;

  private constructor(
    public readonly root: string,
    public readonly workdir: string,
    private readonly env: Record<string, string>,
    private readonly readScope: string[],
    /** Whether to actually wrap with sandbox-exec (darwin). False ⇒ unsandboxed, like InMemorySandbox. */
    private readonly sandboxed: boolean,
  ) {}

  static async create(opts: CreateOpts): Promise<SeatbeltSandbox> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-seatbelt-'));
    const workdir = path.resolve(root, opts.workdir || '.');
    await fs.mkdir(workdir, { recursive: true });
    await fs.mkdir(path.resolve(workdir, opts.outputDir || 'out'), { recursive: true });
    if (!IS_DARWIN) warnNonDarwinOnce();
    // Resolve the declared read scope to absolute (CreateOpts.readScope entries are absolute by
    // contract, but a relative entry resolves vs the workdir to stay self-consistent).
    const readScope = (opts.readScope ?? []).map((p) =>
      path.isAbsolute(p) ? p : path.resolve(workdir, p),
    );
    return new SeatbeltSandbox(root, workdir, opts.env ?? {}, readScope, IS_DARWIN);
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
      const cwd = opts.cwd ? this.abs(opts.cwd) : this.workdir;
      // Build the spawn argv. Unsandboxed path mirrors InMemorySandbox (shell:true). Sandboxed path
      // writes a per-exec profile (granting the cwd too, so a node may exec in a subdir of the workdir)
      // and runs sandbox-exec -f <profile> sh -c <cmd> with shell:false so OUR argv is what runs.
      let file: string;
      let argv: string[];
      let useShell: boolean;
      let profilePath: string | undefined;
      if (this.sandboxed) {
        const profile = buildSeatbeltProfile({
          workdir: this.workdir,
          // grant both the workdir AND the exec cwd (a node may run a step in a workdir subdir).
          readScope: [...this.readScope, cwd],
        });
        profilePath = path.join(this.root, `exec-${process.pid}-${Date.now()}.sb`);
        fsSync.writeFileSync(profilePath, profile);
        file = 'sandbox-exec';
        argv = ['-f', profilePath, 'sh', '-c', cmd];
        useShell = false;
      } else {
        file = cmd;
        argv = [];
        useShell = true;
      }
      const child = spawn(file, argv, {
        cwd,
        env: { ...process.env, ...this.env, ...opts.env },
        shell: useShell,
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
        if (profilePath) { try { fsSync.unlinkSync(profilePath); } catch { /* already gone */ } }
      };
      const finish = (r: ExecResult): void => { if (done) return; done = true; cleanup(); resolve(r); };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      child.stdout?.on('data', (d: Buffer) => {
        const s = d.toString();
        stdout += s;
        opts.onStdout?.(s);
      });
      child.stderr?.on('data', (d: Buffer) => {
        const s = d.toString();
        stderr += s;
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

// ── WORKTREE (secondary goal) — typed stub + FLAG ─────────────────────────────────────────────────
//
// FLAG (not wired this pass): a `WorktreeSandboxProvider` for per-run git WRITE isolation — a port of
// run.mjs setupWorktree/finishWorktree (400–460). It would, in create(): make a fresh per-run git
// worktree (branch pi/<run>, checked out at HEAD) in a sibling `.pi-worktrees/<run>` OUTSIDE the repo,
// symlink node_modules from the main checkout for every tracked package (the worktree is HEAD-clean, so
// gitignored node_modules is absent), and run the node INSIDE it so N concurrent runs are PHYSICALLY
// write-isolated (a node in one run cannot clobber another's files). In dispose()/finish: commit the
// worktree to its branch, copy the deliverable (out/<run>) back to the MAIN tree (out/ is gitignored, so
// it would vanish with the worktree), then `git worktree remove` (branch persists for a human-gated merge).
//
// It is NOT implemented here because it needs run-scoped wiring the CreateOpts contract does not yet
// carry: a stable `run` id (to name the branch + the .pi-worktrees dir), the base repo ROOT vs the cwd
// REL (to rewrite hardcoded paths BASE_ROOT→wtRoot), and a finish hook on the WHOLE run (not per-node
// dispose — the worktree spans all of a run's nodes, but a provider creates one Sandbox per node). Wiring
// those is a spine touch (a run-level provider lifecycle, or a `run`/`repoRoot` field on CreateOpts),
// which this pass must NOT make (frozen spine). The class below documents the shape and HALTs clearly so
// nothing silently runs unisolated; promote it once the run-level seam exists.
//
// Composability note: --worktree and --sandbox COMPOSE in run.mjs — the BASE_ROOT→wtRoot rewrite runs
// before scope extraction, and Seatbelt grants the node_modules symlink TARGET realpath, so a Seatbelt
// read scope auto-follows into the worktree. A future WorktreeSandboxProvider can therefore delegate exec
// to a SeatbeltSandbox whose workdir is the worktree.

export class WorktreeSandboxProvider implements SandboxProvider {
  readonly kind: SandboxProviderKind = 'worktree';
  create(): Promise<Sandbox> {
    return Promise.reject(
      new Error(
        "WorktreeSandboxProvider is a typed stub (see seatbelt.ts FLAG): per-run git WRITE isolation " +
          "(port of run.mjs setupWorktree/finishWorktree) needs a run-level provider lifecycle + a " +
          "`run`/`repoRoot` seam on CreateOpts that the frozen spine does not yet carry. Use " +
          "SeatbeltSandboxProvider for read-scope isolation; promote this once the run-level seam exists.",
      ),
    );
  }
}
