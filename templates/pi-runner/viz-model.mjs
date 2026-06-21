// ── pi-runner/viz-model.mjs ──────────────────────────────────────────────────
// The renderer-AGNOSTIC data layer for visualizing a pi-runner run. GENERIC —
// copy verbatim alongside run.mjs/extract.mjs/status.mjs/watch.mjs.
//
// It joins the two things that already exist, with ZERO new fields written by the
// engine:
//   1. the STATIC DAG  — extractWorkflow() re-runs the workflow .js under recording
//      stubs (no model, no cost) → ordered stages, parallel lanes, phases, labels.
//   2. the RUNTIME      — out/<run>/run-status.json → per-node status/timing/tokens/
//      tools/thinking/artifacts/issues/attempts + the live heartbeat.
// The join key is the node id: run.mjs assigns `slug(label, globalIndex)` over the
// FULL DAG (run.mjs:999); we reproduce the SAME slug here, so extract-node ⋈ status-
// node is exact. Stages, stage durations, pathways and the Gantt are all RECONSTRUCTED
// from data already on disk — nothing is duplicated into a new persisted field.
//
// Both renderers (the HTTP dashboard + the TUI in viz.mjs) consume buildModel()'s
// output. One definition of "the truth", many views.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractWorkflow } from './extract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // pi-runner/ — same dir as .env
const ROOT = path.resolve(HERE, '..');

// EXACT copy of run.mjs:292 — the id is the DAG↔runtime join key; it must match byte-for-byte.
const slug = (label, i) => (label || `node-${i}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const ms = (iso) => (iso ? Date.parse(iso) : null);

// ── per-node IO derivation (the "what does this node read / write, and to/from whom" layer) ──────
// EVERYTHING here is parsed back out of the realized node prompt the extractor already recorded —
// no new persisted field. The `contract()` helper renders DRIVER-ARTIFACTS (exact outputs),
// DRIVER-READ-SCOPE (read surface; its first entry is the project dir) and DRIVER-OWNS into the
// prompt; the SKILL line names the responsibility. We parse those, then recover the file-level data
// flow the way the engine itself works — nodes coordinate ONLY through on-disk files — by matching
// one node's output path against another node's prompt text (an output that appears in node B's
// prompt is an input B reads from the node that produced it).
function parseNodeContract(prompt) {
  const line = (re) => { const m = prompt.match(re); return m ? m[1].trim() : ''; };
  const toks = (s) => s.split(/\s+/).filter(Boolean);
  const readScope = toks(line(/^DRIVER-READ-SCOPE:\s*(.*)$/m));
  return {
    artifacts: toks(line(/^DRIVER-ARTIFACTS:\s*(.*)$/m)),
    owns: toks(line(/^DRIVER-OWNS:\s*(.*)$/m)),
    readScope,
    projectDir: readScope[0] || null, // contract() always lists PROJECT first
    skill: (prompt.match(/SKILL TO LOAD AND FOLLOW:\s*(\S+)/) || [])[1] || null,
    note: line(/^OWNED-PATH NOTE:\s*(.*)$/m) || null,
  };
}
const relTo = (dir, p) => (dir && p.startsWith(dir + '/') ? p.slice(dir.length + 1) : p);
// A produced file is "referenced" by a node's prompt if its full project path appears, or (more
// forgivingly, for path-shaped rels only — never a bare generic name) its project-relative form does.
const promptRefs = (prompt, full, rel) => prompt.includes(full) || (rel.includes('/') && prompt.includes(rel));

// Cache the DAG per (workflow file, mtime, args). extract re-runs the workflow body; on a 2s monitor
// tick over a STATIC DAG that is pure waste. Invalidated automatically when the .js is edited (mtime).
const _dagCache = new Map();
async function extractCached(workflowPath, wfArgs = {}) {
  let mtime = 0;
  try { mtime = fs.statSync(workflowPath).mtimeMs; } catch {}
  const key = `${workflowPath}::${mtime}::${JSON.stringify(wfArgs)}`;
  if (_dagCache.has(key)) return _dagCache.get(key);
  const res = await extractWorkflow(workflowPath, wfArgs);
  _dagCache.set(key, res);
  return res;
}

function fromEnvFile(key) {
  try {
    const m = fs.readFileSync(path.join(HERE, '.env'), 'utf8').match(new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, 'm'));
    return m ? m[1].replace(/^["']|["']$/g, '') : null;
  } catch { return null; }
}

// Resolve the workflow .js the SAME way extract.mjs's CLI does: explicit → env → .env file.
export function resolveWorkflowPath(explicit) {
  if (explicit) return path.isAbsolute(explicit) ? explicit : path.resolve(process.cwd(), explicit);
  const rel = process.env.PI_RUNNER_WORKFLOW || fromEnvFile('PI_RUNNER_WORKFLOW');
  if (!rel) return null;
  return path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
}

export function resolveStatusPath({ run, out = 'out', status } = {}) {
  return path.resolve(status || path.join(process.cwd(), out, run, 'run-status.json'));
}

function readStatus(statusPath) {
  try { return JSON.parse(fs.readFileSync(statusPath, 'utf8')); }
  catch { return null; }
}

// Best-effort partial OUTPUT text for a running (or finished) node — the ONE thing the
// always-on digest does not carry. Reconstructs the assistant text from the slimmed
// events.jsonl delta stream (DEBUG runs only; returns null otherwise — the UI then falls
// back to the digest's textChars count + currentTool). No engine change required.
export function tailNodeOutput({ run, out = 'out', node, maxChars = 1200 } = {}) {
  if (!node) return null;
  const evPath = path.resolve(process.cwd(), out, run, '_pi', `${node}.events.jsonl`);
  let raw;
  try { raw = fs.readFileSync(evPath, 'utf8'); } catch { return null; }
  let text = '';
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    // run.mjs keeps only incremental deltas in the slimmed archive; concatenate text deltas.
    const a = ev?.assistantMessageEvent || ev?.event || ev;
    const d = a?.delta;
    if (ev?.type === 'message_update' && (a?.type === 'text_delta' || a?.type === 'content_delta') && typeof d === 'string') text += d;
  }
  if (!text) return null;
  return { node, chars: text.length, tail: text.slice(-maxChars) };
}

// THE join. extractWorkflow() is async, so this is the single entry point both renderers call.
export async function buildModel({ workflowPath, statusPath, wfArgs = {}, out = 'out', run } = {}) {
  const s = readStatus(statusPath);
  const now = Date.now();

  // 1) STATIC DAG (no model invoked) + exact id assignment over the FULL DAG.
  const stages = [];
  const staticById = {};
  const contractById = {}; // id -> parseNodeContract(prompt)  (for the IO pass below)
  const promptById = {};   // id -> full realized prompt        (transient; not retained on nodes)
  let meta = null;
  let extractErr = null;
  if (workflowPath) {
    try {
      const { stages: raw, meta: m } = await extractCached(workflowPath, wfArgs);
      meta = m || null;
      let gidx = 0;
      raw.forEach((st, si) => {
        const nodeIds = [];
        st.nodes.forEach((nd, lane) => {
          const id = slug(nd.label, gidx++);
          const prompt = nd.prompt || '';
          contractById[id] = parseNodeContract(prompt);
          promptById[id] = prompt;
          staticById[id] = {
            id, label: nd.label || id, phase: nd.phase || st.phase || null,
            agentType: nd.agentType || null, hasSchema: !!nd.hasSchema, group: nd.group ?? null,
            stageIndex: si + 1, lane,
            promptLength: prompt.length,
            promptPreview: prompt.slice(0, 240),
            skill: contractById[id].skill,
          };
          nodeIds.push(id);
        });
        stages.push({ index: si + 1, phase: st.phase || null, parallel: st.nodes.length > 1, nodeIds });
      });
    } catch (e) { extractErr = String(e && e.message || e); }
  }

  // 2) RUNTIME — merge status.nodes by id (the digest may carry nodes the static pass lacks if the
  //    workflow couldn't be re-extracted; and vice-versa before a run starts).
  const ids = new Set([...Object.keys(staticById), ...Object.keys(s?.nodes || {})]);
  const nodes = {};
  for (const id of ids) {
    const st = staticById[id] || { id, label: id, phase: (s?.nodes?.[id]?.phase) || null, stageIndex: null, lane: 0 };
    const rt = (s?.nodes && s.nodes[id]) || {};
    const startMs = ms(rt.startedAt);
    const endMs = ms(rt.endedAt) || (rt.status === 'running' ? now : null);
    nodes[id] = {
      ...st,
      status: rt.status || 'pending',
      modelUsed: rt.modelUsed || null, providerUsed: rt.providerUsed || null,
      startedAt: rt.startedAt || null, endedAt: rt.endedAt || null,
      durationMs: rt.durationMs ?? (startMs && endMs ? endMs - startMs : null),
      startMs, endMs,
      tokens: rt.tokens || null,
      toolCalls: rt.toolCalls ?? (rt.live?.toolCalls || 0),
      toolBreakdown: rt.toolBreakdown || null,
      timeline: rt.timeline || null,          // per-tool / per-turn wall-clock x-ray (run.mjs), if present
      thinking: rt.thinking || null,
      eventCount: rt.eventCount ?? (rt.live?.eventCount || 0),
      artifacts: rt.artifacts || null,
      requiredArtifacts: rt.requiredArtifacts || null,
      issues: rt.issues || [],
      summary: rt.summary || null,
      pipelineFindings: rt.pipelineFindings || [],
      attempts: rt.attempts || null,
      escalated: !!rt.escalated,
      live: rt.live || null,
    };
  }

  // ── per-node IO + file-level data flow (derived; nothing persisted) ──────────────────────────────
  // Runtime exists/bytes for every produced file, keyed by its project-relative path (strip out/<run>/).
  const runId = s?.run || run || null;
  const runPrefix = runId ? `${out}/${runId}/` : null;
  const runtimeByRel = {};
  for (const n of Object.values(nodes)) {
    for (const a of (n.artifacts || [])) {
      if (!a || !a.path) continue;
      const rel = runPrefix && a.path.startsWith(runPrefix) ? a.path.slice(runPrefix.length) : a.path;
      if (!(rel in runtimeByRel)) runtimeByRel[rel] = { exists: !!a.exists, bytes: a.bytes ?? a.size ?? null, path: a.path };
    }
  }
  const descOf = (id) => (meta?.phases || []).find((p) => p && p.title === nodes[id]?.phase)?.detail || null;
  // producer index: a produced file -> the node that writes it (the engine's only hard guarantee).
  const producers = [];
  for (const id of Object.keys(contractById)) {
    for (const full of contractById[id].artifacts) producers.push({ id, full, rel: relTo(contractById[id].projectDir, full) });
  }
  for (const id of Object.keys(nodes)) {
    const c = contractById[id];
    if (!c) continue;
    const node = nodes[id];
    node.description = descOf(id);
    const myPrompt = promptById[id] || '';
    // INPUTS — an upstream output this node's prompt references is a file it reads from that producer.
    const inputs = []; const seenIn = new Set();
    for (const p of producers) {
      if (p.id === id || seenIn.has(p.rel)) continue;
      if (!promptRefs(myPrompt, p.full, p.rel)) continue;
      seenIn.add(p.rel);
      const st = runtimeByRel[p.rel] || null;
      inputs.push({ rel: p.rel, fromNode: p.id, fromLabel: nodes[p.id]?.label || p.id, functionality: descOf(p.id), exists: st?.exists ?? null, bytes: st?.bytes ?? null, path: st?.path || null });
    }
    // OUTPUTS — this node's declared artifacts + which downstream nodes reference each.
    const outputs = c.artifacts.map((full) => {
      const rel = relTo(c.projectDir, full);
      const consumers = Object.keys(promptById).filter((oid) => oid !== id && promptRefs(promptById[oid], full, rel));
      const st = runtimeByRel[rel] || null;
      return { rel, toNodes: consumers, toLabels: consumers.map((oid) => nodes[oid]?.label || oid), functionality: node.description, exists: st?.exists ?? null, bytes: st?.bytes ?? null, path: st?.path || null };
    });
    // PRODUCED — every file this node actually wrote this run (the contract names only the REQUIRED
    // ones; a node may emit more, e.g. W3's 8 sprites under one declared ASSETS.md). All are openable.
    const produced = (node.artifacts || []).map((a) => ({
      rel: runPrefix && a.path?.startsWith(runPrefix) ? a.path.slice(runPrefix.length) : a.path,
      exists: !!a.exists, bytes: a.bytes ?? a.size ?? null, path: a.path,
    })).filter((p) => p.rel);
    node.io = {
      description: node.description, projectDir: c.projectDir, skill: c.skill,
      inputs, outputs, produced,
      externalReads: c.readScope.slice(1), // non-project read roots (skills, templates, catalogs)
      owns: c.owns.map((o) => relTo(c.projectDir, o)),
      note: c.note,
    };
  }

  // If the DAG couldn't be extracted, synthesize stages from runtime phase order so the renderers
  // still have a spine (best-effort: consecutive same-phase nodes group into a stage).
  if (!stages.length && s?.nodes) {
    let cur = null;
    Object.values(nodes).forEach((n) => {
      if (!cur || cur.phase !== n.phase) { cur = { index: stages.length + 1, phase: n.phase, parallel: false, nodeIds: [] }; stages.push(cur); }
      cur.nodeIds.push(n.id);
      n.stageIndex = cur.index;
    });
    stages.forEach((st) => { st.parallel = st.nodeIds.length > 1; });
  }

  // 3) DERIVED — Gantt timeline + stage durations + pathways (all reconstructed, none persisted).
  const runStart = ms(s?.startedAt) || Math.min(...Object.values(nodes).map((n) => n.startMs).filter(Boolean), now);
  const runEnd = s?.done ? (ms(s.updatedAt) || now) : now;
  const timeline = {
    t0: Number.isFinite(runStart) ? runStart : now,
    t1: Number.isFinite(runEnd) ? runEnd : now,
    rows: Object.values(nodes)
      .filter((n) => n.startMs)
      .map((n) => ({ id: n.id, stageIndex: n.stageIndex, lane: n.lane, status: n.status, startMs: n.startMs, endMs: n.endMs || now, durationMs: n.durationMs })),
  };
  const stageTimes = stages.map((st) => {
    const ns = st.nodeIds.map((id) => nodes[id]).filter((n) => n && n.startMs);
    const start = ns.length ? Math.min(...ns.map((n) => n.startMs)) : null;
    const end = ns.length ? Math.max(...ns.map((n) => n.endMs || now)) : null;
    return { index: st.index, durationMs: start && end ? end - start : null };
  });

  const pathways = {
    halted: s?.done === true && s?.ok === false,
    haltNode: Object.values(nodes).find((n) => n.status === 'error' || n.status === 'blocked')?.id || null,
    reused: Object.values(nodes).filter((n) => n.status === 'reused').map((n) => n.id),
    pending: Object.values(nodes).filter((n) => n.status === 'pending').map((n) => n.id),
    running: Object.values(nodes).filter((n) => n.status === 'running').map((n) => n.id),
    escalated: Object.values(nodes).filter((n) => n.escalated).map((n) => n.id),
  };

  const totals = s?.totals || {
    nodes: Object.keys(nodes).length,
    toolCalls: Object.values(nodes).reduce((a, n) => a + (n.toolCalls || 0), 0),
    tokensBillable: Object.values(nodes).reduce((a, n) => a + (n.tokens?.billable || 0), 0),
  };
  const cost = Object.values(nodes).reduce((a, n) => a + (n.tokens?.cost || 0), 0);

  return {
    run: {
      id: s?.run || run || null,
      source: s?.source || (workflowPath ? path.basename(workflowPath) : null),
      provider: s?.provider || null, model: s?.model || null,
      done: !!s?.done, ok: s?.ok ?? null,
      debug: !!s?.debug, sandbox: !!s?.sandbox, escalate: s?.escalate || false,
      startedAt: s?.startedAt || null, updatedAt: s?.updatedAt || null,
      elapsedMs: s?.elapsedMs ?? null, durationMs: s?.durationMs ?? null,
      stage: s?.stage || null,
      staleMs: s?.updatedAt ? now - ms(s.updatedAt) : null,
      missing: !s,
      extractErr,
    },
    stages, stageTimes, nodes, timeline, pathways,
    totals: { ...totals, cost },
  };
}

// ── multi-run / namespace discovery (the TUI monitor's list layer) ─────────────
// A NAMESPACE is the outermost divider — one project root. Its THREADS are that
// project's runs (out/<id>/run-status.json). summarizeRun is EFFICIENT (no extract): it
// powers the namespace/thread columns; only drilling into a thread calls buildModel.
function envKeyOf(file, key) {
  try {
    const m = fs.readFileSync(file, 'utf8').match(new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, 'm'));
    return m ? m[1].replace(/^["']|["']$/g, '') : null;
  } catch { return null; }
}

// Per-namespace workflow resolution (each project has its own pi-runner/.env).
export function resolveWorkflowForRoot(rootDir) {
  for (const f of [path.join(rootDir, 'pi-runner', '.env'), path.join(rootDir, '.env')]) {
    const rel = envKeyOf(f, 'PI_RUNNER_WORKFLOW');
    if (rel) return path.isAbsolute(rel) ? rel : path.join(rootDir, rel);
  }
  return null;
}

// ── the global registry (zero-arg `pi-tui`) ────────────────────────────────────
// One file, ~/.pi-runner/registry.json, that every run.mjs upserts into (keyed by abs project
// dir). The TUI reads it so a bare `pi-tui` lists every project that has ever run — no flags, no
// per-repo config. registerProject/unregister also back the `pi-tui add|rm` commands.
export function registryPath() {
  return process.env.PI_RUNNER_REGISTRY || path.join(os.homedir(), '.pi-runner', 'registry.json');
}
function readRegistry() {
  try { return JSON.parse(fs.readFileSync(registryPath(), 'utf8')); } catch { return { namespaces: {} }; }
}
function writeRegistry(reg) {
  const p = registryPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(reg, null, 2));
}
export function listRegistered() {
  return Object.entries(readRegistry().namespaces || {}).map(([dir, v]) => ({ dir, ...v }));
}
export function registerProject(dir, { name, out = 'out' } = {}) {
  const abs = path.resolve(dir);
  const reg = readRegistry();
  reg.namespaces ??= {};
  reg.namespaces[abs] = { name: name || path.basename(abs), out, lastSeen: new Date().toISOString() };
  writeRegistry(reg);
  return abs;
}
export function unregisterProject(dir) {
  const abs = path.resolve(dir);
  const reg = readRegistry();
  if (reg.namespaces) delete reg.namespaces[abs];
  writeRegistry(reg);
  return abs;
}

const TERMINAL_OK = new Set(['ok', 'reused', 'gap', 'dry']);
export function summarizeRun(statusPath) {
  const s = readStatus(statusPath);
  if (!s) return null;
  const nodes = Object.values(s.nodes || {});
  const nodesDone = nodes.filter((n) => TERMINAL_OK.has(n.status)).length;
  const running = nodes.find((n) => n.status === 'running');
  const updatedMs = ms(s.updatedAt);
  const now = Date.now();
  return {
    run: s.run, statusPath,
    state: s.done ? (s.ok === false ? 'failed' : 'done') : 'running',
    done: !!s.done, ok: s.ok ?? null,
    stageIndex: s.stage?.index ?? null, stageTotal: s.stage?.total ?? null, phase: s.stage?.phase ?? null,
    runningNode: running?.id || null, runningTool: running?.live?.currentTool || null, runningStalled: !!running?.live?.stalled,
    nodesDone, nodesTotal: nodes.length,
    frac: s.done ? 1 : (nodes.length ? nodesDone / nodes.length : 0),
    elapsedMs: s.done ? (s.durationMs ?? s.elapsedMs) : (s.elapsedMs ?? null),
    tokensBillable: nodes.reduce((a, n) => a + (n.tokens?.billable || 0), 0),
    cost: nodes.reduce((a, n) => a + (n.tokens?.cost || 0), 0),
    provider: s.provider || null, model: s.model || null,
    updatedAt: s.updatedAt || null, staleMs: updatedMs ? now - updatedMs : null,
    errorNode: nodes.find((n) => n.status === 'error' || n.status === 'blocked')?.id || null,
  };
}

function listThreads(dir, out) {
  const outDir = path.join(dir, out);
  let entries = [];
  try { entries = fs.readdirSync(outDir, { withFileTypes: true }); } catch { return []; }
  const threads = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const sp = path.join(outDir, e.name, 'run-status.json');
    if (fs.existsSync(sp)) { const sum = summarizeRun(sp); if (sum) threads.push(sum); }
  }
  return threads.sort((a, b) => (ms(b.updatedAt) || 0) - (ms(a.updatedAt) || 0)); // newest first
}

// registry: true pulls every globally-registered project (the zero-arg `pi-tui` source).
// roots: [{name?, dir}]  ·  scan: a parent dir whose immediate children with an out/ become namespaces.
// All three compose; entries are de-duplicated by absolute dir.
export function discoverNamespaces({ roots = [], scan = null, out = 'out', registry = false } = {}) {
  const list = [];
  const seen = new Set();
  // workflow precedence: the abs path run.mjs recorded in the registry (correct even when cwd≠root,
  // where the .env scan can't find pi-runner/.env from the subdir) → else the per-namespace .env scan
  // (single-package projects, scan/root entries, registry rows written before this field existed). A
  // recorded-but-now-missing file falls back to the scan rather than blanking the static DAG.
  const add = (name, dir, outName = out, workflow = null) => {
    const abs = path.resolve(dir);
    if (seen.has(abs)) return;
    seen.add(abs);
    const wf = (workflow && fs.existsSync(workflow)) ? workflow : resolveWorkflowForRoot(abs);
    list.push({ name: name || path.basename(abs), dir: abs, out: outName, workflow: wf, threads: listThreads(abs, outName) });
  };
  if (registry) {
    // Auto-heal: a registered project whose out/ has vanished is silently skipped (stale entry).
    for (const r of listRegistered()) if (fs.existsSync(path.join(r.dir, r.out || out))) add(r.name, r.dir, r.out || out, r.workflow);
  }
  if (scan) {
    let kids = [];
    try { kids = fs.readdirSync(scan, { withFileTypes: true }); } catch {}
    for (const k of kids) if (k.isDirectory() && fs.existsSync(path.join(scan, k.name, out))) add(k.name, path.join(scan, k.name));
  }
  for (const r of roots) add(r.name, r.dir);
  if (!list.length) add(null, process.cwd());
  // Surface active work: namespaces with running threads first, then alphabetical.
  list.sort((a, b) => {
    const ar = a.threads.filter((t) => t.state === 'running').length;
    const br = b.threads.filter((t) => t.state === 'running').length;
    return ar !== br ? br - ar : a.name.localeCompare(b.name);
  });
  return list;
}
