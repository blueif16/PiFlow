// Execute-and-record extractor — GENERIC, copy this file verbatim.
//
// Your `.claude/workflows/<name>.js` (the Claude Code Workflow) is the SINGLE SOURCE OF
// TRUTH. We run its body under recording stubs for the Workflow hooks (agent / parallel /
// pipeline / phase / log) and capture the EXACT realized prompts + DAG. The pi driver spawns
// one `pi` per recorded node. No second copy of the wave text, no codegen, no drift: edit the
// workflow, prove it by spawning the real Claude Code Workflow, and pi gets the same prompts.
//
// The ONLY transform is mechanical: de-export `meta` and wrap the body in an AsyncFunction.
// The Workflow runtime wraps the script the same way — that is why a workflow script legally
// uses top-level `return` / `await`. Wave prose, paths, skill refs and control flow run verbatim.
//
// WHY THIS WORKS: a workflow's control flow is data-INdependent at the structural level — the
// set of agent() calls and their parallel grouping is fixed; only their RESULTS vary. So we
// run the script once with stubbed hooks that (a) record each agent() prompt and (b) return a
// generic success-shaped object, which makes every data-dependent branch take its happy path.
// The recording is the DAG. (If your workflow branches on agent RESULTS to decide WHICH agents
// to spawn — e.g. loop-until-dry — extraction captures only the happy-path expansion; see
// reference/architecture.md "Dynamic workflows".)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Pull the `meta = { … }` object literal out of the source and evaluate it on its own. meta is a
// PURE literal by the Workflow contract (no vars/calls/spreads), so this is deterministic and safe —
// it gives us each phase's human description (meta.phases[].detail) without running the body. Returns
// null on any failure (older workflows, parse error): callers treat meta as optional.
function extractMeta(src) {
  const m = src.match(/\bmeta\s*=\s*\{/);
  if (!m) return null;
  let i = m.index + m[0].length - 1; // at the opening brace
  let depth = 0, str = null, esc = false;
  for (; i < src.length; i++) {
    const c = src[i];
    if (str) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === str) str = null;
    } else if (c === '"' || c === "'" || c === "`") str = c;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  const startBrace = src.indexOf("{", m.index);
  try { return new Function(`return (${src.slice(startBrace, i)})`)(); } catch { return null; }
}

export async function extractWorkflow(workflowPath, args = {}) {
  const src = fs.readFileSync(workflowPath, "utf8");
  const meta = extractMeta(src);
  // de-export meta so the body is legal inside a function; nothing else is touched.
  const body = src.replace(/^[ \t]*export[ \t]+const[ \t]+meta\b/m, "const meta");

  const records = [];
  let curPhase = null;
  let curGroup = null;
  let groupSeq = 0;

  // Success-shaped result so every data-dependent branch (preflight ok, accepted, …) takes the
  // happy path and ALL nodes are recorded. Add fields here if your workflow reads other keys off
  // an agent() result to decide control flow.
  const GENERIC = {
    node: "", status: "ok", outputArtifacts: [], summary: "", issues: [], pipelineFindings: [],
    accepted: true, ok: true, missing: [], findings: [],
  };
  const agent = async (prompt, opts = {}) => {
    records.push({
      phase: curPhase,
      label: opts.label || null,
      agentType: opts.agentType || null,
      group: curGroup,
      hasSchema: !!opts.schema,
      prompt: Array.isArray(prompt) ? prompt.join("\n") : String(prompt),
    });
    return GENERIC;
  };
  const parallel = async (thunks) => {
    const g = ++groupSeq;
    const prev = curGroup;
    curGroup = g;
    try { return await Promise.all(thunks.map((t) => t())); } finally { curGroup = prev; }
  };
  const pipeline = async (items, ...stages) => {
    const out = [];
    for (let i = 0; i < items.length; i++) {
      let v = items[i];
      for (const s of stages) v = await s(v, items[i], i);
      out.push(v);
    }
    return out;
  };
  const phase = (t) => { curPhase = t; };
  const log = () => {};
  const budget = { total: null, spent: () => 0, remaining: () => Infinity };

  const fn = new AsyncFunction("agent", "parallel", "pipeline", "phase", "log", "args", "budget", body);
  const aggregate = await fn(agent, parallel, pipeline, phase, log, args, budget);

  // Group consecutive same-group records into stages; serial (group=null) = its own stage.
  const stages = [];
  for (const r of records) {
    const last = stages[stages.length - 1];
    if (r.group != null && last && last.group === r.group) last.nodes.push(r);
    else stages.push({ group: r.group, phase: r.phase, nodes: [r] });
  }
  return { records, stages, aggregate, meta };
}

// CLI: node pi-runner/extract.mjs [workflowPath] [--arg k=v ...] — print the realized stages/DAG to
// sanity-check the recording BEFORE a live run. Costs nothing (no model is invoked). With no argv
// path it resolves PI_RUNNER_WORKFLOW from the environment or pi-runner/.env (same key run.mjs reads).
// `--arg k=v` (repeatable, same form as run.mjs) passes workflow args THROUGH, so a STATIC input-arg
// branch is checkable too — e.g. `--arg mode=companion` realizes the companion DAG (verify nodes dropped).
if (process.argv[1] && process.argv[1].endsWith("extract.mjs")) {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const ROOT = path.resolve(HERE, "..");
  const fromEnvFile = (key) => {
    try {
      const m = fs.readFileSync(path.join(HERE, ".env"), "utf8").match(new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, "m"));
      return m ? m[1].replace(/^["']|["']$/g, "") : null;
    } catch { return null; }
  };
  // Parse argv: the first non-flag token is an optional workflow-path override; `--arg k=v` (or
  // `--arg=k=v`), repeatable, are workflow args passed THROUGH to the script — so a flag is never
  // mistaken for the path (the bug this fixes) and a static input-arg branch is realizable.
  const cliArgs = {};
  let pathArg = null;
  const cli = process.argv.slice(2);
  for (let i = 0; i < cli.length; i++) {
    const a = cli[i];
    const kv = a === "--arg" ? cli[++i] : a.startsWith("--arg=") ? a.slice(6) : null;
    if (kv != null) {
      const eq = kv.indexOf("=");
      if (eq > 0) cliArgs[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a && !a.startsWith("-") && pathArg === null) {
      pathArg = a;
    }
  }
  const rel = process.env.PI_RUNNER_WORKFLOW || fromEnvFile("PI_RUNNER_WORKFLOW");
  const wf = pathArg
    || (rel ? (path.isAbsolute(rel) ? rel : path.join(ROOT, rel)) : `${process.cwd()}/.claude/workflows/CHANGEME.js`);
  const { records, stages } = await extractWorkflow(wf, cliArgs);
  console.log(`extracted ${records.length} agent() calls in ${stages.length} stages from\n  ${wf}\n`);
  stages.forEach((s, i) => {
    const tag = s.nodes.length > 1 ? `∥ parallel x${s.nodes.length}` : "serial";
    console.log(`stage ${i + 1}  [${s.phase}]  ${tag}`);
    s.nodes.forEach((n) => console.log(`    - ${(n.label || "(no label)").padEnd(22)} prompt=${n.prompt.length}B  agentType=${n.agentType}  schema=${n.hasSchema}`));
  });
}
