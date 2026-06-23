#!/usr/bin/env node
// pi-runner driver — runs a Claude Code Workflow by spawning one `pi` per node, on an efficient non-Claude
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

import { spawn, execFileSync, spawnSync } from "node:child_process";
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
// Stuck-loop guard: some non-Claude models get stuck emitting the SAME delta over and over. If one
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
// No-progress tool-thrash guard: a non-Claude model that can't find something re-runs the SAME read/grep/
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
// the worktree if active). Non-Claude models often self-report paths RELATIVE TO THIS dir (e.g. "src/x")
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
// in plain code — NO pi spawn — killing the non-Claude-model failure mode where a glorified `ls` grinds
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
// spawns (driver plumbing, never the model). Two classic cases: (a) copy the per-archetype blueprint
// FILE into spec/blueprint.json so HARDEN fills <FILL:…> leaves via `edit` instead of composing the
// whole structure; (b) copy a template DIRECTORY tree (the engine base / a module's src) into the
// project so a scaffold node only does the design-dependent merge/materialize, never the mechanical
// copy + tree-explore. A node may declare MULTIPLE DRIVER-SEED lines (each <dest> <= <src>); they are
// staged in the ORDER written, so a base copy can precede an overlay that wins on conflict. <src> may
// carry {jsonfile:field} tokens resolved from on-disk JSON (the archetype is frozen into
// spec/classification.json by W0, before any consumer) — and a token may be NESTED inside another
// (resolved inner→outer to a fixpoint), with the field a DOTTED PATH (incl. array indices, e.g.
// `genres.0.coreBase`). Each entry stages ONLY when its dest is absent/empty (file: missing/size 0;
// dir: missing or an empty readdir) AND the resolved src exists — idempotent (a resume never clobbers a
// filled artifact; a missing template falls through to the node's own hand-build). A directory src is
// copied RECURSIVELY (so an overlay merges over the base = "second wins"); a file src is copied as a
// file. Generic: any workflow opts a node in via the contract() `seed` field (object OR array). Returns
// an ARRAY of {to,from} (empty when the marker is absent).
function driverSeed(prompt) {
  // Per-line, multi-match. The trailing boundary is a LOOKAHEAD (?=\n|$), never a consumed \n — three
  // ADJACENT DRIVER-SEED lines must all match, and consuming the separator would eat the next line's
  // leading anchor and skip every other one. (^...$ with the m flag is the same idea, lookahead is explicit.)
  const re = /(?:^|\n)[ \t]*DRIVER-SEED:[ \t]*(\S+)[ \t]*<=[ \t]*(\S+)[ \t]*(?=\n|$)/g;
  const seeds = [];
  let m;
  while ((m = re.exec(prompt || ""))) seeds.push({ to: m[1], from: m[2] });
  return seeds;
}
function resolveSeedTokens(spec) {
  // {relpath.json:field} → the JSON at relpath (resolved vs RUN_CWD), drilled by `field` as a DOTTED
  // PATH (`a.b.0.c`, array indices allowed). Tokens NEST: an inner {…} is resolved first, so an outer
  // token's file/field may be COMPUTED (e.g. {templates/modules/{spec/classification.json:archetype}/
  // genre.json:genres.0.coreBase} → inner resolves the archetype, then the outer reads coreBase). We
  // iterate to a fixpoint over the INNERMOST tokens (those with no nested brace) so resolution is
  // archetype-agnostic — no literal ever appears here. Bounded passes guard against a cycle.
  const drill = (obj, dotted) => dotted.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
  const oneToken = /\{([^:{}]+):([^{}]+)\}/; // only INNERMOST tokens (no braces inside) match
  let out = spec;
  for (let pass = 0; pass < 8 && oneToken.test(out); pass++) {
    out = out.replace(new RegExp(oneToken, "g"), (whole, file, field) => {
      try {
        const abs = path.isAbsolute(file) ? file : path.resolve(RUN_CWD, file);
        const v = drill(JSON.parse(fs.readFileSync(abs, "utf8")), field.trim());
        return v == null ? whole : String(v);
      } catch { return whole; }
    });
  }
  return out;
}

// DRIVER-PROJECT: <source> => genre:<token> @ <mapRef> — the POST/DERIVE sibling of DRIVER-SEED. Where
// DRIVER-SEED PRE-STAGES a node's starting artifact before the model (copy a skeleton/tree to FILL), this
// DERIVES a node's mechanical outputs AFTER the model exits — outputs that are a fixed function of an
// already-frozen on-disk input (e.g. a frozen spec → its runtime data file / a config-merge / a derived
// manifest). Run in the driver, it makes that projection a TESTED CODE PATH instead of a per-run non-Claude-model
// gamble, removes the explore-forever/mis-project thrash surface, makes the output un-hallucinatable, and cuts
// tokens. It is the AUTHORITY for its outputs → it OVERWRITES them each run.
//
// 100% GENERIC — zero game-omni/voxel/blueprint vocabulary. The marker carries only { source, mapRef,
// genreToken }; the projection OPS are generic JSON transforms declared as DATA in the registry (the mapRef
// genre record's `projections`), so adding a game type needs ZERO engine edit. ABSENT marker ⇒ inert (every
// other repo/node unaffected). UNREADABLE map / missing record ⇒ warn + skip (degrade like the optional schema
// gate), never crash a run. Returns null when no marker; else { source, mapRef, genreToken } (token resolved).
function driverProject(prompt) {
  const m = /(?:^|\n)[ \t]*DRIVER-PROJECT:[ \t]*(\S+)[ \t]*=>[ \t]*genre:(\S+)[ \t]*@[ \t]*(\S+)[ \t]*(?=\n|$)/.exec(prompt || "");
  if (!m) return null;
  return { source: m[1], genreToken: resolveSeedTokens(m[2]), mapRef: m[3] };
}
// Conventional asset sub-dir by slot `type` (the generic asset-path convention W2's index.json uses — NOT
// game-specific: a sprite lives under sprites/, an image under images/, etc.). Used by the `union` op to fill
// a slot's conventional default `path` (the asset lane confirms/overwrites it later).
const ASSET_DIR_BY_TYPE = { sprite: "sprites", animation: "sprites", image: "images", tileset: "tiles", background: "backgrounds", audio: "audio", model: "models" };
const ASSET_EXT_BY_TYPE = { audio: "mp3", model: "glb" };
// Pretty-print JSON the way the existing artifacts are formatted (2-space indent + trailing newline) so a
// projected file is byte-identical to a hand/LLM-written one.
const projJson = (obj) => JSON.stringify(obj, null, 2) + "\n";
const drillPath = (obj, dotted) => String(dotted).split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
// Apply ONE generic projection op against the source JSON (`spec`), resolving the absolute target from the
// project-relative `to` the same way DRIVER-SEED resolves its dest (RUN_CWD/PROJECT_BASE-relative or absolute).
// Returns { to, op, wrote, skipped? } for the digest. Op kinds:
//   copy:  "<dotted.path>"                         → write spec drilled at the path to `to` (a pure subtree copy)
//   merge: { wrapInto, from, literals }            → START from the SEEDED target on disk, overwrite the
//                                                     `.value` of each spec[from] key that already has a home
//                                                     under target[wrapInto], set each literal (name→a dotted
//                                                     spec path, OR an ARRAY of paths = first-present-wins
//                                                     COALESCE, "" when all absent) at top level, KEEP template
//                                                     defaults, write back.
//   union: { union:[paths], row:{const}, schema? } → derive one slot row per id in the UNION of the named spec
//                                                     arrays (a bare name → each entry's `.slot`; `entities[].assetSlot`
//                                                     → each entity's assetSlot), each row built from that source
//                                                     entry's own fields + a conventional `path` + the const `row`
//                                                     fields; validate against `schema` (best-effort) and write.
//   assemble: { spread, fields }                   → the PARTIAL-projection op (the multi-source / non-1:1-copy case,
//                                                     e.g. a platformer LevelData assembled from layout + systems +
//                                                     effects + a config default). SPREAD the source object at the
//                                                     dotted `spread` path (its keys become the file's base), then set
//                                                     each `fields` entry: a STRING → a dotted spec path pulled verbatim;
//                                                     an OBJECT {from,default} → that path with a fallback when absent; a
//                                                     LITERAL {value:v} → the constant v; a STRING beginning "@entity:" →
//                                                     a NON-DETERMINISTIC transform the driver CANNOT resolve (the
//                                                     entity-binding weave), so the driver OMITS it AND deletes any
//                                                     same-named key the spread injected — leaving it genuinely ABSENT
//                                                     for the model to fill (the partial-bypass fallback). The result is
//                                                     the deterministic skeleton; the model weaves only the @entity:
//                                                     fields. GENERIC — no game vocabulary; the field map is registry DATA.
async function applyProjectionOp(name, opSpec, spec, projectBase) {
  const toRel = opSpec.to;
  const toAbs = path.isAbsolute(toRel) ? toRel : path.join(projectBase, toRel);
  ensureDir(path.dirname(toAbs));

  if (typeof opSpec.copy === "string") {
    const subtree = drillPath(spec, opSpec.copy);
    if (subtree === undefined) return { to: toRel, op: "copy", wrote: false, skipped: `source path "${opSpec.copy}" not found` };
    fs.writeFileSync(toAbs, projJson(subtree));
    return { to: toRel, op: "copy", wrote: true };
  }

  if (opSpec.assemble && typeof opSpec.assemble === "object") {
    const { spread, fields = {} } = opSpec.assemble;
    // POST-hook authority semantics: the driver is the authority for the DETERMINISTIC fields (it re-derives +
    // OVERWRITES them every run, defeating drift), while the @entity: WEAVE belongs to the MODEL — so we START
    // from the model's on-disk file (preserving its woven player/goal/rewards/threats/background), then
    // overwrite ONLY the deterministic fields. On a fresh run the model already built the whole file (skeleton
    // + weave) per the prompt fallback; here we re-assert the deterministic mass authoritatively on top. If the
    // file is somehow absent we start from the spread skeleton alone (a valid partial file the model/JOIN reads).
    let onDisk = {};
    try { onDisk = JSON.parse(fs.readFileSync(toAbs, "utf8")); } catch {}
    if (!onDisk || typeof onDisk !== "object" || Array.isArray(onDisk)) onDisk = {};
    // Spread source = the deterministic geometry block (e.g. layout). Its OWN keys may include some the model
    // weaves (layout.goal/rewards/threats are the BARE source form, not the runtime form) — those are listed as
    // @entity: fields below, so they are NEVER written from the spread; the model's woven version is preserved.
    const base = spread ? drillPath(spec, spread) : undefined;
    const det = {};                                                          // the deterministic fields the driver owns
    const entityKeys = new Set();                                            // the @entity: keys the model owns
    for (const [outKey, fieldSpec] of Object.entries(fields)) {
      if (typeof fieldSpec === "string" && fieldSpec.startsWith("@entity:")) { entityKeys.add(outKey); continue; }
      if (typeof fieldSpec === "string") {                                    // "<dotted.path>" → verbatim pull
        const v = drillPath(spec, fieldSpec);
        if (v !== undefined) det[outKey] = v;
      } else if (fieldSpec && typeof fieldSpec === "object" && "value" in fieldSpec) {
        det[outKey] = fieldSpec.value;                                        // {value:v} → a constant literal
      } else if (fieldSpec && typeof fieldSpec === "object" && "from" in fieldSpec) {
        const v = drillPath(spec, fieldSpec.from);                            // {from:"<path>", default:v} → pull w/ fallback
        if (v !== undefined) det[outKey] = v; else if ("default" in fieldSpec) det[outKey] = fieldSpec.default;
      }
    }
    // The deterministic geometry the spread contributes = its keys MINUS the model-owned @entity: keys.
    const spreadDet = {};
    if (base && typeof base === "object" && !Array.isArray(base)) for (const k of Object.keys(base)) if (!entityKeys.has(k)) spreadDet[k] = base[k];
    // Compose: START from the model's on-disk file (it sets the KEY ORDER and owns the @entity: WEAVE), then
    // OVERWRITE every deterministic field with the frozen value — object-spread updates an existing key IN PLACE
    // (preserving the model's ordering) and only APPENDS a deterministic key the model omitted. So the driver is
    // the AUTHORITY for the deterministic mass (a model that DRIFTS a spread/explicit field is corrected here),
    // the model is the authority for the @entity: fields, and the file's shape follows the model's intent.
    const out = { ...onDisk, ...spreadDet, ...det };
    fs.writeFileSync(toAbs, projJson(out));
    return { to: toRel, op: "assemble", wrote: true, ...(entityKeys.size ? { modelOwns: [...entityKeys] } : {}) };
  }

  if (opSpec.merge && typeof opSpec.merge === "object") {
    const { wrapInto, from, literals = {} } = opSpec.merge;
    // Start from the SEEDED target already on disk (the template-default file DRIVER-SEED staged); fall back to
    // an empty object only if it is somehow absent (then the projection still produces a valid merged file).
    let target = {};
    try { target = JSON.parse(fs.readFileSync(toAbs, "utf8")); } catch {}
    const group = (target[wrapInto] && typeof target[wrapInto] === "object") ? target[wrapInto] : (target[wrapInto] = {});
    const src = (spec[from] && typeof spec[from] === "object") ? spec[from] : {};
    // Overwrite the .value of each src key that ALREADY has a home in the template group (so a key the
    // template doesn't house under wrapInto — e.g. one that lives in another group — is left to its own
    // template default, never dropped here). KEEPS the template's type/description.
    for (const k of Object.keys(src)) {
      if (group[k] && typeof group[k] === "object" && "value" in group[k]) group[k].value = src[k];
    }
    // Set each literal at the TOP level from a dotted spec path; absent → "" (matches the known-good, e.g. an
    // open-ended game with no winCondition.description renders objective:"").  COALESCE form (additive,
    // generic): a literal value may be an ARRAY of dotted paths — the FIRST present (non-undefined) wins, the
    // rest fall back; all absent → "". This is the source-of-truth-with-fallback case (e.g. objective sources
    // meta.objective for a creative-objective build target, falling back to winCondition.description for a
    // win-lose game). A plain string is unchanged.
    for (const [key, spec_path] of Object.entries(literals)) {
      const paths = Array.isArray(spec_path) ? spec_path : [spec_path];
      let v;
      for (const p of paths) { const got = drillPath(spec, p); if (got !== undefined) { v = got; break; } }
      target[key] = v === undefined ? "" : v;
    }
    fs.writeFileSync(toAbs, projJson(target));
    return { to: toRel, op: "merge", wrote: true };
  }

  if (Array.isArray(opSpec.union)) {
    const constRow = opSpec.row || {};
    const rows = [];
    const seen = new Set();
    for (const ref of opSpec.union) {
      const mEnt = /^(.+?)\[\]\.(.+)$/.exec(ref); // "entities[].assetSlot" → collect each entity's assetSlot
      if (mEnt) {
        const arr = drillPath(spec, mEnt[1]);
        if (Array.isArray(arr)) for (const ent of arr) {
          const slot = ent && ent[mEnt[2]];
          if (!slot || seen.has(slot)) continue;
          seen.add(slot);
          const type = ent.type || "sprite";
          rows.push({ slot, type, path: assetDefaultPath(slot, type), width: ent.width || 32, height: ent.height || 32, ...(ent.description ? { description: ent.description } : {}), ...constRow });
        }
      } else {
        const arr = drillPath(spec, ref);
        if (Array.isArray(arr)) for (const e of arr) {
          const slot = e && e.slot;
          if (!slot || seen.has(slot)) continue;
          seen.add(slot);
          const type = e.type || "sprite";
          const r = { slot, type, path: assetDefaultPath(slot, type), width: e.width || 32, height: e.height || 32 };
          if (typeof e.depth === "number") r.depth = e.depth; // 3D model slot: carry the Z extent for the runtime fit-to-box
          if (Array.isArray(e.frames)) r.frames = e.frames;
          if (Array.isArray(e.entityIds)) r.entityIds = e.entityIds;
          if (e.description) r.description = e.description;
          rows.push({ ...r, ...constRow });
        }
      }
    }
    const out = { archetype: drillPath(spec, "meta.archetype"), assetsDir: "public/assets", slots: rows };
    // Best-effort schema validation (degrades like the engine's own schema gate): a present validator + a
    // declared schema HARD-fail an invalid projection (the guardrail); a missing validator warns + writes.
    if (opSpec.schema) {
      const factory = await loadSchemaValidatorFactory();
      if (factory) {
        const schemaAbs = path.isAbsolute(opSpec.schema)
          ? opSpec.schema
          : [path.join(RUN_CWD, opSpec.schema), path.join(ROOT, opSpec.schema)].find((c) => { try { return fs.statSync(c).size > 0; } catch { return false; } }) || path.join(RUN_CWD, opSpec.schema);
        try {
          const validate = factory(JSON.parse(fs.readFileSync(schemaAbs, "utf8")));
          const r = validate(out);
          if (!r.ok) return { to: toRel, op: "union", wrote: false, skipped: `projected slots violate ${path.basename(opSpec.schema)}: ${(r.errors || []).slice(0, 4).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ")}` };
        } catch (e) { console.warn(`    ⚠ DRIVER-PROJECT union: schema "${opSpec.schema}" unreadable/uncompilable — writing without validation (${e.message})`); }
      } else {
        console.warn(`    ⚠ DRIVER-PROJECT union: no draft-2020-12 validator resolved — writing ${toRel} WITHOUT schema validation`);
      }
    }
    fs.writeFileSync(toAbs, projJson(out));
    return { to: toRel, op: "union", wrote: true, rows: rows.length };
  }

  return { to: toRel, op: "unknown", wrote: false, skipped: `no recognized op (copy|merge|union) for "${name}"` };
}
function assetDefaultPath(slot, type) {
  const dir = ASSET_DIR_BY_TYPE[type] || "sprites";
  const ext = ASSET_EXT_BY_TYPE[type] || "png";
  return `${dir}/${slot}.${ext}`;
}
// Run a node's DRIVER-PROJECT map (POST-node, the authority for its outputs). Resolves the genre record in the
// mapRef by id===genreToken, reads its `projections` object, and applies each op. Returns a summary the digest
// records ({ map, genre, ops:[...] }); a null marker / unreadable map / missing record returns null|skip so a
// run is never crashed by it (graceful degrade — the engine law).
async function runProjection(proj, projectBase) {
  if (!proj) return null;
  const mapAbs = path.isAbsolute(proj.mapRef)
    ? proj.mapRef
    : [path.join(RUN_CWD, proj.mapRef), path.join(ROOT, proj.mapRef)].find((c) => { try { return fs.statSync(c).size > 0; } catch { return false; } });
  if (!mapAbs) { console.warn(`    ⚠ DRIVER-PROJECT — mapRef "${proj.mapRef}" not found; skipping projection`); return { skipped: `mapRef not found: ${proj.mapRef}` }; }
  let map;
  try { map = JSON.parse(fs.readFileSync(mapAbs, "utf8")); }
  catch (e) { console.warn(`    ⚠ DRIVER-PROJECT — mapRef "${proj.mapRef}" unreadable (${e.message}); skipping`); return { skipped: `mapRef unreadable: ${e.message}` }; }
  const record = (map.genres || []).find((g) => g.id === proj.genreToken);
  if (!record) { console.warn(`    ⚠ DRIVER-PROJECT — no genre record "${proj.genreToken}" in ${proj.mapRef}; skipping`); return { skipped: `no genre record: ${proj.genreToken}` }; }
  const projections = record.projections;
  if (!projections || typeof projections !== "object") return { genre: proj.genreToken, ops: [], note: "no projections declared for this genre (inert)" };
  // Read the source JSON ONCE (the frozen spec the projection derives from).
  const srcAbs = path.isAbsolute(proj.source) ? proj.source
    : [path.join(projectBase, proj.source), path.join(RUN_CWD, proj.source), path.join(ROOT, proj.source)].find((c) => { try { return fs.statSync(c).size > 0; } catch { return false; } });
  let spec;
  try { spec = JSON.parse(fs.readFileSync(srcAbs, "utf8")); }
  catch (e) { console.warn(`    ⚠ DRIVER-PROJECT — source "${proj.source}" unreadable (${e.message}); skipping`); return { skipped: `source unreadable: ${e.message}` }; }
  const ops = [];
  for (const [name, opSpec] of Object.entries(projections)) {
    try { ops.push(await applyProjectionOp(name, opSpec, spec, projectBase)); }
    catch (e) { ops.push({ to: opSpec && opSpec.to, op: name, wrote: false, skipped: `error: ${e.message}` }); console.warn(`    ⚠ DRIVER-PROJECT op "${name}" errored: ${e.message}`); }
  }
  return { genre: proj.genreToken, map: proj.mapRef, ops };
}

// DRIVER-MERGE — a SECOND post-node DERIVE family (sibling of DRIVER-PROJECT), for the deterministic
// FILESYSTEM merges that are NOT a per-archetype projection of one frozen spec but the SAME mechanical
// reconcile for EVERY archetype: concatenate per-node fragments into one canonical file, and reconcile
// one JSON's per-key fields onto another's matching rows. It lifts a whole would-be LLM merge node into a
// TESTED CODE PATH. 100% GENERIC — zero game-omni/voxel/blueprint vocabulary; the SPEC is DATA declared in
// the workflow's contract() (a `merge:{ ops:[...] }` field), rendered as ONE base64-encoded DRIVER-MERGE
// marker (the ops carry arbitrary headings/globs/field lists, so a whitespace-tolerant single line keeps the
// marker parser trivial and collision-free). ABSENT marker ⇒ inert; a missing INPUT file degrades GRACEFULLY
// (the same skip/partial the old LLM merge had — e.g. an absent manifest still lets the concat run).
//
// THREE generic ops:
//   concat:    { glob, to, heading }   — concat every file matching `glob` (project-relative) into `to`, each
//                                         under a formatted `heading` (a template with {name}=basename, {path}=
//                                         project-relative path), in STABLE lexical-by-path order; idempotent
//                                         (overwrites `to`). A missing/empty source set writes nothing-but-still
//                                         a (possibly empty) file is avoided — 0 files ⇒ skip (record count).
//   reconcile: { from, to, key, fields, schema? } — project `from`'s per-key entries' `fields` onto `to`'s
//                                         matching-key ROWS (mutating ONLY those fields of EXISTING rows;
//                                         keys/order/count untouched), then optional best-effort schema
//                                         re-validate (degrade like the projection schema gate). `from` is the
//                                         source JSON whose `.<key-collection>` is an object keyed by id;
//                                         `to` is the JSON whose `.slots` (or the array under `arrayAt`) holds
//                                         the rows keyed by row[key]. A field copies ALWAYS, or CONDITIONALLY
//                                         when listed as { name, when:{field,equals} } (e.g. path/width/height
//                                         only when status=="generated").
//   fold:      { from, to, into }      — SET to[into] = the parsed JSON object at `from` (a section fragment),
//                                         then write `to`. SYNCHRONOUS read-modify-write (no await) → two parallel
//                                         lanes folding DISTINCT keys (v1.6 chrome: shell vs guidance) cannot lose
//                                         an update. Graceful: an absent/unreadable fragment skips the fold.
function driverMerge(prompt) {
  // base64 line (the contract() encodes the ops object so headings/globs with spaces ride one marker line).
  const m = /(?:^|\n)[ \t]*DRIVER-MERGE:[ \t]*([A-Za-z0-9+/=]+)[ \t]*(?=\n|$)/.exec(prompt || "");
  if (!m) return null;
  try { return JSON.parse(Buffer.from(m[1], "base64").toString("utf8")); }
  catch (e) { console.warn(`    ⚠ DRIVER-MERGE — marker payload unreadable (${e.message}); skipping`); return null; }
}
function mergeResolveAbs(rel, projectBase) {
  if (path.isAbsolute(rel)) return rel;
  return [path.join(projectBase, rel), path.join(RUN_CWD, rel), path.join(ROOT, rel)].find((c) => { try { return fs.statSync(c).size >= 0; } catch { return false; } }) || path.join(projectBase, rel);
}
async function applyMergeOp(opSpec, projectBase) {
  // ---- concat: glob → to, each under a heading, stable lexical-by-path, idempotent overwrite ----
  if (opSpec.concat && typeof opSpec.concat === "object") {
    const { glob, to, heading = "## {name}" } = opSpec.concat;
    const toAbs = path.isAbsolute(to) ? to : path.join(projectBase, to);
    // Resolve the glob in the SAME dir family as `to` (a single dir + a filename pattern — no deep walk
    // needed; the fragments live beside the canonical file). Support a leading dir and a `*` wildcard.
    const dir = path.dirname(glob);
    const pat = path.basename(glob);
    const reSrc = "^" + pat.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$";
    const re = new RegExp(reSrc);
    const dirAbs = path.isAbsolute(dir) ? dir : path.join(projectBase, dir);
    let names = [];
    try { names = fs.readdirSync(dirAbs); } catch {}
    // STABLE lexical-by-path order; EXCLUDE the destination itself (never fold MEMORY.md into MEMORY.md).
    const toBase = path.basename(toAbs);
    const matched = names.filter((n) => re.test(n) && n !== toBase).sort();
    if (!matched.length) return { op: "concat", to, wrote: false, skipped: `no files match ${glob}`, merged: 0 };
    const parts = [];
    for (const n of matched) {
      const relPath = path.join(dir, n).replace(/^\.\//, "");
      let body = "";
      try { body = fs.readFileSync(path.join(dirAbs, n), "utf8"); } catch { continue; }
      const head = heading.replaceAll("{name}", n).replaceAll("{path}", relPath);
      parts.push(`${head}\n\n${body.replace(/\s+$/, "")}`);
    }
    ensureDir(path.dirname(toAbs));
    fs.writeFileSync(toAbs, parts.join("\n\n") + "\n");
    return { op: "concat", to, wrote: true, merged: matched.length };
  }

  // ---- reconcile: from.<keys> → to.slots[].<fields> on matching key; keys/order untouched ----
  if (opSpec.reconcile && typeof opSpec.reconcile === "object") {
    const { from, to, key = "slot", fields = [], arrayAt = "slots", fromAt = "slots", schema } = opSpec.reconcile;
    const toAbs = path.isAbsolute(to) ? to : path.join(projectBase, to);
    let toJson;
    try { toJson = JSON.parse(fs.readFileSync(toAbs, "utf8")); }
    catch (e) { return { op: "reconcile", to, wrote: false, skipped: `target unreadable: ${e.message}` }; }
    const fromAbs = mergeResolveAbs(from, projectBase);
    let fromMap = null;
    try { fromMap = drillPath(JSON.parse(fs.readFileSync(fromAbs, "utf8")), fromAt); }
    catch (e) { /* graceful: a missing/absent source ⇒ no reconcile, target left as-is (the LLM JOIN's partial) */
      return { op: "reconcile", to, wrote: false, skipped: `source unreadable: ${e.message} (target left unchanged)` }; }
    if (!fromMap || typeof fromMap !== "object") return { op: "reconcile", to, wrote: false, skipped: `source "${from}" has no .${fromAt} object` };
    const rows = drillPath(toJson, arrayAt);
    if (!Array.isArray(rows)) return { op: "reconcile", to, wrote: false, skipped: `target has no .${arrayAt} array` };
    let reconciled = 0;
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const id = row[key];
      const src = id != null ? fromMap[id] : undefined;
      if (!src || typeof src !== "object") continue; // a row with no source entry keeps its existing fields
      let touched = false;
      for (const f of fields) {
        const name = typeof f === "string" ? f : f.name;
        if (!name) continue;
        if (typeof f === "object" && f.when) {
          // conditional copy: only when the SOURCE's gating field equals the expected value (e.g. status=="generated")
          if (src[f.when.field] !== f.when.equals) continue;
        }
        if (name in src) { row[name] = src[name]; touched = true; }
      }
      if (touched) reconciled++;
    }
    // optional best-effort schema re-validate (degrade like the projection schema gate — never crash a run)
    if (schema) {
      const factory = await loadSchemaValidatorFactory();
      if (factory) {
        const schemaAbs = path.isAbsolute(schema) ? schema
          : [path.join(RUN_CWD, schema), path.join(ROOT, schema)].find((c) => { try { return fs.statSync(c).size > 0; } catch { return false; } }) || path.join(RUN_CWD, schema);
        try {
          const validate = factory(JSON.parse(fs.readFileSync(schemaAbs, "utf8")));
          const r = validate(toJson);
          if (!r.ok) return { op: "reconcile", to, wrote: false, skipped: `reconciled ${to} violates ${path.basename(schema)}: ${(r.errors || []).slice(0, 4).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ")}` };
        } catch (e) { console.warn(`    ⚠ DRIVER-MERGE reconcile: schema "${schema}" unreadable/uncompilable — writing without validation (${e.message})`); }
      } else {
        console.warn(`    ⚠ DRIVER-MERGE reconcile: no draft-2020-12 validator resolved — writing ${to} WITHOUT schema validation`);
      }
    }
    fs.writeFileSync(toAbs, projJson(toJson));
    return { op: "reconcile", to, wrote: true, reconciled };
  }

  // ---- fold: a fragment JSON object → to.<into> (a section-fold/union; v1.6 chrome — contracts-v1.md Contract 5).
  // SET to[into] = the parsed fragment, then write `to`. The read-modify-write is FULLY SYNCHRONOUS (no await), so
  // when two parallel chrome lanes' fold post-hooks fire back-to-back on the Node event loop, each runs atomically
  // and they touch DISTINCT keys (e.g. shell vs guidance) → no lost update. Graceful: a missing/unreadable fragment
  // skips the fold (the section stays absent; the build tier Array.isArray-guards an absent chrome section). ----
  if (opSpec.fold && typeof opSpec.fold === "object") {
    const { from, to, into } = opSpec.fold;
    if (!from || !to || !into) return { op: "fold", to, wrote: false, skipped: "fold needs { from, to, into }" };
    const toAbs = path.isAbsolute(to) ? to : path.join(projectBase, to);
    let toJson;
    try { toJson = JSON.parse(fs.readFileSync(toAbs, "utf8")); }
    catch (e) { return { op: "fold", to, wrote: false, skipped: `target unreadable: ${e.message}` }; }
    const fromAbs = mergeResolveAbs(from, projectBase);
    let frag;
    try { frag = JSON.parse(fs.readFileSync(fromAbs, "utf8")); }
    catch (e) { /* graceful: an absent/unreadable fragment ⇒ no fold, target left unchanged */
      return { op: "fold", to, wrote: false, skipped: `fragment "${from}" unreadable: ${e.message} (target left unchanged)` }; }
    toJson[into] = frag;
    fs.writeFileSync(toAbs, projJson(toJson));
    return { op: "fold", to, wrote: true, into };
  }

  // ---- run: execute a declared command — a deterministic GENERATION/derive step that does NOT deserve an LLM
  // node (the node authors the INPUT, the driver RUNS the tool). This is the realization of the MECHANICAL→
  // DRIVER-HOOK law for an EXEC step (e.g. the asset image generator): a programmatic tool invocation is a
  // tested code path here, not a per-run non-Claude-model bash gamble. Tokens {project}/{root} in `cmd`/`args[]`/`cwd`
  // are substituted with the resolved projectBase / ROOT (absolute) — so a repo-rooted tool ({root}/…, where the
  // venv/tooling lives, NOT the worktree) reads/writes the run's project tree ({project}/…) worktree-safely. cwd
  // defaults to ROOT. A non-zero exit returns { failed:true, exit } (runMerge records it + warns); the node is
  // HARD-FAILED via its DRIVER-ARTIFACTS gate — declare the tool's required OUTPUT (e.g. its manifest) as a
  // required artifact, so a failed/absent generation is a contract breach (status=blocked). That is the
  // "real generation mandatory, no placeholder floor" rule enforced by the EXISTING gate, never a model branch.
  if (opSpec.run && typeof opSpec.run === "object") {
    const { cmd, args = [], cwd, note } = opSpec.run;
    if (!cmd) return { op: "run", wrote: false, skipped: "run needs { cmd }" };
    const sub = (s) => typeof s === "string" ? s.replace(/\{project\}/g, projectBase).replace(/\{root\}/g, ROOT) : s;
    // A BARE command (no path separator) — `node` (run with the driver's OWN interpreter, robust to a
    // PATH/nvm mismatch in the spawned env), `python3`, etc. — resolves via process/PATH, NOT joined to
    // ROOT (joining produced <ROOT>/node → ENOENT, which silently no-op'd a bare-cmd run op like an
    // event-wiring gate). Only a path CONTAINING a separator is a repo-relative file and keeps the ROOT join.
    const subCmd = sub(cmd);
    const cmdAbs = path.isAbsolute(subCmd) ? subCmd
      : subCmd === "node" ? process.execPath
      : !/[\\/]/.test(subCmd) ? subCmd
      : path.join(ROOT, subCmd);
    const argv = (Array.isArray(args) ? args : []).map(sub);
    const runCwd = cwd ? (path.isAbsolute(sub(cwd)) ? sub(cwd) : path.join(ROOT, sub(cwd))) : ROOT;
    const res = spawnSync(cmdAbs, argv, { cwd: runCwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    const out = (res.stdout || "").toString().trim().split("\n").slice(-3).join(" | ");
    const err = (res.stderr || "").toString().trim().split("\n").slice(-3).join(" | ");
    if (res.error) { console.warn(`    ⚠ DRIVER-MERGE run: spawn error (${res.error.message})`); return { op: "run", wrote: false, failed: true, skipped: `spawn error: ${res.error.message}`, cmd: path.relative(ROOT, cmdAbs) }; }
    if (res.status !== 0) { console.warn(`    ⚠ DRIVER-MERGE run: ${path.basename(cmdAbs)} exited ${res.status} — ${err || out}`); return { op: "run", wrote: false, failed: true, exit: res.status, stderr: err.slice(0, 400), cmd: path.relative(ROOT, cmdAbs) }; }
    return { op: "run", wrote: true, exit: 0, cmd: path.relative(ROOT, cmdAbs), stdout: out.slice(0, 200), note: note || undefined };
  }

  return { op: "unknown", wrote: false, skipped: "no recognized op (concat|reconcile|fold|run)" };
}
// Run a node's DRIVER-MERGE ops (POST-node, the AUTHORITY for its merged outputs — it OVERWRITES each run).
// Each op degrades gracefully (a missing input ⇒ skip that op, others still run). Returns { ops:[...] }; a
// null marker returns null. Generic: any workflow opts a node in via the contract() `merge` field.
async function runMerge(spec, projectBase) {
  if (!spec || !Array.isArray(spec.ops)) return null;
  const ops = [];
  for (const opSpec of spec.ops) {
    try { ops.push(await applyMergeOp(opSpec, projectBase)); }
    catch (e) { ops.push({ op: Object.keys(opSpec || {})[0] || "?", wrote: false, skipped: `error: ${e.message}` }); console.warn(`    ⚠ DRIVER-MERGE op errored: ${e.message}`); }
  }
  return { ops };
}

// PROMOTE-UPSTREAM (local-first, flagged per the engine law): this DRIVER-SEED-CONTRACT family + its catalog-driven
// interpreter is a NEW generic op added LOCALLY in this repo's pi-runner/. It carries ZERO repo-specific literals
// (it is driven entirely by the catalog DATA + the marker), so it is a candidate for promotion into the canonical
// transform-workflow-to-pi template (reference/artifact-contract.md's marker family + the run.mjs template) once
// proven on a real run — alongside the existing DRIVER-SEED/DRIVER-PROJECT/DRIVER-MERGE families. Until promoted it
// lives here only; the engine stays byte-identical for repos that don't render the marker (it is inert when absent).
// DRIVER-SEED-CONTRACT — a THIRD post-node DERIVE family (sibling of DRIVER-PROJECT / DRIVER-MERGE), for the
// deterministic per-node SEEDED CONTRACT projection: AFTER the producing node freezes a `source` JSON, the driver
// PROJECTS a basic contract per downstream node into `source.<into>.<node> = { owns, bind, demand, tone, ... }`,
// resolving each node-TYPE's DECLARATIVE bind-template (from a drift-gated `catalog` JSON) against the frozen
// source. It is the AUTHORITY for that field → it OVERWRITES it each run. (Why a hook, not the model: the
// resolution is a deterministic function of frozen sections + a data catalog — un-hallucinatable, keeps the
// producer to one job. MECHANICAL→DRIVER-HOOK.) 100% GENERIC — zero game-omni/blueprint/archetype vocabulary;
// the marker carries only { source, catalog, into? }, and the bind-templates + observable palette live as DATA in
// the catalog, so adding a node-TYPE or a game type needs ZERO engine edit. ABSENT marker ⇒ inert (every other
// repo/node unaffected). UNREADABLE catalog / source ⇒ warn + skip (degrade like the optional schema gate), never
// crash a run. Returns null when no marker; else { source, catalog, into }.
function driverSeedContract(prompt) {
  // base64 line (the contract() encodes {source,catalog,into} so paths with any char ride one marker line, the
  // same trivial-parser convention as DRIVER-MERGE).
  const m = /(?:^|\n)[ \t]*DRIVER-SEED-CONTRACT:[ \t]*([A-Za-z0-9+/=]+)[ \t]*(?=\n|$)/.exec(prompt || "");
  if (!m) return null;
  try { const o = JSON.parse(Buffer.from(m[1], "base64").toString("utf8")); return { into: "contracts", ...o }; }
  catch (e) { console.warn(`    ⚠ DRIVER-SEED-CONTRACT — marker payload unreadable (${e.message}); skipping`); return null; }
}
// ---- the bind-template interpreter (generic primitives; the catalog declares which to run, in order) ----
// drillPath() (above) drills a DOTTED path; these add the array-projection + dedup-sort the bind segments need.
// "a[].b" → collect each element's drilled `b`; a plain dotted path with a non-array value → [value]; an array
// value → the array. Used by `events`/`slots`/`tokens` segments. GENERIC — no field name is hard-coded.
function drillArrayField(obj, spec) {
  const m = /^(.+?)\[\]\.(.+)$/.exec(spec);
  if (m) {
    const arr = drillPath(obj, m[1]);
    if (!Array.isArray(arr)) return [];
    return arr.map((e) => (e == null ? undefined : drillPath(e, m[2]))).filter((v) => v != null);
  }
  const v = drillPath(obj, spec);
  return v == null ? [] : Array.isArray(v) ? v : [v];
}
const dedupSort = (xs) => [...new Set(xs.map(String))].sort();
// The CORE OBSERVABLE set, computed ONCE per source from the catalog's `observables` palette (base + the meta-
// scalar-gated additions). The ONLY archetype knowledge — the failModel→observable map / scoringModel→maxScore —
// is DATA in the catalog, never here. Returns a deduped (insertion-order) array.
function coreObservables(spec, palette) {
  if (!palette || typeof palette !== "object") return [];
  const out = [...(Array.isArray(palette.base) ? palette.base : [])];
  for (const [scalarPath, rule] of Object.entries(palette.whenScalar || {})) {
    const val = drillPath(spec, scalarPath);
    if (rule && Array.isArray(rule.unless)) { if (!rule.unless.includes(val)) for (const a of (rule.add || [])) out.push(a); }
    else if (rule && rule.map && typeof rule.map === "object") { const mapped = rule.map[val]; if (mapped != null) out.push(mapped); }
  }
  return [...new Set(out.map(String))];
}
// Gather the POSITIONED entity ids from a list of dotted paths (each a single object with `.id`, e.g. layout.goal,
// OR an array of {id}, e.g. layout.rewards/threats) — in path order, then array order. The diegetic-cue handles.
function gatherEntityIds(spec, paths) {
  const ids = [];
  for (const p of (paths || [])) {
    const v = drillPath(spec, p);
    if (v == null) continue;
    if (Array.isArray(v)) { for (const e of v) if (e && e.id != null) ids.push(String(e.id)); }
    else if (v.id != null) ids.push(String(v.id));
  }
  return ids;
}
// Resolve ONE node-TYPE's catalog entry against the frozen source → its contract object { owns, bind, demand, tone,
// ...scalars }. Pure data-interpretation: every concrete value is drilled from `spec`; the catalog supplies only the
// SHAPE. The bind list is assembled from ordered `segments` (each a typed producer), exactly mirroring the hand-sim.
function resolveNodeContract(spec, entry, palette) {
  const out = {};
  if (Array.isArray(entry.owns)) out.owns = entry.owns.slice();
  // ---- bind: ordered segments → one concatenated handle list ----
  const obs = coreObservables(spec, palette);
  const bind = [];
  for (const seg of (entry.bind && entry.bind.segments) || []) {
    if (seg.kind === "observables") {
      let xs = obs.slice();
      if (typeof seg.with === "string") xs.push(seg.with);
      else if (Array.isArray(seg.with)) xs.push(...seg.with);
      if (seg.sort === "dedup-sort") xs = dedupSort(xs);
      bind.push(...xs);
    } else if (seg.kind === "literals") {
      bind.push(...(seg.values || []));
    } else if (seg.kind === "events") {
      let xs = drillArrayField(spec, seg.from).map(String);
      if (seg.sort === "dedup-sort") xs = dedupSort(xs);
      bind.push(...xs);
    } else if (seg.kind === "anchors") {
      const ids = gatherEntityIds(spec, seg.entityIdsFrom);
      bind.push(...ids.map((i) => `near:${i}`), ...ids.map((i) => `${i}.position`));
    } else if (seg.kind === "tokens") {
      const xs = drillArrayField(spec, seg.from).map(String);
      bind.push(...xs.map((v) => `${seg.prefix}${v}`));
    } else if (seg.kind === "slots") {
      const xs = [];
      for (const f of (seg.from || [])) for (const v of drillArrayField(spec, f)) xs.push(String(v));
      bind.push(...[...new Set(xs)]);
    }
  }
  out.bind = bind;
  // ---- scalars: extra top-level fields copied/derived verbatim (nodeContract is additionalProperties:true) ----
  for (const [field, sc] of Object.entries(entry.scalars || {})) {
    if (sc && Array.isArray(sc.fromEntityIds)) out[field] = gatherEntityIds(spec, sc.fromEntityIds);
    else if (sc && typeof sc.from === "string") { const v = drillPath(spec, sc.from); out[field] = v == null ? (sc.default ?? "") : v; }
  }
  // ---- the templated demand + tone context (generic token grammar; values all drilled from spec) ----
  const scoringModel = drillPath(spec, "meta.scoringModel") ?? "none";
  const failModel = drillPath(spec, "meta.failModel") ?? "none";
  const ctx = {
    coreVerb: drillPath(spec, "meta.coreVerb") ?? "",
    goalId: (drillPath(spec, "layout.goal") || {}).id ?? "",
    firstMilestone: (() => { const ms = drillArrayField(spec, "milestones[].id"); return ms.length ? ms[0] : "M1"; })(),
    slotCount: (() => { let n = 0; for (const seg of (entry.bind && entry.bind.segments) || []) if (seg.kind === "slots") n = out.bind.length; return n; })(),
  };
  const renderDemand = (tmpl) => String(tmpl || "")
    // {scoring?A:B} — ternary on scoringModel != 'none'
    .replace(/\{scoring\?([^:}]*):([^}]*)\}/g, (_, a, b) => (scoringModel !== "none" ? a : b))
    // {failResource} — ' + the <fm> resource' iff failModel not in {none,respawn} (a HUD resource exists)
    .replace(/\{failResource\}/g, () => (["none", "respawn"].includes(failModel) ? "" : ` + the ${failModel} resource`))
    // {gameOver?} — 'out' iff failModel cannot reach a terminal lose (none/respawn) → 'without a gameOver branch'
    .replace(/\{gameOver\?\}/g, () => (["none", "respawn"].includes(failModel) ? "out" : ""))
    // {coreVerb}/{goalId}/{firstMilestone}/{slotCount} — plain context substitutions
    .replace(/\{(coreVerb|goalId|firstMilestone|slotCount)\}/g, (_, k) => String(ctx[k] ?? ""));
  if (entry.demand && typeof entry.demand.template === "string") out.demand = renderDemand(entry.demand.template);
  // ---- tone: first-present coalesce over dotted paths, with a default ----
  if (entry.tone && Array.isArray(entry.tone.from)) {
    let tone;
    for (const p of entry.tone.from) { const v = drillPath(spec, p); if (v != null && v !== "") { tone = v; break; } }
    out.tone = tone == null ? (entry.tone.default ?? "") : tone;
  }
  return out;
}
// Run a node's DRIVER-SEED-CONTRACT (POST-node, the AUTHORITY for source.<into>): read the drift-gated `catalog`
// (its `nodes` map of bind-templates + the `observables` palette), resolve each node-TYPE against the frozen
// `source` JSON, and write source.<into>.<node> = the resolved contract — then write the source back. Returns a
// summary the digest records ({ source, catalog, into, nodes:[...] }); a null marker / unreadable catalog|source
// returns null|skip so a run is never crashed by it (graceful degrade — the engine law).
async function runSeedContract(proj, projectBase) {
  if (!proj) return null;
  const catalogAbs = path.isAbsolute(proj.catalog)
    ? proj.catalog
    : [path.join(RUN_CWD, proj.catalog), path.join(ROOT, proj.catalog)].find((c) => { try { return fs.statSync(c).size > 0; } catch { return false; } });
  if (!catalogAbs) { console.warn(`    ⚠ DRIVER-SEED-CONTRACT — catalog "${proj.catalog}" not found; skipping`); return { skipped: `catalog not found: ${proj.catalog}` }; }
  let catalog;
  try { catalog = JSON.parse(fs.readFileSync(catalogAbs, "utf8")); }
  catch (e) { console.warn(`    ⚠ DRIVER-SEED-CONTRACT — catalog "${proj.catalog}" unreadable (${e.message}); skipping`); return { skipped: `catalog unreadable: ${e.message}` }; }
  if (!catalog || typeof catalog.nodes !== "object") return { skipped: "catalog has no `nodes` map (inert)" };
  const srcAbs = path.isAbsolute(proj.source) ? proj.source
    : [path.join(projectBase, proj.source), path.join(RUN_CWD, proj.source), path.join(ROOT, proj.source)].find((c) => { try { return fs.statSync(c).size > 0; } catch { return false; } });
  let spec;
  try { spec = JSON.parse(fs.readFileSync(srcAbs, "utf8")); }
  catch (e) { console.warn(`    ⚠ DRIVER-SEED-CONTRACT — source "${proj.source}" unreadable (${e.message}); skipping`); return { skipped: `source unreadable: ${e.message}` }; }
  const into = proj.into || "contracts";
  if (!spec[into] || typeof spec[into] !== "object" || Array.isArray(spec[into])) spec[into] = {};
  const done = [];
  for (const [node, entry] of Object.entries(catalog.nodes)) {
    if (node.startsWith("$")) continue; // skip $comment-style keys
    try { spec[into][node] = resolveNodeContract(spec, entry, catalog.observables); done.push(node); }
    catch (e) { console.warn(`    ⚠ DRIVER-SEED-CONTRACT — node "${node}" failed (${e.message}); skipping that node`); }
  }
  fs.writeFileSync(srcAbs, projJson(spec));
  return { source: proj.source, catalog: proj.catalog, into, nodes: done };
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

// ── DECLARATIVE INTEGRITY CHECKS — the unified node contract (DRIVER-CHECKS / DRIVER-POLICY / DRIVER-RETURN) ──
// A node declares its CHECKS (pure predicates over its artifacts) SEPARATELY from the verdict→ACTION POLICY,
// so detection and consequence stay disentangled: flip an action in DRIVER-POLICY without touching a check,
// or add a check without touching the policy. Each check is { kind, path, param?, severity? }; the engine runs
// CHECK_KINDS[kind] (a pure fn of the file's bytes) and folds the verdicts into the node status. base64-on-one-
// line (the DRIVER-MERGE convention) carries arbitrary regex/params collision-free. ALL inert when their marker
// is absent — an undeclared node is byte-identical to before. Spec: reference/artifact-contract.md.
function decodeB64Marker(prompt, key) {
  const v = markerValue(prompt, key);
  if (!v) return null;
  try { return JSON.parse(Buffer.from(v.trim(), "base64").toString("utf8")); }
  catch { try { return JSON.parse(v); } catch { return null; } } // tolerate inline JSON for a hand-authored marker
}
const driverChecks = (prompt) => { const c = decodeB64Marker(prompt, "DRIVER-CHECKS"); return Array.isArray(c) ? c : null; };
const driverPolicy = (prompt) => { const p = decodeB64Marker(prompt, "DRIVER-POLICY"); return p && typeof p === "object" ? p : null; };
function resolveArtifactPath(p) { // forgiving RUN_CWD/ROOT/PROJECT_BASE resolve, like the existence/schema gates
  if (path.isAbsolute(p)) return p;
  const cands = [path.join(RUN_CWD, p), path.join(ROOT, p), ...(PROJECT_BASE ? [path.join(PROJECT_BASE, p)] : [])];
  return cands.find((c) => { try { return fs.statSync(c).size >= 0; } catch { return false; } }) || cands[0];
}
const fieldAt = (obj, dotted) => String(dotted).split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function lastFencedBlock(text, lang) { // extract+parse the LAST fenced ```<lang> block; undefined=none, null=unparseable
  const re = new RegExp("```" + (lang || "json") + "\\s*([\\s\\S]*?)```", "g");
  let m, last; while ((m = re.exec(text || ""))) last = m[1];
  if (last == null) return undefined;
  try { return JSON.parse(last.trim()); } catch { return null; }
}
// CHECK_KINDS — pure predicates over a read file { bytes, size }. Each returns { ok, reason }. NEVER judges
// GOODNESS (count-floor asserts "≥N items EXIST", never "the items are good"). Unknown kind → graceful skip.
const CHECK_KINDS = {
  "exists":        (f) => ({ ok: f.bytes != null, reason: f.bytes != null ? "present" : "missing" }),
  "non-empty":     (f) => ({ ok: (f.size || 0) > 0, reason: `${f.size || 0} bytes` }),
  "regex-absent":  (f, p) => { const hit = new RegExp(p).test(f.bytes || ""); return { ok: !hit, reason: hit ? `/${p}/ present (incomplete)` : `/${p}/ absent` }; },
  "regex-present": (f, p) => { const hit = new RegExp(p).test(f.bytes || ""); return { ok: hit, reason: hit ? `/${p}/ present` : `/${p}/ absent` }; },
  "json-parses":   (f) => { try { JSON.parse(f.bytes); return { ok: true, reason: "valid JSON" }; } catch (e) { return { ok: false, reason: `invalid JSON: ${e.message}` }; } },
  "field-present": (f, p) => { let v; try { v = fieldAt(JSON.parse(f.bytes), p); } catch { return { ok: false, reason: "unparseable JSON" }; } return { ok: v != null, reason: v != null ? `${p} present` : `${p} missing` }; },
  "count-floor":   (f, p) => { let v; try { v = fieldAt(JSON.parse(f.bytes), p.path); } catch { return { ok: false, reason: "unparseable JSON" }; } const n = Array.isArray(v) ? v.length : -1; return { ok: n >= p.min, reason: `${p.path}: ${n} (min ${p.min})` }; },
  "fenced-tail":   (f, p) => { const o = lastFencedBlock(f.bytes, p.lang); if (o === undefined) return { ok: false, reason: `no fenced ${p.lang || "json"} block` }; if (o === null) return { ok: false, reason: "fenced tail does not parse" }; const v = p.field ? o[p.field] : o; const n = Array.isArray(v) ? v.length : v != null ? 1 : -1; const min = p.minItems ?? 1; return { ok: n >= min, reason: `${p.field || "tail"}: ${n} (min ${min})` }; },
};
function runChecks(checkList) { // → [{ kind, path, verdict:pass|warn|fail, reason, severity }] (reads each file once)
  if (!checkList || !checkList.length) return [];
  return checkList.map((c) => {
    const sev = c.severity || "fail";
    const fn = CHECK_KINDS[c.kind];
    if (!fn) return { kind: c.kind, path: c.path || null, verdict: "warn", reason: `unknown check kind '${c.kind}' (skipped)`, severity: "warn" };
    let bytes = null, size = 0;
    try { const abs = resolveArtifactPath(c.path); const stt = fs.statSync(abs); size = stt.size; bytes = fs.readFileSync(abs, "utf8"); } catch {}
    const r = fn({ bytes, size }, c.param);
    return { kind: c.kind, path: c.path || null, verdict: r.ok ? "pass" : sev, reason: r.reason, severity: sev };
  });
}
// Effective checks = explicit DRIVER-CHECKS ∪ the AUTO fill-sentinel completeness check (a DRIVER-FILL-SENTINEL'd
// node whose required artifact STILL contains the sentinel is incomplete → fail). This makes "contract satisfied"
// mean USABLE, not merely present — so the return-block release below is safe (real corruption is still caught).
function effectiveChecks(prompt) {
  const explicit = driverChecks(prompt) || [];
  const sentinel = markerValue(prompt, "DRIVER-FILL-SENTINEL");
  const reqs = (sentinel && markerPaths(prompt, "DRIVER-ARTIFACTS")) || [];
  const auto = reqs.map((p) => ({ kind: "regex-absent", path: p, param: escapeRe(sentinel), severity: "fail" }));
  return [...auto, ...explicit];
}
// Map a non-pass verdict → an engine action via the node's DRIVER-POLICY (default: fail→block, warn→warn).
// block|warn|stop are honored in wave 1; retry-once|subagent-fix parse but fall back to block (wave 2).
function actionForVerdict(verdict, policy) {
  const a = (policy && policy[verdict]) || (verdict === "warn" ? "warn" : "block");
  return a === "warn" || a === "stop" ? a : "block";
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
  // Robustly recover the node's return object. Non-Claude models botch the ```json FENCE (drop the close,
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

  // DRIVER-SEED pre-stage (see driverSeed): deterministically stage this node's STARTING artifact(s)
  // before pi spawns — e.g. copy the per-archetype blueprint template (a FILE) so HARDEN fills leaves
  // via `edit`, or copy the engine base + module-src + contract (DIRECTORY trees) so a scaffold node
  // skips the mechanical copy + tree-explore. Each entry stages ONLY when its dest is absent/empty AND
  // its resolved src exists; entries apply in ORDER (a base copy before an overlay that wins). A dir src
  // is copied RECURSIVELY (overlay merges over base = second wins); a file src is copied as a file.
  for (const seed of driverSeed(node.prompt)) {
    const toAbs = path.isAbsolute(seed.to) ? seed.to : path.resolve(RUN_CWD, seed.to);
    const fr = resolveSeedTokens(seed.from);
    const fromAbs = path.isAbsolute(fr) ? fr : path.resolve(RUN_CWD, fr);
    let srcIsDir = false, srcExists = false;
    try { srcIsDir = fs.statSync(fromAbs).isDirectory(); srcExists = true; } catch {}
    // Idempotency — never clobber an already-staged copy on a resume:
    //   FILE dest: "filled" when it exists with size > 0.
    //   DIR  dest: "filled" when EVERY top-level entry of the SOURCE already exists under the dest.
    // The dir test is per-SOURCE (not "dest non-empty"): a seed whose dest is the PROJECT ROOT shares
    // that dir with sibling artifacts (spec/, _pi/, asset-prompts.json) the upstream nodes wrote — a
    // bare "non-empty" test would wrongly skip the base copy because spec/ exists. Checking the source's
    // own entries is generic (any tree, any archetype) and correctly stages a base into a populated root
    // while still skipping a genuine re-stage of the same tree.
    let destFilled = false;
    try {
      const ds = fs.statSync(toAbs);
      if (srcIsDir && ds.isDirectory()) {
        const want = fs.readdirSync(fromAbs);
        destFilled = want.length > 0 && want.every((e) => fs.existsSync(path.join(toAbs, e)));
      } else if (!srcIsDir) {
        destFilled = ds.size > 0;
      } // src is a dir but dest is a file (or vice-versa) → not "filled"; the copy below resolves it
    } catch {}
    if (destFilled) {
      console.log(`    ⇪ DRIVER-SEED ${node.id} — dest present (${path.relative(RUN_CWD, toAbs)}); not re-staging`);
    } else if (!srcExists) {
      console.log(`    ⇪ DRIVER-SEED ${node.id} — no template at ${path.relative(RUN_CWD, fromAbs)} (node hand-builds)`);
    } else if (args.dryRun) {
      console.log(`    DRY: DRIVER-SEED ${node.id} — would stage ${path.relative(RUN_CWD, toAbs)}${srcIsDir ? "/" : ""} from ${path.relative(RUN_CWD, fromAbs)}${srcIsDir ? "/ (recursive)" : ""}`);
    } else {
      if (srcIsDir) { ensureDir(toAbs); fs.cpSync(fromAbs, toAbs, { recursive: true, force: true }); }
      else { ensureDir(path.dirname(toAbs)); fs.copyFileSync(fromAbs, toAbs); }
      n.seeded = (n.seeded ? n.seeded + " " : "") + path.relative(BASE_RUN_CWD, toAbs);
      console.log(`    ⇪ DRIVER-SEED ${node.id} — staged ${path.relative(RUN_CWD, toAbs)}${srcIsDir ? "/" : ""} from ${path.relative(RUN_CWD, fromAbs)}${srcIsDir ? "/ (recursive)" : ""}`);
    }
  }

  ensureDir(promptDir);
  const promptFile = path.join(promptDir, `${node.id}.prompt.md`);
  // promptPrefix carries the escalation CONSULT preamble (the prior cheap attempt's failure evidence)
  // on a re-run; empty on attempt 0.
  fs.writeFileSync(promptFile, (opts.promptPrefix || "") + node.prompt + returnProtocol(node.label));
  // Per-node TOOL GATING (DRIVER-TOOLS / DRIVER-EXCLUDE-TOOLS markers): shrink the non-Claude model's
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
    // PER-CALL TIMING (the wall-clock x-ray). pi's events carry NO per-event timestamp and its
    // tool_execution_start/end carry no time at all (verified: only `session` has an ISO stamp and
    // message_end a per-turn epoch-ms), so per-tool/per-turn wall-clock can ONLY be reconstructed at
    // the point the driver RECEIVES each line. We stamp every event with a node-relative `_t` ms (and
    // the slimmed archive line also gets an absolute `_rt`), then pair tool_execution_start→end by the
    // native `toolCallId` and turn_start/message_start→message_end for turns — accumulating ONE compact
    // per-node timeline. All driver-side, all additive (no pi change). Lands in BOTH modes (cheap;
    // bounded by tool-call + turn count, not by delta volume), so production keeps the x-ray too.
    const tlTools = [];                                  // [{ id, name, tStartMs, durMs }] — pi tool calls, start→end paired by toolCallId
    const tlTurns = [];                                  // [{ tStartMs, durMs, tokIn, tokOut, tokBillable }] — model turns, start→message_end
    const toolOpen = new Map();                          // toolCallId -> { name, startRel } awaiting its tool_execution_end
    let turnStartRel = null;                             // node-relative ms the current turn began (turn_start/message_start)
    let firstEventRel = null, lastEventRel = 0;          // node-relative span of the event stream (for the reconciliation check)
    let tokBefore = 0;                                   // running billable BEFORE the current message_end (→ per-turn delta)
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
      // RECEIVE-TIME stamp (the per-event clock pi does not provide). `tRel` = ms since this node's
      // t0; `rtISO` = wall-clock. Captured ONCE here so the slimmed archive line and the per-tool/
      // per-turn timeline below share one consistent clock. Additive — no existing reader of
      // events.jsonl enumerates keys, so injecting _t/_rt never breaks the tail/replay consumer.
      const tRel = lastEventAt - t0;
      const rtISO = new Date(lastEventAt).toISOString();
      if (firstEventRel === null) firstEventRel = tRel;
      lastEventRel = tRel;
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
      // TURN START — a model turn opens at turn_start (or the first message_start if turn_start is
      // absent in this pi version). Mark it ONCE per turn so message_end can close the interval.
      if (t === "turn_start" || (t === "message_start" && turnStartRel === null)) turnStartRel = tRel;
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
        // PER-TURN row: timing (turn open → this message_end) + the billable token DELTA this turn
        // added. tokIn/tokOut are already per-call (this turn's), so they ARE the delta; tokBillable
        // is taken as (running billable − the snapshot before this turn) so the turns' deltas SUM to
        // the node billable exactly (the reconciliation invariant). turn_start may be absent → fall
        // back to firstEvent for turn 0 so the first row still has a real start.
        const tStart = turnStartRel != null ? turnStartRel : (firstEventRel ?? tRel);
        tlTurns.push({ tStartMs: tStart, durMs: tRel - tStart, tokIn: u.input || 0, tokOut: u.output || 0, tokBillable: tokens.billable - tokBefore });
        tokBefore = tokens.billable;
        turnStartRel = null;
      }
      if (t.startsWith("tool_execution_start")) {
        toolCalls++;
        const tn = ev.toolName || ev.tool || ev.name || (ev.toolCall && ev.toolCall.name) || "tool";
        toolBreakdown[tn] = (toolBreakdown[tn] || 0) + 1;
        n.live.currentTool = tn;
        dbg(`tool▶ ${tn}`);
        // OPEN a per-tool interval keyed by the NATIVE toolCallId (exact start→end pairing, never
        // positional). A long bash/render dominates a node's wall-clock; this is the only way to see it.
        const cid = ev.toolCallId || ev.id || `${tn}#${toolCalls}`;
        toolOpen.set(cid, { name: tn, startRel: tRel });
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
        // CLOSE the matching tool interval → one timeline row (name · start · duration). Match by the
        // native toolCallId; fall back to the oldest still-open call (FIFO) for a pi version that omits
        // the id on the end event, so a duration is still recorded rather than dropped.
        const cid = ev.toolCallId || ev.id || null;
        let open = cid ? toolOpen.get(cid) : null;
        if (!open && toolOpen.size) { const k = toolOpen.keys().next().value; open = toolOpen.get(k); toolOpen.delete(k); }
        else if (cid) toolOpen.delete(cid);
        if (open) tlTools.push({ name: open.name || tn || "tool", tStartMs: open.startRel, durMs: tRel - open.startRel });
        dbg(`tool✓ ${n.live.currentTool || ""}`); n.live.currentTool = null;
      }
      else if (dbgStream && t) dbg(`ev ${t}`);
      // Archive write — SLIM message_update events: drop the cumulative `partial`/`message` snapshots
      // pi re-embeds on every delta. THAT redundancy is what makes a raw transcript 100s of MB; the
      // unique content is tiny and fully reconstructable from the kept `delta`s. Every other event
      // type (incl. message_end's `usage`) is written verbatim. Aggregates above already read the
      // full event, so slimming costs no information.
      if (evStream) {
        // Stamp every archived event with the driver receive-time: `_t` (node-relative ms) + `_rt`
        // (wall ISO). Additive top-level keys — the only events.jsonl reader (viz-model.tailNodeOutput)
        // reads named keys, never enumerates — so this is a pure superset of the prior stream.
        ev._t = tRel; ev._rt = rtISO;
        if (ev.type === "message_update") {
          if (ev.assistantMessageEvent) delete ev.assistantMessageEvent.partial;
          delete ev.message;
          evStream.write(JSON.stringify(ev) + "\n");
        } else {
          evStream.write(JSON.stringify(ev) + "\n");
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
      // DRIVER-PROJECT post-hook (see runProjection): the DERIVE sibling of the DRIVER-SEED pre-hook. AFTER the
      // model exits, DERIVE this node's MECHANICAL outputs (a fixed function of the frozen on-disk source) in
      // the driver — the AUTHORITY for them, so it OVERWRITES each run, strictly BEFORE the artifact/schema
      // gates below verify them and (in this DAG) BEFORE the later serial JOIN stage, so no concurrent writer.
      // Skipped on a killed/error exit (a half-run node's source may be stale — don't project off it). Inert
      // when the node declares no DRIVER-PROJECT marker; graceful-degrade (warn+skip) on an unreadable map.
      const projMarker = driverProject(node.prompt);
      if (projMarker && !(n.killedTimeout || n.killedRepeat || n.killedStall || n.killedToolLoop || code !== 0)) {
        try {
          const projBase = PROJECT_BASE || RUN_CWD;
          n.projected = await runProjection(projMarker, projBase);
          const wrote = (n.projected && n.projected.ops || []).filter((o) => o.wrote).map((o) => o.to);
          const skipped = (n.projected && n.projected.ops || []).filter((o) => o.skipped);
          if (wrote.length) console.log(`    ⇲ DRIVER-PROJECT ${node.id} — derived ${wrote.join(", ")}`);
          for (const s of skipped) console.warn(`    ⚠ DRIVER-PROJECT ${node.id} — op "${s.op}" → ${s.to || "?"} skipped: ${s.skipped}`);
        } catch (e) { console.warn(`    ⚠ DRIVER-PROJECT ${node.id} — projection failed (${e.message}); node continues`); n.projected = { skipped: e.message }; }
      }
      // DRIVER-MERGE post-hook (see runMerge): the SECOND post-node DERIVE family — the deterministic FILESYSTEM
      // merges (concat per-node fragments → one canonical file; reconcile a manifest's per-key fields onto another
      // JSON's matching rows) that replace a would-be LLM merge node. Same gate as DRIVER-PROJECT (skip on a
      // killed/error exit — a half-run lane's fragments may be stale). Inert when unmarked; each op degrades
      // gracefully on a missing input (an absent manifest still lets the fragment concat run — the JOIN's behavior).
      const mergeSpec = driverMerge(node.prompt);
      if (mergeSpec && !(n.killedTimeout || n.killedRepeat || n.killedStall || n.killedToolLoop || code !== 0)) {
        try {
          const projBase = PROJECT_BASE || RUN_CWD;
          n.merged = await runMerge(mergeSpec, projBase);
          const wrote = (n.merged && n.merged.ops || []).filter((o) => o.wrote).map((o) => o.to);
          const skipped = (n.merged && n.merged.ops || []).filter((o) => o.skipped);
          if (wrote.length) console.log(`    ⇲ DRIVER-MERGE ${node.id} — merged ${wrote.join(", ")}`);
          for (const s of skipped) console.warn(`    ⚠ DRIVER-MERGE ${node.id} — op "${s.op}" → ${s.to || "?"} skipped: ${s.skipped}`);
        } catch (e) { console.warn(`    ⚠ DRIVER-MERGE ${node.id} — merge failed (${e.message}); node continues`); n.merged = { skipped: e.message }; }
      }
      // DRIVER-SEED-CONTRACT post-hook (see runSeedContract): the THIRD post-node DERIVE family — project a basic
      // per-node SEEDED CONTRACT (source.contracts.<node> = {owns,bind,demand,tone,...}) from the frozen source +
      // the drift-gated node-catalog. Same gate as DRIVER-PROJECT/MERGE (skip on a killed/error exit — a half-run
      // node's source may be stale). Inert when unmarked; graceful-degrade on an unreadable catalog/source. Runs
      // BEFORE the artifact/schema gates below, so the contracts land before the produced source is validated.
      const seedContractSpec = driverSeedContract(node.prompt);
      if (seedContractSpec && !(n.killedTimeout || n.killedRepeat || n.killedStall || n.killedToolLoop || code !== 0)) {
        try {
          const projBase = PROJECT_BASE || RUN_CWD;
          n.seedContracts = await runSeedContract(seedContractSpec, projBase);
          if (n.seedContracts && Array.isArray(n.seedContracts.nodes) && n.seedContracts.nodes.length)
            console.log(`    ⇲ DRIVER-SEED-CONTRACT ${node.id} — seeded ${seedContractSpec.into || "contracts"}.{${n.seedContracts.nodes.join(",")}} into ${seedContractSpec.source}`);
          else if (n.seedContracts && n.seedContracts.skipped) console.warn(`    ⚠ DRIVER-SEED-CONTRACT ${node.id} — skipped: ${n.seedContracts.skipped}`);
        } catch (e) { console.warn(`    ⚠ DRIVER-SEED-CONTRACT ${node.id} — projection failed (${e.message}); node continues`); n.seedContracts = { skipped: e.message }; }
      }
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
      // DECLARATIVE INTEGRITY CHECKS (the unified contract) folded through the verdict→action POLICY.
      const checkResults = runChecks(effectiveChecks(node.prompt));
      if (checkResults.length) n.checks = checkResults;
      const policy = driverPolicy(node.prompt);
      const failedChecks = checkResults.filter((c) => c.verdict !== "pass");
      const blocking = failedChecks.filter((c) => actionForVerdict(c.verdict, policy) !== "warn");
      const warning = failedChecks.filter((c) => actionForVerdict(c.verdict, policy) === "warn");
      // RETURN-BLOCK expectation — GENERALIZED default: a node that declares a (satisfied) DRIVER-ARTIFACTS
      // contract proves its work by the FILE on disk, so a missing return handshake is advisory (optional). A
      // node that declares NO artifact (its structured return IS its only output) still REQUIRES the handshake.
      // DRIVER-RETURN overrides per node. This releases the redundant handshake that falsely error'd a node whose
      // required artifact was present + complete (the W1-class defect), GENERALLY — while REAL corruption (missing
      // / schema-invalid / sentinel-unfilled / malformed-tail) is still caught by the gates + checks above.
      const returnMode = markerValue(node.prompt, "DRIVER-RETURN") || ((requiredPaths && requiredPaths.length) ? "optional" : "required");
      n.returnMode = returnMode;
      let st;
      if (n.killedTimeout || n.killedRepeat || n.killedStall || n.killedToolLoop || code !== 0) st = "error";
      else if (contractMissing.length) st = "blocked"; // CONTRACT: a required artifact is missing — driver-verified, beats any self-report
      else if (schemaInvalid.length) st = "blocked"; // CONTRACT: a required artifact is present but VIOLATES its declared schema — driver-verified breach, beats any self-report
      else if (blocking.length) st = "blocked"; // DECLARATIVE INTEGRITY breach — a declared check failed at block severity (incomplete/unfilled/malformed artifact), driver-verified
      else if (parsed && parsed.status && parsed.status !== "ok") st = parsed.status; // gap/blocked self-report honored
      else if (declaredMissing && !(requiredPaths && requiredPaths.length)) st = "blocked"; // a missing/empty SELF-REPORTED file blocks ONLY a node with NO DRIVER-ARTIFACTS contract. When a contract WAS declared and is satisfied (contractMissing empty, above), it is the authority — a noisy self-report (a stripped path, or an intentionally size-0 file like .gitkeep) must NOT override it.
      else if (!parsed && returnMode === "required") st = "error"; // NO return-protocol block ⇒ error ONLY when the handshake is REQUIRED (a node with no satisfied artifact contract to prove its work). The release: an artifact-backed node missing ONLY its handshake is `ok` (advisory). A truly derailed node that wrote nothing is already caught above by contractMissing/blocking.
      else st = "ok";
      n.status = st;
      n.verdict = { status: st, returnMode, parsed: !!parsed, checks: checkResults.map((c) => ({ kind: c.kind, path: c.path, verdict: c.verdict, reason: c.reason })) }; // structured per-node verdict — drives control flow AND is the companion-mode stream payload
      n.exitCode = code;
      n.toolCalls = toolCalls;
      n.toolBreakdown = toolBreakdown;
      n.thinking = { deltas: thinkingDeltas, chars: thinkingChars, spanMs: thinkFirstAt ? thinkLastAt - thinkFirstAt : 0 };
      n.tokens = tokens;
      n.eventCount = eventCount;
      // PER-NODE TIMELINE (the wall-clock x-ray) — a COMPACT, additive node-record field, present in
      // BOTH modes (its size is bounded by tool-call + turn count — a few dozen rows, KB not MB). It
      // answers "where did this node's wall-clock go?": which tools ran when + for how long, each
      // model turn's duration, and the per-turn token delta. `toolMs`/`turnMs` are the summed busy
      // times; `wallMs` is the event-stream span (firstEvent→lastEvent). Reconciliation invariants a
      // consumer can assert (anti-reward-hack): Σ tlTurns.tokBillable === tokens.billable (turns
      // partition the billable tokens) and toolMs+turnMs ≲ durationMs+wallMs (busy time ≤ node wall-
      // clock; tools and model turns interleave, never exceeding the node's own elapsed). A timeline
      // that does not reconcile with the observed node wall-clock/tokens is a bug, not evidence.
      const toolMs = tlTools.reduce((a, x) => a + (x.durMs || 0), 0);
      const turnMs = tlTurns.reduce((a, x) => a + (x.durMs || 0), 0);
      n.timeline = {
        firstEventMs: firstEventRel ?? 0,
        lastEventMs: lastEventRel,
        wallMs: lastEventRel - (firstEventRel ?? 0),    // event-stream span (first→last received event)
        toolMs, turnMs,                                  // summed per-tool / per-turn busy time
        tools: tlTools,                                  // [{ name, tStartMs, durMs }] in completion order
        turns: tlTurns,                                  // [{ tStartMs, durMs, tokIn, tokOut, tokBillable }]
        toolsOpen: toolOpen.size,                        // tools still in flight at exit (e.g. a killed node) — nonzero flags an unclosed interval
      };
      n.summary = n.killedTimeout ? `killed: exceeded ${NODE_TIMEOUT_S}s node timeout`
        : n.killedStall ? `killed: silent-stall — no event for ${((n.stallMs || 0) / 1000).toFixed(0)}s with no tool in flight`
        : n.killedToolLoop ? `killed: tool-thrash — ${n.toolLoopSig} repeated ×${n.toolLoopCount} with no write`
        : n.killedRepeat ? `killed: stuck-loop — same delta repeated ≥${REPEAT_KILL}×`
        : (parsed && parsed.summary) || assistantText.trim().slice(-240) || "";
      n.issues = (parsed && parsed.issues) || [];
      n.pipelineFindings = (parsed && parsed.pipelineFindings) || [];
      if (!parsed && returnMode === "required") (n.issues = n.issues || []).push("no return JSON block parsed from pi output (return:required)");
      else if (!parsed) (n.issues = n.issues || []).push("no return-protocol block (return:optional — the artifact contract is the authority; advisory only)");
      if (blocking.length) (n.issues = n.issues || []).push(`integrity check FAILED — ${blocking.map((c) => `${c.kind} ${c.path || ""}: ${c.reason}`).join(" | ")}`);
      if (warning.length) (n.issues = n.issues || []).push(`integrity warn — ${warning.map((c) => `${c.kind} ${c.path || ""}: ${c.reason}`).join(" | ")}`);
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
  if (n.verdict && n.verdict.checks && n.verdict.checks.some((c) => c.verdict === "fail")) return "ESCALATE"; // declarative integrity breach — a stronger model may repair an incomplete/malformed artifact
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
    "CONSULT — the prior model attempted this node and FAILED; do not repeat its mistake.",
    `Failure class: ${cls}`,
    `Evidence: ${ev.join(" | ") || "(none captured)"}`,
    "Produce EVERY required artifact and end with the return-protocol JSON block.",
    "", "",
  ].join("\n");
}
// Wrapper the stage loop calls instead of runNode: attempt 0 on the non-Claude default; on a VERIFIED
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
