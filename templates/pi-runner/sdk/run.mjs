#!/usr/bin/env node
// The SDK consumer entrypoint — config → bridge → compile → runWorkflow, on the in-place
// LocalSandboxProvider. The @piflow/core counterpart to pi-runner/run.mjs (which stays the LIVE
// engine until Phase 3 proves parity — both drive the SAME workflow .js, no fork). See
// design/sdk-convergence-phase2.md (STATUS + HANDOFF) for the locked wiring this implements.
//
// Run:   node pi-runner/sdk/run.mjs --run <id> --arg prompt="…" [--arg projectDir=out/<id>]
//                                   [--arg mode=companion] [--from <p>] [--until <p>] [--dry-run]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { compile, runWorkflow, DefaultToolRegistry, auditWorkflow } from "@piflow/core";
import { buildWorkflowSpec } from "./bridge.mjs";
import { LocalSandboxProvider } from "./local-provider.mjs";
import { piCommand } from "./command.mjs";
import { loadConfig } from "./config.mjs";

/**
 * The pi-runner RETURN PROTOCOL — appended to EVERY node prompt at runtime, verbatim from run.mjs
 * (run.mjs:1329, applied at run.mjs:1558 `node.prompt + returnProtocol(label)`). This is a RUNTIME
 * prompt addition, NOT part of the workflow .js, so it lives here (the consumer's runtime layer), not
 * in the bridge (which must stay faithful to the workflow-intake PORT oracle that bridge.test.mjs
 * pins). LOAD-BEARING for parity: it is the explicit "after WRITING all your output files, END with
 * the fenced json block; status=ok REQUIRES them on disk; never exit clean having skipped a required
 * artifact" instruction that drives the model to WRITE — without it the model returns inline and skips
 * the write (the never-write divergence gate 3 surfaced).
 */
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

/**
 * A permissive registry that registers EVERY pi-native tool the workflow declares (the union of all
 * nodes' DRIVER-TOOLS / DRIVER-EXCLUDE bare names) as a `builtin`, addressed by its bare name. The SDK
 * registry addresses builtins as `fs:read`/`sh:bash`, but game-omni's markers carry BARE pi names
 * (`read`/`write`/`bash`/`find`/`submit_result`), so the runner's pre-spawn `verifyToolBinding` would
 * mark them MISSING → `blocked`. The SDK tool-binding layer (L1) is OUT OF SCOPE for game-omni (it
 * uses pi's NATIVE tools — migration plan), so we make that bind-check a no-op by registering the
 * declared names as builtins. Dynamic (no hard-coded list); each bare name → a unique piName (no
 * collision). `resolve()` then yields the bare piNames (piCommand ignores them and reads node.tools
 * directly, so this only satisfies the gate).
 */
export function nativeToolRegistry(wf) {
  const names = new Set();
  for (const id of Object.keys(wf.nodes)) {
    const t = wf.nodes[id].tools || {};
    for (const n of t.allow || []) names.add(n);
    for (const n of t.deny || []) names.add(n);
  }
  const entries = [...names].map((n) => ({
    address: n, source: "builtin", piName: n, description: n, origin: { kind: "native" },
  }));
  return new DefaultToolRegistry(entries.length ? entries : undefined);
}

/**
 * Build the runnable pieces from a resolved config — the SHARED wiring the CLI and the smoke test both
 * exercise (so the test proves the REAL entrypoint, not a copy). Returns the compiled+staged workflow,
 * the in-place provider, the permissive registry, and the resolved bases.
 */
export async function buildRun(cfg) {
  const BASE_ROOT = cfg.baseRoot;
  // The project base — where the game is built (out/<run>); the bridge's POST hooks write their op
  // `to` paths under it and it substitutes the {project} placeholder. Derived from the SAME wfArg the
  // workflow uses to build its marker paths, so the two stay consistent.
  const projectDir = cfg.wfArgs.projectDir || "out/game";
  const projectBaseAbs = path.resolve(BASE_ROOT, projectDir);

  // THE SYNC: extract → bridge → WorkflowSpec, WITH the deterministic DRIVER-SEED/PROJECT/MERGE/
  // SEED-CONTRACT hooks re-attached (bound to pi-runner/hooks/). The hook ctx threads the TWO bases:
  // runCwd/root = BASE_ROOT (resolves every repo-relative marker path); here = pi-runner/ (the ajv
  // loader); resolveProjectBase = the project base (where the POST executors write their op `to`).
  const spec = await buildWorkflowSpec(cfg.workflow, cfg.wfArgs, {
    hookCtx: { runCwd: BASE_ROOT, root: BASE_ROOT, here: cfg.here },
    resolveProjectBase: () => projectBaseAbs,
  });
  const wf = compile(spec);

  // OPEN-1 — the parallel `_pi/prompt.md` clobber fix. The SDK runner writes EVERY node's prompt to
  // the FIXED `_pi/prompt.md` under the sandbox workspace, so a parallel stage would clobber it. Give
  // each node a DISTINCT per-node staging workspace (under the gitignored repo-root `_pi/`); the
  // provider's execCwd keeps the actual exec cwd at BASE_ROOT so repo-relative skill/template reads
  // still resolve, and piCommand emits an ABSOLUTE `@<workspace>/_pi/prompt.md` so refs never collide.
  for (const id of Object.keys(wf.nodes)) {
    const n = wf.nodes[id];
    n.sandbox.workspace = path.join(BASE_ROOT, "_pi", id); // per-node staging = the writeFile/_pi base
    n.sandbox.output = ".";                                 // downloadDir is a no-op; create's mkdir lands at the staging root
    // Append the return protocol at runtime (mirrors run.mjs:1558) — the write-driver instruction the
    // SDK runner does NOT add. The runner then writes node.prompt + the contract markers.
    n.prompt = n.prompt + returnProtocol(n.label);
  }

  const provider = new LocalSandboxProvider({ execCwd: BASE_ROOT });
  const registry = nativeToolRegistry(wf);
  return { wf, provider, registry, baseRoot: BASE_ROOT, projectBaseAbs };
}

function printDryRun(wf, cfg, baseRoot, projectBaseAbs) {
  console.log(`workflow: ${wf.meta.name}  (${Object.keys(wf.nodes).length} nodes / ${wf.stages.length} stages)`);
  console.log(`base    : ${baseRoot}`);
  console.log(`project : ${projectBaseAbs}`);
  console.log(`provider: ${cfg.provider}   model: ${cfg.model || "(provider default)"}\n`);
  // Static tool-binding audit (upstream @piflow/core) — findings keyed by node id.
  const findings = Object.fromEntries(auditWorkflow(wf).map((a) => [a.id, a.findings]));
  for (let i = 0; i < wf.stages.length; i++) {
    const s = wf.stages[i];
    console.log(`[stage ${i + 1}/${wf.stages.length}] [${s.phase ?? "—"}] ${s.nodeIds.join(" ∥ ")}`);
    for (const id of s.nodeIds) {
      const node = wf.nodes[id];
      const hk = node.hooks || {};
      const hookTag = [
        (hk.pre || []).length ? `pre:${hk.pre.map((h) => h.id).join(",")}` : null,
        (hk.post || []).length ? `post:${hk.post.map((h) => h.id).join(",")}` : null,
      ].filter(Boolean).join(" ") || "—";
      // TOOL SURFACE — the exact thing that was invisible when DRIVER-TOOLS mis-parsed: show each node's
      // resolved tools AS pi will bind them, and flag the binding anomaly (an entry with whitespace =
      // an un-tokenized list ⇒ pi binds only the first word and the node silently can't write).
      const allow = node.tools?.allow || [];
      const deny = node.tools?.deny || [];
      const toolTag = allow.length ? allow.join(" ") : "(all native)";
      const cmd = piCommand(node, { piTools: [] }, { promptFile: "_pi/prompt.md", model: cfg.model || undefined, provider: cfg.provider });
      console.log(`  • ${id}  [tools: ${toolTag}${deny.length ? ` ∖ ${deny.join(" ")}` : ""}] [hooks: ${hookTag}]`);
      for (const f of findings[id] || []) console.log(`    ⚠ TOOL BINDING — ${f}`);
      console.log(`    (cd ${baseRoot} && ${cmd})`);
    }
  }
}

async function main() {
  const cfg = loadConfig(process.argv.slice(2));
  const { wf, provider, registry, baseRoot, projectBaseAbs } = await buildRun(cfg);

  if (cfg.dryRun) {
    printDryRun(wf, cfg, baseRoot, projectBaseAbs); // acceptance gate 1 — no model, no writes
    process.exit(0);
  }

  console.log(`run     : ${cfg.run}`);
  console.log(`status  → ${path.join(baseRoot, "run-status.json")}\n`);
  const { status } = await runWorkflow(wf, {
    run: cfg.run,
    outDir: baseRoot,         // artifacts are repo-relative (out/<run>/spec/…) → resolve under the repo root
    repoRoot: baseRoot,
    provider,
    registry,
    buildCommand: piCommand,
    providerName: cfg.provider,
    model: cfg.model || undefined, // empty ⇒ pi uses the provider's default model
    nodeTimeoutMs: cfg.nodeTimeoutMs,
    stallMs: cfg.stallMs,     // silent-stall self-kill (0 = off; opt in via PI_RUNNER_STALL_TIMEOUT)
    from: cfg.from,
    until: cfg.until,
    // recordEvents defaults ON upstream ⇒ each node's stream lands at <root>/_pi/<id>.events.jsonl;
    // tail it live with `node pi-runner/logs.mjs . -f` (docker-logs for the run).
    validateSchema: null,     // OPEN-3: the per-archetype DRIVER-SCHEMA gate is a later SchemaValidator injection
  });
  const t = status.totals || {};
  console.log(`\n${status.ok ? "✓ ok" : "✕ failed"}  —  ${t.ok ?? "?"}/${t.nodes ?? "?"} nodes ok, ${t.failed ?? "?"} failed`);
  process.exit(status.ok ? 0 : 1);
}

// Run the CLI only when invoked directly (so `import { buildRun }` from a test does NOT spawn a run).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
