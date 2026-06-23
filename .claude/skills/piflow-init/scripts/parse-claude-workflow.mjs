#!/usr/bin/env node
// parse-claude-workflow.mjs — the Claude-Workflow-`.js` → @piflow/core `WorkflowSpec` bridge.
//
// Mechanical half of the PORT condition (see ../references/parse-claude-workflow.md). It does NOT
// reinvent parsing: it REUSES the repo's `extract.mjs` (run the workflow body under recording stubs →
// the exact realized prompts + DAG grouping) and the SDK's own `parseMarkers`/`compile`, then maps the
// recorded nodes into a typed `WorkflowSpec` and PROVES the result by compiling it.
//
// Usage:
//   node parse-claude-workflow.mjs <workflow.js> [--arg k=v ...] [-o out.spec.json]
// Exit 0 = a WorkflowSpec was emitted AND it compiles with the recorded staging preserved (the oracle).
// Exit non-zero = extraction or the compile self-check failed (the spec is NOT trustworthy — do not use it).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// skill is <repo>/.claude/skills/workflow-intake/scripts → the repo root is four levels up
// (scripts → workflow-intake → skills → .claude → <repo>).
const REPO_ROOT = path.resolve(HERE, '../../../..');
const EXTRACT = path.join(REPO_ROOT, 'templates/pi-runner/extract.mjs');
const CORE = path.join(REPO_ROOT, 'packages/core/dist/index.js');

function die(msg) {
  console.error(`parse-claude-workflow: ${msg}`);
  process.exit(1);
}

// ── argv ──────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let workflowPath = null;
let outPath = null;
const wfArgs = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--arg') {
    const kv = argv[++i] ?? '';
    const eq = kv.indexOf('=');
    if (eq > 0) wfArgs[kv.slice(0, eq)] = kv.slice(eq + 1);
  } else if (a === '-o' || a === '--out') {
    outPath = argv[++i] ?? null;
  } else if (!a.startsWith('-') && workflowPath === null) {
    workflowPath = a;
  }
}
if (!workflowPath) die('usage: parse-claude-workflow.mjs <workflow.js> [--arg k=v ...] [-o out.spec.json]');
workflowPath = path.resolve(workflowPath);
if (!fs.existsSync(workflowPath)) die(`workflow not found: ${workflowPath}`);
if (!fs.existsSync(CORE)) die(`@piflow/core dist not found at ${CORE} — run \`npx tsc -b\` in the repo first`);

// ── load the engine + the SDK (repo-relative, cwd-independent) ──────────────────────────────────────
const { extractWorkflow } = await import(pathToFileURL(EXTRACT).href);
const { parseMarkers, compile, tryCompile, slugify } = await import(pathToFileURL(CORE).href);

// ── strip the machine markers from the prose (the SDK RE-EMITS them from io, so keeping them in the ──
// prompt would duplicate them in the spawned pi prompt). Only DRIVER-* lines go; the human/LLM-facing
// Definition-of-Done prose stays.
function stripMarkers(prompt) {
  return prompt
    .split('\n')
    .filter((line) => !/^\s*DRIVER-[A-Z0-9-]+\s*:/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── extract → recorded stages (each is one serial node or one parallel group) ──────────────────────
const { stages, meta } = await extractWorkflow(workflowPath, wfArgs);
if (!stages.length) die('extraction recorded ZERO agent() calls — is this a Claude Code Workflow .js?');

// Flatten in execution order; remember each node's stage index so we can chain dependsOn to the prior
// stage (this preserves the EXACT recorded DAG without needing data-flow inference — the mechanical port).
const flat = [];
stages.forEach((stage, sIdx) => stage.nodes.forEach((rec) => flat.push({ rec, sIdx })));
const labelOf = flat.map(({ rec }, i) => rec.label || `node-${i}`);
// Predict the id `compile` will assign each node so dependsOn can reference it. MUST mirror tryCompile
// EXACTLY: slugify(label, flatIndex), then dedup collisions with a -2/-3… suffix.
const used = new Set();
const idOf = labelOf.map((label, i) => {
  let id = slugify(label, i);
  const base = id;
  let n = 1;
  while (used.has(id)) { n++; id = `${base}-${n}`; }
  used.add(id);
  return id;
});
const idsByStage = new Map();
flat.forEach(({ sIdx }, i) => {
  if (!idsByStage.has(sIdx)) idsByStage.set(sIdx, []);
  idsByStage.get(sIdx).push(idOf[i]);
});

const nodes = flat.map(({ rec, sIdx }, i) => {
  const m = parseMarkers(rec.prompt);
  const artifacts = (m.artifacts ?? []).map((p) => {
    const s = (m.schema ?? []).find((x) => x.path === p);
    return s ? { path: p, schema: s.schema } : { path: p };
  });
  const io = {
    reads: [], // the mechanical port carries the DAG via dependsOn; data-flow reads are a refinement (see the reference)
    produces: [],
    artifacts,
    ...(sIdx > 0 ? { dependsOn: idsByStage.get(sIdx - 1) } : {}),
    ...(m.checks ? { checks: m.checks } : {}),
    ...(m.policy ? { policy: m.policy } : {}),
    ...(m.returnMode ? { returnMode: m.returnMode } : {}),
    ...(m.fillSentinel ? { fillSentinel: m.fillSentinel } : {}),
  };
  const node = {
    label: rec.label || `node-${i}`,
    prompt: stripMarkers(rec.prompt),
    tools: {
      ...(m.tools ? { allow: m.tools } : {}),
      ...(m.excludeTools ? { deny: m.excludeTools } : {}),
    },
    io,
  };
  if (rec.agentType) node.agentType = rec.agentType;
  if (m.owns || m.readScope) {
    node.sandbox = { ...(m.readScope ? { read: m.readScope } : {}), ...(m.owns ? { write: m.owns } : {}) };
  }
  return node;
});

const spec = {
  meta: { name: meta?.name || path.basename(workflowPath, '.js'), description: meta?.description || '' },
  nodes,
};

// ── ORACLE: the spec must COMPILE, and the compiled staging must MATCH the recording (else the port ──
// silently lost the DAG). This is the self-check that makes a 0 exit mean "trustworthy", not "ran".
const res = tryCompile(spec);
if (res.errors.length || !res.workflow) {
  die(`emitted spec does NOT compile:\n  - ${res.errors.join('\n  - ') || '(no workflow returned)'}`);
}
const wf = res.workflow;
const problems = [];
if (wf.stages.length !== stages.length) {
  problems.push(`stage count: recorded ${stages.length}, compiled ${wf.stages.length}`);
}
stages.forEach((stage, i) => {
  const recorded = new Set(idsByStage.get(i));
  const compiled = new Set(wf.stages[i]?.nodeIds ?? []);
  const same = recorded.size === compiled.size && [...recorded].every((id) => compiled.has(id));
  if (!same) problems.push(`stage ${i + 1} membership: recorded {${[...recorded]}} vs compiled {${[...compiled]}}`);
});
if (problems.length) {
  die(`spec compiles but the DAG DRIFTED from the recording:\n  - ${problems.join('\n  - ')}`);
}

// ── emit ────────────────────────────────────────────────────────────────────────────────────────────
const json = JSON.stringify(spec, null, 2) + '\n';
if (outPath) {
  fs.writeFileSync(path.resolve(outPath), json);
  console.error(`✓ ${nodes.length} nodes in ${wf.stages.length} stages → ${outPath} (compiles; staging preserved)`);
} else {
  process.stdout.write(json);
  console.error(`✓ ${nodes.length} nodes in ${wf.stages.length} stages (compiles; staging preserved)`);
}
