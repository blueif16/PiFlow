# Seatbelt read-scope sandbox — research brief (2026-06-21)

Targeted confirmation leg for the `@piflow/core` **Seatbelt read-scope SandboxProvider** (macOS). The
profile logic is already proven in `templates/pi-runner/run.mjs` `buildSandboxProfile`; this brief only
confirms current best practices / gotchas so the port is faithful and the FLAGs (Linux stub, deprecation)
are accurate.

**Legs run:** Exa web search (3 queries — SBPL best practices, realpath/symlink escape, bubblewrap).
Reddit (apify macrocosmos/reddit-scraper, `r/macprogramming` + `r/MacOS`, keyword "sandbox-exec seatbelt
macOS deprecated") returned **0 items** — niche dev tooling is sparse on those subs. **No YouTube** (per
scope). Net: effectively **Exa-only**, which is the authoritative source type for this (the corroborating
evidence is production code, not practitioner chatter).

## 1. `sandbox-exec` / SBPL — deprecated but functional (and widely relied on)

- `sandbox-exec(1)` + the `sandbox_init()` C API have been **marked deprecated since macOS 10.8 (2012)**,
  but **remain fully functional on macOS 15 Sequoia (2024/2025)**. The *kernel* enforcement (TrustedBSD
  MAC / Seatbelt) is NOT deprecated — only the public userspace API annotation. No removal date announced;
  Apple has published **no replacement** for non-App-Store / headless CLI process sandboxing
  (App Sandbox needs code-signing + entitlements + Xcode; Endpoint Security only observes). See
  apple/containerization#737.
- **In production today** by Bazel, Nix, Homebrew, **Anthropic (Claude Code)**, **OpenAI (Codex)**,
  Chrome/Chromium, Firefox, gemini-cli, anthropic-experimental/sandbox-runtime. This is the de-facto
  mechanism; the deprecation banner is cosmetic (it prints `WARNING: sandbox-exec is deprecated` to
  stderr on every invocation — harmless, but a node's stderr stream will carry it).
- **Invocation:** `sandbox-exec -f <profile>.sb <cmd>` (file) or `-p '<inline>'`. The sandbox is applied
  before `exec()`, **inherited by every child process**, and **cannot be lifted from inside** — exactly
  the property the read-scope incident needs (a spawned `grep`/`cat`/`find` is bound too).
- **Profile structure (matches run.mjs):** `(version 1)` → `(allow default)` → `(deny file-read*)` →
  `(allow file-read-metadata)` (so stat/readdir/getcwd/dyld resolve paths everywhere; denying metadata
  EPERMs `uv_cwd` and node never boots) → re-allow `file-read*` for the system/toolchain roots and the
  declared scope. `exec`/`network` left open. This is the runok / mcp-cage / trailofbits canonical shape.

### Refinement worth noting (NOT changing the port)
- trailofbits' `seatbelt-sandboxer` recommends **`file-read-data`** (content only) for the allowlist
  rather than `file-read*` (all read ops), combined with a broad `file-read-metadata` allow. The pi-runner
  template uses `file-read*` for the allowlist — functionally fine (it grants data+metadata for the scoped
  subpaths, and metadata is already globally allowed), just slightly broader than the strict minimum. We
  **port `file-read*` verbatim** (faithful to the proven template + its `demo.sh`); the `file-read-data`
  tightening is a future option, not this pass.
- **SIP note:** on a SIP-relaxed machine `sandbox-exec -p` testing is unrestricted; standard machines run
  `-f <profile>` fine for our use. We use `-f` (a written profile file), matching run.mjs.

## 2. realpath / symlink-escape subtleties (the load-bearing correctness rule)

- **SBPL path filters match the kernel's RESOLVED (vnode-level) realpath, not the lexical path.** This is
  the single most important rule and it cuts both ways:
  1. **Security:** a model **cannot escape** by creating its own symlink to an out-of-scope file — the
     kernel checks the *target* realpath, which is not granted. (anthropic-experimental/sandbox-runtime's
     `symlink-boundary` tests assert exactly this: a symlink resolving to a *broader* scope must NOT widen
     the grant.)
  2. **Functionality:** you MUST grant the realpath of legitimately-symlinked roots or they EPERM. Canonical
     cases: `/tmp → /private/tmp`, `/var → /private/var`, `/etc → /private/etc` (so grant the `/private/*`
     forms AND the `/tmp`,`/var`,`/etc` literals as root-symlink entries); `$TMPDIR` (Go/node resolve it);
     and **workspace-linked deps** (a monorepo `node_modules/@scope/x` symlink points OUTSIDE node_modules —
     granting `node_modules` alone EPERMs `tsc`/`webpack` with "Cannot find module").
- **The proven mitigation (run.mjs, and corroborated by mkke/seatbelt + openai/codex#378 + gemini-cli):**
  expand **every** granted root to `{itself, its realpath}` and emit both. `process.cwd()` is already
  canonical on UNIX so it needs no realpath, but everything sourced from user input / `os.tmpdir()` does.
  openai/codex#378 (`realpathSafe`) is the same fix; mkke/seatbelt emits "both the original and resolved
  paths to handle edge cases"; gemini-cli passes `WORKSPACE` (realpath) + `WORKSPACE_RAW` (lexical).
- **cwd-as-literal nuance:** the cwd dir-ENTRY needs file-read DATA (not just metadata) for `getcwd`/
  `uv_cwd`, but granting `(subpath cwd)` re-exposes the whole tree and defeats isolation. The fix
  (run.mjs) is `(literal <cwd>)` — the entry reads, subdirs stay denied — expanded to {itself, realpath}.
  We port this exactly.

## 3. Linux equivalent — `bubblewrap` (stub + flag, not wired)

- On Linux the equivalent of `sandbox-exec` is **`bubblewrap` (`bwrap`)** — an unprivileged sandboxing
  tool (Linux user namespaces; used by Flatpak). It builds an **empty mount namespace** and you compose
  the visible filesystem with bind mounts: `--ro-bind <host> <dest>` (read-only), `--bind` (read-write),
  `--tmpfs /tmp`, `--proc /proc`, `--dev /dev`, `--unshare-net` (drop network), `--chdir`.
- **Model difference vs Seatbelt:** Seatbelt is *deny-specific-ops-on-a-shared-view* (allowlist on the
  real fs); bwrap is *build-a-new-view-from-nothing* (only what you bind is visible). A read-scope port
  would `--ro-bind` each system/toolchain root + each declared scope root + the workdir (rw), `--tmpfs
  /tmp`, `--dev`, `--proc`, then `--chdir <workdir>`. Out-of-scope reads fail with ENOENT (not present in
  the namespace) rather than EPERM — semantically equivalent for the over-read defense.
- **Not wired in this pass.** ArchWiki notes bwrap has "no explicit allowlist/blacklist of file paths"
  primitive — you express scope via which binds you add, so the port is a real (if mechanical) translation
  of the grant list into `--ro-bind` args. We GATE on `process.platform`: `darwin` → Seatbelt; otherwise
  WARN once and run UNSANDBOXED (byte-identical to InMemorySandbox), matching run.mjs. A future
  `bubblewrap` arm slots in at the same gate.

## Decisions locked for the port

1. **Profile = run.mjs `buildSandboxProfile`, verbatim mechanism:** deny-all-read → metadata-allow → system
   roots → declared-scope-union, every root `{itself, realpath}`-expanded, cwd as `(literal)`, reads-only.
2. **Invoke `sandbox-exec -f <generated .sb> sh -c <cmd>`** (the runner passes a single shell string, so
   wrap with an explicit `sh -c`; `sandbox-exec` needs an argv, and `sh -c` is the shell InMemorySandbox
   used via `shell:true`). Keep `detached:true` + `stdio:['ignore','pipe','pipe']` + signal→`process.kill
   (-pid)` EXACTLY as InMemorySandbox (the kill targets the `sandbox-exec` process group, which contains
   the wrapped `sh` and its children — the sandbox is inherited, so the whole tree dies).
3. **Platform gate:** darwin → wrap; non-darwin → WARN once + run unsandboxed.
4. **Linux/bubblewrap:** typed FLAG only, not wired.
5. **`file-read*` (not `file-read-data`)** for the allowlist — faithful to the template + demo.sh; tighten
   later if desired.

## Sources
- mkke/seatbelt (github) — production Go Seatbelt lib; symlink-aware (emits original+realpath), deprecation
  reliance list, `import "bsd.sb"`.
- trailofbits/skills `seatbelt-sandboxer` — `file-read-data` vs `file-read*` allowlist refinement;
  symptom/cause/fix table; deny-all-then-allow workflow.
- apple/containerization#737 — deprecation timeline; no replacement for headless sandboxing; stderr banner.
- openai/codex#378 (`realpathSafe`) — realpath the policy paths, macOS-only, `os.tmpdir()` realpath.
- google-gemini/gemini-cli `seatbeltArgsBuilder.ts` — `-D` params (WORKSPACE realpath + WORKSPACE_RAW),
  PATH dirs read-only, worktree git-dir grants, `.env*` deny regex.
- anthropic-experimental/sandbox-runtime `symlink-boundary.test.ts` — a symlink to a broader scope must not
  widen; `/tmp→/private/tmp` canonical resolution is allowed.
- runok / mcp-cage MACOS_SANDBOX / zameermanji.com (2025) / macinternals.app (2026) / Apple Sandbox Guide
  v1.0 — SBPL semantics: subpath/literal/regex, "subpath never ends with /", symlink resolution, profile
  immutable after exec, deny-wins-over-allow.
- containers/bubblewrap + ArchWiki Bubblewrap + bwrap(1) — Linux equivalent; bind-mount model; `--ro-bind`/
  `--tmpfs`/`--unshare-net`; no path allowlist primitive.
