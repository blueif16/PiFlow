#!/usr/bin/env node
// pi-runner driver — runs a Claude Code Workflow by spawning one `pi` per node, on a cheap
// non-Claude coding-plan model, orchestrated entirely from Claude Code (the user runs nothing).
//
// SOURCE OF TRUTH = your `.claude/workflows/<name>.js` (the Claude Code Workflow). This driver
// does NOT re-define the graph. It EXECUTES that file under recording stubs (extract.mjs) to
// capture the EXACT realized prompts + DAG, then runs each node on pi. So: edit the workflow,
// prove it by spawning the real Claude Code Workflow, and pi runs the SAME prompts — no drift,
// nothing to hand-sync.
//
// The DRIVER owns the deterministic graph (stage order, parallel lanes, status, watchdog);
// pi is the per-node executor (read/bash/edit/write) on a non-Claude coding-plan model. Nodes
// coordinate through the FILESYSTEM, exactly like the Workflow's agents do.
//
// THIS FILE IS GENERIC AND BYTE-IDENTICAL ACROSS REPOS. Per-repo specifics live entirely in
// pi-runner/.env (gitignored): the credential/model AND the three path knobs below + an optional
// default `--until`. To adopt in a new repo: copy pi-runner/ and write its .env — never edit this
// file. (That is how the repo copy and the global-skill template stay the same: a fix here is a
// one-file copy, never a manual merge.)
//
// USAGE (the orchestrator runs this — never the user):
//   node pi-runner/run.mjs --run <id> [--arg k=v ...] [--arg-file k=path ...] \
//        [--from <phase>] [--until <phase>] [--only <phase>] [--debug] [--dry-run] [--node-timeout N]
//   --run <id> | --id <id> | --lesson <id>   instance id — keys out/<id>/ AND seeds args.lessonId.
//   --arg k=v          a workflow arg (repeatable). Becomes the workflow's `args.k`.
//   --arg-file k=path  read file text into args.k (repeatable).
//   --brief <file>     alias for --arg-file brief=<file> (common pipeline input doc).
//   --style <value>    alias for --arg style=<value>.
//   --until <phase>    truncate AFTER the last stage whose phase TITLE / node LABEL / node ID
//                      contains this substring (case-insensitive). Default = $PI_RUNNER_UNTIL or "all".
//   --from <phase>     RESUME: skip every stage BEFORE the first one matching this substring and
//                      reuse their on-disk artifacts (a prior run must have produced them — the
//                      driver PREFLIGHT-verifies the skipped nodes' DRIVER-ARTIFACTS and HALTS if any
//                      are missing, so a resume never runs on absent inputs). Pairs with --until to
//                      run an inclusive node RANGE; default = $PI_RUNNER_FROM or the start.
//   --only <phase>     sugar for --from <phase> --until <phase>: run exactly that stage in isolation
//                      against frozen upstream artifacts (the tight edit→retest loop for one node).
//   --provider/--model/--extension(-e)/--status as below (model defaults to $PI_CP_MODEL).
//   --debug            DEBUG mode: real-time heartbeats + stall detection AND the forensic archive
//                      (<node>.events.jsonl, slimmed to the low MB, + <node>.debug.log). Production
//                      (no --debug) skips both, keeping only the digest's distilled aggregates
//                      (timing, tool breakdown, thinking, tokens). ALWAYS use while developing;
//                      re-run one node with --debug to recover its raw archive.
//   --node-timeout N   hard-kill a node after N seconds (default $PI_RUNNER_NODE_TIMEOUT or 1800).
//   --dry-run          extract + build prompts + print the exact pi commands; invoke no model.

import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractWorkflow } from "./extract.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // pi-runner/ lives here

// Load pi-runner/.env (KEY=VALUE) so the PI_RUNNER_* WIRING below is visible. A real process.env
// value always wins (override per-invocation). The CREDENTIAL + MODEL are NOT here — they live in
// pi's OWN machine-global config (~/.pi/agent/models.json), set once, so a product needs no key of
// its own. This file is therefore wiring-only (and optional). Never commit it.
function loadDefaults() {
  let raw;
  try { raw = fs.readFileSync(path.join(HERE, ".env"), "utf8"); } catch { return; }
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadDefaults();

// ==== PROJECT CONFIG — set these in pi-runner/.env, NOT here ===============================
// PI_RUNNER_ROOT     repo root (the workflow's ROOT). Default = pi-runner/'s parent dir.
// PI_RUNNER_CWD      where pi executes each node + where node-reported relative artifact paths
//                    resolve (the dir your npm scripts run in). Relative paths resolve vs ROOT.
//                    Default = ROOT.
// PI_RUNNER_WORKFLOW path to the workflow .js. Relative paths resolve vs ROOT.
// PI_RUNNER_UNTIL    optional default for --until (e.g. an early phase during bring-up).
// PI_RUNNER_FROM     optional default for --from (resume boundary; --from/--only override).
// PI_RUNNER_PROVIDER optional default provider the driver passes (--provider overrides). Default
//                    "cp". Set it (e.g. "minimax") to pin THIS repo's model lane once in wiring,
//                    instead of typing --provider every run. The named provider must exist in pi's
//                    ~/.pi/agent/models.json. Verify the resolved model before a real run.
// PI_RUNNER_MODEL    optional default model the driver pins (--model overrides; checked BEFORE the
//                    provider-specific PI_CP_MODEL). Empty → pi uses the named provider's first/default
//                    model. Set it (e.g. "MiniMax-M3") to pin THIS repo's model alongside PI_RUNNER_PROVIDER.
// PI_RUNNER_NODE_TIMEOUT  optional default node hard-kill seconds (--node-timeout overrides).
//                    Set generously: heavy nodes (long TTS / build / render steps) run long on a
//                    cheap coding-plan model. Default 1800 (30 min); 600 was too tight.
// PI_RUNNER_ESCALATE  "1" to enable the escalation gate (default off). On a VERIFIED failure, consult
//                    PI_RUNNER_ESCALATE_MODEL (optionally on PI_RUNNER_ESCALATE_PROVIDER) once, after
//                    PI_RUNNER_MAX_RETRIES (default 1) same-model transient retries. Consult model
//                    lives in ~/.pi/agent/models.json. Spec: reference/escalation.md.
// PI_RUNNER_CONTRACT_EXT  "1" loads the bundled extensions/node-contract.ts (typed submit_result tool
//                    + in-loop owned-paths block) via -e; a path loads a custom one; default off.
const resolveFrom = (root, p, fb) => (!p ? fb : path.isAbsolute(p) ? p : path.join(root, p));
// BASE_* = the real (main) checkout. With --worktree these are remapped to a per-run git
// worktree below (ROOT/RUN_CWD become the worktree); without it ROOT===BASE_ROOT etc.
const BASE_ROOT = process.env.PI_RUNNER_ROOT ? path.resolve(process.env.PI_RUNNER_ROOT) : path.resolve(HERE, "..");
const BASE_RUN_CWD = resolveFrom(BASE_ROOT, process.env.PI_RUNNER_CWD, BASE_ROOT);
const WORKFLOW = resolveFrom(BASE_ROOT, process.env.PI_RUNNER_WORKFLOW, path.join(BASE_ROOT, ".claude/workflows/CHANGEME.js"));
// ==========================================================================================

function parseArgs(argv) {
  const a = { until: process.env.PI_RUNNER_UNTIL || "all", from: process.env.PI_RUNNER_FROM || null, provider: process.env.PI_RUNNER_PROVIDER || "cp", dryRun: false, wfArgs: {} };
  const setRun = (v) => { a.run = v; if (a.wfArgs.lessonId === undefined) a.wfArgs.lessonId = v; if (a.wfArgs.id === undefined) a.wfArgs.id = v; };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === "--run" || k === "--id" || k === "--lesson") setRun(next());
    else if (k === "--arg") { const [key, ...rest] = next().split("="); a.wfArgs[key] = rest.join("="); }
    else if (k === "--arg-file") { const [key, ...rest] = next().split("="); a.wfArgs[key] = fs.readFileSync(path.resolve(rest.join("=")), "utf8"); }
    else if (k === "--brief") a.wfArgs.brief = fs.readFileSync(path.resolve(next()), "utf8");
    else if (k === "--style") a.wfArgs.style = next();
    else if (k === "--until") a.until = next();
    else if (k === "--from") a.from = next();
    else if (k === "--only") { const v = next(); a.from = v; a.until = v; }
    else if (k === "--provider") a.provider = next();
    else if (k === "--model") a.model = next();
    else if (k === "--extension" || k === "-e") a.extension = next();
    else if (k === "--status") a.status = next();
    else if (k === "--dry-run") a.dryRun = true;
    else if (k === "--debug") a.debug = true;
    else if (k === "--worktree") a.worktree = true;
    else if (k === "--keep-worktree") { a.worktree = true; a.keepWorktree = true; }
    else if (k === "--sandbox") a.sandbox = true;
    else if (k === "--node-timeout") a.nodeTimeout = Number(next());
    else throw new Error(`unknown arg: ${k}`);
  }
  if (!a.run) a.run = a.wfArgs.lessonId || a.wfArgs.id || a.wfArgs.run || "run";
  return a;
}

const args = parseArgs(process.argv.slice(2));
const model = args.model || process.env.PI_RUNNER_MODEL || process.env.PI_CP_MODEL || ""; // empty → pi uses the provider's default model
// Provider/credential/model come from pi's OWN global config (~/.pi/agent/models.json); NO provider
// extension is loaded by default. --extension stays available only for a provider that needs a
// custom API implementation or OAuth flow (then pi loads it via -e).
const extension = args.extension ? path.resolve(args.extension) : null;

// DEBUG (always use while developing): frequent status refresh + console heartbeats + stall
// detection so a hang is visible in seconds, never minutes. Production mode is lean.
const DEBUG = args.debug === true;
const HEARTBEAT_MS = DEBUG ? 4000 : 10000;
const STALL_WARN_S = 45;
const NODE_TIMEOUT_S =
  args.nodeTimeout || Number(process.env.PI_RUNNER_NODE_TIMEOUT) || 1800;
// Stuck-loop guard: some cheap models get stuck emitting the SAME delta over and over. If one
// non-trivial delta repeats this many times in a row the node is looping (not progressing), so it's
// killed early instead of burning to the node-timeout. 0 disables. NOTE: this is NOT what makes a raw
// transcript huge — that is pi re-embedding the whole accumulated message on every delta (those lines
// GROW, never repeat), fixed separately by the message_update slimming below.
const REPEAT_KILL = process.env.PI_RUNNER_REPEAT_KILL !== undefined ? Number(process.env.PI_RUNNER_REPEAT_KILL) : 400;
// Silent-stall guard: a model can stop emitting events ENTIRELY after a tool returns (provider drop /
// the model just gives up) and sit dead until the node-timeout — a real run burned ~25 silent minutes
// this way. If NO event (text, thinking, or tool) arrives for this many seconds WHILE NO TOOL IS IN
// FLIGHT, the node is dead, not working → kill it early. The "no tool in flight" gate is essential: a
// long silent bash (TTS / render) legitimately emits nothing for minutes, so it must NOT count as a
// stall. Must be < node-timeout to matter. 0 disables. (STALL_WARN_S above still only WARNS.)
const STALL_TIMEOUT_S = process.env.PI_RUNNER_STALL_TIMEOUT !== undefined ? Number(process.env.PI_RUNNER_STALL_TIMEOUT) : 300;
// No-progress tool-thrash guard: a cheap model that can't find something re-runs the SAME read/grep/
// find/ls (identical toolName+args) over and over, writing nothing, until the node-timeout — the
// composer spelunk that motivated this fired identical `grep -rn` ×7 and `ls …|head` ×9 with ZERO files
// written. If one (toolName+args) signature repeats this many times with NO write/edit in between, kill.
// The per-signature counters RESET on any write/edit/submit_result (= progress), so a node that
// legitimately re-runs an identical `npm run …:check` after each edit never trips. 0 disables.
const TOOL_REPEAT_KILL = process.env.PI_RUNNER_TOOL_REPEAT_KILL !== undefined ? Number(process.env.PI_RUNNER_TOOL_REPEAT_KILL) : 5;

// ESCALATION (advisor inversion) — opt-in. On a VERIFIED failure (artifact-contract breach, stuck
// loop, timeout, degenerate output — NEVER self-confidence) consult a stronger, ideally different-
// family model ONCE, fed the cheap attempt's failure evidence (not a blind retry). Transient infra
// noise gets a cheap same-model retry; a missing UPSTREAM input halts (escalation can't manufacture
// it). All per-repo selection is wiring in .env; the consult model lives in ~/.pi/agent/models.json.
// Spec: reference/escalation.md. (cp's qwen3.7-max is already its top tier → escalate CROSS-family.)
const ESCALATE = /^(1|true|on)$/i.test(process.env.PI_RUNNER_ESCALATE || "");
const ESCALATE_MODEL = process.env.PI_RUNNER_ESCALATE_MODEL || "";
const ESCALATE_PROVIDER = process.env.PI_RUNNER_ESCALATE_PROVIDER || "";
const MAX_RETRIES = process.env.PI_RUNNER_MAX_RETRIES !== undefined ? Number(process.env.PI_RUNNER_MAX_RETRIES) : 1;

// NODE-CONTRACT extension (generic): a typed `submit_result` tool (structured return, no fence to
// scrape) + an in-loop owned-paths `tool_call` block. Opt-in via PI_RUNNER_CONTRACT_EXT (path to the
// .ts, or "1" for the bundled pi-runner/extensions/node-contract.ts). Loaded with -e (explicit -e
// still loads under --no-extensions). Default OFF until the qwen tool-call spike passes; the driver
// keeps the fenced-JSON parser as a fallback, so ON or OFF never breaks a run. Spec: reference/artifact-contract.md.
const contractExtEnv = process.env.PI_RUNNER_CONTRACT_EXT || "";
const contractExtension = /^(0|false|off|)$/i.test(contractExtEnv)
  ? null
  : /^(1|true|on)$/i.test(contractExtEnv) ? path.join(HERE, "extensions", "node-contract.ts") : path.resolve(contractExtEnv);

// WORKTREE remap (opt-in via --worktree / PI_RUNNER_WORKTREE=1). When on, every node runs inside a
// fresh per-run git worktree (ROOT/RUN_CWD point there); when off, ROOT===BASE_ROOT (unchanged).
const WORKTREE = (args.worktree === true || process.env.PI_RUNNER_WORKTREE === "1") && !args.dryRun;
const cwdRel = path.relative(BASE_ROOT, BASE_RUN_CWD); // e.g. "remotion-svg-primitives" (or "" if cwd===root)
const wtRoot = WORKTREE ? setupWorktree(args.run, BASE_ROOT, cwdRel, BASE_RUN_CWD) : null;
const ROOT = wtRoot || BASE_ROOT;
const RUN_CWD = wtRoot ? path.join(wtRoot, cwdRel) : BASE_RUN_CWD;

const outRel = `out/${args.run}`;
// Status + prompt/event logs ALWAYS live in the MAIN tree, so monitoring (run-status.json /
// status.mjs / watch.mjs) is unaffected by worktree mode and survives teardown.
const promptDir = path.join(BASE_RUN_CWD, outRel, "_pi");
const statusPath = path.resolve(args.status || path.join(BASE_RUN_CWD, outRel, "run-status.json"));

// GLOBAL REGISTRY — so a zero-arg `pi-tui` lists this project with no per-repo config. Idempotent
// upsert keyed by abs project dir; opt out with PI_RUNNER_NO_REGISTER=1. Best-effort: a registry
// write must NEVER affect a run, hence the swallow. Format matches viz-model.mjs's reader.
// Record the ABSOLUTE workflow path (and root) so the TUI can load the static DAG directly: when
// cwd≠root (monorepo subdir), the namespace key is the SUBDIR, but pi-runner/.env lives under ROOT,
// so viz-model's .env scan can't re-derive the workflow from the subdir — without this field the
// detail view degrades to runtime-only nodes (a --from/--only partial run then loses its un-run tail
// and stage structure). WORKFLOW/BASE_ROOT are the MAIN-tree paths (stable across --worktree teardown).
if (process.env.PI_RUNNER_NO_REGISTER !== "1") {
  try {
    const regPath = process.env.PI_RUNNER_REGISTRY || path.join(os.homedir(), ".pi-runner", "registry.json");
    let reg = {};
    try { reg = JSON.parse(fs.readFileSync(regPath, "utf8")); } catch {}
    reg.namespaces ??= {};
    reg.namespaces[BASE_RUN_CWD] = { name: path.basename(BASE_RUN_CWD), out: "out", workflow: WORKFLOW, root: BASE_ROOT, lastSeen: new Date().toISOString() };
    fs.mkdirSync(path.dirname(regPath), { recursive: true });
    fs.writeFileSync(regPath, JSON.stringify(reg, null, 2));
  } catch { /* best-effort: never let registry I/O break a run */ }
}

// SANDBOX (opt-in via --sandbox / PI_RUNNER_SANDBOX=1) — macOS Seatbelt read-scope. PROTOTYPE: only a
// node that DECLARES its read scope (a `DRIVER-READ-SCOPE:` marker) is wrapped; the rest run unchanged,
// so ON or OFF is non-breaking. macOS only (the Linux fleet would use bubblewrap — not wired here).
const SANDBOX_REQ = args.sandbox === true || process.env.PI_RUNNER_SANDBOX === "1";
if (SANDBOX_REQ && process.platform !== "darwin")
  console.warn(`⚠ --sandbox is a macOS sandbox-exec prototype; on ${process.platform} use bubblewrap (not wired) — nodes run UNSANDBOXED.`);
// macOS only. dry-run still PREVIEWS (the dry-run branch returns before the spawn that writes a profile).
const SANDBOX_OK = SANDBOX_REQ && process.platform === "darwin";
const SANDBOX_TMPL = path.join(HERE, "sandbox", "read-scope.sb");
// Render the node's read-scope profile: deny-all-read base (from the template) + the toolchain roots +
// the node's DECLARED scope, plus a few always-needed run paths (node_modules, the node's own _pi dir).
// Anything not granted — other lessons' src/lessons + lesson-data, other out/* — stays read-denied.
// Resolve every top-level (and @scope) SYMLINK in each node_modules to its target realpath, so
// workspace-linked packages (whose target lives outside node_modules) are readable under the sandbox.
// Bounded to the top level (no deep recursion); generic (any linked dep, not just @studio).
function linkedPkgTargets(nmDirs) {
  const out = [];
  for (const nm of nmDirs) {
    let names = [];
    try { names = fs.readdirSync(nm); } catch { continue; }
    for (const name of names) {
      const p = path.join(nm, name);
      try {
        if (name.startsWith("@")) {
          for (const sub of fs.readdirSync(p)) {
            const sp = path.join(p, sub);
            if (fs.lstatSync(sp).isSymbolicLink()) out.push(fs.realpathSync(sp));
          }
        } else if (fs.lstatSync(p).isSymbolicLink()) {
          out.push(fs.realpathSync(p));
        }
      } catch {}
    }
  }
  return out;
}

function buildSandboxProfile(node, scopeRoots) {
  const tmpl = fs.readFileSync(SANDBOX_TMPL, "utf8");
  const auto = [
    path.join(RUN_CWD, "node_modules"),
    path.join(ROOT, "node_modules"),
    path.join(BASE_RUN_CWD, outRel, "_pi"),    // the node's own prompt + logs (always in the main tree)
    // every -e extension pi is REQUIRED to load (the bundled contractExtension and/or an explicit
    // --extension) lives outside the repo scope; pi EPERMs and never boots without it. Grant each
    // one's dir (covers the .ts file + any sibling it imports).
    ...[contractExtension, extension].filter(Boolean).map((e) => path.dirname(e)),
    // workspace-linked deps are SYMLINKS inside node_modules pointing OUTSIDE it (e.g.
    // @studio/* -> ../../../shared-narration). Seatbelt checks the symlink TARGET realpath, so
    // granting node_modules alone EPERMs when tsc / webpack / node resolve them ("Cannot find
    // module @studio/narration-kit") -- which derails the agent into a phantom module-hunt and
    // breaks lesson:check/render. Grant each linked package's target.
    ...linkedPkgTargets([path.join(RUN_CWD, "node_modules"), path.join(ROOT, "node_modules")]),
  ];
  // Seatbelt matches file-read on the RESOLVED realpath, not the lexical path (verified empirically).
  // Two consequences: (1) under --worktree, node_modules is a SYMLINK into the MAIN checkout, so we
  // must allow its TARGET realpath or pi can't load modules; (2) a model therefore CANNOT escape via a
  // self-made symlink, since the target realpath is what is checked. Expand every root to {itself, its
  // realpath} so a symlinked root (node_modules, or a worktree-rewritten scope dir) reads correctly.
  const expand = (p) => { const a = path.resolve(p); try { const r = fs.realpathSync(a); return a === r ? [a] : [a, r]; } catch { return [a]; } };
  const roots = [...new Set([...auto, ...scopeRoots].flatMap(expand))];
  // getcwd (node uv_cwd, every shell) needs file-read DATA on the process cwd directory ENTRY, not just
  // metadata; if cwd is outside every granted root the process EPERMs on uv_cwd before pi even runs. Grant
  // cwd as a NON-recursive (literal ...) so the dir entry reads but its subdirs (other lessons' lesson-data
  // / src/lessons) stay denied -- a (subpath cwd) would re-expose the whole repo and defeat the isolation.
  // Expand to {itself, realpath} like the roots so a symlinked cwd (worktree mode) matches too.
  const cwdLits = [...new Set(expand(RUN_CWD))].map((p) => `  (literal ${JSON.stringify(p)})`).join("\n");
  // cwd dotenv files are ALWAYS readable: build CLIs (e.g. the Remotion CLI) unconditionally read
  // .env/.env.local from cwd; an EPERM there kills the still-render path before the model runs.
  const dotenvLits = [".env", ".env.local"]
    .flatMap((f) => [...new Set(expand(path.join(RUN_CWD, f)))])
    .map((p) => `  (literal ${JSON.stringify(p)})`).join("\n");
  const allows = roots.map((p) => `  (subpath ${JSON.stringify(p)})`).join("\n") + "\n" + cwdLits + "\n" + dotenvLits;
  const out = tmpl
    .replaceAll("@HOME@", os.homedir())
    .replaceAll("@TMPDIR@", os.tmpdir().replace(/\/+$/, ""))
    .replace("@SCOPE_ALLOWS@", allows);
  ensureDir(promptDir);
  const sbFile = path.join(promptDir, `${node.id}.sandbox.sb`);
  fs.writeFileSync(sbFile, out);
  return sbFile;
}

const abs = (p) => (path.isAbsolute(p) ? p : path.join(RUN_CWD, p));
// FUNCTION DECLARATION (hoisted): setupWorktree runs at module-eval (the `const wtRoot = ...` above),
// BEFORE this line — so ensureDir must be hoisted, not a TDZ const, or --worktree throws on startup.
function ensureDir(d) { return fs.mkdirSync(d, { recursive: true }); }
const nowISO = () => new Date().toISOString();
const slug = (label, i) => (label || `node-${i}`).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
// PROJECT_BASE — the workflow's output root (the `projectDir` arg) resolved to absolute (and into
// the worktree if active). Cheap models often self-report paths RELATIVE TO THIS dir (e.g. "src/x")
// rather than to RUN_CWD/ROOT, so the forgiving resolvers below try it as an extra base — else a
// node that genuinely wrote its files (esp. a no-DRIVER-ARTIFACTS node judged only by self-report)
// gets a false "missing" → false `blocked`. No-op when no projectDir arg is passed (generic:
// workflows without one are unaffected). Could later derive from the DRIVER-OWNS markers to drop the
// arg-name convention entirely.
const PROJECT_BASE = (() => {
  const a = (args.wfArgs && args.wfArgs.projectDir != null) ? String(args.wfArgs.projectDir) : null;
  if (!a) return null;
  if (!path.isAbsolute(a)) return path.join(RUN_CWD, a);
  return (wtRoot && a.includes(BASE_ROOT)) ? a.split(BASE_ROOT).join(wtRoot) : a;
})();

function artifactState(p) {
  // Resolve a node-declared artifact path FORGIVINGLY before judging it missing. pi agents
  // inconsistently report a path relative to RUN_CWD (the repo subdir), ROOT (the prompt shows
  // ROOT-prefixed abs paths), OR the projectDir (e.g. "src/x" under projectDir). The strict
  // join(RUN_CWD, p) false-flags a real written file as "blocked" (killing the run for nothing).
  // Try RUN_CWD, then ROOT, then PROJECT_BASE; absolute as-is.
  const candidates = path.isAbsolute(p) ? [p]
    : [path.join(RUN_CWD, p), path.join(ROOT, p), ...(PROJECT_BASE ? [path.join(PROJECT_BASE, p)] : [])];
  for (const c of candidates) {
    try { const s = fs.statSync(c); return { path: p, exists: s.size > 0, bytes: s.size }; } catch {}
  }
  return { path: p, exists: false, bytes: 0 };
}

// A pure file-existence CHECK node (e.g. workflow preflight) declares its required paths via a
// `DRIVER-PREFLIGHT: <space-separated absolute paths>` line in its prompt. The driver resolves it
// in plain code — NO pi spawn — killing the cheap-model failure mode where a glorified `ls` grinds
// to the node-timeout. The dev Workflow runtime forbids fs in the script (so it uses an agent
// there); the pi driver does not. Generic: any workflow can opt a check node in with this marker.
function driverPreflightPaths(prompt) {
  const m = /(?:^|\n)\s*DRIVER-PREFLIGHT:\s*(.+?)\s*(?:\n|$)/.exec(prompt || "");
  if (!m) return null;
  const paths = m[1].split(/\s+/).filter(Boolean);
  return paths.length ? paths : null;
}
function artifactStateAbs(p) {
  // Forgiving like artifactState: a DRIVER-ARTIFACTS marker may be project-relative (resolve via
  // RUN_CWD/ROOT/PROJECT_BASE — fixes the worktree/projectDir case where a bare statSync against the
  // driver's cwd misses a file written into the worktree/projectDir). A DRIVER-PREFLIGHT path is
  // absolute → candidates=[p], unchanged.
  const candidates = path.isAbsolute(p) ? [p]
    : [path.join(RUN_CWD, p), path.join(ROOT, p), ...(PROJECT_BASE ? [path.join(PROJECT_BASE, p)] : [])];
  for (const c of candidates) {
    try { const s = fs.statSync(c); return { path: p, exists: s.size > 0, bytes: s.size }; } catch {}
  }
  return { path: p, exists: false, bytes: 0 };
}

// DRIVER-SEED: <dest> <= <src> — deterministically PRE-STAGE a node's STARTING artifact before pi
// spawns (driver plumbing, never the model). The classic case: copy the per-archetype blueprint
// template into spec/blueprint.json so HARDEN fills <FILL:…> leaves via `edit` instead of composing
// the whole structure. <src> may carry {jsonfile:field} tokens resolved from on-disk JSON (the
// archetype is frozen into spec/classification.json by W0, before HARDEN). Copies ONLY when the dest is
// absent/empty AND the resolved src exists — idempotent (a resume never clobbers a filled artifact; a
// no-template archetype falls through to the node's own §0.5 hand-build). Generic: any workflow opts a
// node in via the contract() `seed` field. No-op when the marker is absent.
function driverSeed(prompt) {
  const m = /(?:^|\n)\s*DRIVER-SEED:\s*(\S+)\s*<=\s*(\S+)\s*(?:\n|$)/.exec(prompt || "");
  return m ? { to: m[1], from: m[2] } : null;
}
function resolveSeedTokens(spec) {
  // {relpath.json:field} → the top-level `field` of the JSON at relpath (resolved vs RUN_CWD).
  return spec.replace(/\{([^:{}]+):([^{}]+)\}/g, (whole, file, field) => {
    try {
      const abs = path.isAbsolute(file) ? file : path.resolve(RUN_CWD, file);
      const v = JSON.parse(fs.readFileSync(abs, "utf8"))[field];
      return v == null ? whole : String(v);
    } catch { return whole; }
  });
}

// ===== WORKTREE ISOLATION (opt-in) =========================================================
// Create a fresh per-run git worktree (branch pi/<run>, checked out at HEAD) so N concurrent runs
// are PHYSICALLY isolated — a node in one run cannot see or clobber another lesson's files. The
// worktree lives OUTSIDE the repo (a sibling .pi-worktrees/<run>) so it needs no gitignore and can
// never recurse. node_modules is symlinked from the main checkout (it is gitignored, so the fresh
// checkout has none). The workflow's hardcoded absolute paths are rewritten BASE_ROOT→wtRoot per
// node in runNode, so agents write INTO the worktree; status + logs stay in the MAIN tree (below).
// FUNCTION DECLARATION (hoisted): setupWorktree calls git() at module-eval (above), before this
// line — a TDZ const would throw on --worktree startup (the worktree-remove try/catch hid it; the
// later worktree-add did not). Hoisted so the eager setupWorktree call resolves it.
function git(cwd, ...a) { return execFileSync("git", a, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim(); }
function setupWorktree(run, baseRoot, cwdRel, baseRunCwd) {
  const wtRoot = path.join(path.dirname(baseRoot), ".pi-worktrees", run);
  const branch = `pi/${run}`;
  // Idempotent: drop any stale worktree at this path first (a prior run / crash), then re-add.
  try { git(baseRoot, "worktree", "remove", "--force", wtRoot); } catch {}
  try { fs.rmSync(wtRoot, { recursive: true, force: true }); } catch {}
  ensureDir(path.dirname(wtRoot));
  // -B resets branch pi/<run> to HEAD so the run starts from a known committed state (clean room).
  git(baseRoot, "worktree", "add", "-B", branch, wtRoot, "HEAD");
  // Link node_modules (gitignored → absent in the fresh checkout) for EVERY package in the base
  // checkout, not just root+cwd: a worktree is HEAD-clean, so any tracked package dir whose base
  // has an installed node_modules needs it symlinked, or that package's scripts (build/test/verify)
  // break inside the worktree (e.g. a packages/verify harness with its own deps). Discover packages
  // by their TRACKED package.json (git ls-files — so a gitignored nested node_modules never
  // recurses), then symlink each existing node_modules at the same relative path. A single-package
  // repo links just root — identical to the prior behavior.
  let pkgRels = [];
  try {
    pkgRels = git(baseRoot, "ls-files")
      .split("\n")
      .filter((f) => f === "package.json" || f.endsWith("/package.json"))
      .map((f) => (f === "package.json" ? "" : path.dirname(f)));
  } catch {}
  const linkRels = Array.from(new Set(["", cwdRel, ...pkgRels])).filter((d) => !d.split("/").includes("node_modules"));
  let linked = 0;
  for (const rel of linkRels) {
    const target = path.join(baseRoot, rel, "node_modules");
    const link = path.join(wtRoot, rel, "node_modules");
    try {
      if (fs.existsSync(target) && !fs.existsSync(link)) { ensureDir(path.dirname(link)); fs.symlinkSync(target, link, "dir"); linked++; }
    } catch {}
  }
  console.log(`worktree → ${wtRoot}  (branch ${branch}, ${linked} node_modules symlinked)\n`);
  return wtRoot;
}
// After the run: preserve the lesson SOURCE on its branch, copy the deliverable (out/<run>) back to
// the MAIN tree (out/ is gitignored, so it would vanish with the worktree), then remove the worktree
// (branch persists for a human-gated merge). On failure we KEEP the worktree for inspection.
function finishWorktree(wtRoot, run, baseRoot, baseRunCwd, cwdRel, ok, keep) {
  const wtCwd = path.join(wtRoot, cwdRel);
  try {
    git(wtRoot, "add", "-A");
    try { git(wtRoot, "commit", "-m", `pi(${run}): lesson run artifacts`); } catch {} // nothing to commit is fine
  } catch (e) { console.error(`worktree commit skipped: ${e.message}`); }
  // Copy the deliverable back so it survives teardown and is visible in the main tree.
  try {
    const src = path.join(wtCwd, "out", run);
    if (fs.existsSync(src)) {
      const dst = path.join(baseRunCwd, "out", run);
      ensureDir(dst);
      fs.cpSync(src, dst, { recursive: true, force: true });
      console.log(`worktree → copied out/${run} back to the main tree`);
    }
  } catch (e) { console.error(`worktree copy-back skipped: ${e.message}`); }
  if (ok && !keep) {
    try { git(baseRoot, "worktree", "remove", "--force", wtRoot); console.log(`worktree removed (branch pi/${run} kept for merge)`); }
    catch (e) { console.error(`worktree remove skipped: ${e.message}`); }
  } else {
    console.log(`worktree KEPT at ${wtRoot} (${ok ? "--keep-worktree" : "run not ok — inspect it"}); branch pi/${run}`);
  }
}

// OUTPUT CONTRACT (the "artifact contract") — the generic marker layer Claude Code leaves to the
// orchestrator. Native Claude gives a skill `description` (requirements), `## Inputs`/`## Output`
// prose (I/O), and a JSON `schema` (the RETURN shape, validated + retried) — but it verifies the
// returned MESSAGE, never the FILESYSTEM. A producing node may therefore DECLARE, in its prompt,
// the files it is REQUIRED to leave on disk (`DRIVER-ARTIFACTS`) and the only paths it may write
// (`DRIVER-OWNS`) — both space-separated absolute paths/globs, same marker convention as
// `DRIVER-PREFLIGHT`. The workflow author writes ONE `contract({...})` declaration that renders
// both the Definition-of-Done prose (for the model) AND these markers (for this driver). Unlike
// `outputArtifacts` (self-reported, honest only when the model is), the driver verifies the
// REQUIRED set itself — a clean exit that did NOT produce a required artifact is a contract BREACH,
// not an ok. Full spec: transform-workflow-to-pi/reference/artifact-contract.md.
function markerPaths(prompt, key) {
  const m = new RegExp(`(?:^|\\n)\\s*${key}:\\s*(.+?)\\s*(?:\\n|$)`).exec(prompt || "");
  if (!m) return null;
  const paths = m[1].split(/\s+/).filter(Boolean);
  return paths.length ? paths : null;
}
// Presence-only marker (no value), e.g. DRIVER-NO-ESCALATE — opts a node out of the escalation gate.
function hasMarker(prompt, key) {
  return new RegExp(`(?:^|\\n)\\s*${key}\\b`).test(prompt || "");
}
// Single-VALUE marker (the rest of the line as ONE token), e.g. DRIVER-SCHEMA / DRIVER-FILL-SENTINEL.
// markerPaths splits on whitespace (multi-path); this keeps the value whole (a schema PATH, a sentinel
// STRING). Returns null when absent. The value may itself contain no spaces (a path / a fence token).
function markerValue(prompt, key) {
  const m = new RegExp(`(?:^|\\n)\\s*${key}:\\s*(.+?)\\s*(?:\\n|$)`).exec(prompt || "");
  return m ? m[1] : null;
}

// POST-NODE SCHEMA GATE — a GENERIC, draft-2020-12-capable JSON-Schema validator the driver runs over a
// node's produced artifact after it exits (parallel to the DRIVER-ARTIFACTS existence gate). A node opts
// in by declaring a DRIVER-SCHEMA: <path> marker (the contract() `schema` field renders it); the driver
// validates EACH of that node's DRIVER-ARTIFACTS against the schema, and an invalid artifact is a contract
// BREACH (status=blocked) exactly like a missing one. This catches the class the existence gate cannot — a
// present-but-malformed artifact (a wrong type, a missing required key, an unfilled <FILL:> sentinel that
// still violates a type/enum) — PROGRAMMATICALLY, never relying on an LLM. draft-2020-12 because a modern
// schema using allOf/if-then/$defs/const is what ajv-cli's default draft-07 rejects (the live gap this closes).
//
// LEAN + GRACEFULLY-DEGRADING (engine law): run.mjs stays byte-identical across repos, so it CANNOT hard-
// depend on a bundled validator — a draft-2020-12 validator is an OPTIONAL per-repo dep (declare `ajv`
// [+`ajv-formats`] in pi-runner/package.json so it installs into pi-runner/node_modules; another repo may
// not). The loader is best-effort: it resolves a draft-2020-12 validator from the engine dir / RUN_CWD /
// ROOT node_modules and, if NONE resolves, returns null → the gate WARNS loudly and SKIPS (non-blocking),
// so a missing optional dep never bricks a run while a declared schema WITH a validator present is enforced
// hard. Memoized (resolved once per run). Returns a `compile(schemaObj) -> (data) => {ok, errors}` factory or null.
let _schemaValidatorFactory; // undefined = not tried; null = unavailable; fn = the factory
async function loadSchemaValidatorFactory() {
  if (_schemaValidatorFactory !== undefined) return _schemaValidatorFactory;
  const bases = [...new Set([HERE, RUN_CWD, ROOT])].map((d) => path.join(d, "__pi-runner-resolve-base.js"));
  const specs = ["ajv/dist/2020.js", "ajv/dist/2020", "ajv2020"]; // draft-2020-12 entry points
  for (const base of bases) {
    const req = createRequire(base);
    for (const spec of specs) {
      let resolved;
      try { resolved = req.resolve(spec); } catch { continue; }
      try {
        const m = await import(resolved);
        const Ajv2020 = m.Ajv2020 || m.default || m;
        if (typeof Ajv2020 !== "function") continue;
        let addFormats = null;
        try { addFormats = (await import(req.resolve("ajv-formats"))).default; } catch {}
        _schemaValidatorFactory = (schema) => {
          const ajv = new Ajv2020({ allErrors: true, strict: false });
          if (addFormats) try { addFormats(ajv); } catch {}
          const v = ajv.compile(schema);
          return (data) => ({ ok: !!v(data), errors: v.errors || [] });
        };
        return _schemaValidatorFactory;
      } catch { /* try the next spec/base */ }
    }
  }
  _schemaValidatorFactory = null;
  return null;
}
// Validate a node's DRIVER-ARTIFACTS against its DRIVER-SCHEMA. Returns { checked, invalid:[{path,errors}],
// skipped:<reason> } — `skipped` set (and invalid empty) when no schema is declared, no validator resolves,
// or the schema won't parse (a parse failure of the ARTIFACT is itself an invalid → breach; a parse failure
// of the SCHEMA is a config error → skip+warn, never a false breach). Resolves artifact + schema paths the
// same forgiving way the existence gate does (RUN_CWD/ROOT/PROJECT_BASE).
async function schemaCheck(prompt) {
  const schemaPath = markerValue(prompt, "DRIVER-SCHEMA");
  if (!schemaPath) return { checked: 0, invalid: [], skipped: null };
  const factory = await loadSchemaValidatorFactory();
  if (!factory) return { checked: 0, invalid: [], skipped: "no draft-2020-12 validator resolved (install ajv in pi-runner/ to enable the schema gate)" };
  const required = markerPaths(prompt, "DRIVER-ARTIFACTS");
  if (!required) return { checked: 0, invalid: [], skipped: "DRIVER-SCHEMA declared but no DRIVER-ARTIFACTS to validate" };
  // Resolve the schema file forgivingly (it is repo-relative like DRIVER-ARTIFACTS, or absolute).
  const schemaAbs = path.isAbsolute(schemaPath)
    ? schemaPath
    : [path.join(RUN_CWD, schemaPath), path.join(ROOT, schemaPath), ...(PROJECT_BASE ? [path.join(PROJECT_BASE, schemaPath)] : [])].find((c) => { try { return fs.statSync(c).size >= 0; } catch { return false; } }) || path.join(RUN_CWD, schemaPath);
  let validate;
  try { validate = factory(JSON.parse(fs.readFileSync(schemaAbs, "utf8"))); }
  catch (e) { return { checked: 0, invalid: [], skipped: `schema unreadable/uncompilable (${path.basename(schemaPath)}): ${e.message}` }; }
  const invalid = [];
  let checked = 0;
  for (const p of required) {
    const candidates = path.isAbsolute(p) ? [p]
      : [path.join(RUN_CWD, p), path.join(ROOT, p), ...(PROJECT_BASE ? [path.join(PROJECT_BASE, p)] : [])];
    const found = candidates.find((c) => { try { return fs.statSync(c).size > 0; } catch { return false; } });
    if (!found) continue; // a MISSING artifact is the existence gate's job, not the schema gate's
    checked++;
    let data;
    try { data = JSON.parse(fs.readFileSync(found, "utf8")); }
    catch (e) { invalid.push({ path: p, errors: [`not valid JSON: ${e.message}`] }); continue; }
    const r = validate(data);
    if (!r.ok) invalid.push({ path: p, errors: (r.errors || []).slice(0, 8).map((e) => `${e.instancePath || "/"} ${e.message}`) });
  }
  return { checked, invalid, skipped: null };
}
// Resolve a possibly-relative path to absolute the SAME forgiving way artifactState does, so the
// owned-path check and the existence check agree on where a file is.
function toAbsForgiving(p) {
  if (path.isAbsolute(p)) return p;
  for (const c of [path.join(RUN_CWD, p), path.join(ROOT, p)]) { try { fs.statSync(c); return c; } catch {} }
  return path.join(RUN_CWD, p);
}
// Is an absolute path inside one of the owned globs? Supports a trailing /* or /** (a directory the
// node owns) and exact files; everything else is treated as a file or a directory prefix.
function withinOwned(p, globs) {
  const ap = toAbsForgiving(p);
  return globs.some((g) => {
    if (/\/\*\*?$/.test(g)) { const base = g.replace(/\/\*\*?$/, ""); return ap === base || ap.startsWith(base + "/"); }
    return ap === g || ap.startsWith(g.replace(/\/$/, "") + "/");
  });
}

// pi has no schema-forced return, so each node ends with a fenced JSON block the driver parses;
// the driver ALSO stat()s the reported artifacts on disk (verified, not trusted).
function returnProtocol(label) {
  return [
    "",
    "RETURN PROTOCOL (pi runner) — after writing all your output files AND the _logs entry,",
    "END your final message with ONE fenced ```json block (and nothing after it) of EXACTLY:",
    "```json",
    JSON.stringify(
      { node: label, status: "ok | gap | blocked", outputArtifacts: ["<repo-relative paths you wrote>"], summary: "<1-2 sentences>", issues: [], pipelineFindings: [] },
      null, 2,
    ),
    "```",
    "The driver stat()s outputArtifacts on disk; status=ok REQUIRES them present.",
    "If this node's prompt carries a DRIVER-ARTIFACTS line, the driver ALSO verifies those EXACT files",
    "exist regardless of what you list — a missing one is a contract breach (status=blocked). Produce",
    "every one, or set status=blocked and say why; never exit clean having skipped a required artifact.",
  ].join("\n");
}

// A stage matches a --from/--until substring if it appears in the phase TITLE, any node LABEL, or
// any node ID (the slug a human reads off run-status.json — e.g. "w2-scaffold"). Matching the id too
// means you can copy a node id straight from the status digest into --from/--only and it just works.
function stageMatches(s, sel) {
  const u = sel.toLowerCase();
  return [s.phase, ...s.nodes.map((n) => n.label), ...s.nodes.map((n) => n.id)]
    .some((x) => (x || "").toLowerCase().includes(u));
}
// Resolve the inclusive [fromIdx, untilIdx] window over the FULL DAG. --from picks the FIRST matching
// stage (resume boundary); --until picks the LAST (truncation boundary), preserving the prior --until
// semantics exactly when --from is absent. Returns the selected slice + the skipped prefix (whose
// artifacts the resume preflight verifies). Node ids must already be assigned (matching uses them).
function selectStages(stages, until, from) {
  let fromIdx = 0, untilIdx = stages.length - 1;
  if (from && from.toLowerCase() !== "all") {
    const i = stages.findIndex((s) => stageMatches(s, from));
    if (i < 0) console.error(`--from "${from}" matched no phase/label/id — starting at the first stage`);
    else fromIdx = i;
  }
  if (until && until.toLowerCase() !== "all") {
    let i = -1;
    stages.forEach((s, j) => { if (stageMatches(s, until)) i = j; }); // LAST match (unchanged --until behavior)
    if (i < 0) console.error(`--until "${until}" matched no phase/label/id — running to the last stage`);
    else untilIdx = i;
  }
  if (fromIdx > untilIdx) { console.error(`--from "${from}" resolves AFTER --until "${until}" — ignoring --from`); fromIdx = 0; }
  return { fromIdx, untilIdx, selected: stages.slice(fromIdx, untilIdx + 1), skipped: stages.slice(0, fromIdx) };
}

const RUN_T0 = Date.now();
let stageT0 = 0;
const status = {
  run: args.run,
  lessonId: args.wfArgs.lessonId || null,
  until: args.until,
  from: args.from || null,
  source: path.relative(ROOT, WORKFLOW),
  provider: args.provider,
  model: model || null,
  escalate: ESCALATE ? { provider: ESCALATE_PROVIDER || args.provider, model: ESCALATE_MODEL, maxRetries: MAX_RETRIES } : false,
  contractExt: contractExtension ? path.basename(contractExtension) : false,
  sandbox: SANDBOX_OK,
  dryRun: args.dryRun,
  debug: DEBUG,
  startedAt: nowISO(),
  updatedAt: nowISO(),
  elapsedMs: 0,        // live wall-clock since start — answers "is a run going, and for how long?"
  done: false,
  ok: null,
  durationMs: null,    // final wall-clock at completion
  stage: null,         // { index, total, phase, nodes, startedAt, elapsedMs } while a stage runs
  totals: null,        // { nodes, toolCalls, tokensBillable } at completion
  nodes: {},
};
function writeStatus() {
  status.updatedAt = nowISO();
  status.elapsedMs = Date.now() - RUN_T0;
  if (status.stage) status.stage.elapsedMs = Date.now() - stageT0;
  ensureDir(path.dirname(statusPath));
  fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
}

function lastJsonBlock(text) {
  // Robustly recover the node's return object. Cheap models botch the ```json FENCE (drop the close,
  // omit the language tag, or emit the object bare) even when the JSON itself is valid — so a strict
  // fenced-only parse false-fails a node that actually did its work. Try, in order: a closed ```json
  // block, an UNCLOSED opening fence, then the last balanced {...} that parses AND looks like a node
  // return. A truly derailed node (no JSON at all) still returns null → caught as a degenerate run.
  if (!text) return null;
  const tryParse = (s) => { try { return JSON.parse(s.trim()); } catch { return null; } };
  // 1) Protocol form: the LAST closed ```json ... ``` block.
  const fenced = /```json\s*([\s\S]*?)```/g;
  let m, last = null;
  while ((m = fenced.exec(text))) last = m[1];
  if (last) { const o = tryParse(last); if (o) return o; }
  // 2) An opening ```json with no proper close — take everything after it, drop a dangling fence.
  const open = text.lastIndexOf("```json");
  if (open >= 0) { const o = tryParse(text.slice(open + 7).replace(/```\s*$/, "")); if (o) return o; }
  // 3) Bare/unfenced: the LAST balanced {...} object that parses and carries a node-return key.
  for (let end = text.lastIndexOf("}"); end >= 0; end = text.lastIndexOf("}", end - 1)) {
    let depth = 0, start = -1;
    for (let i = end; i >= 0; i--) {
      if (text[i] === "}") depth++;
      else if (text[i] === "{") { depth--; if (depth === 0) { start = i; break; } }
    }
    if (start < 0) break;
    const o = tryParse(text.slice(start, end + 1));
    if (o && typeof o === "object" && ("status" in o || "outputArtifacts" in o || "node" in o)) return o;
  }
  return null;
}

function piArgs(promptFileAbs, opts = {}) {
  // headless executor: print+json, trust project files, ephemeral, --offline (no startup network
  // ops; the model call still works), --no-extensions, --no-context-files. NOTE: models.json is CORE
  // pi config, not an extension, so --no-extensions does NOT disable it — pi still resolves the `cp`
  // provider + its credential from ~/.pi/agent/models.json. We only NAME the provider; --model when
  // pinned; -e only for an explicit custom-API/OAuth provider or the generic node-contract extension.
  // --no-context-files (-nc) is a HEADLESS INVARIANT: a pi node must run on ONLY the prompt the driver
  // hands it — pi must NOT auto-discover/inject a repo AGENTS.md/CLAUDE.md into the executor. Those
  // files address the ORCHESTRATOR (load-these-skills-first, run-policy directives); silently prepending
  // them to a per-node executor derails it (e.g. a Harden node told "load BOTH governing skills FIRST"
  // burns its turn meta-reasoning instead of writing the artifact). The exact realized prompt the driver
  // captured (extract.mjs) is the WHOLE contract; nothing else may leak in.
  // opts = { model, provider, toolsAllow, toolsDeny } — per-node overrides (escalation consult model,
  // tool gating) that ride ONE node without mutating module state.
  const prov = opts.provider || args.provider;
  const mdl = opts.model !== undefined ? opts.model : model;
  const a = ["-p", "--mode", "json", "-a", "--no-session", "--offline", "--no-extensions",
             "--no-context-files", "--provider", prov];
  if (mdl) a.push("--model", mdl);
  // Cap reasoning depth (off|minimal|low|medium|high|xhigh). pi defaults to "medium"; on the Anthropic
  // path this actually modulates the thinking budget (on the OpenAI path MiniMax ignores reasoning_effort).
  if (process.env.PI_RUNNER_THINKING) a.push("--thinking", process.env.PI_RUNNER_THINKING);
  if (opts.toolsAllow) a.push("--tools", opts.toolsAllow);       // DRIVER-TOOLS marker → per-node allowlist
  if (opts.toolsDeny) a.push("--exclude-tools", opts.toolsDeny); // DRIVER-EXCLUDE-TOOLS marker → per-node denylist
  if (contractExtension) a.push("-e", contractExtension);        // generic node-contract ext (submit_result + owns-block), opt-in
  if (extension) a.push("-e", extension);                        // explicit custom-provider ext (still loads under --no-extensions)
  a.push(`@${promptFileAbs}`);
  return a;
}

async function runNode(node, opts = {}) {
  const n = status.nodes[node.id];
  n.status = "running";
  n.startedAt = nowISO();
  n.modelUsed = (opts.model !== undefined ? opts.model : model) || "(default)";
  n.providerUsed = opts.provider || args.provider;
  const t0 = Date.now();
  writeStatus();

  // WORKTREE: rewrite the workflow's hardcoded absolute paths (under BASE_ROOT) to THIS run's
  // worktree, ONCE — so the agent writes INTO the worktree AND the driver's own marker checks
  // (DRIVER-PREFLIGHT / DRIVER-ARTIFACTS / DRIVER-OWNS, all parsed from node.prompt below) resolve
  // there too. wtRoot is a sibling dir that never contains BASE_ROOT as a substring, so this is
  // idempotent. No-op when not isolated.
  if (wtRoot && node.prompt.includes(BASE_ROOT)) node.prompt = node.prompt.split(BASE_ROOT).join(wtRoot);

  // DRIVER-side preflight short-circuit (see driverPreflightPaths): resolve a pure existence-check
  // node in plain code, no pi spawn.
  const pfPaths = driverPreflightPaths(node.prompt);
  if (pfPaths) {
    if (args.dryRun) {
      console.log(`    DRY: DRIVER-PREFLIGHT ${node.id} — would fs-check ${pfPaths.length} path(s), no pi spawn`);
      n.status = "dry"; n.endedAt = nowISO(); n.durationMs = Date.now() - t0; n.command = "driver-preflight (no pi)";
      writeStatus(); return n;
    }
    const checks = pfPaths.map(artifactStateAbs);
    const missing = checks.filter((c) => !c.exists).map((c) => c.path);
    n.status = missing.length ? "blocked" : "ok";
    n.artifacts = []; n.exitCode = 0; n.toolCalls = 0; n.toolBreakdown = {};
    n.driverPreflight = { checked: pfPaths.length, missing };
    n.summary = missing.length
      ? `DRIVER-PREFLIGHT blocked — missing: ${missing.join(", ")}`
      : `DRIVER-PREFLIGHT ok — ${pfPaths.length} upstream artifact(s) present (no pi spawn)`;
    n.issues = missing.length ? [`missing upstream: ${missing.join(", ")}`] : [];
    n.pipelineFindings = [];
    n.endedAt = nowISO(); n.durationMs = Date.now() - t0;
    writeStatus();
    const mark = n.status === "ok" ? "✓" : "✕";
    console.log(`    ${mark} ${node.label} → ${n.status}  (driver preflight, no pi) — ${n.summary}`);
    return n;
  }

  // DRIVER-SEED pre-stage (see driverSeed): deterministically stage this node's STARTING artifact
  // before pi spawns — e.g. copy the per-archetype blueprint template so HARDEN fills leaves via
  // `edit` rather than re-composing the structure. Copy ONLY when dest is absent/empty AND src exists.
  const seed = driverSeed(node.prompt);
  if (seed) {
    const toAbs = path.isAbsolute(seed.to) ? seed.to : path.resolve(RUN_CWD, seed.to);
    const fr = resolveSeedTokens(seed.from);
    const fromAbs = path.isAbsolute(fr) ? fr : path.resolve(RUN_CWD, fr);
    let destBytes = -1; try { destBytes = fs.statSync(toAbs).size; } catch {}
    if (destBytes > 0) {
      console.log(`    ⇪ DRIVER-SEED ${node.id} — dest present (${path.relative(RUN_CWD, toAbs)}); not re-staging`);
    } else if (!fs.existsSync(fromAbs)) {
      console.log(`    ⇪ DRIVER-SEED ${node.id} — no template at ${path.relative(RUN_CWD, fromAbs)} (node hand-builds)`);
    } else if (args.dryRun) {
      console.log(`    DRY: DRIVER-SEED ${node.id} — would stage ${path.relative(RUN_CWD, toAbs)} from ${path.relative(RUN_CWD, fromAbs)}`);
    } else {
      ensureDir(path.dirname(toAbs));
      fs.copyFileSync(fromAbs, toAbs);
      n.seeded = path.relative(BASE_RUN_CWD, toAbs);
      console.log(`    ⇪ DRIVER-SEED ${node.id} — staged ${path.relative(RUN_CWD, toAbs)} from ${path.relative(RUN_CWD, fromAbs)}`);
    }
  }

  ensureDir(promptDir);
  const promptFile = path.join(promptDir, `${node.id}.prompt.md`);
  // promptPrefix carries the escalation CONSULT preamble (the prior cheap attempt's failure evidence)
  // on a re-run; empty on attempt 0.
  fs.writeFileSync(promptFile, (opts.promptPrefix || "") + node.prompt + returnProtocol(node.label));
  // Per-node TOOL GATING (DRIVER-TOOLS / DRIVER-EXCLUDE-TOOLS markers): shrink the cheap model's
  // surface so a check node can't wander/write. Default (no marker) = full toolset, unchanged.
  const toolAllow = markerPaths(node.prompt, "DRIVER-TOOLS");
  const toolDeny = markerPaths(node.prompt, "DRIVER-EXCLUDE-TOOLS");
  const argv = piArgs(promptFile, {
    model: opts.model, provider: opts.provider,
    toolsAllow: toolAllow ? toolAllow.join(",") : null,
    toolsDeny: toolDeny ? toolDeny.join(",") : null,
  });
  // SANDBOX read-scope (opt-in): only a node that DECLARES its read scope (DRIVER-READ-SCOPE marker)
  // is wrapped in sandbox-exec; everything else spawns pi directly (byte-identical to before).
  const sandboxScope = SANDBOX_OK ? markerPaths(node.prompt, "DRIVER-READ-SCOPE") : null;
  // Hand the node's owned lane to the node-contract extension's in-loop block (PI_NODE_OWNS); only set
  // when the node declares DRIVER-OWNS and the extension is active. No-op otherwise.
  // ALSO hand the node's REQUIRED artifacts (DRIVER-ARTIFACTS) to the extension's write-first gate
  // (PI_NODE_REQUIRE): the extension BLOCKS submit_result while any required path is absent/empty on
  // disk, and re-prompts once on a turn ending with one still missing. Same marker the driver verifies
  // post-hoc (the contractMissing → blocked floor below stays the backstop), so ON or OFF is identical
  // when the feature is absent. Both are space-separated abs paths the contract() helper renders.
  const childEnv = process.env;
  const ownLane = markerPaths(node.prompt, "DRIVER-OWNS");
  const requireLane = markerPaths(node.prompt, "DRIVER-ARTIFACTS");
  // The template-fill SENTINEL the node-contract write-first gate refuses to submit_result over (e.g.
  // "<FILL:"). A node that pre-seeds a SCHEMA-SHAPED skeleton (DRIVER-SEED) is DONE only once every leaf
  // is replaced — a present-but-unfilled skeleton passes the existence gate yet is not a satisfied
  // contract. The fast in-loop sentinel is the COMPLEMENT of the post-node DRIVER-SCHEMA gate (a left
  // <FILL:> also breaks the schema's type/enum, caught post-hoc regardless); it gives the model immediate
  // feedback. Declared via DRIVER-FILL-SENTINEL; inert when absent (back-compat).
  const fillSentinel = markerValue(node.prompt, "DRIVER-FILL-SENTINEL");
  const spawnEnv = contractExtension
    ? { ...childEnv,
        ...(ownLane ? { PI_NODE_OWNS: ownLane.join(" ") } : {}),
        ...(requireLane ? { PI_NODE_REQUIRE: requireLane.join(" ") } : {}),
        ...(fillSentinel ? { PI_NODE_FILL_SENTINEL: fillSentinel } : {}) }
    : childEnv;
  console.log(`  ▶ ${node.label}  [${node.id}]`);

  if (args.dryRun) {
    if (sandboxScope) console.log(`    DRY: SANDBOX sandbox-exec -f <generated .sb> (read-scope: ${sandboxScope.length} declared allow-root(s) + toolchain)`);
    console.log(`    DRY: (cd ${RUN_CWD} && pi ${argv.join(" ")})`);
    console.log(`    prompt: ${promptFile} (${fs.statSync(promptFile).size} bytes)`);
    n.status = "dry";
    n.endedAt = nowISO();
    n.durationMs = Date.now() - t0;
    n.command = `pi ${argv.join(" ")}`;
    writeStatus();
    return n;
  }

  const eventsFile = path.join(promptDir, `${node.id}.events.jsonl`);
  const debugLog = path.join(promptDir, `${node.id}.debug.log`);
  return await new Promise((resolve) => {
    let assistantText = "", stderr = "", toolCalls = 0, eventCount = 0;
    let lastEventAt = Date.now(), lastWrite = 0, finished = false;
    // Distilled per-node telemetry — computed live from the stream, lands in the digest in BOTH
    // modes (cheap). These are the SIGNAL that the raw archive below buries in bulk.
    const toolBreakdown = {};                                       // toolName -> count
    let thinkingChars = 0, thinkingDeltas = 0, thinkFirstAt = 0, thinkLastAt = 0;
    let lastDelta = null, repeatRun = 0;                            // consecutive identical-delta run (stuck-loop guard)
    let submittedResult = null;                                     // structured return from the node-contract submit_result tool (if active)
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, billable: 0, contextPeak: 0, cost: 0 };
    // SINGLE FLIP (--debug) gates the FORENSIC artifacts: the event stream AND the timeline
    // debug.log. The stream is SLIMMED as written (message_update snapshots stripped below), so it
    // stays in the low MB instead of the 100s of MB pi's cumulative deltas would otherwise produce.
    // Production writes neither (the digest's aggregates above are its telemetry); re-run with --debug.
    const evStream = DEBUG ? fs.createWriteStream(eventsFile) : null;
    const dbgStream = DEBUG ? fs.createWriteStream(debugLog) : null;
    const dbg = (m) => { if (dbgStream) dbgStream.write(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}\n`); };
    n.live = { eventCount: 0, toolCalls: 0, lastEvent: "(starting pi)", sinceEventMs: 0, elapsedMs: 0, currentTool: null, textChars: 0, thinkingChars: 0, stalled: false };
    dbg(`spawn: pi ${argv.join(" ")}`);

    // SANDBOX wrap: when the node declared a read scope, run pi INSIDE sandbox-exec with a per-node
    // Seatbelt profile. Reads outside {toolchain ∪ declared scope} (e.g. another lesson, `grep … /`)
    // get "Operation not permitted" — kernel-enforced and inherited by pi's child grep/find/cat.
    let spawnCmd = "pi", spawnArgv = argv;
    if (sandboxScope) {
      const sbFile = buildSandboxProfile(node, sandboxScope);
      spawnCmd = "sandbox-exec"; spawnArgv = ["-f", sbFile, "pi", ...argv];
      n.sandbox = path.relative(BASE_RUN_CWD, sbFile);
      dbg(`sandbox: sandbox-exec -f ${sbFile} (read-scope: ${sandboxScope.length} declared root(s) + toolchain)`);
    }
    // stdin MUST be closed — a headless CLI with an open stdin pipe (no TTY) blocks forever
    // waiting for EOF (this caused a silent ~10-min startup hang).
    const child = spawn(spawnCmd, spawnArgv, { cwd: RUN_CWD, env: spawnEnv, stdio: ["ignore", "pipe", "pipe"] });

    // ONE place that kills the child (SIGTERM, then SIGKILL after a grace). All four watchdogs
    // (node-timeout, silent-stall, stuck-delta-loop, tool-thrash) route through it; the `killing`
    // latch makes a double-trip a no-op. Each caller sets its own n.killedX flag first (read in the
    // close handler to classify the failure).
    let killing = false;
    const killChild = (msg) => {
      if (killing || finished) return;
      killing = true;
      console.error(`    ✕ ${node.id} ${msg} — killing pi`);
      dbg(`kill: ${msg}`);
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000);
    };
    // tool-thrash: (toolName+args) signature -> count of no-progress repeats since the last write/edit.
    const toolSig = new Map();

    const refresh = (force) => {
      Object.assign(n.live, {
        eventCount, toolCalls, textChars: assistantText.length, thinkingChars,
        sinceEventMs: Date.now() - lastEventAt, elapsedMs: Date.now() - t0,
        stalled: Date.now() - lastEventAt > STALL_WARN_S * 1000,
      });
      const now = Date.now();
      if (force || now - lastWrite > 800) { lastWrite = now; writeStatus(); }
    };

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      eventCount++;
      lastEventAt = Date.now();
      let ev;
      try { ev = JSON.parse(line); } catch { if (evStream) evStream.write(line + "\n"); return; }
      const t = typeof ev.type === "string" ? ev.type : "";
      if (t) n.live.lastEvent = t;
      const ame = ev.assistantMessageEvent || ev.event || null;
      // Stuck-loop guard: count consecutive IDENTICAL non-trivial deltas across text+thinking. A
      // model looping on one token trips this; normal generation never repeats a ≥4-char delta 400×.
      const delta = ev.type === "message_update" && ame && typeof ame.delta === "string" ? ame.delta : null;
      if (delta && delta.length >= 4) { if (delta === lastDelta) repeatRun++; else { repeatRun = 1; lastDelta = delta; } }
      if (ev.type === "message_update" && ame && ame.type === "text_delta" && typeof ame.delta === "string") assistantText += ame.delta;
      else if (ev.type === "message_update" && ame && ame.type === "thinking_delta" && typeof ame.delta === "string") { thinkingChars += ame.delta.length; thinkingDeltas++; thinkLastAt = lastEventAt; if (!thinkFirstAt) thinkFirstAt = lastEventAt; }
      else if (typeof ev.delta === "string" && t.includes("text")) assistantText += ev.delta;
      // Per-call usage is final on message_end. input/output are PER CALL → summing them is the true
      // billable total (input re-sends context each turn, which is what you pay). totalTokens is a
      // CUMULATIVE context counter, not per-call → take its MAX (peak context footprint), never sum.
      // cost stays 0 for providers that don't price tokens.
      if (t === "message_end" && ev.message && ev.message.usage) {
        const u = ev.message.usage;
        tokens.input += u.input || 0; tokens.output += u.output || 0;
        tokens.cacheRead += u.cacheRead || 0; tokens.cacheWrite += u.cacheWrite || 0;
        tokens.billable = tokens.input + tokens.output;
        tokens.contextPeak = Math.max(tokens.contextPeak, u.totalTokens || 0);
        tokens.cost += (u.cost && u.cost.total) || 0;
      }
      if (t.startsWith("tool_execution_start")) {
        toolCalls++;
        const tn = ev.toolName || ev.tool || ev.name || (ev.toolCall && ev.toolCall.name) || "tool";
        toolBreakdown[tn] = (toolBreakdown[tn] || 0) + 1;
        n.live.currentTool = tn;
        dbg(`tool▶ ${tn}`);
        // No-progress tool-thrash guard: identical (name+args) repeated with no write/edit between.
        if (TOOL_REPEAT_KILL > 0 && !finished) {
          if (/^(write|edit|str_replace|apply_patch|multi_edit|create|submit_result)/i.test(tn)) {
            toolSig.clear();                                  // a write/edit/submit = progress → reset thrash counters
          } else {
            const sig = `${tn}:${JSON.stringify(ev.args || ev.toolInput || ev.input || {})}`;
            const c = (toolSig.get(sig) || 0) + 1; toolSig.set(sig, c);
            if (c >= TOOL_REPEAT_KILL && !n.killedToolLoop) {
              n.killedToolLoop = true; n.toolLoopSig = sig.slice(0, 120); n.toolLoopCount = c;
              killChild(`tool-thrash: ${tn} repeated ×${c} with no write (${sig.slice(0, 60)})`);
            }
          }
        }
      }
      else if (t.startsWith("tool_execution_end")) {
        // node-contract structured return: the typed submit_result tool's `details` ride this event.
        // Field shape varies by pi version — probe the documented spots; the --debug archive nails it.
        const tn = ev.toolName || ev.tool || ev.name || (ev.toolCall && ev.toolCall.name) || n.live.currentTool;
        const res = ev.result || ev.toolResult || ev.output || null;
        const det = (res && (res.details || res.detail)) || ev.details || null;
        if (tn === "submit_result" && det && typeof det === "object") submittedResult = det;
        dbg(`tool✓ ${n.live.currentTool || ""}`); n.live.currentTool = null;
      }
      else if (dbgStream && t) dbg(`ev ${t}`);
      // Archive write — SLIM message_update events: drop the cumulative `partial`/`message` snapshots
      // pi re-embeds on every delta. THAT redundancy is what makes a raw transcript 100s of MB; the
      // unique content is tiny and fully reconstructable from the kept `delta`s. Every other event
      // type (incl. message_end's `usage`) is written verbatim. Aggregates above already read the
      // full event, so slimming costs no information.
      if (evStream) {
        if (ev.type === "message_update") {
          if (ev.assistantMessageEvent) delete ev.assistantMessageEvent.partial;
          delete ev.message;
          evStream.write(JSON.stringify(ev) + "\n");
        } else {
          evStream.write(line + "\n");
        }
      }
      // Kill an obvious stuck-token loop early instead of letting it burn to the node-timeout.
      if (REPEAT_KILL > 0 && repeatRun >= REPEAT_KILL && !n.killedRepeat) {
        n.killedRepeat = true; n.repeatRun = repeatRun;
        killChild(`stuck-loop: same delta ×${repeatRun} (${JSON.stringify(lastDelta).slice(0, 40)})`);
      }
      refresh(false);
    });
    child.stderr.on("data", (d) => { stderr += d.toString(); dbg(`stderr: ${d.toString().trim().slice(0, 200)}`); });
    child.on("error", (err) => { stderr += `\n[spawn error] ${err.message}`; });

    const hb = setInterval(() => {
      if (finished) return;
      refresh(true);
      if (DEBUG) {
        // Console shows only ACTIONABLE signal: how long, what it's doing now, work/cost so far,
        // and liveness (Δ since last event + stall). Raw event count + event-type strings stay in
        // the polled `live` block, not the console — they are noise to a human watching.
        const el = (n.live.elapsedMs / 1000).toFixed(0), dl = (n.live.sinceEventMs / 1000).toFixed(0);
        const think = thinkingChars > 999 ? `${(thinkingChars / 1000).toFixed(1)}k` : `${thinkingChars}`;
        const tok = tokens.billable > 999 ? `${(tokens.billable / 1000).toFixed(1)}k` : `${tokens.billable}`;
        console.log(`    · ${node.id}  t=${el}s  cur=${n.live.currentTool || "-"}  think=${think} tok=${tok}  Δ=${dl}s${n.live.stalled ? "  ⚠ STALLED" : ""}`);
      }
      if (n.live.elapsedMs > NODE_TIMEOUT_S * 1000 && !n.killedTimeout) {
        n.killedTimeout = true;
        killChild(`exceeded --node-timeout ${NODE_TIMEOUT_S}s`);
      }
      // Silent-stall kill: no event for STALL_TIMEOUT_S WHILE no tool is in flight = a dead/stalled
      // model (a long silent bash keeps currentTool set, so it is exempt). Catches the silent-death
      // class in ~minutes instead of burning the full node-timeout.
      if (STALL_TIMEOUT_S > 0 && !n.live.currentTool && n.live.sinceEventMs > STALL_TIMEOUT_S * 1000 && !n.killedStall) {
        n.killedStall = true; n.stallMs = n.live.sinceEventMs;
        killChild(`silent-stall: no event for ${(n.live.sinceEventMs / 1000).toFixed(0)}s with no tool in flight`);
      }
    }, HEARTBEAT_MS);

    child.on("close", async (code) => {
      finished = true;
      clearInterval(hb);
      if (evStream) evStream.end();
      if (dbgStream) dbgStream.end();
      if (DEBUG) { n.eventsFile = path.relative(RUN_CWD, eventsFile); n.debugLog = path.relative(RUN_CWD, debugLog); }
      // Structured return FIRST (node-contract submit_result tool), else the forgiving fenced-JSON
      // parser. So enabling the extension is non-breaking: if the model didn't call the tool, we still
      // recover the return block exactly as before.
      const parsed = submittedResult || lastJsonBlock(assistantText);
      n.artifacts = ((parsed && parsed.outputArtifacts) || []).map(artifactState);
      // Suspect ONLY when the node DECLARED artifacts that are missing. A node that declares
      // none (a check/preflight/gate node legitimately writes nothing) is judged by its
      // self-reported status — forcing "blocked" on every zero-artifact node wrongly fails
      // legitimate gates (e.g. a mid-chain-resume preflight that only verifies upstream files).
      const declaredMissing = n.artifacts.length > 0 && !n.artifacts.every((a) => a.exists);
      // OUTPUT CONTRACT enforcement: verify the REQUIRED artifacts the node's prompt declared
      // (DRIVER-ARTIFACTS), independent of the self-report. This closes the false-OK hole the
      // no-return-block fix did NOT cover — a node that parses a clean return but produced an empty
      // or wrong artifact set (the W2c contamination class). A missing required artifact is a breach.
      const requiredPaths = markerPaths(node.prompt, "DRIVER-ARTIFACTS");
      let contractMissing = [];
      if (requiredPaths) {
        const reqChecks = requiredPaths.map(artifactStateAbs);
        n.requiredArtifacts = reqChecks;
        contractMissing = reqChecks.filter((c) => !c.exists).map((c) => c.path);
      }
      // POST-NODE SCHEMA GATE (generic, opt-in via DRIVER-SCHEMA — see schemaCheck): validate the PRESENT
      // required artifacts against the declared JSON-Schema (draft-2020-12). A present-but-INVALID artifact
      // (wrong type / missing required key / unfilled <FILL:> sentinel that breaks a type/enum) is a contract
      // BREACH — driver-verified, programmatic, NOT an LLM judgment — exactly like a missing artifact. Skips
      // (advisory) when no schema is declared, no validator is installed, or the schema won't compile.
      const schema = await schemaCheck(node.prompt);
      const schemaInvalid = schema.invalid.map((x) => x.path);
      if (schema.invalid.length) n.schemaInvalid = schema.invalid;
      if (schema.skipped) n.schemaSkipped = schema.skipped;
      else if (schema.checked) n.schemaChecked = schema.checked;
      // Persist the EMPIRICAL signals the escalation classifier reads (all already computed here).
      n.contractMissing = contractMissing;
      n.schemaInvalidPaths = schemaInvalid;
      n.parsedOk = !!parsed;
      // Soft owned-path containment on the SELF-REPORTED writes (the hard cross-contamination gate —
      // git diff ⊆ owns — arrives with per-stage commits; until then this catches a node that ADMITS
      // a write outside its lane).
      const ownedGlobs = markerPaths(node.prompt, "DRIVER-OWNS");
      let ownsBreach = [];
      if (ownedGlobs && n.artifacts.length) {
        ownsBreach = n.artifacts.filter((a) => !withinOwned(a.path, ownedGlobs)).map((a) => a.path);
        if (ownsBreach.length) n.ownsBreach = ownsBreach;
      }
      let st;
      if (n.killedTimeout || n.killedRepeat || n.killedStall || n.killedToolLoop || code !== 0) st = "error";
      else if (contractMissing.length) st = "blocked"; // CONTRACT: a required artifact is missing — driver-verified, beats any self-report
      else if (schemaInvalid.length) st = "blocked"; // CONTRACT: a required artifact is present but VIOLATES its declared schema — driver-verified breach, beats any self-report
      else if (parsed && parsed.status && parsed.status !== "ok") st = parsed.status; // gap/blocked self-report honored
      else if (declaredMissing && !(requiredPaths && requiredPaths.length)) st = "blocked"; // a missing/empty SELF-REPORTED file blocks ONLY a node with NO DRIVER-ARTIFACTS contract. When a contract WAS declared and is satisfied (contractMissing empty, above), it is the authority — a noisy self-report (a stripped path, or an intentionally size-0 file like .gitkeep) must NOT override it. "Verified, not trusted" cuts both ways: trust the driver-verified contract over the model's self-report.
      else if (!parsed) st = "error"; // clean exit but NO return-protocol block = degenerate run (agent derailed / its output was lost). Fail LOUDLY here — never silently pass it as ok. (A derailed W2c that wandered into another lesson's file + wrote nothing was slipping through as ok and only surfacing one node downstream when its consumer couldn't find the input.)
      else st = "ok";
      n.status = st;
      n.exitCode = code;
      n.toolCalls = toolCalls;
      n.toolBreakdown = toolBreakdown;
      n.thinking = { deltas: thinkingDeltas, chars: thinkingChars, spanMs: thinkFirstAt ? thinkLastAt - thinkFirstAt : 0 };
      n.tokens = tokens;
      n.eventCount = eventCount;
      n.summary = n.killedTimeout ? `killed: exceeded ${NODE_TIMEOUT_S}s node timeout`
        : n.killedStall ? `killed: silent-stall — no event for ${((n.stallMs || 0) / 1000).toFixed(0)}s with no tool in flight`
        : n.killedToolLoop ? `killed: tool-thrash — ${n.toolLoopSig} repeated ×${n.toolLoopCount} with no write`
        : n.killedRepeat ? `killed: stuck-loop — same delta repeated ≥${REPEAT_KILL}×`
        : (parsed && parsed.summary) || assistantText.trim().slice(-240) || "";
      n.issues = (parsed && parsed.issues) || [];
      n.pipelineFindings = (parsed && parsed.pipelineFindings) || [];
      if (!parsed) (n.issues = n.issues || []).push("no return JSON block parsed from pi output");
      if (contractMissing.length) (n.issues = n.issues || []).push(`contract breach — required artifact(s) missing: ${contractMissing.join(", ")}`);
      if (schema.invalid.length) (n.issues = n.issues || []).push(`contract breach — artifact(s) violate the declared schema: ${schema.invalid.map((x) => `${x.path} [${x.errors.join("; ")}]`).join(" | ")}`);
      if (schema.skipped) (n.issues = n.issues || []).push(`schema gate skipped — ${schema.skipped}`);
      if (ownsBreach.length) (n.issues = n.issues || []).push(`contract warn — reported writes outside owned paths: ${ownsBreach.join(", ")}`);
      if (declaredMissing && requiredPaths && requiredPaths.length) (n.issues = n.issues || []).push(`contract note — a self-reported artifact is empty/unresolved but the DRIVER-ARTIFACTS contract is satisfied (advisory, non-blocking)`);
      if (stderr.trim()) n.stderrTail = stderr.trim().slice(-500);
      n.endedAt = nowISO();
      n.durationMs = Date.now() - t0;
      delete n.live;
      writeStatus();
      const mark = st === "ok" ? "✓" : st === "error" || st === "blocked" ? "✕" : "•";
      const tokK = tokens.billable > 999 ? `${(tokens.billable / 1000).toFixed(1)}k` : `${tokens.billable}`;
      const thinkK = thinkingChars > 999 ? `${(thinkingChars / 1000).toFixed(1)}k` : `${thinkingChars}`;
      console.log(`    ${mark} ${node.label} → ${st}  (${(n.durationMs / 1000).toFixed(1)}s · tools=${toolCalls} · think=${thinkK} · tok=${tokK}) — ${(n.summary || "").split("\n")[0].slice(0, 100)}`);
      resolve(n);
    });
  });
}

// ESCALATION GATE (advisor inversion). ONE classifier over signals runNode already computes — all
// EMPIRICAL (artifact-contract breach, stuck loop, timeout, degenerate output), NEVER self-confidence.
// The artifact-contract breach is the centerpiece: we don't ask the model "are you sure", we stat()
// the files it was REQUIRED to produce. Spec: reference/escalation.md.
function classifyFailure(n) {
  if (n.driverPreflight) return "HALT";                                  // driver-side gate, no model ran
  const issueText = `${(n.issues || []).join(" ")} ${n.summary || ""}`;
  if ((n.status === "blocked" || n.status === "gap") && /upstream|missing input/i.test(issueText)) return "HALT"; // escalation can't manufacture a missing input
  if (n.contractMissing && n.contractMissing.length) return "ESCALATE"; // contract breach — ground-truth trigger
  if (n.schemaInvalidPaths && n.schemaInvalidPaths.length) return "ESCALATE"; // schema breach — ground-truth trigger (artifact present but malformed)
  if (n.killedRepeat) return "ESCALATE";                                 // stuck loop — a same-model retry just loops again (correlated blind spots)
  if (n.killedToolLoop) return "ESCALATE";                               // no-progress tool thrash — a same-model retry thrashes the same way
  if (n.killedStall) return "ESCALATE";                                  // model went silent/dead — a stronger model is the move, not a blind retry
  if (n.killedTimeout) return "ESCALATE";                                // over budget
  if (n.exitCode && n.exitCode !== 0 && /rate.?limit|ECONN|ETIMEDOUT|EAI_AGAIN|socket hang up|\b429\b|\b5\d\d\b|network/i.test(n.stderrTail || "")) return "RETRY_SAME"; // infra, not capability
  if (!n.parsedOk) return "DEGENERATE";                                  // no return block — retry once, then escalate
  return "ESCALATE";                                                     // any other capability failure
}
// The consult is NOT blind: prepend the cheap attempt's VERIFIED failure evidence (not a score).
function consultPreamble(n) {
  const cls = (n.contractMissing && n.contractMissing.length) ? "contract"
    : (n.schemaInvalidPaths && n.schemaInvalidPaths.length) ? "schema"
    : n.killedRepeat ? "loop" : n.killedToolLoop ? "tool-thrash" : n.killedStall ? "stall"
    : n.killedTimeout ? "timeout" : !n.parsedOk ? "degenerate" : "capability";
  const ev = [];
  if (n.contractMissing && n.contractMissing.length) ev.push(`missing required artifact(s): ${n.contractMissing.join(", ")}`);
  if (n.schemaInvalidPaths && n.schemaInvalidPaths.length) ev.push(`artifact(s) violate the declared schema: ${(n.schemaInvalid || []).map((x) => `${x.path} [${(x.errors || []).slice(0, 3).join("; ")}]`).join(" | ") || n.schemaInvalidPaths.join(", ")}`);
  if (n.killedRepeat) ev.push(`looped on a repeated token (~${n.repeatRun}× identical delta)`);
  if (n.killedToolLoop) ev.push(`thrashed on a repeated tool call (${n.toolLoopSig} ×${n.toolLoopCount}) without writing — find it via the catalog/digest, do NOT re-run the same search`);
  if (n.killedStall) ev.push(`went silent for ~${((n.stallMs || 0) / 1000).toFixed(0)}s with no tool running (model stalled)`);
  if (n.killedTimeout) ev.push(`exceeded the ${NODE_TIMEOUT_S}s node budget`);
  if (!n.parsedOk) ev.push("produced no parseable return-protocol block");
  if (n.stderrTail) ev.push(`stderr: ${n.stderrTail.slice(-160)}`);
  return [
    "CONSULT — a cheaper model attempted this node and FAILED; do not repeat its mistake.",
    `Failure class: ${cls}`,
    `Evidence: ${ev.join(" | ") || "(none captured)"}`,
    "Produce EVERY required artifact and end with the return-protocol JSON block.",
    "", "",
  ].join("\n");
}
// Wrapper the stage loop calls instead of runNode: attempt 0 on the cheap default; on a VERIFIED
// failure, a bounded same-model retry for transient infra noise, else ONE cross-family consult fed
// the failure evidence. Records n.attempts[] + n.escalated for observability (a wave that escalates
// every run is a SKILL flaw, not a model flaw → feed Hermes). No-op (returns attempt 0) unless
// PI_RUNNER_ESCALATE is on. Needs NO pi extension — it is a per-node --model/--provider override.
async function runNodeWithEscalation(node) {
  const snap = (x) => ({ model: x.modelUsed, provider: x.providerUsed, status: x.status, durationMs: x.durationMs, tokens: x.tokens });
  let n = await runNode(node);                                            // attempt 0 — cheap default
  if (!ESCALATE || args.dryRun) return n;
  const attempts = [snap(n)];
  let retriesLeft = MAX_RETRIES, escalatedYet = false;
  while (n.status === "error" || n.status === "blocked") {
    if (hasMarker(node.prompt, "DRIVER-NO-ESCALATE")) break;             // pure gates opt out
    const decision = classifyFailure(n);
    if (decision === "HALT") break;
    if ((decision === "RETRY_SAME" || decision === "DEGENERATE") && retriesLeft > 0) {
      retriesLeft--;
      console.log(`    ↻ ${node.id} ${decision} retry (${retriesLeft} left)`);
      n = await runNode(node);
    } else if (decision === "ESCALATE" && !escalatedYet && ESCALATE_MODEL) {
      escalatedYet = true;
      console.log(`    ⤴ ${node.id} ESCALATE → ${(ESCALATE_PROVIDER || args.provider)}/${ESCALATE_MODEL}`);
      n = await runNode(node, { model: ESCALATE_MODEL, provider: ESCALATE_PROVIDER || undefined, promptPrefix: consultPreamble(n) });
    } else break;
    attempts.push(snap(n));
  }
  n.attempts = attempts;
  n.escalated = escalatedYet;
  writeStatus();
  return n;
}

(async () => {
  if (!args.dryRun && args.provider === "cp") {
    // Credentials/model live in pi's OWN global config now — nothing per-product to require. Just
    // nudge if the one-time native setup is absent; pi itself errors loudly on a real auth miss.
    const piDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
    if (!fs.existsSync(path.join(piDir, "models.json")) && !fs.existsSync(path.join(piDir, "auth.json"))) {
      console.warn(`\n⚠ provider "cp" expects pi's native global config at ${piDir}/models.json (one-time, machine-global). See pi-runner/README.md.\n`);
    }
  }

  // THE SYNC: execute the workflow under recording stubs → exact prompts + DAG.
  const { stages: allStages } = await extractWorkflow(WORKFLOW, args.wfArgs);
  // Assign stable ids over the FULL DAG FIRST — so a node's id is identical with or without
  // --from/--until, --from/--until can match on id, and the preflight can name the skipped owners.
  let gidx = 0;
  for (const s of allStages) for (const node of s.nodes) node.id = slug(node.label, gidx++);
  const { fromIdx, untilIdx, selected: stages, skipped } = selectStages(allStages, args.until, args.from);

  // Register the skipped upstream as "reused" (honest digest — those nodes ran in a prior invocation
  // and their artifacts are reused this run), the selected window as "pending".
  for (const s of skipped) for (const node of s.nodes) status.nodes[node.id] = { id: node.id, label: node.label, phase: node.phase, status: "reused" };
  for (const s of stages)  for (const node of s.nodes) status.nodes[node.id] = { id: node.id, label: node.label, phase: node.phase, status: "pending" };

  const span = (fromIdx > 0 || untilIdx < allStages.length - 1) ? ` [stages ${fromIdx + 1}–${untilIdx + 1} of ${allStages.length}]` : "";
  console.log(`\npi-runner — run "${args.run}" — ${stages.flatMap((s) => s.nodes).length} nodes / ${stages.length} stages${span} from ${path.basename(WORKFLOW)} — ${args.dryRun ? "DRY-RUN" : `provider=${args.provider} model=${model}`}${DEBUG ? ` — DEBUG (heartbeat ${HEARTBEAT_MS / 1000}s · stall-warn>${STALL_WARN_S}s · stall-kill ${STALL_TIMEOUT_S || "off"}s · tool-repeat-kill ${TOOL_REPEAT_KILL || "off"} · node-timeout ${NODE_TIMEOUT_S}s)` : ""}`);
  console.log(`source-of-truth: ${WORKFLOW}`);
  console.log(`status → ${statusPath}\n`);
  writeStatus();

  // RESUME PREFLIGHT (soundness of --from): the skipped upstream nodes were NOT re-run, so their
  // on-disk artifacts MUST already exist or the resumed tail would run on stale/absent inputs. Verify
  // the skipped nodes' DRIVER-ARTIFACTS (the same contract the driver enforces after a node) in plain
  // code — no pi spawn — and HALT loudly on any miss. (Dry-run previews the slice but skips this gate:
  // no execution to protect, and the file may legitimately not exist yet.)
  if (fromIdx > 0 && !args.dryRun) {
    const need = [];
    for (const s of skipped) for (const node of s.nodes) {
      if (wtRoot && node.prompt.includes(BASE_ROOT)) node.prompt = node.prompt.split(BASE_ROOT).join(wtRoot);
      const req = markerPaths(node.prompt, "DRIVER-ARTIFACTS");
      if (req) for (const p of req) need.push({ node: node.id, ...artifactStateAbs(p) });
    }
    const missing = need.filter((c) => !c.exists);
    status.resumePreflight = { from: args.from, checked: need.length, missing: missing.map((m) => `${m.path} (${m.node})`) };
    if (missing.length) {
      console.error(`\n✕ cannot --from "${args.from}": ${missing.length} upstream artifact(s) the skipped nodes must have produced are missing —`);
      for (const m of missing) console.error(`    - ${m.path}  (owner: ${m.node})`);
      console.error(`  A resume never runs on absent inputs. Run from an earlier --from, or regenerate them.\n`);
      status.done = true; status.ok = false; status.durationMs = Date.now() - RUN_T0; writeStatus();
      process.exit(1);
    }
    console.log(`resume preflight ✓ — ${need.length} upstream artifact(s) from ${skipped.flatMap((s) => s.nodes).length} skipped node(s) present; reusing them\n`);
    writeStatus();
  }

  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    stageT0 = Date.now();
    const absIndex = fromIdx + i + 1; // 1-based position in the FULL DAG, so the digest stays honest under --from
    status.stage = { index: absIndex, total: allStages.length, phase: s.phase, nodes: s.nodes.map((x) => x.id), startedAt: nowISO(), elapsedMs: 0 };
    console.log(`[stage ${absIndex}/${allStages.length}] [${s.phase}] ${s.nodes.map((x) => x.id).join(" ∥ ")}`);
    const results = await Promise.all(s.nodes.map((node) => runNodeWithEscalation(node)));
    console.log(`  └ stage ${absIndex}/${allStages.length} done in ${((Date.now() - stageT0) / 1000).toFixed(1)}s  ·  run elapsed ${((Date.now() - RUN_T0) / 1000).toFixed(1)}s`);
    const bad = results.find((r) => r.status === "error" || r.status === "blocked");
    if (bad && !args.dryRun) {
      status.stage = null;
      status.done = true; status.ok = false; status.durationMs = Date.now() - RUN_T0; writeStatus();
      console.error(`\n✕ halted at ${bad.id} (${bad.status}) after ${((Date.now() - RUN_T0) / 1000).toFixed(1)}s. See ${statusPath}\n`);
      if (wtRoot) finishWorktree(wtRoot, args.run, BASE_ROOT, BASE_RUN_CWD, cwdRel, false, args.keepWorktree);
      process.exit(1);
    }
  }

  status.stage = null;
  status.done = true;
  status.ok = args.dryRun ? null : true;
  status.durationMs = Date.now() - RUN_T0;
  // Run-level rollup — cost/effort at a glance. Wall-clock total ≠ Σ(node durations): parallel
  // lanes overlap, so durationMs is true elapsed while tokens/tools sum the work done.
  const nodeVals = Object.values(status.nodes);
  status.totals = {
    nodes: nodeVals.length,
    toolCalls: nodeVals.reduce((a, x) => a + (x.toolCalls || 0), 0),
    tokensBillable: nodeVals.reduce((a, x) => a + ((x.tokens && x.tokens.billable) || 0), 0),
  };
  writeStatus();
  const totS = (status.durationMs / 1000).toFixed(1), totMin = (status.durationMs / 60000).toFixed(1);
  const totTokK = status.totals.tokensBillable > 999 ? `${(status.totals.tokensBillable / 1000).toFixed(1)}k` : `${status.totals.tokensBillable}`;
  console.log(`\n${args.dryRun ? "DRY-RUN complete" : "✓ complete"} — ${status.totals.nodes} nodes in ${totS}s (${totMin}m) · ${status.totals.toolCalls} tools · ${totTokK} tok · status: ${statusPath}\n`);
  if (wtRoot) finishWorktree(wtRoot, args.run, BASE_ROOT, BASE_RUN_CWD, cwdRel, status.ok === true, args.keepWorktree);
})();
