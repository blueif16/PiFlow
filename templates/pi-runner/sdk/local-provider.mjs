// In-place LocalSandboxProvider — the GAP-1 fill for @piflow/core.
//
// EVERY shipped provider (InMemory, Seatbelt) `mkdtemp`s a throwaway workspace and `downloadDir`-copies
// outputs back. The live `pi-runner/run.mjs` instead runs `pi` IN-PLACE in a real directory (RUN_CWD /
// out/<run>) with no copy. This provider mirrors that RUN_CWD model so the SDK can run a node in a real
// existing directory: the sandbox root IS `opts.workdir` (no temp dir), `downloadDir` is identity when
// remote==local (the output already lives at the host location), and `dispose` NEVER deletes the tree.
//
// Duck-typed against the `Sandbox` / `SandboxProvider` contract (types.ts:204-300, @piflow/core). It is
// the canonical `InMemorySandbox` (src/sandbox/index.ts) with the four in-place deltas only:
//   create   — root = resolve(workdir) (mkdir -p), NOT mkdtemp
//   write    — resolve under the real root
//   download — identity no-op when same realpath; defensive recursive copy otherwise
//   dispose  — no-op (the real workspace is the user's project tree)
// exec is byte-for-byte the reference impl (detached process group + opts.signal SIGTERM→SIGKILL).
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { tailAppend } from "@piflow/core";

export class LocalSandbox {
  /**
   * @param {string} root absolute path — the REAL workspace this sandbox operates in-place (the
   *   writeFile/readFile base — a node's PRIVATE staging dir under the in-place run entrypoint).
   * @param {Record<string,string>} env
   * @param {string} [execCwd] absolute path the COMMAND runs in, DECOUPLED from `root`. The OPEN-1
   *   fix: the SDK runner writes every node's prompt to the FIXED `_pi/prompt.md`, so parallel nodes
   *   need DISTINCT write-roots (staging) yet must SHARE one exec cwd (the repo root) for their
   *   repo-relative skill/template reads. Omitted ⇒ exec runs in `root` (the simple in-place case;
   *   keeps every non-entrypoint caller — and the existing tests — byte-identical).
   */
  constructor(root, env, execCwd) {
    this.root = root;
    this.workdir = root; // in-place: root and workdir are the same real dir
    this.env = env ?? {};
    this.execCwd = execCwd; // exec cwd base; defaults to root when undefined
  }

  /**
   * Root the sandbox AT the given workdir (resolved absolute). Unlike InMemory, NO mkdtemp — we only
   * ensure the real dir (and its output subdir) exist. All files live in the REAL tree.
   * @param {{ readScope: string[], outputDir: string, workdir: string, image?: string, env?: Record<string,string>, timeoutMs?: number }} opts
   * @param {string} [execCwd] the shared exec cwd (see the constructor) — the provider threads its own.
   */
  static async create(opts, execCwd) {
    const root = path.resolve(opts.workdir || ".");
    await fs.mkdir(root, { recursive: true });
    if (opts.outputDir) await fs.mkdir(path.resolve(root, opts.outputDir), { recursive: true });
    return new LocalSandbox(root, opts.env ?? {}, execCwd ? path.resolve(execCwd) : undefined);
  }

  abs(p) {
    return path.resolve(this.root, p);
  }

  async putFiles(files) {
    for (const f of files) await this.writeFile(f.path, f.data);
  }

  async writeFile(p, data) {
    const target = this.abs(p);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
  }

  exec(cmd, opts = {}) {
    return new Promise((resolve) => {
      const child = spawn(cmd, {
        // exec cwd: an explicit opts.cwd (resolved under root) wins; else the decoupled execCwd (the
        // shared repo root, for repo-relative reads); else root (the simple in-place case).
        cwd: opts.cwd ? this.abs(opts.cwd) : (this.execCwd ?? this.root),
        env: { ...process.env, ...this.env, ...opts.env },
        shell: true,
        // detached → the command is its own process group leader, so on cancel we can kill the WHOLE
        // tree (the agent AND any grandchildren it spawned), not just the shell — no orphans.
        detached: true,
        // Close stdin: a headless CLI with an open stdin pipe and no TTY blocks forever waiting for
        // EOF (the documented ~10-minute pi hang). Pipe stdout/stderr for the event stream.
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let done = false;
      const signal = opts.signal;
      // On cancel, SIGTERM the process group then SIGKILL-escalate (`-pid` targets the group).
      const onAbort = () => {
        const pid = child.pid;
        if (pid === undefined) return;
        try { process.kill(-pid, "SIGTERM"); } catch { /* already gone */ }
        const esc = setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch { /* reaped */ } }, 2000);
        esc.unref?.();
      };
      const cleanup = () => { signal?.removeEventListener("abort", onAbort); };
      const finish = (r) => { if (done) return; done = true; cleanup(); resolve(r); };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      child.stdout?.on("data", (d) => {
        const s = d.toString();
        stdout = tailAppend(stdout, s); // bounded: a model re-embedding its transcript each delta can't RangeError us
        opts.onStdout?.(s);
      });
      child.stderr?.on("data", (d) => {
        const s = d.toString();
        stderr = tailAppend(stderr, s);
        opts.onStderr?.(s);
      });
      child.on("error", (err) => finish({ stdout, stderr: stderr + String(err), code: 1 }));
      // A signal-killed child reports code=null + a signal name → surface a nonzero (124) so the runner
      // classifies it as a failure even before the watchdog's own `killed` verdict.
      child.on("close", (code, sig) => finish({ stdout, stderr, code: code ?? (sig ? 124 : 0) }));
    });
  }

  async readFile(p, opts = {}) {
    return opts.encoding === "utf8" ? fs.readFile(this.abs(p), "utf8") : fs.readFile(this.abs(p));
  }

  /**
   * NO-OP — ALWAYS. In-place means the node ran directly in the real workspace, so its output already
   * lives at the host location; there is NOTHING to collect. The shipped providers copy from a throwaway
   * temp dir, but this one never does — and a copy here would be actively WRONG: the runner calls
   * downloadDir(node.sandbox.output, outDir), and with workspace=repoRoot + outDir=projectDir that would
   * clone the whole repo into the project dir. The filesystem IS the contract; collection is identity.
   */
  async downloadDir() {
    /* in-place: artifacts are already on the host disk — nothing to download */
  }

  /** NO-OP. NEVER delete the real workspace — it is the user's project tree (the RUN_CWD contract). */
  async dispose() {
    /* intentionally empty */
  }
}

export class LocalSandboxProvider {
  // Reuse the existing union member so a NodeSpec's default `sandbox.provider` matches (the runner picks
  // a provider by `kind`; 'inmemory' is the local no-isolation default the in-place model substitutes for).
  kind = "inmemory";
  /**
   * @param {{ execCwd?: string }} [opts] execCwd = the SHARED exec cwd every node runs in (the repo
   *   root), DECOUPLED from each node's per-node write-root (staging). The in-place run entrypoint
   *   sets this to BASE_ROOT so parallel nodes — each with its own `_pi/<id>` staging workspace —
   *   don't clobber the SDK's fixed `_pi/prompt.md` yet still resolve repo-relative skill/template
   *   reads. Omitted ⇒ exec runs in each node's own workdir (the OPEN-1-free simple case).
   */
  constructor(opts = {}) {
    this.execCwd = opts.execCwd;
  }
  create(opts) {
    return LocalSandbox.create(opts, this.execCwd);
  }
}
