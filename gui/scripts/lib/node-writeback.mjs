// (SA-E · expert-representations) The pure write-back core for the GUI drag-to-compose editor —
// shared by the Vite plugin (gui/vite.config.ts `piflowNodeWriteback`) and its test, so the
// "config is the single source of truth" contract is unit-testable WITHOUT standing up Vite or a
// browser. The plugin owns HTTP (route match, run→template resolution, body read); THIS owns the two
// load-bearing decisions: is the target node-id a containment-safe slug, and what EXACT bytes land in
// `<template>/nodes/<id>/node.json` after a chip is dropped.
//
// INVARIANT (worker-types.md §"GUI — drag-to-compose"): every GUI edit is a mutation to the JSON the
// run reads. A dropped gate chip is NOT GUI-local state — it appends a gate to that node's authored
// `op[]` lane (the gate pipeline lives in `op[]`, build-spec §"op[] mapping"). We mutate the per-repo
// TEMPLATE `node.json` on disk; never the GUI bundle, never a ~/.piflow snapshot (the data-boundary rule).
//
// We CONSUME core's schemas (never modify them): the authoring gate kinds + their op[] lowering are
// SA-B's `lowerGate` (packages/core gate-authoring.ts); the on-disk node shape is validated against
// SA's `nodeSchema` (node.schema.ts) with the SAME ajv validator `loadTemplate` uses (loader.ts:191).
// We re-implement NOTHING of the lowering math here — the chip→op[] mapping below is the GUI-facing
// projection of that exact table, kept tiny so a power-user drop round-trips through the loader.

import { mkdir, readFile, writeFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";

// A containment-safe node id slug: starts alnum, then letters/digits/_/-/. only, no `..` segment — so
// the join below can never escape `<template>/nodes/`. Mirrors checkpoint-reply.mjs's SAFE_NODE_ID.
const SAFE_NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** True iff `id` is a containment-safe node id (the write stays inside `<template>/nodes/<id>/`). */
export function isSafeNodeId(id) {
  return typeof id === "string" && id.length > 0 && id.length <= 200 && SAFE_NODE_ID.test(id) && !id.includes("..");
}

/** The on-disk path of a node's authored config in a template. The ONLY file this module ever writes. */
export function nodeJsonPathFor(templateDir, nodeId) {
  return join(templateDir, "nodes", nodeId, "node.json");
}

// ── The chip → op[] projection ────────────────────────────────────────────────
//
// The GUI palette drops one of three GATE chips onto a node. Each lowers to the SAME op[] / checkpoint
// shape SA-B's `lowerGate` emits (gate-authoring.ts), expressed here as the minimal authored entry so
// the result re-loads through the template loader unchanged:
//
//   execution → op{ when:'post', run:{cmd,args?,cwd?}, onFailure }
//   judge     → op{ when:'on-failure', action:{kind:'rerouteTo', node:<self>, max} } + a PERSISTED judgeGate
//   human     → the G5 `checkpoint` field on the node (NOT an op[] entry — types.ts CheckpointSpec)
//   floor     → op{ when:'post', gate:{kind, path?, param?, advisory?}, onFailure }     (structural floor)
//
// JUDGE auto-expansion is REAL (no longer deferred): a judge chip PERSISTS the `judgeGate` descriptor
// (judgeTier/rubric/threshold/policy — the `JudgeGate` shape, gate-authoring.ts) onto node.json in the
// loader-consumable `judgeGate` field. The template LOADER's `materializeJudgeNodes` (judge/materialize.ts)
// reads it and INSERTS a real `<id>__judge` pi node wired into the DAG at load time — so the GUI never
// hand-writes a sibling node dir; it just records the gate intent and the loader does the multi-node wiring.
// We ALSO append the producer-side `rerouteTo` op (the judge-fail loop) so the producer carries it directly.

const ONFAIL = new Set(["block", "warn", "stop"]); // the schema's policyAction enum (node.schema.ts $defs.policyAction)

/**
 * Build the authored `op[]` entries (and/or a `checkpoint` patch) for one dropped gate chip. PURE — the
 * GUI-facing projection of SA-B's `lowerGate`. Returns `{ ops, checkpointPatch?, pendingJudgeNode? }`.
 * Throws `WritebackError` on a malformed chip (the test asserts the throw).
 */
export function chipToOps(chip, nodeId) {
  if (!chip || typeof chip !== "object") throw new WritebackError("chip must be an object");
  const onFailure = ONFAIL.has(chip.onFailure) ? chip.onFailure : "block";
  switch (chip.kind) {
    case "execution": {
      if (typeof chip.cmd !== "string" || !chip.cmd.length) throw new WritebackError("execution gate requires a non-empty `cmd`");
      const run = { cmd: chip.cmd };
      if (Array.isArray(chip.args) && chip.args.length) run.args = chip.args.map(String);
      if (typeof chip.cwd === "string" && chip.cwd.length) run.cwd = chip.cwd;
      return { ops: [{ when: "post", run, onFailure }] };
    }
    case "floor": {
      if (typeof chip.check !== "string" || !chip.check.length) throw new WritebackError("floor gate requires a `check` kind");
      const gate = { kind: chip.check };
      if (typeof chip.path === "string" && chip.path.length) gate.path = chip.path;
      if (chip.param !== undefined) gate.param = chip.param;
      if (chip.advisory === true) gate.advisory = true;
      return { ops: [{ when: "post", gate, onFailure }] };
    }
    case "judge": {
      // Producer-side reroute op (the one op the gate appends to THIS node). max = retry budget (default 1).
      const max = Number.isInteger(chip.retryMax) && chip.retryMax > 0 ? chip.retryMax : 1;
      const ops = [{ when: "on-failure", action: { kind: "rerouteTo", node: nodeId, max } }];
      // PERSIST the judge GATE descriptor (the `JudgeGate` shape minus `kind`) onto node.json — the loader's
      // `materializeJudgeNodes` consumes it to insert a real `<id>__judge` node. judgeTier+rubric are required
      // by the schema; threshold/policy are optional. We carry exactly what the loader needs (no GUI-local stub).
      if (typeof chip.judgeTier !== "string" || !chip.judgeTier.length) throw new WritebackError("judge gate requires a non-empty `judgeTier`");
      if (typeof chip.rubric !== "string" || !chip.rubric.length) throw new WritebackError("judge gate requires a non-empty `rubric`");
      const judgeGate = { judgeTier: chip.judgeTier, rubric: chip.rubric };
      if (typeof chip.threshold === "string" && chip.threshold.length) judgeGate.threshold = chip.threshold;
      // The reroute budget rides the gate's policy so the loader's lowering re-derives the SAME rerouteTo op.
      judgeGate.policy = { retryMax: max };
      if (chip.retryScope === "feedback" || chip.retryScope === "fix") judgeGate.policy.retryScope = chip.retryScope;
      return { ops, judgeGate };
    }
    case "human": {
      // Human (HITL) gate → the G5 `checkpoint` field (NOT an op[] entry — CheckpointSpec, types.ts).
      const ckKind = chip.checkpointKind === "input" || chip.checkpointKind === "select" ? chip.checkpointKind : "confirm";
      const question = typeof chip.question === "string" && chip.question.length ? chip.question : "Approve this node's output?";
      const checkpointPatch = { kind: ckKind, prompt: question };
      if (ckKind === "select" && Array.isArray(chip.choices) && chip.choices.length) checkpointPatch.choices = chip.choices.map(String);
      return { ops: [], checkpointPatch };
    }
    default:
      throw new WritebackError(`unknown gate chip kind "${chip.kind}" (expected execution | floor | judge | human)`);
  }
}

/** Thrown for a malformed edit (bad chip, bad node, schema-invalid result). Carries a list of reasons. */
export class WritebackError extends Error {
  constructor(message, reasons) {
    super(message);
    this.name = "WritebackError";
    this.reasons = reasons ?? [message];
  }
}

/**
 * Apply a parsed gate-chip edit onto a node.json object IN MEMORY and return the mutated copy. PURE (no
 * I/O) so the test can assert the exact bytes without a filesystem. Appends the chip's op[] entries to
 * the node's existing `op[]` lane (creating it if absent) and/or merges the human-gate checkpoint patch.
 *
 *   - `node`   the parsed current node.json object.
 *   - `nodeId` the node id (for judge reroute self-targeting + safety).
 *   - `edit`   `{ chip }` — the dropped chip descriptor.
 */
export function applyEdit(node, nodeId, edit) {
  if (!node || typeof node !== "object" || Array.isArray(node)) throw new WritebackError("node.json must be a JSON object");
  if (!edit || typeof edit !== "object") throw new WritebackError("edit must be { chip }");
  const { ops, checkpointPatch, judgeGate } = chipToOps(edit.chip, nodeId);
  const next = { ...node };
  if (ops.length) next.op = [...(Array.isArray(node.op) ? node.op : []), ...ops];
  if (checkpointPatch) next.checkpoint = { ...(node.checkpoint && typeof node.checkpoint === "object" ? node.checkpoint : {}), ...checkpointPatch };
  // PERSIST the judge gate descriptor onto node.json — the loader materializes a real `<id>__judge` node
  // from it (judge/materialize.ts). A second judge chip OVERWRITES the prior gate (one judge per producer).
  if (judgeGate) next.judgeGate = judgeGate;
  return { node: next, judgeGate };
}

/**
 * READ a node's authored config from the template — the GUI's badge source-of-truth (the run-view
 * distillation does NOT carry the template `op[]`/tier/loadout, so the badge reads the authored file
 * directly). Returns the parsed object, or throws if absent/unparseable.
 */
export async function readNodeConfig(templateDir, nodeId) {
  if (!isSafeNodeId(nodeId)) throw new WritebackError("missing or unsafe nodeId");
  const file = nodeJsonPathFor(templateDir, nodeId);
  let raw;
  try { raw = await readFile(file, "utf8"); } catch { throw new WritebackError(`no node.json for "${nodeId}" at ${file}`); }
  try { return JSON.parse(raw); } catch { throw new WritebackError(`node.json for "${nodeId}" is not valid JSON`); }
}

/**
 * The full write-back: read the template node.json, apply the dropped chip, VALIDATE the result against
 * core's `nodeSchema` (the SAME gate `loadTemplate` runs — so a malformed edit is rejected BEFORE it
 * lands, never producing a template that won't compile), then ATOMICALLY persist it (write a temp file +
 * rename). Returns `{ ok, status, body }` mirroring the HTTP response the plugin sends, so the test
 * asserts the SAME decisions the endpoint makes.
 *
 *   - 400  malformed edit / unsafe node id / schema-invalid result (NOTHING written);
 *   - 404  the node has no node.json in this template;
 *   - 200  + the mutated config on success.
 *
 * @param templateDir  the per-repo TEMPLATE dir (`<wf>/template`) — resolved by the plugin from the run.
 * @param nodeId       the target node id.
 * @param edit         `{ chip }` — the dropped chip.
 * @param validate     a `(schema, data) => { ok, errors }` validator (core's `defaultSchemaValidator`).
 *                     Injected so the test runs without ajv resolution; when null the schema gate is
 *                     SKIPPED with a warning (degrade-don't-brick — mirrors loader's optional-ajv stance,
 *                     BUT the plugin always passes the real validator, so production always validates).
 */
export async function writeNodeEdit(templateDir, nodeId, edit, validate) {
  if (!isSafeNodeId(nodeId)) return { ok: false, status: 400, body: { error: "missing or unsafe nodeId" } };

  let node;
  try {
    node = await readNodeConfig(templateDir, nodeId);
  } catch (e) {
    return { ok: false, status: 404, body: { error: String(e?.message ?? e) } };
  }

  let mutated, judgeGate;
  try {
    ({ node: mutated, judgeGate } = applyEdit(node, nodeId, edit));
  } catch (e) {
    return { ok: false, status: 400, body: { error: String(e?.message ?? e), reasons: e?.reasons } };
  }

  // VALIDATE against the SAME nodeSchema loadTemplate uses — reject a malformed result before it lands.
  if (validate) {
    const { ok, errors } = validate(nodeSchemaFor(), mutated);
    if (!ok) return { ok: false, status: 400, body: { error: "edit would make node.json invalid", reasons: errors } };
  }

  const file = nodeJsonPathFor(templateDir, nodeId);
  const bytes = JSON.stringify(mutated, null, 2) + "\n";
  await atomicWrite(file, bytes);
  return { ok: true, status: 200, body: { ok: true, node: mutated, ...(judgeGate ? { judgeGate } : {}) }, file };
}

/**
 * (Slice 1.5) RUN-FIRST bake: apply a dropped gate chip to THIS RUN's `.pi/run.json` (its
 * `nodes[<id>].config.gates`) WITHOUT touching the template — the "applied to this run" default. The gate
 * lands on the run's DISPLAY surface (observe's `buildRunView` reads `config.gates` VERBATIM off run.json,
 * ungated by node status); it is NOT promoted to the template until the user chooses to (that is the durable
 * `writeNodeEdit` path). Mirrors `writeNodeEdit`'s decisions (safe id, apply, schema-validate, 400/404), but
 * the fold that produces the run's `config.gates` is core's canonical `summarizeGates` (INJECTED, like
 * `validate`) so a run-baked gate is byte-shaped exactly like a real run would have written it — no drift.
 *
 * A run bake is DISPLAY-ONLY: it does NOT feed the journal-driven resume/re-run (that is envelope-hash driven,
 * `.pi/journal.json`, untouched here). It makes the authored gate visible on this run's graph/HUD immediately.
 * The gate is applied ON TOP OF the CURRENT template config, so `config.gates` becomes "the template's gates +
 * this edit" for this run (a run-scoped preview of the template edit). Structural judge materialization (the
 * `<id>__judge` node) is NOT added to the run graph — the judge's user-facing effect (reroute-on-fail) is
 * folded into `config.gates` by `summarizeGates`, which is the honest run-scoped representation.
 *
 *   - `runDir`      the run dir (`<wf>/runs/<id>`) whose `.pi/run.json` we mutate.
 *   - `templateDir` the per-repo TEMPLATE dir — the CURRENT authored config the edit is applied ON TOP of.
 *   - `nodeId`      the target node (must be a run node AND a containment-safe slug).
 *   - `edit`        `{ chip }` — the dropped chip.
 *   - `validate`    core's `defaultSchemaValidator` (the mutated node must still satisfy nodeSchema, else 400).
 *   - `summarize`   core's `summarizeGates` (the canonical `op[]` + checkpoint → GateSummary fold).
 */
export async function bakeNodeEditToRun(runDir, templateDir, nodeId, edit, validate, summarize) {
  if (!isSafeNodeId(nodeId)) return { ok: false, status: 400, body: { error: "missing or unsafe nodeId" } };

  // 1. the node's CURRENT authored config (template) is the base the edit applies on top of.
  let node;
  try {
    node = await readNodeConfig(templateDir, nodeId);
  } catch (e) {
    return { ok: false, status: 404, body: { error: String(e?.message ?? e) } };
  }

  // 2. apply the chip in memory (validates the chip; throws WritebackError on malformed → 400).
  let mutated;
  try {
    ({ node: mutated } = applyEdit(node, nodeId, edit));
  } catch (e) {
    return { ok: false, status: 400, body: { error: String(e?.message ?? e), reasons: e?.reasons } };
  }

  // 3. the mutated node must still satisfy nodeSchema (the SAME gate the template write runs).
  if (validate) {
    const { ok, errors } = validate(nodeSchemaFor(), mutated);
    if (!ok) return { ok: false, status: 400, body: { error: "edit would make node.json invalid", reasons: errors } };
  }

  // 4. the run's `.pi/run.json` — the target must be a real run node.
  const runJsonFile = join(runDir, ".pi", "run.json");
  let runJson;
  try {
    runJson = JSON.parse(await readFile(runJsonFile, "utf8"));
  } catch {
    return { ok: false, status: 404, body: { error: `no run.json for this run at ${runJsonFile}` } };
  }
  const nodes = runJson && typeof runJson === "object" ? runJson.nodes : undefined;
  if (!nodes || typeof nodes !== "object" || !nodes[nodeId]) {
    return { ok: false, status: 404, body: { error: `node "${nodeId}" is not in this run` } };
  }

  // 5. fold the mutated node → the canonical GateSummary, and set it on the run node's config (verbatim the
  //    shape a real run's finishNode would have written). Preserve any other config fields already recorded.
  const gates = typeof summarize === "function" ? summarize(mutated) : undefined;
  const rec = nodes[nodeId];
  const prevConfig = rec.config && typeof rec.config === "object" ? rec.config : {};
  rec.config = { ...prevConfig, ...(gates ? { gates } : {}) };

  // 6. atomic write-back of run.json (the same atomic write the template path uses).
  await atomicWrite(runJsonFile, JSON.stringify(runJson, null, 2) + "\n");
  return { ok: true, status: 200, body: { ok: true, node: mutated, ...(gates ? { gates } : {}), scope: "run" }, file: runJsonFile };
}

// The schema object is injected by the plugin (it imports core's dist); in the test we pass the validator
// a closed-over schema. This indirection keeps THIS lib free of a static core import (esbuild never
// bundles core into the Vite config — same reason the index/checkpoint libs load core by absolute path).
let _nodeSchema = null;
/** Set the `nodeSchema` object this module validates against (the plugin/test injects core's). */
export function setNodeSchema(schema) { _nodeSchema = schema; }
function nodeSchemaFor() {
  if (!_nodeSchema) throw new WritebackError("nodeSchema not set — call setNodeSchema(core.nodeSchema) before writeNodeEdit");
  return _nodeSchema;
}

/** Atomic-ish write: write to a sibling temp then rename over the target (rename is atomic on the same fs). */
async function atomicWrite(file, bytes) {
  const dir = file.slice(0, file.lastIndexOf("/")) || ".";
  await mkdir(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, bytes);
  try {
    await rename(tmp, file);
  } catch (e) {
    // rename can fail across odd mounts; fall back to a direct write so the edit still lands.
    await writeFile(file, bytes);
    try { await stat(tmp).then(() => writeFile(tmp, "")); } catch { /* best-effort cleanup */ }
    throw e;
  }
}
