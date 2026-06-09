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
//        [--until <phase>] [--debug] [--dry-run] [--node-timeout N]
//   --run <id> | --id <id> | --lesson <id>   instance id — keys out/<id>/ AND seeds args.lessonId.
//   --arg k=v          a workflow arg (repeatable). Becomes the workflow's `args.k`.
//   --arg-file k=path  read file text into args.k (repeatable).
//   --brief <file>     alias for --arg-file brief=<file> (common pipeline input doc).
//   --style <value>    alias for --arg style=<value>.
//   --until <phase>    truncate after the first stage whose phase TITLE or node LABEL contains
//                      this substring (case-insensitive). Default = $PI_RUNNER_UNTIL or "all".
//   --provider/--model/--extension(-e)/--status as below (model defaults to $PI_CP_MODEL).
//   --debug            DEBUG mode: real-time heartbeats + stall detection AND the forensic archive
//                      (<node>.events.jsonl, slimmed to the low MB, + <node>.debug.log). Production
//                      (no --debug) skips both, keeping only the digest's distilled aggregates
//                      (timing, tool breakdown, thinking, tokens). ALWAYS use while developing;
//                      re-run one node with --debug to recover its raw archive.
//   --node-timeout N   hard-kill a node after N seconds (default $PI_RUNNER_NODE_TIMEOUT or 1800).
//   --dry-run          extract + build prompts + print the exact pi commands; invoke no model.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
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
// PI_RUNNER_NODE_TIMEOUT  optional default node hard-kill seconds (--node-timeout overrides).
//                    Set generously: heavy nodes (long TTS / build / render steps) run long on a
//                    cheap coding-plan model. Default 1800 (30 min); 600 was too tight.
const resolveFrom = (root, p, fb) => (!p ? fb : path.isAbsolute(p) ? p : path.join(root, p));
const ROOT = process.env.PI_RUNNER_ROOT ? path.resolve(process.env.PI_RUNNER_ROOT) : path.resolve(HERE, "..");
const RUN_CWD = resolveFrom(ROOT, process.env.PI_RUNNER_CWD, ROOT);
const WORKFLOW = resolveFrom(ROOT, process.env.PI_RUNNER_WORKFLOW, path.join(ROOT, ".claude/workflows/CHANGEME.js"));
// ==========================================================================================

function parseArgs(argv) {
  const a = { until: process.env.PI_RUNNER_UNTIL || "all", provider: "cp", dryRun: false, wfArgs: {} };
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
    else if (k === "--provider") a.provider = next();
    else if (k === "--model") a.model = next();
    else if (k === "--extension" || k === "-e") a.extension = next();
    else if (k === "--status") a.status = next();
    else if (k === "--dry-run") a.dryRun = true;
    else if (k === "--debug") a.debug = true;
    else if (k === "--node-timeout") a.nodeTimeout = Number(next());
    else throw new Error(`unknown arg: ${k}`);
  }
  if (!a.run) a.run = a.wfArgs.lessonId || a.wfArgs.id || a.wfArgs.run || "run";
  return a;
}

const args = parseArgs(process.argv.slice(2));
const model = args.model || process.env.PI_CP_MODEL || ""; // empty → pi uses the provider's default model
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

const outRel = `out/${args.run}`;
const promptDir = path.join(RUN_CWD, outRel, "_pi");
const statusPath = path.resolve(args.status || path.join(RUN_CWD, outRel, "run-status.json"));

const abs = (p) => (path.isAbsolute(p) ? p : path.join(RUN_CWD, p));
const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });
const nowISO = () => new Date().toISOString();
const slug = (label, i) => (label || `node-${i}`).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
function artifactState(p) {
  // Resolve a node-declared artifact path FORGIVINGLY before judging it missing. pi agents
  // inconsistently report a path relative to RUN_CWD (the repo subdir) OR to ROOT (e.g.
  // "remotion-svg-primitives/lesson-data/..", because the prompt shows ROOT-prefixed abs paths).
  // The strict join(RUN_CWD, p) double-prefixes the repo dir and false-flags a real written file as
  // "blocked" (killing the whole run for nothing). Try RUN_CWD first, then ROOT; absolute as-is.
  const candidates = path.isAbsolute(p) ? [p] : [path.join(RUN_CWD, p), path.join(ROOT, p)];
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
  try { const s = fs.statSync(p); return { path: p, exists: s.size > 0, bytes: s.size }; }
  catch { return { path: p, exists: false, bytes: 0 }; }
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

function selectStages(stages, until) {
  if (!until || until.toLowerCase() === "all") return stages;
  const u = until.toLowerCase();
  let idx = -1;
  stages.forEach((s, i) => {
    if ((s.phase || "").toLowerCase().includes(u) || s.nodes.some((n) => (n.label || "").toLowerCase().includes(u))) idx = i;
  });
  if (idx < 0) { console.error(`--until "${until}" matched no phase/label — running ALL stages`); return stages; }
  return stages.slice(0, idx + 1);
}

const RUN_T0 = Date.now();
let stageT0 = 0;
const status = {
  run: args.run,
  lessonId: args.wfArgs.lessonId || null,
  until: args.until,
  source: path.relative(ROOT, WORKFLOW),
  provider: args.provider,
  model: model || null,
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

function piArgs(promptFileAbs) {
  // headless executor: print+json, trust project files, ephemeral, --offline (no startup network
  // ops; the model call still works), --no-extensions. NOTE: models.json is CORE pi config, not an
  // extension, so --no-extensions does NOT disable it — pi still resolves the `cp` provider + its
  // credential from ~/.pi/agent/models.json. We only NAME the provider; --model when pinned; -e only
  // for an explicit custom-API/OAuth provider.
  const a = ["-p", "--mode", "json", "-a", "--no-session", "--offline", "--no-extensions",
             "--provider", args.provider];
  if (model) a.push("--model", model);
  if (extension) a.push("-e", extension);
  a.push(`@${promptFileAbs}`);
  return a;
}

async function runNode(node) {
  const n = status.nodes[node.id];
  n.status = "running";
  n.startedAt = nowISO();
  const t0 = Date.now();
  writeStatus();

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

  ensureDir(promptDir);
  const promptFile = path.join(promptDir, `${node.id}.prompt.md`);
  fs.writeFileSync(promptFile, node.prompt + returnProtocol(node.label));
  const argv = piArgs(promptFile);
  console.log(`  ▶ ${node.label}  [${node.id}]`);

  if (args.dryRun) {
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

    // stdin MUST be closed — a headless CLI with an open stdin pipe (no TTY) blocks forever
    // waiting for EOF (this caused a silent ~10-min startup hang).
    const child = spawn("pi", argv, { cwd: RUN_CWD, env: process.env, stdio: ["ignore", "pipe", "pipe"] });

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
      }
      else if (t.startsWith("tool_execution_end")) { dbg(`tool✓ ${n.live.currentTool || ""}`); n.live.currentTool = null; }
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
      if (REPEAT_KILL > 0 && repeatRun >= REPEAT_KILL && !n.killedRepeat && !finished) {
        n.killedRepeat = true; n.repeatRun = repeatRun;
        console.error(`    ✕ ${node.id} stuck-loop: same delta ×${repeatRun} (${JSON.stringify(lastDelta).slice(0, 40)}) — killing pi`);
        dbg(`stuck-loop kill: same delta ×${repeatRun}`);
        try { child.kill("SIGTERM"); } catch {}
        setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000);
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
      if (n.live.elapsedMs > NODE_TIMEOUT_S * 1000) {
        console.error(`    ✕ ${node.id} exceeded --node-timeout ${NODE_TIMEOUT_S}s — killing pi`);
        n.killedTimeout = true;
        try { child.kill("SIGTERM"); } catch {}
        setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000);
      }
    }, HEARTBEAT_MS);

    child.on("close", (code) => {
      finished = true;
      clearInterval(hb);
      if (evStream) evStream.end();
      if (dbgStream) dbgStream.end();
      if (DEBUG) { n.eventsFile = path.relative(RUN_CWD, eventsFile); n.debugLog = path.relative(RUN_CWD, debugLog); }
      const parsed = lastJsonBlock(assistantText);
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
      if (n.killedTimeout || n.killedRepeat || code !== 0) st = "error";
      else if (contractMissing.length) st = "blocked"; // CONTRACT: a required artifact is missing — driver-verified, beats any self-report
      else if (parsed && parsed.status && parsed.status !== "ok") st = parsed.status; // gap/blocked self-report honored
      else if (declaredMissing) st = "blocked"; // ok claimed but a REPORTED file is missing (measure, don't trust)
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
        : n.killedRepeat ? `killed: stuck-loop — same delta repeated ≥${REPEAT_KILL}×`
        : (parsed && parsed.summary) || assistantText.trim().slice(-240) || "";
      n.issues = (parsed && parsed.issues) || [];
      n.pipelineFindings = (parsed && parsed.pipelineFindings) || [];
      if (!parsed) (n.issues = n.issues || []).push("no return JSON block parsed from pi output");
      if (contractMissing.length) (n.issues = n.issues || []).push(`contract breach — required artifact(s) missing: ${contractMissing.join(", ")}`);
      if (ownsBreach.length) (n.issues = n.issues || []).push(`contract warn — reported writes outside owned paths: ${ownsBreach.join(", ")}`);
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
  const stages = selectStages(allStages, args.until);

  // assign stable ids + register in status
  let idx = 0;
  for (const s of stages) for (const node of s.nodes) { node.id = slug(node.label, idx++); status.nodes[node.id] = { id: node.id, label: node.label, phase: node.phase, status: "pending" }; }

  console.log(`\npi-runner — run "${args.run}" — ${stages.flatMap((s) => s.nodes).length} nodes / ${stages.length} stages from ${path.basename(WORKFLOW)} — ${args.dryRun ? "DRY-RUN" : `provider=${args.provider} model=${model}`}${DEBUG ? ` — DEBUG (heartbeat ${HEARTBEAT_MS / 1000}s · stall>${STALL_WARN_S}s · node-timeout ${NODE_TIMEOUT_S}s)` : ""}`);
  console.log(`source-of-truth: ${WORKFLOW}`);
  console.log(`status → ${statusPath}\n`);
  writeStatus();

  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    stageT0 = Date.now();
    status.stage = { index: i + 1, total: stages.length, phase: s.phase, nodes: s.nodes.map((x) => x.id), startedAt: nowISO(), elapsedMs: 0 };
    console.log(`[stage ${i + 1}/${stages.length}] [${s.phase}] ${s.nodes.map((x) => x.id).join(" ∥ ")}`);
    const results = await Promise.all(s.nodes.map((node) => runNode(node)));
    console.log(`  └ stage ${i + 1}/${stages.length} done in ${((Date.now() - stageT0) / 1000).toFixed(1)}s  ·  run elapsed ${((Date.now() - RUN_T0) / 1000).toFixed(1)}s`);
    const bad = results.find((r) => r.status === "error" || r.status === "blocked");
    if (bad && !args.dryRun) {
      status.stage = null;
      status.done = true; status.ok = false; status.durationMs = Date.now() - RUN_T0; writeStatus();
      console.error(`\n✕ halted at ${bad.id} (${bad.status}) after ${((Date.now() - RUN_T0) / 1000).toFixed(1)}s. See ${statusPath}\n`);
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
})();
