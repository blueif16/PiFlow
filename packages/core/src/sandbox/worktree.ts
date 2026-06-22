// ─────────────────────────────────────────────────────────────────────────────
// WorktreeSandbox / WorktreeSandboxProvider — per-run git WRITE isolation, LIVE.
//
// A faithful port of templates/pi-runner/run.mjs `setupWorktree`/`finishWorktree`
// (run.mjs 400–460) onto the @piflow/core RunScope/openRun seam (types.ts). Each
// RUN gets a fresh git worktree on a NEW branch `pi/<run>` checked out at HEAD, in
// a sibling `<repoRoot>/../.pi-worktrees/<run>` OUTSIDE the repo. Every node of the
// run runs INSIDE that one worktree, so N concurrent runs are PHYSICALLY write-
// isolated — a node in one run cannot see or clobber another run's files, and none
// of them touch the main checkout's working tree. After the last node the worktree
// is committed to its branch (work is durable for a human-gated merge) and the
// checkout is removed (the branch persists).
//
// PLAN — openRun/create/dispose mapped to run.mjs, with the deliberate divergences:
//   openRun({ run, repoRoot, outDir })  ← port of setupWorktree (run.mjs 400–433)
//     1. wtPath = <dirname(repoRoot)>/.pi-worktrees/<run>     (run.mjs 401: sibling, OUTSIDE the repo)
//     2. idempotent: `git worktree remove --force <wtPath>` + rm -rf the dir       (run.mjs 404–405)
//     3. `git -C <repoRoot> worktree add -B pi/<run> <wtPath> HEAD`                (run.mjs 408; -B resets to HEAD)
//     4. for every TRACKED package (git ls-files package.json) whose base node_modules exists,
//        symlink it into the worktree at the same rel path                          (run.mjs 409–431)
//     → return a WorktreeRunScope whose `root` is wtPath.
//   create(opts)  ← the per-node VIEW (no run.mjs analogue — run.mjs reuses ONE driver inside the wt)
//     workdir = <wtPath>/<opts.workdir> INSIDE the shared worktree, so every node's WRITES land in the
//     worktree, never the main checkout. file/exec/readFile/downloadDir/putFiles mechanics are copied
//     VERBATIM from InMemorySandbox (real `spawn`, detached process-group kill + closed stdin +
//     ExecOpts.signal SIGTERM→SIGKILL; downloadDir via fs.cp). Per-node dispose is a NO-OP w.r.t. the
//     shared worktree (mirrors daytona `ownsVm:false`) — the scope owns the worktree's lifetime.
//   dispose()  ← port of finishWorktree (run.mjs 438–459)
//     1. `git -C <wtPath> add -A` + `commit -m "pi(<run>): run artifacts"`          (run.mjs 441–442; empty commit is fine)
//     2. `git -C <repoRoot> worktree remove --force <wtPath>` (branch pi/<run> PERSISTS) (run.mjs 455)
//     DIVERGENCE from finishWorktree: run.mjs ALSO copied out/<run> back to the main tree (run.mjs
//     444–453) because its nodes wrote straight into the worktree's out/ and out/ is gitignored (so it
//     would vanish with the worktree). OUR runner already does `sandbox.downloadDir(node output, outDir)`
//     per node (runner.ts runNode 320–324), landing every node's deliverable on the host outDir (the
//     MAIN tree) BEFORE dispose — so we do NOT re-copy. The commit is what makes the run's worktree
//     contents durable on the branch; the host outDir already holds the collected deliverable.
//
//   Non-scoped create(opts) fallback: REJECTS. A worktree is inherently RUN-level (one branch + one
//   checkout span ALL of a run's nodes), so there is no shared worktree to put a node in without a run.
//   We reject with a clear pointer to openRun rather than spin up a throwaway one-node worktree (which
//   would be neither durable nor isolated in any useful way). The runner only ever calls openRun for a
//   provider that has it, so this path is the explicit "used wrong" guard.
// ─────────────────────────────────────────────────────────────────────────────

import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import type {
  Sandbox,
  SandboxProvider,
  SandboxProviderKind,
  CreateOpts,
  ExecOpts,
  ExecResult,
  RunScope,
  OpenRunOpts,
} from '../types.js';

// ── git helper (port of run.mjs `git()` 399) ───────────────────────────────────
/** Run a git subcommand in `cwd`, returning trimmed stdout. Throws on nonzero (caller try/catches). */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

// ── the per-node sandbox VIEW (a workdir INSIDE the shared worktree) ────────────

/**
 * One node's view INSIDE the shared run worktree. Each node gets its own `WorktreeSandbox`, but they
 * all live under the SAME worktree dir (the per-run checkout booted in `openRun`). The node's workdir
 * is `<wtPath>/<opts.workdir>`, so every write/exec lands in the worktree — NOT the main checkout.
 * `dispose()` here is a NO-OP w.r.t. the worktree (mirrors daytona's `ownsVm:false`): the worktree is
 * committed + removed ONCE by `WorktreeRunScope.dispose` after the last node.
 *
 * The file/exec/readFile/downloadDir/putFiles mechanics are copied VERBATIM from InMemorySandbox —
 * same `spawn` shape (detached process-group + closed stdin + ExecOpts.signal SIGTERM→SIGKILL), same
 * `fs.cp` downloadDir — so cancellation under this provider behaves byte-identically to the baseline.
 */
export class WorktreeSandbox implements Sandbox {
  readonly kind = 'worktree' as const;

  private constructor(
    public readonly workdir: string,
    private readonly env: Record<string, string>,
  ) {}

  /**
   * Build a per-node view rooted at `<wtPath>/<opts.workdir>`. Mirrors InMemorySandbox.create's mkdir
   * of the workdir + its output dir (so a relative write/exec resolves the same way it does locally),
   * but the root is the SHARED worktree, not a throwaway temp dir.
   */
  static async open(wtPath: string, opts: CreateOpts): Promise<WorktreeSandbox> {
    const workdir = path.resolve(wtPath, opts.workdir || '.');
    await fs.mkdir(workdir, { recursive: true });
    await fs.mkdir(path.resolve(workdir, opts.outputDir || 'out'), { recursive: true });
    return new WorktreeSandbox(workdir, opts.env ?? {});
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
   * Run a command in the node's workdir (inside the shared worktree). The process-group kill +
   * closed-stdin + ExecOpts.signal handling is copied EXACTLY from InMemorySandbox (the exec contract):
   * detached → the command is its own process-group leader, so on cancel we kill the WHOLE tree;
   * stdin closed so a headless CLI never blocks on EOF; on abort SIGTERM the group then SIGKILL-escalate.
   */
  exec(cmd: string, opts: ExecOpts = {}): Promise<ExecResult> {
    return new Promise((resolve) => {
      const child = spawn(cmd, {
        cwd: opts.cwd ? this.abs(opts.cwd) : this.workdir,
        env: { ...process.env, ...this.env, ...opts.env },
        shell: true,
        // detached → the command is its own process group leader, so on cancel we can kill the WHOLE
        // tree (the agent AND any grandchildren it spawned), not just the shell — no orphans.
        detached: true,
        // Close stdin: a headless CLI with an open stdin pipe and no TTY blocks forever waiting for
        // EOF (the documented ~10-minute pi hang). Pipe stdout/stderr for the event stream.
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
      const cleanup = (): void => { signal?.removeEventListener('abort', onAbort); };
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

  /**
   * Per-node teardown. NO-OP w.r.t. the shared worktree (mirrors daytona's `ownsVm:false`): the
   * worktree outlives every node and is committed + removed ONCE by `WorktreeRunScope.dispose`. There
   * is nothing per-node to clean up — the node's files belong to the worktree, which the scope owns.
   */
  async dispose(): Promise<void> {
    /* no-op: the run scope owns the worktree's lifetime. */
  }
}

// ── the run scope: ONE worktree for the whole run; per-node views inside it ──────

/**
 * The per-run resource lifecycle the seam exists for. Holds the ONE worktree created in `openRun`;
 * `create` makes per-node `WorktreeSandbox` views inside it; `dispose` commits the worktree to its
 * branch then removes the checkout (the branch persists) — ONCE, after the last node.
 */
class WorktreeRunScope implements RunScope {
  /** The worktree path all nodes live under (the run's write-isolated checkout). */
  readonly root: string;

  constructor(
    private readonly repoRoot: string,
    private readonly run: string,
    wtPath: string,
  ) {
    this.root = wtPath;
  }

  /**
   * Make one node's sandbox view INSIDE the shared worktree. Every node's writes land under the same
   * worktree dir, so they are physically isolated from the main checkout (and from other runs).
   */
  create(opts: CreateOpts): Promise<Sandbox> {
    return WorktreeSandbox.open(this.root, opts);
  }

  /**
   * Run-level teardown — port of finishWorktree (run.mjs 438–459). Commit the run's worktree contents
   * to branch `pi/<run>` so the work is DURABLE for a human-gated merge, then `git worktree remove
   * --force` the checkout (the branch PERSISTS). Best-effort per the seam: a throw here must not mask
   * the run verdict (the runner wraps this in try/catch), so each git step is independently guarded.
   *
   * We do NOT copy the deliverable back (run.mjs 444–453 did) — the runner already downloadDir'd every
   * node's output to the host outDir (the MAIN tree) before this runs, so the deliverable is already
   * collected. The commit is purely to make the worktree's contents durable on the branch.
   */
  async dispose(): Promise<void> {
    // 1. Commit the run's work to its branch (run.mjs 441–442). `add -A` then commit; "nothing to
    //    commit" is fine (a run that produced no tracked changes still tears down cleanly).
    try {
      git(this.root, 'add', '-A');
      try {
        git(this.root, 'commit', '-m', `pi(${this.run}): run artifacts`);
      } catch {
        /* nothing to commit — fine */
      }
    } catch {
      /* add failed (e.g. dir already gone) — best-effort, don't mask the run verdict */
    }
    // 2. Remove the worktree CHECKOUT; the branch pi/<run> persists for a human-gated merge (run.mjs
    //    455). `--force` because the worktree may hold uncommitted gitignored output dirs.
    try {
      git(this.repoRoot, 'worktree', 'remove', '--force', this.root);
    } catch {
      /* remove failed — best-effort; the branch is already durable from step 1 */
    }
  }
}

// ── the provider ─────────────────────────────────────────────────────────────────

/**
 * The git-worktree provider — per-run WRITE isolation. Implements ONLY the run-scoped lifecycle:
 *   - `openRun` (port of setupWorktree): make a fresh per-run worktree on branch `pi/<run>` at HEAD in
 *     a sibling `.pi-worktrees/<run>`, symlink each tracked package's node_modules in, return a scope.
 *   - `create` (the non-scoped fallback): REJECTS — a worktree is inherently run-level, so there is no
 *     shared worktree to place a node in without `openRun` (see PLAN). The runner always uses `openRun`
 *     when a provider defines it, so this is the explicit "used wrong" guard.
 *
 * Composes with Seatbelt: a future read-scope layer can wrap exec, and Seatbelt grants the node_modules
 * symlink TARGET realpath, so a read scope auto-follows into the worktree (see the seatbelt.ts pointer).
 */
export class WorktreeSandboxProvider implements SandboxProvider {
  readonly kind: SandboxProviderKind = 'worktree';

  /**
   * Open the run scope: create the per-run git worktree and symlink node_modules in. Port of
   * setupWorktree (run.mjs 400–433).
   */
  async openRun(opts: OpenRunOpts): Promise<RunScope> {
    const repoRoot = path.resolve(opts.repoRoot);
    // 1. The worktree lives OUTSIDE the repo (a sibling `.pi-worktrees/<run>`) so it needs no gitignore
    //    and can never recurse (run.mjs 401).
    const wtPath = path.join(path.dirname(repoRoot), '.pi-worktrees', opts.run);
    const branch = `pi/${opts.run}`;

    // 2. Idempotent: drop any stale worktree at this path first (a prior run / crash), then re-add
    //    (run.mjs 404–405).
    try { git(repoRoot, 'worktree', 'remove', '--force', wtPath); } catch { /* none to remove */ }
    try { fsSync.rmSync(wtPath, { recursive: true, force: true }); } catch { /* none to rm */ }
    await fs.mkdir(path.dirname(wtPath), { recursive: true });

    // 3. `git worktree add -B pi/<run> <wtPath> HEAD` — a fresh checkout at HEAD on a NEW branch reset
    //    to HEAD, so the run starts from a known committed state (a clean room) (run.mjs 408).
    git(repoRoot, 'worktree', 'add', '-B', branch, wtPath, 'HEAD');

    // 4. Link node_modules for EVERY tracked package (gitignored → absent in the fresh checkout), so a
    //    node that runs a toolchain (build/test) inside the worktree resolves its deps (run.mjs 409–431).
    //    Discover packages by their TRACKED package.json (git ls-files — a gitignored nested
    //    node_modules never recurses), then symlink each existing node_modules at the same rel path.
    let pkgRels: string[] = [];
    try {
      pkgRels = git(repoRoot, 'ls-files')
        .split('\n')
        .filter((f) => f === 'package.json' || f.endsWith('/package.json'))
        .map((f) => (f === 'package.json' ? '' : path.dirname(f)));
    } catch { /* not a package repo / no tracked package.json — link nothing */ }
    const linkRels = Array.from(new Set(['', ...pkgRels])).filter(
      (d) => !d.split('/').includes('node_modules'),
    );
    for (const rel of linkRels) {
      const target = path.join(repoRoot, rel, 'node_modules');
      const link = path.join(wtPath, rel, 'node_modules');
      try {
        if (fsSync.existsSync(target) && !fsSync.existsSync(link)) {
          await fs.mkdir(path.dirname(link), { recursive: true });
          // 'dir' junction-type on Windows; a plain symlink elsewhere. Best-effort (Windows without
          // Developer Mode / admin may refuse symlinks — a toolchain node then re-installs, which is
          // the same fallback run.mjs accepts).
          fsSync.symlinkSync(target, link, 'dir');
        }
      } catch { /* symlink refused (perms/Windows) — best-effort, skip this package */ }
    }

    return new WorktreeRunScope(repoRoot, opts.run, wtPath);
  }

  /**
   * Non-scoped fallback: REJECT. A worktree spans an entire run (one branch, one checkout, all nodes),
   * so there is no shared worktree to place a single node in without `openRun`. The runner uses
   * `openRun` whenever a provider defines it (runner.ts openRunScope), so reaching here means the
   * provider was driven outside its run-scoped contract — fail loudly rather than silently run a node
   * unisolated or spin up a throwaway one-node worktree that is neither durable nor useful.
   */
  create(): Promise<Sandbox> {
    return Promise.reject(
      new Error(
        'WorktreeSandboxProvider requires the run-scoped path (openRun): a git worktree is inherently ' +
          'run-level (branch pi/<run> + one checkout span all of a run\'s nodes). Drive it via ' +
          'runWorkflow (which calls openRun), not the bare per-node create().',
      ),
    );
  }
}
