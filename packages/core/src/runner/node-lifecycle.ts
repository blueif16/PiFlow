// The pi-node lifecycle (clusters I + J) — runNode (create→stage→exec→collect→verify→G8-repair→promote→
// dispose, the single biggest function) + its AttemptOverride, plus finishNode + cappedRecord. Extracted
// verbatim from runner.ts (the §2.1 split). `finishNode` lives HERE WITH `runNode` so the import edges to
// node-lanes.ts (finishNode) and retry.ts (runNode) stay ONE-WAY into this module (RISK 2) — no cycle.

import { promises as fs, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type {
  NodeSpec,
  Sandbox,
  RunScope,
  ResolveResult,
  OnFailure,
} from '../types.js';
import { defaultSecretResolver } from '../types.js';
import { verifyToolBinding } from '../tools/verify.js';
import { markersFromNode, emitMarkers } from '../contract.js';
import { effectiveChecks, evaluateChecks, actionForVerdict, type FileBytes } from '../checks.js';
import { validateArtifactSchemas } from './schema.js';
import { runHooks } from '../hooks/index.js';
import { NodeRecorder, recordingSandbox } from './events.js';
import { resolveNodeModel, type EffectiveModel } from './model-routing.js';
import { resolveTokens, resolveAll, resolveDeep, type ResolveCtx } from '../workflow/resolver.js';
import { stageSeed } from '../workflow/ops/seed.js';
import { resolveSkillStage } from '../workflow/ops/skill.js';
import { runMerge, applyMergeOp } from '../workflow/ops/merge.js';
import { applyProjectionOp, runProjection } from '../workflow/ops/project.js';
import { readJsonSafe, absUnder } from '../workflow/ops/util.js';
import { parsePromote, extractPromoteValue, type ResolvedPromote } from '../workflow/ops/promote.js';
import { derivesFromOp, gatesFromOp, runOpsFromOp } from './op-dispatch.js';
import {
  type NodeStatusRecord,
  type ArtifactState,
  nowISO,
  writeStatus,
  artifactState,
} from './status.js';
import { piSessionsDir, writeNodePid, clearNodePid } from './layout.js';
import {
  envelopeHash,
  inputFilesOf,
  hashFile,
  writeJournalEntry,
} from './journal.js';
import { lastJsonBlock } from './return-parse.js';
import {
  CLOUD_KINDS,
  IN_PLACE_KINDS,
  effectiveSandboxLocation,
  selectedBridgedTool,
  referencedEnvVars,
  mcpEnvAdditions,
  cloudCredEnvAdditions,
} from './env-staging.js';
import type { RunContext } from './run-context.js';
import { readHostFile, stageHostPathIntoSandbox } from './run-context.js';

/**
 * (G12 — M4) A per-attempt OVERRIDE for an ESCALATION/CONSULT re-run: prepend the verified-evidence
 * `promptPrefix` (consultPreamble) and route to a STRONGER `model`/`provider`. Absent on the cheap first
 * attempt and on a same-model `retry` (those re-run with the node's own prompt + resolved model).
 */
export interface AttemptOverride {
  promptPrefix?: string;
  model?: string;
  provider?: string;
  /**
   * (warm-resume) When set, this attempt RESUMES the per-node pi session of `resumeSessionId` (= the node
   * id) instead of running cold: the command builder emits `--session <id>` (not `--session-id`), and the
   * staged prompt is FEEDBACK-ONLY (`promptPrefix` alone — the original prompt + markers already live in the
   * resumed session tree, §4c). Set ONLY on a SAME-MODEL L1 retry over a warm-eligible (local) provider; an
   * ESCALATION (model swap) leaves this absent and stays cold (§4d). Honored only where the session dir
   * persists across attempts (in-place/local); ignored elsewhere so cloud/inmemory stay cold.
   */
  resumeSessionId?: string;
}

// Exported as the lifecycle seam: ./retry.ts drives the retry/escalate loop around `runNode`.
export async function runNode(ctx: RunContext, node: NodeSpec, scope: RunScope, over: AttemptOverride = {}): Promise<NodeStatusRecord> {
  const rec = ctx.status.nodes[node.id];
  rec.status = 'running';
  rec.startedAt = nowISO();
  const t0 = Date.now();
  // A re-run STARTS FRESH: clear the prior attempt's signals so a successful re-run leaves none.
  ctx.failureSignals.delete(node.id);
  await writeStatus(ctx.outDir, ctx.status);

  // PRE-NODE BIND CHECK ("Verified, not trusted", spine #8): the node DECLARED its toolset; confirm
  // it actually GETS every declared function — each address binds to a unique bare name — BEFORE we
  // stand up a sandbox or spawn pi. A miss (declared tool not in the catalog) or a collision (two
  // tools sharing one bare name, which pi silently skips) is a contract breach → `blocked`.
  const bind = verifyToolBinding(node.tools, ctx.registry.list());
  if (!bind.ok) {
    return finishNode(ctx, node, rec, t0, 'blocked', `tool bind check failed: ${bind.issues.join('; ')}`, [], bind.issues);
  }

  let resolved: ResolveResult;
  try {
    resolved = ctx.registry.resolve(node.tools);
  } catch (e) {
    return finishNode(ctx, node, rec, t0, 'error', `tool resolution failed: ${(e as Error).message}`, []);
  }

  // LANE ISOLATION (run.mjs runNode 851–1176 always RESOLVES to a record, never rejects): standing up
  // the sandbox can throw (scope.create on a cloud backend: image pull / quota / network). That
  // throw is OUTSIDE the try/finally below, so unguarded it would reject this lane's promise and —
  // since the stage uses Promise.all — fail-fast the WHOLE run, discarding the sibling lanes' already-
  // completed work (MDN "Promise.all fail-fast"; javascript.info "Dangerous Promise.all": an uncaught
  // rejection can crash a Node process). Mark this node `error` and let the run halt cleanly instead.
  // MCP CONFIG STAGING (decided BEFORE create so the env additions reach the `CreateOpts.env` seam):
  // a node that selected bridge tools (mcp./oc.) + a run-level mcpConfig gets `_pi/mcp.json` (written
  // below, after the sandbox exists) and, injected here, `PIFLOW_MCP_CONFIG` (absolute in-sandbox path) +
  // the referenced secret env vars. CLOUD providers forward ONLY the referenced (allowlisted) vars — never
  // the host env.
  // Per-node staging dir: the prompt, the generated tool extension, and the MCP config all land under
  // `_pi/<id>/` so parallel nodes that SHARE a workspace (the in-place local case) never clobber each
  // other's staged files. This is the root fix for the OPEN-1 prompt-clobber that a consumer otherwise
  // works around three ways (an execCwd split + an absolute @prompt ref + a per-node `wf.nodes` mutation).
  const nodeStage = path.posix.join('_pi', node.id);
  const MCP_CONFIG_FILE = path.posix.join(nodeStage, 'mcp.json');
  // The in-sandbox ROOT that staged files resolve under (for the absolute paths advertised to pi). An
  // IN-PLACE provider's per-node sandbox is rooted at the RUN DIR (the cwd-anchoring at scope.create below),
  // so `_pi/<id>/mcp.json` and `.pi/skills/<name>` live under `outDir` — NOT `scope.root` (LocalRunScope.root
  // = the host repoRoot, which only coincided with the sandbox root before the in-place anchoring). Isolated/
  // cloud kinds stage relative to the provider scope root, so they keep `scope.root` unchanged.
  const stageRoot = IN_PLACE_KINDS.has(ctx.providerKind) ? ctx.outDir : scope.root;
  const isCloud = CLOUD_KINDS.has(ctx.providerKind);
  const stageMcp = Boolean(resolved.extension) && selectedBridgedTool(node) && Boolean(ctx.mcpConfig);
  let mcpEnv: Record<string, string> | undefined;
  if (stageMcp && ctx.mcpConfig) {
    // Absolute in-sandbox path: the staged file under the node's effective sandbox root (`stageRoot` —
    // outDir in-place, scope.root isolated/cloud). posix join keeps it valid in a cloud VM.
    const configPathAbs = path.posix.join(stageRoot, node.sandbox.workspace || '.', MCP_CONFIG_FILE);
    // Resolve each referenced $VAR through the broker seam (default: process.env). A host-plugged broker
    // mints a scoped token here so the raw credential never reaches the (cloud) VM.
    mcpEnv = await mcpEnvAdditions(
      configPathAbs,
      referencedEnvVars(ctx.mcpConfig),
      isCloud,
      node.id,
      ctx.secretResolver ?? defaultSecretResolver,
    );
  }
  // (M1) PROVIDER-CREDENTIAL PARITY — on a CLOUD VM, pi's OWN gateway key (`ANTHROPIC_API_KEY`, …) must
  // cross too: the command stamps `--provider`/`--model` but no key, and the VM does NOT inherit host env.
  // Resolve the declared provider-cred allowlist through the SAME resolver and forward EXACTLY that set
  // (no-op on local — the child already inherits process.env; no-op when no cloudSecrets declared).
  const credEnv = await cloudCredEnvAdditions(
    ctx.cloudSecrets,
    isCloud,
    node.id,
    ctx.secretResolver ?? defaultSecretResolver,
  );

  // The per-node resolver ctx — ONE ctx threads the prompt resolve, the seed/op resolution, AND the io/
  // sandbox/checks PATH resolution (U7). `{{RUN}}` is the host run dir (the collection namespace); state is
  // the barrier-merged RunState loaded for this stage.
  const resolveCtx: ResolveCtx = { run: ctx.outDir, workspace: ctx.workspace, state: ctx.runState, args: ctx.args };

  // IO/SANDBOX TOKEN RESOLUTION AT LAUNCH (U7): make `{{arg.*}}`/`{{WORKSPACE}}`/`{{RUN}}`/`{{state.*}}`
  // PHYSICAL in the node's CONTRACT paths — io.artifacts[].path, sandbox.read (read-scope), sandbox.write
  // (owns), and checks[].path — so the existence gate stat()s, the DRIVER-* markers, and scope.create all
  // consume the resolved path, never a raw `{{…}}` joined under the run dir with braces intact. SAME loud
  // discipline as the prompt below: a missing arg/channel throws (MissingArgError/MissingChannelError) →
  // the node fails cleanly with a clear issue, never a silently-unresolved io path. We resolve ONCE into a
  // local `node` clone and thread it; the runner consumes `node.*` from here on (raw `srcNode` is untouched).
  const srcNode = node;
  try {
    node = {
      ...srcNode,
      io: {
        ...srcNode.io,
        artifacts: srcNode.io.artifacts.map((a) => ({ ...a, path: resolveTokens(a.path, resolveCtx) })),
        checks: srcNode.io.checks?.map((c) => (c.path ? { ...c, path: resolveTokens(c.path, resolveCtx) } : c)),
      },
      sandbox: {
        ...srcNode.sandbox,
        read: resolveAll(srcNode.sandbox.read, resolveCtx),
        write: resolveAll(srcNode.sandbox.write, resolveCtx),
      },
    };
  } catch (e) {
    return finishNode(ctx, srcNode, rec, t0, 'error', `io token resolution failed: ${(e as Error).message}`, [], [(e as Error).message]);
  }

  // Resolve the node's hard wall-clock cap ONCE — explicit node timeout else the run watchdog default
  // (30 min). The runner watchdog enforces it locally; the CLOUD backends (e2b/daytona) ALSO take it as the
  // per-command exec `timeoutMs`. E2B's `commands.run` defaults to 60_000ms when unset (verified against the
  // SDK: CommandStartOpts.timeoutMs default 60000), so passing `undefined` here KILLS any node generating
  // >60s. Local/seatbelt/worktree backends ignore CreateOpts.timeoutMs (watchdog-only). Threading the SAME
  // value into both create and the watchdog (below) keeps the two caps from diverging.
  const nodeTimeoutMs = node.sandbox.timeoutMs ?? ctx.watchdog.nodeTimeoutMs;
  // IN-PLACE providers run IN the run dir (cwd = outDir) so a node's RELATIVE artifact write lands under
  // {{RUN}} where the contract verifies it + the next node injects it; isolated kinds keep the throwaway
  // workspace + out/<id>. Shared by scope.create AND the pre/post hookCtx so both agree on the node's cwd.
  const sbLoc = effectiveSandboxLocation(ctx.providerKind, ctx.outDir, node.sandbox);
  let sandbox: Sandbox;
  try {
    sandbox = await scope.create({
      readScope: node.sandbox.read,
      writeScope: node.sandbox.write, // = contract.owns; bounds file-write* to the node's lane (darwin jail)
      outputDir: sbLoc.outputDir,
      workdir: sbLoc.workdir,
      image: node.sandbox.image,
      // Merge the MCP env additions + the cloud provider-cred additions over the node's declared env (so
      // PIFLOW_MCP_CONFIG + the referenced MCP secrets + the pi gateway key land in the child via the
      // provider's exec merge). Both additions are {} when inapplicable, so a local/keyless run is unchanged.
      env: mcpEnv || Object.keys(credEnv).length
        ? { ...node.sandbox.env, ...mcpEnv, ...credEnv }
        : node.sandbox.env,
      timeoutMs: nodeTimeoutMs, // cloud per-command cap = the watchdog cap (NOT undefined → E2B's 60s default)
    });
  } catch (e) {
    return finishNode(ctx, node, rec, t0, 'error', `sandbox create failed: ${(e as Error).message}`, []);
  }

  // (U1a/U1b) The derive DISPATCH now reads the canonical `op[]` (via `derivesFromOp`), NOT `node.ops`.
  // One reconstruction per node; each derive site below iterates the matching family list. The resolution +
  // executor calls are byte-identical to the legacy `node.ops?.{…}` sites — only the SOURCE changed.
  const derived = derivesFromOp(node.op);

  try {
    // STAGE io.reads from the host run dir INTO the sandbox at the same relative path (filesystem-as-
    // contract across sandboxes). A missing read is left to the node's own contract check downstream.
    for (const rel of node.io.reads) {
      const data = await readHostFile(ctx, rel);
      if (data) await sandbox.writeFile(rel, data);
    }

    // SEED PRE op (S2): stage each declared starting artifact onto the host run dir (= `{{RUN}}`), then
    // mirror the staged dest INTO the sandbox so the model reads it. A token-bearing `from` (incl
    // `{{state.*}}`) resolves through the seed-token resolver; an absent source is a graceful skip, an
    // already-filled dest is not re-staged (idempotent). A `{{state.*}}` naming a not-yet-promoted channel
    // throws → fail the node loudly (a real wiring error), never a silent skip.
    try {
      for (const seed of derived.seeds) {
        const res = await stageSeed(seed, resolveCtx, ctx.outDir);
        if (res.staged) await stageHostPathIntoSandbox(sandbox, ctx.outDir, seed.to);
      }
    } catch (e) {
      return finishNode(ctx, node, rec, t0, 'error', `seed staging failed: ${(e as Error).message}`, [], [(e as Error).message]);
    }

    // (M5 · #11) PRE-GATE — fire the node's `when:'pre'` gate ops over the STAGED inputs BEFORE the model.
    // The deprecated `checks.pre` lowered to these; today's render flattened pre→post so a pre-check never
    // ran before the model. Here a blocking pre-gate failure fails the node WITHOUT ever spawning pi — the
    // real firing site #11 needs. Each gate's `onFailure` (default 'block') gives its consequence; an
    // `advisory`/`warn` gate is recorded but does not block. Reads the host run dir (= the staged inputs).
    const preChecks = gatesFromOp(node.op).pre; // (C2) the SINGLE gate→Check reconstruction (was inlined here).
    if (preChecks.length) {
      const preReadBytes = (rel: string): FileBytes => {
        try {
          const absPath = path.resolve(ctx.outDir, rel);
          return { bytes: readFileSync(absPath, 'utf8'), size: statSync(absPath).size };
        } catch {
          return { bytes: null, size: 0 };
        }
      };
      const preResults = evaluateChecks(preChecks, preReadBytes);
      rec.preChecks = preResults;
      const blockingPre = preResults.filter((c, i) => c.verdict !== 'pass' && preChecks[i].severity !== 'warn');
      if (blockingPre.length) {
        const detail = blockingPre.map((c) => `${c.kind} ${c.path || ''}: ${c.reason}`).join(' | ');
        return finishNode(ctx, node, rec, t0, 'blocked', `pre-gate FAILED (before the model) — ${detail}`, [], [`pre-gate: ${detail}`]);
      }
    }

    // TOKEN RESOLUTION AT LAUNCH (U7): make `{{arg.*}}`/`{{WORKSPACE}}`/`{{RUN}}`/`{{state.*}}` PHYSICAL
    // in the prompt before staging. A missing arg/channel throws loudly (MissingArgError/MissingChannelError)
    // → the node fails with a clear issue, never a silently-unresolved prompt handed to the model.
    let resolvedPrompt: string;
    try {
      // A pi-lane node always carries a prompt (the schema requires it for a non-programmatic node); the
      // `?? ''` only satisfies the now-optional `prompt` type (a programmatic node never reaches this lane).
      resolvedPrompt = resolveTokens(node.prompt ?? '', resolveCtx);
    } catch (e) {
      return finishNode(ctx, node, rec, t0, 'error', `prompt token resolution failed: ${(e as Error).message}`, [], [(e as Error).message]);
    }

    // (warm-resume §4) PER-NODE SESSION: mint a stable session id = the node id, persisted under the RUN dir's
    // DEDICATED `.pi-sessions` tree (`piSessionsDir(ctx.outDir)` = `<runDir>/.pi-sessions` — the runs subfolder
    // where `.pi/` lives, a SIBLING of `.pi/`, NEVER inside the engine journal/state tree, NEVER the sandbox
    // workspace — §4d). The session living UNDER THE RUN DIR is what makes resume DETERMINISTICALLY locatable: a
    // future `piflowctl node <run> <id> --resume` resolves it by this one absolute path. `ctx.outDir` is already
    // absolute (built via `path.resolve` in runWorkflow), but we `path.resolve` again so the in-sandbox pi and
    // the future CLI agree on ONE absolute path even if a caller ever threads a relative outDir. Scoped to
    // IN-PLACE (local) providers, the only kind where the session `.jsonl` survives between attempts AND the run
    // dir is a real HOST path the in-sandbox pi can write — on an inmemory/cloud sandbox each attempt gets a
    // fresh root, so the session would not persist; those stay COLD (`--no-session`, today's default) by leaving
    // `session` undefined. A SAME-MODEL L1 retry sets `over.resumeSessionId` (= the node id) ⇒ this attempt
    // RESUMES (`--session <id>`) and the prompt is FEEDBACK-ONLY; the first attempt CREATES (`--session-id <id>`).
    // An escalation never sets it (stays cold).
    const warmEligible = IN_PLACE_KINDS.has(ctx.providerKind);
    const isResume = warmEligible && over.resumeSessionId !== undefined;
    const session = warmEligible
      ? { dir: piSessionsDir(path.resolve(ctx.outDir)), id: node.id, resume: isResume }
      : undefined;
    if (session) { rec.sessionId = session.id; rec.sessionDir = session.dir; }

    // The prompt carries the machine-readable contract markers (artifacts/owns/read-scope/tools) so a
    // future node-contract extension can self-gate; we append them exactly as run.mjs does. An escalation
    // attempt PREPENDS the verified-evidence consult prefix (M4 — runNodeWithEscalation's promptPrefix).
    // A WARM RESUME attempt writes ONLY the feedback (`promptPrefix`): the original prompt + markers already
    // live in the resumed session tree, so re-feeding them would duplicate the turn (§4c).
    const markers = emitMarkers(markersFromNode(node, resolved));
    const promptFile = path.posix.join(nodeStage, 'prompt.md');
    const promptBody = isResume
      ? (over.promptPrefix ?? '')
      : (over.promptPrefix ?? '') + resolvedPrompt + (markers ? `\n\n${markers}` : '');
    await sandbox.writeFile(promptFile, promptBody);

    // Stage the generated tool `-e` extension (binds the node's declared sdk/mcp tools) and pass its
    // in-sandbox path to the command builder. Absent when the node selected only builtins.
    let extensionFile: string | undefined;
    if (resolved.extension) {
      extensionFile = path.posix.join(nodeStage, 'tools.ts');
      await sandbox.writeFile(extensionFile, resolved.extension);
    }

    // Stage the node's MCP server map VERBATIM (only for MCP-tool nodes with a run-level mcpConfig). It
    // carries `$VAR` refs, never literal secrets — the bridge expands them in-child against PIFLOW_MCP_CONFIG
    // + the referenced env vars injected at create above. A node with no MCP tools writes NO `_pi/mcp.json`.
    if (stageMcp && ctx.mcpConfig) {
      await sandbox.writeFile(MCP_CONFIG_FILE, JSON.stringify(ctx.mcpConfig));
    }

    // SKILL stage: a node's `skill` (an Agent-Skill dir) is a forced read-only PRE-stage — so it REUSES the
    // seed seam. Copy the source onto the host run dir at `.pi/skills/<name>/` (pi's native discovery dir),
    // mirror it INTO the sandbox via `stageHostPathIntoSandbox`, and point `--skill` at the in-sandbox path.
    // Staged UNDER the workdir ⇒ jail-readable by construction (no readScope widening); the bytes ride into a
    // cloud VM like every other staged input. An ABSENT source is a graceful skip (mirrors a missing seed);
    // a real staging failure fails the node loudly (never a silent half-stage).
    let skillPath: string | undefined;
    try {
      const skillStage = resolveSkillStage(node.skill, resolveCtx);
      const exists = skillStage && (await fs.stat(skillStage.source).then(() => true, () => false));
      if (skillStage && exists) {
        const skillRel = path.posix.join('.pi', 'skills', skillStage.name);
        await fs.cp(skillStage.source, path.resolve(ctx.outDir, skillRel), { recursive: true, force: true });
        await stageHostPathIntoSandbox(sandbox, ctx.outDir, skillRel);
        skillPath = path.posix.join(stageRoot, node.sandbox.workspace || '.', skillRel);
      }
    } catch (e) {
      return finishNode(ctx, node, rec, t0, 'error', `skill staging failed: ${(e as Error).message}`, [], [(e as Error).message]);
    }

    // PRE hooks (deterministic plumbing — stage inputs / seeds). A blocking failure throws → error.
    // `sbLoc.workdir` (not the raw `node.sandbox.workspace`) so an in-place hook's relative writes land in
    // the run dir, matching the node's own cwd above; isolated kinds resolve to the same workspace as before.
    const hookCtx = { workspace: sbLoc.workdir, inputs: node.io.reads, outputs: node.io.produces };
    try {
      await runHooks(node.hooks?.pre, hookCtx, { outcome: 'success' });
    } catch (e) {
      return finishNode(ctx, node, rec, t0, 'error', `pre-hook failed: ${(e as Error).message}`, []);
    }

    // G1 — resolve THIS node's effective model/provider (the §2 precedence lives in model-routing.ts). An
    // unresolvable tier throws → fail the node cleanly (never crash the run, never silently mis-route).
    let eff: EffectiveModel;
    try {
      eff = resolveNodeModel(node, {
        model: ctx.model,
        provider: ctx.providerName,
        tiers: ctx.modelRouting.tiers,
        modelsIndex: ctx.modelRouting.modelsIndex,
      });
    } catch (e) {
      return finishNode(ctx, node, rec, t0, 'error', (e as Error).message, []);
    }
    // M4 — an escalation attempt overrides the resolved model/provider with the stronger target.
    const effModel = over.model ?? eff.model;
    const effProvider = over.provider ?? eff.provider;
    rec.model = effModel ?? null; // record the effective model (null ⇒ pi's provider default)
    // (warm-resume) Merge the per-node `session` into the builder opts (DROPs `--no-session`, emits
    // `--session-dir` + `--session-id`/`--session`). `undefined` ⇒ no merge ⇒ today's `--no-session` default.
    const cmd = ctx.buildCommand(node, resolved, { promptFile, model: effModel, provider: effProvider, extensionFile, skillPath }, session ? { ...ctx.commandOpts, session } : ctx.commandOpts);
    rec.command = cmd;

    // `nodeTimeoutMs` is resolved ONCE above (shared with the cloud per-command cap at scope.create).
    // Tee the agent's stdout into a per-node slimmed events archive (additive — the wrap chains the
    // watchdog's own onStdout, so recording can never disable the stall kill). See ./events.ts.
    const recorder = ctx.recordEvents ? new NodeRecorder(ctx.outDir, node.id, ctx.onEvent) : null;
    const execSandbox = recorder ? recordingSandbox(sandbox, recorder) : sandbox;
    // (per-node stop) PERSIST the spawned pi's pid to `.pi/nodes/<id>/pid.json` the instant the child exists,
    // so a separate `piflowctl node <run> <id> --stop` can signal THIS node's live process group. SCOPED to
    // HOST-SIGNALABLE (in-place/local) providers: the recorded pid is a real host process a host CLI can reach.
    // On an inmemory (ephemeral) or CLOUD (in-VM) provider the host cannot signal the process, so we persist
    // NOTHING (`onSpawn` left undefined ⇒ no misleading host pid). `finishNode` clears the file on every exit.
    // Both the first exec and the G8 repair re-exec carry it (a repair spawns a fresh pi for the same node).
    const hostSignalable = IN_PLACE_KINDS.has(ctx.providerKind);
    const onSpawn = hostSignalable ? (pid: number): void => { void writeNodePid(ctx.outDir, node.id, pid); } : undefined;
    // `let result` (not `const`): the G8 repair loop re-execs in the live sandbox and re-binds it.
    const exec0 = await ctx.execRunner(execSandbox, cmd, { ...ctx.watchdog, nodeTimeoutMs, onSpawn });
    let result = exec0.result;
    const { killed } = exec0;
    await recorder?.close();
    rec.exitCode = result.code;

    // COLLECT: copy the node's sandbox output dir back to the host run dir. The convention (proven in
    // the test): a node writes each artifact at `<output>/<artifactPath>`, so downloadDir flattens
    // `<output>/*` onto `<hostRunDir>/*` and the artifact path IS the host-run-dir-relative path.
    //
    // CONCURRENCY CONTRACT: collection is SERIALIZED across the stage via `ctx.collectMutex` (a one-slot
    // FIFO). Every parallel lane copies into the SAME shared host run dir, and two recursive copies that
    // both create a common destination subdir (e.g. siblings under `shared/`) race → one `fs.cp` throws
    // EEXIST. The mutex removes the overlap so neither collides; the costly exec already ran concurrently
    // OUTSIDE this gate. (fusion keeps its disjoint-top-level-dir workaround, cb16658 — this is the
    // general safety net underneath it.)
    //
    // ERROR CONTRACT: a collection failure is RECORDED, never swallowed. ENOENT (the source output dir
    // genuinely does not exist ⇒ the node produced nothing) is a LEGITIMATE quiet no-op — the artifact
    // gate below marks it blocked on its own. ANY OTHER error (EEXIST race, ENOSPC, EACCES, …) is a REAL
    // collection failure captured into `collectError` and surfaced on the node's `issues` in the verdict
    // block below — so a blocked node EXPLAINS that its file was lost in collection, not merely "missing".
    // IN-PLACE SKIP: a `local` node ran in the real workspace, so its deliverable is ALREADY at its host
    // location — there is no `out/<id>` throwaway to copy back and `downloadDir(out/<id> → outDir)` would
    // hit the guarded-identity THROW (the compile-default output ≠ the run dir). Skip the download; the
    // artifact gate below stat()s the real run dir directly. (Isolated providers are untouched.)
    const inPlace = IN_PLACE_KINDS.has(ctx.providerKind);
    let collectError: string | null = null;
    if (killed === null && result.code === 0 && !inPlace) {
      try {
        await ctx.collectMutex(() => sandbox.downloadDir(node.sandbox.output, ctx.outDir));
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err?.code !== 'ENOENT') collectError = `output collection failed: ${err?.message ?? String(e)}`;
        // ENOENT ⇒ nothing produced — stay quiet; the artifact gate below marks it blocked.
      }
    }

    // DERIVE ops (project → registryProject → merge), the mechanical "derive an output from frozen
    // on-disk inputs" families. Run them HERE — after COLLECT, STRICTLY BEFORE the artifact/schema
    // gates below (canonical run.mjs order: "the AUTHORITY for them … strictly BEFORE the gates
    // verify them"). They are gated on a CLEAN MODEL EXIT (killed === null && code === 0), NOT on the
    // node verdict: a node whose REQUIRED artifact is GENERATED by its own merge `run` op (the asset
    // gen hook → public/assets/asset-manifest.json) would deadlock if verified first (missing →
    // blocked → the op that produces it never runs). `promote` stays AFTER the verdict (it lifts a
    // GOOD node's output into a state channel). Each op's tokens are resolved per the node ctx; a
    // missing input degrades gracefully inside the executors.
    // (M5 · #18) POST-op failures whose exit code ROUTES to status via the lowered op's `onFailure`. Today
    // a merge `run` op's non-zero exit is DISCARDED (the `runMerge` return is dropped); now it routes — a
    // `block`/`stop` op blocks the node, a `warn` op surfaces an issue but stays ok. Collected here, applied
    // in the status ladder below. The legacy `ops`/`op` executors are reused UNCHANGED; only the exit is read.
    const opFailures: { detail: string; onFailure: OnFailure }[] = [];
    if (killed === null && result.code === 0) {
      // project: derive from a FROZEN source JSON read once (graceful no-op on an authoring-only spec).
      for (const rawOp of derived.projects) {
        const op = resolveDeep(rawOp as Record<string, unknown>, resolveCtx);
        const srcRel = (op.source as string) ?? (Array.isArray(op.from) ? (op.from[0] as string) : (op.from as string));
        const spec = srcRel ? await readJsonSafe(absUnder(ctx.outDir, srcRel)) : undefined;
        const name = String(op.op ?? Object.keys(op).find((k) => k === 'copy' || k === 'assemble' || k === 'merge') ?? 'project');
        await applyProjectionOp(name, op, spec, ctx.outDir);
      }
      // registryProject: the op-map lives in the registry record (mapRef), resolved by `key`. The single
      // `derived.registryProjects` loop covers BOTH hooks- and op[]-authored nodes (the legacy `if` arm folded
      // into the `else` op[] dispatch — #12, project.ts:184: without this the built `union` path / `index.json`
      // was silently dropped for an op[]-authored node).
      for (const rp of derived.registryProjects) {
        const pg = resolveDeep({ source: rp.source, mapRef: rp.mapRef, key: rp.key }, resolveCtx) as { source: string; mapRef: string; key: string };
        await runProjection({ source: pg.source, mapRef: pg.mapRef, key: pg.key }, ctx.outDir);
      }
      // merge: the `{ ops:[...] }` MergeSpec (fold|concat|reconcile|run) — incl. the gen-hook `run` op. The
      // merge transform's lowered `op` carries the onFailure that a failing `run` sub-op now routes through.
      for (const m of derived.merges) {
        const mergeOnFailure = ((node.op ?? []).find((o) => o.transform?.kind === 'merge')?.onFailure ?? 'block') as OnFailure;
        const merged = await runMerge(resolveDeep(m, resolveCtx), ctx.outDir);
        for (const r of merged?.ops ?? []) {
          if (r.failed) opFailures.push({ detail: `merge ${r.op} failed${r.exit != null ? ` (exit ${r.exit})` : ''}${r.stderr ? `: ${r.stderr}` : ''}`, onFailure: mergeOnFailure });
        }
      }
      // (M5 · #9/#18) AUTHORABLE `run` body — a POST `op` with a `run:{cmd,args,cwd}` body is a deterministic
      // derive/side-effect step (the now-authorable Hook.run). Reuse the merge executor's `run` impl, then
      // route a non-zero exit through the op's `onFailure` (default 'block').
      const runOps = runOpsFromOp(node.op); // (C2) the SINGLE run→executor-input adapter (was inlined here).
      for (const { body, onFailure } of runOps.runnable) {
        const r = await applyMergeOp({ run: { cmd: body.cmd, args: body.args, cwd: body.cwd } }, ctx.outDir);
        if (r.failed) {
          opFailures.push({ detail: `run ${r.cmd ?? body.cmd} failed${r.exit != null ? ` (exit ${r.exit})` : ''}${r.stderr ? `: ${r.stderr}` : ''}`, onFailure });
        }
      }
      // (B-fix) FAIL LOUD: a run op the runner has NO executor for (when:'pre'/'on-failure', the {fn} variant,
      // or a cmd-less body) is surfaced as an op failure here — never the old silent `continue` that dropped it.
      for (const rej of runOps.rejected) opFailures.push(rej);
    }

    // VERIFY by host-stat (run.mjs: a node is `ok` only if its declared artifacts exist on disk).
    // `let` (not `const`): the G8 in-sandbox repair loop (below) re-execs + re-validates in place, so a
    // repaired-good node re-binds these to the corrected results the status ladder then reads.
    let artifacts: ArtifactState[] = await Promise.all(
      node.io.artifacts.map((a) => artifactState(path.resolve(ctx.outDir, a.path), a.path)),
    );
    let missing = artifacts.filter((a) => !a.exists).map((a) => a.path);

    // POST-NODE SCHEMA GATE: a present-but-invalid artifact (vs its declared draft-2020-12 schema) is a
    // contract breach, driver-verified — exactly like a missing one. Skips (advisory) when no schema is
    // declared or no validator resolved (run.mjs schemaCheck).
    let schema = await validateArtifactSchemas(node.io.artifacts, {
      outDir: ctx.outDir,
      roots: [ctx.outDir, scope.root],
      validate: ctx.validateSchema,
    });
    if (schema.invalid.length) rec.schemaInvalid = schema.invalid;
    if (schema.checked) rec.schemaChecked = schema.checked;
    if (schema.skipped) rec.schemaSkipped = schema.skipped;

    // DECLARATIVE INTEGRITY CHECKS (explicit ∪ the auto fill-sentinel completeness check) folded through
    // the verdict→action POLICY (detection ⊥ consequence). A failed check at block severity is a breach.
    const readBytes = (rel: string): FileBytes => {
      try {
        const absPath = path.resolve(ctx.outDir, rel);
        return { bytes: readFileSync(absPath, 'utf8'), size: statSync(absPath).size };
      } catch {
        return { bytes: null, size: 0 };
      }
    };
    const checkResults = evaluateChecks(
      effectiveChecks(node.io.checks, node.io.fillSentinel, node.io.artifacts.map((a) => a.path)),
      readBytes,
    );
    if (checkResults.length) rec.checks = checkResults;
    const failedChecks = checkResults.filter((c) => c.verdict !== 'pass');
    const blockingChecks = failedChecks.filter((c) => actionForVerdict(c.verdict as 'fail' | 'warn', node.io.policy) !== 'warn');
    const warningChecks = failedChecks.filter((c) => actionForVerdict(c.verdict as 'fail' | 'warn', node.io.policy) === 'warn');

    // GENERALIZED RETURN HANDSHAKE: a node that declares a (satisfied) artifact contract proves its work
    // by the FILE on disk, so a missing return block is advisory (optional). A node that declares NO
    // artifact (its structured return IS its only output) still REQUIRES the handshake. `returnMode`
    // overrides per node. This releases the redundant-handshake false-error (the W1-class defect) while
    // real corruption is still caught by the missing/schema/checks gates above.
    // PRECEDENCE: per-node override → run-level default (ctx.returnProtocol) → the artifact heuristic.
    const returnMode = node.io.returnMode ?? ctx.returnProtocol ?? (node.io.artifacts.length ? 'optional' : 'required');
    rec.returnMode = returnMode;

    // The status ladder (run.mjs 1876–1883): kill/nonzero ⇒ error; then the driver-verified contract
    // breaches (missing → schema-invalid → blocking integrity check), each beating any self-report; then
    // a non-ok self-report is honored; then a MISSING handshake errors ONLY when it was required; else ok.
    let parsed = lastJsonBlock(result.stdout);

    // POST-NODE RETURN-SCHEMA GATE (mirrors the artifact schema gate, runner.ts above): a node's authored
    // `returnSchema` (node.json top-level `return`) constrains the SHAPE of its structured result. We
    // validate the PARSED return — VALIDATE-IF-PRESENT — with the SAME injected validator the artifact gate
    // uses. A present-but-NON-CONFORMING result is a contract breach under `required` (it BLOCKS, like a
    // present-but-invalid artifact); under `optional` it is advisory (recorded as a warn, never blocks; a
    // missing result is the existing handshake clause's job, never this gate's). Skips when no return
    // schema is declared, no result was parsed, or no validator resolved.
    // RETURN-SCHEMA IS OPT-IN — a CHOICE, never forced. We validate the structured return ONLY when the
    // node CHOOSES to force one (returnMode === 'required'). A filesystem-write node (returnMode 'optional'
    // or the artifact-backed default) proves its work by the artifact ON DISK, so its structured return is
    // NEVER gated — the return-schema mechanism stays available for rigid workflows without ever blocking
    // (or warning on) a node that simply writes its files. Under 'required' a non-conforming result is a
    // contract breach that BLOCKS (mirrors the artifact schema gate).
    // The return-schema validation, factored so the G8 repair loop can RE-RUN it on the repaired output.
    const validateReturn = (): string[] => {
      if (returnMode === 'required' && node.io.returnSchema && Object.keys(node.io.returnSchema).length && parsed && ctx.validateSchema) {
        const r = ctx.validateSchema(node.io.returnSchema, parsed);
        if (!r.ok) return r.errors;
      }
      return [];
    };
    let returnSchemaInvalid: string[] = validateReturn();
    let returnSchemaBreach = returnSchemaInvalid.length > 0 && returnMode === 'required';

    // ── G8 fold — bounded IN-SANDBOX schema repair (composed in M4) ────────────────────────────────────
    // When the node would block SOLELY on a schema miss (artifact-schema OR return-schema breach, with the
    // exec CLEAN, NO missing artifact, NO blocking integrity check) and `maxRepairAttempts > 0`, re-prompt
    // the STILL-ALIVE sandbox from {previousOutput, ajvErrors, schema} up to N times BEFORE the verdict
    // ladder runs — a CHEAP correction that reuses the node's ONE slot. A repair is NOT a retry: it does
    // NOT re-seed a fresh sandbox and does NOT touch the `retry`/`escalate` budget (it runs entirely
    // inside this single `runNode`). Default `maxRepairAttempts:0` ⇒ this whole block is skipped and a
    // schema miss falls straight through to `blocked` (today's exact behavior).
    const maxRepair = Math.max(0, node.io.maxRepairAttempts ?? 0);
    const schemaOnlyBreach = (): boolean =>
      killed === null && result.code === 0 && !missing.length && !blockingChecks.length &&
      (schema.invalid.length > 0 || returnSchemaBreach);
    if (maxRepair > 0 && schemaOnlyBreach()) {
      let repairs = 0;
      while (repairs < maxRepair && schemaOnlyBreach()) {
        repairs++;
        // Build the repair prompt from the in-hand failing facts (the G8 §"Repair-prompt template" shape):
        // the declared schema + the ajv errors + the previous output — fix EXACTLY these, invent nothing.
        const ajvErrors = [
          ...schema.invalid.flatMap((x) => x.errors.map((e) => `${x.path}: ${e}`)),
          ...returnSchemaInvalid.map((e) => `return: ${e}`),
        ];
        const declaredSchema = schema.invalid.length
          ? JSON.stringify(node.io.artifacts.find((a) => schema.invalid.some((x) => x.path === a.path))?.schema ?? {})
          : JSON.stringify(node.io.returnSchema ?? {});
        const target = schema.invalid.length ? schema.invalid.map((x) => x.path).join(', ') : 'the fenced-JSON return tail';
        const repairPrompt = [
          'You fix a structured output that FAILED its schema. Output ONLY the corrected result — no prose.',
          'Produce a CORRECTED version that conforms exactly. Change ONLY what the errors require; preserve all valid content.',
          `<schema>${declaredSchema}</schema>`,
          `<validation_errors>${ajvErrors.join(' | ')}</validation_errors>`,
          `<your_previous_output>${result.stdout.slice(-2000)}</your_previous_output>`,
          `<output_spec>Write the corrected result to ${target}. It MUST validate against <schema>. Use only values present in your previous output or logically implied by it — do NOT fabricate.</output_spec>`,
          '',
        ].join('\n');
        const repairFile = path.posix.join(nodeStage, `repair-${repairs}.md`);
        await sandbox.writeFile(repairFile, repairPrompt);
        const repairCmd = ctx.buildCommand(node, resolved, { promptFile: repairFile, model: effModel, provider: effProvider, extensionFile, skillPath }, ctx.commandOpts);
        const repairExec = await ctx.execRunner(execSandbox, repairCmd, { ...ctx.watchdog, nodeTimeoutMs, onSpawn });
        result = repairExec.result;
        // Re-collect (a fresh artifact may have been rewritten) under the same serialized collect mutex.
        // In-place skips for the same reason as the first collect: the repaired artifact is already on the
        // real run dir, and a download would hit the guarded-identity throw.
        if (repairExec.killed === null && result.code === 0 && !inPlace) {
          try {
            await ctx.collectMutex(() => sandbox.downloadDir(node.sandbox.output, ctx.outDir));
          } catch { /* a collect miss is caught by the re-stat below */ }
        }
        // Re-validate the WHOLE gate set (artifacts present + schema + return) on the corrected output.
        artifacts = await Promise.all(node.io.artifacts.map((a) => artifactState(path.resolve(ctx.outDir, a.path), a.path)));
        missing = artifacts.filter((a) => !a.exists).map((a) => a.path);
        schema = await validateArtifactSchemas(node.io.artifacts, { outDir: ctx.outDir, roots: [ctx.outDir, scope.root], validate: ctx.validateSchema });
        parsed = lastJsonBlock(result.stdout);
        returnSchemaInvalid = validateReturn();
        returnSchemaBreach = returnSchemaInvalid.length > 0 && returnMode === 'required';
      }
      rec.repairAttempts = repairs;
      // Refresh the recorded breach fields off the post-repair state (so a cleared breach leaves no stale record).
      rec.schemaInvalid = schema.invalid.length ? schema.invalid : undefined;
      rec.returnSchemaInvalid = returnSchemaInvalid.length ? returnSchemaInvalid : undefined;
      // Budget spent and STILL a schema miss ⇒ terminal, surfaced loudly (the run halts at the barrier).
      if (schemaOnlyBreach()) rec.repairExhausted = true;
    }
    if (returnSchemaInvalid.length) rec.returnSchemaInvalid = returnSchemaInvalid;

    // (M5 · #18) Partition the routed op failures by their `onFailure`: `block`/`stop` are blocking, `warn`
    // (or any non-blocking consequence) only surfaces an issue. `retry`/`escalate` are blocking at the
    // node-status level here (the M4 retry/escalate lanes then act on the blocked verdict).
    const blockingOpFailures = opFailures.filter((f) => f.onFailure !== 'warn');
    const warningOpFailures = opFailures.filter((f) => f.onFailure === 'warn');

    let st: NodeStatusRecord['status'];
    const issues: string[] = [];
    if (killed === 'timeout' || killed === 'stall' || result.code !== 0) {
      st = 'error';
      if (killed) issues.push(`killed: ${killed === 'timeout' ? 'exceeded node timeout' : 'silent stall'}`);
      else issues.push(`nonzero exit ${result.code}`);
    } else if (missing.length) {
      st = 'blocked';
      // If collection FAILED (not a quiet ENOENT), say so HERE — the lost copy is the REAL cause of the
      // "missing" artifact (the swallowed-EEXIST footgun), not a model that produced nothing.
      issues.push(
        collectError
          ? `${collectError} → required artifact(s) missing: ${missing.join(', ')}`
          : `contract breach — required artifact(s) missing: ${missing.join(', ')}`,
      );
    } else if (schema.invalid.length) {
      st = 'blocked';
      issues.push(`contract breach — artifact(s) violate the declared schema: ${schema.invalid.map((x) => `${x.path} [${x.errors.join('; ')}]`).join(' | ')}`);
    } else if (blockingChecks.length) {
      st = 'blocked';
      issues.push(`integrity check FAILED — ${blockingChecks.map((c) => `${c.kind} ${c.path || ''}: ${c.reason}`).join(' | ')}`);
    } else if (blockingOpFailures.length) {
      // (M5 · #18) A post `run`/`merge.run` op failed with a blocking `onFailure` — the exit code now routes
      // to status (today it was swallowed: the `runMerge` return was discarded). The node blocks.
      st = 'blocked';
      issues.push(`op FAILED — ${blockingOpFailures.map((f) => f.detail).join(' | ')}`);
    } else if (returnSchemaBreach) {
      st = 'blocked';
      issues.push(`contract breach — return violates the declared returnSchema: ${returnSchemaInvalid.join('; ')}`);
    } else if (parsed?.status && parsed.status !== 'ok') {
      st = parsed.status === 'gap' || parsed.status === 'blocked' ? parsed.status : 'gap';
    } else if (!parsed && returnMode === 'required') {
      st = 'error';
      issues.push('no return-protocol block parsed from output (return:required)');
    } else {
      st = 'ok';
    }
    // A collection failure that did NOT already mask a missing artifact (the branch above) is still
    // recorded — never let a real `downloadDir` error vanish (it may have dropped a non-required file).
    if (collectError && !missing.length) issues.push(collectError);
    if (warningChecks.length) issues.push(`integrity warn — ${warningChecks.map((c) => `${c.kind} ${c.path || ''}: ${c.reason}`).join(' | ')}`);
    // (M5 · #18) A `warn`-routed op failure surfaces an issue but never blocks (NOT swallowed, NOT fatal).
    if (warningOpFailures.length) issues.push(`op warn — ${warningOpFailures.map((f) => f.detail).join(' | ')}`);
    if (schema.skipped) issues.push(`schema gate skipped — ${schema.skipped}`);
    if (parsed?.issues?.length) issues.push(...parsed.issues);

    // POST hooks — fire with the node's outcome; a blocking failure downgrades the node to error.
    try {
      await runHooks(node.hooks?.post, hookCtx, { outcome: st === 'ok' ? 'success' : 'failure' });
    } catch (e) {
      st = 'error';
      issues.push(`post-hook failed: ${(e as Error).message}`);
    }

    // (project / registryProject / merge DERIVE ops ran ABOVE — after COLLECT, before the verify gate —
    // so a node whose required artifact is GENERATED by a merge `run` op verifies green. See that block.)

    // PROMOTE POST op (S3): on an OK node, LIFT each declared output into a RunState channel (the value
    // extracted now; the DRIVER merges it at the stage barrier — the "mechanical → driver hook" law, D6).
    // An artifact source reads under `{{RUN}}` (= outDir); an `@return:<field>` source drills the parsed
    // structured return (lastJsonBlock, widened). A promote of nothing throws → downgrade the node to error
    // (a real wiring breach, surfaced loudly), and emit no update.
    if (st === 'ok' && derived.promotes.length) {
      try {
        const promotes: ResolvedPromote[] = [];
        for (const raw of derived.promotes) {
          const spec = parsePromote(raw);
          const value = await extractPromoteValue(spec, { run: ctx.outDir, returnValue: parsed ?? undefined });
          promotes.push({ to: spec.to, value, merge: spec.merge });
        }
        ctx.promotesByNode.set(node.id, { nodeId: node.id, promotes });
      } catch (e) {
        st = 'error';
        issues.push(`promote failed: ${(e as Error).message}`);
      }
    }

    if (killed === 'timeout') rec.killedTimeout = true;
    if (killed === 'stall') rec.killedStall = true;

    // (G12 — M4) CAPTURE the EMPIRICAL failure signals for `runNodeWithRetries` (the retry / escalate
    // lanes). Set ONLY on a non-ok verdict so a clean node leaves none — `classifyFailure`/`consultPreamble`
    // read EXACTLY these (artifact stat, schema gate, integrity checks, watchdog kills, stderr, return
    // parse), never a model self-score. The schema-only-breach flag drives the G8 repair lane below.
    if (st !== 'ok') {
      ctx.failureSignals.set(node.id, {
        status: st,
        issues: [...issues],
        summary: parsed?.summary ?? '',
        missing,
        schemaInvalid: schema.invalid,
        returnSchemaInvalid,
        failedChecks: failedChecks.map((c) => ({ kind: c.kind, path: c.path, reason: c.reason })),
        killedTimeout: killed === 'timeout',
        killedStall: killed === 'stall',
        exitCode: result.code,
        stderrTail: (result.stderr || '').slice(-400),
        parsedOk: parsed != null,
      });
    }

    const summary = killed
      ? `killed (${killed})`
      : parsed?.summary ?? result.stdout.trim().slice(-200);
    return finishNode(ctx, node, rec, t0, st, summary, artifacts, issues);
  } catch (e) {
    // Anything thrown AFTER the sandbox exists (staging a read, the exec primitive, downloadDir, the
    // host-stat) is contained to THIS node as `error` — never a rejected lane (see LANE ISOLATION).
    return finishNode(ctx, node, rec, t0, 'error', `node failed: ${(e as Error).message}`, []);
  } finally {
    // Dispose is best-effort: a teardown failure must not reject the lane either. With a signal-
    // honoring provider (incl. InMemorySandbox) the watchdog aborts ExecOpts.signal → the child's
    // process group is killed → exec resolves before we reach here, so there is NO orphan/dispose race.
    // The only residual orphan is a provider that ignores the signal (the liveness-fallback path).
    try {
      await sandbox.dispose();
    } catch { /* teardown failure is non-fatal — the node verdict already stands */ }
  }
}

/**
 * Stamp a node's terminal fields, write status, and return the record. Exported as the lifecycle seam:
 * ./node-lanes.ts reuses it for the no-pi lanes. Lives WITH `runNode` so those edges stay one-way (RISK 2).
 */
export async function finishNode(
  ctx: RunContext,
  node: NodeSpec,
  rec: NodeStatusRecord,
  t0: number,
  status: NodeStatusRecord['status'],
  summary: string,
  artifacts: ArtifactState[],
  issues: string[] = [],
): Promise<NodeStatusRecord> {
  rec.status = status;
  rec.endedAt = nowISO();
  rec.durationMs = Date.now() - t0;
  rec.artifacts = artifacts;
  rec.issues = issues;
  rec.summary = summary;
  // (per-node stop) The node has EXITED ⇒ any persisted live-pi pid is now STALE and must never be signalled.
  // Remove `.pi/nodes/<id>/pid.json` on EVERY terminal verdict (the single choke point for every lane,
  // incl. the no-pi lanes that reuse finishNode). Best-effort + absent-file-safe (a node that never persisted
  // a pid — cloud/inmemory, or one that never spawned — simply has nothing to clear).
  await clearNodePid(ctx.outDir, node.id);
  // AWAIT the write (was a fire-and-forget `void`): a node's terminal record must be durable on disk
  // before its lane resolves, so the halt decision + final rollup never race an in-flight write. The
  // write is serialized + atomic (see writeStatus), so awaiting here cannot deadlock parallel lanes.
  await writeStatus(ctx.outDir, ctx.status);

  // G4 JOURNAL — write this node's entry ONLY on a terminal-GOOD verdict (`ok`). A `running`/`error`/
  // `blocked`/`gap` node writes NOTHING, so a crash mid-exec leaves the prior (or absent) entry and the
  // next resume sees "no/stale entry" → re-runs. Record: the envelope hash (computed once at run-start),
  // each CONSUMED input file's content hash, and each PRODUCED artifact's content hash (post-verify, so a
  // half-produced output is never recorded). Atomic tmp+rename + .bak, serialized per dir (see journal.ts).
  if (status === 'ok') {
    const inputHashes: Record<string, string> = {};
    for (const f of inputFilesOf(node, ctx.wf)) {
      const h = await hashFile(path.resolve(ctx.outDir, f));
      if (h) inputHashes[f] = h;
    }
    const outputHashes: Record<string, string> = {};
    for (const a of artifacts) {
      if (!a.exists) continue;
      const h = await hashFile(path.resolve(ctx.outDir, a.path));
      if (h) outputHashes[a.path] = h;
    }
    await writeJournalEntry(ctx.outDir, ctx.journal.meta, node.id, {
      hash: ctx.journal.envHash[node.id] ?? envelopeHash(node, { piTools: [] }, ctx.model),
      inputHashes,
      outputHashes,
      status: 'ok',
      producedAt: nowISO(),
      // (warm-resume C) Record the minted per-node session id/dir (when a warm-eligible node ran with one) so
      // a future `node <run> <id> --resume` finds it without re-deriving. Absent on a cold/no-session node.
      ...(rec.sessionId ? { sessionId: rec.sessionId } : {}),
      ...(rec.sessionDir ? { sessionDir: rec.sessionDir } : {}),
    });
  }
  return rec;
}

/**
 * The synthetic terminal record for a node REFUSED ADMISSION by the run-wide total cap (`maxNodesPerRun`).
 * It NEVER ran (no sandbox, no `execRunner`, no `pi`): the cap was hit at slot-acquire. We stamp the
 * node's existing seeded record to `error` with a loud `total node cap … exceeded` issue and persist —
 * so the existing `results.some(... 'error')` halt at the stage boundary stops the run (the loud-failure
 * convention, mirroring `__resume__`/`__barrier__`). Returns the record so the stage map's `results`
 * array carries it like any lane.
 */
export async function cappedRecord(ctx: RunContext, nodeId: string): Promise<NodeStatusRecord> {
  const rec = ctx.status.nodes[nodeId];
  rec.status = 'error';
  rec.endedAt = nowISO();
  rec.artifacts = [];
  rec.issues = [`total node cap (maxNodesPerRun=${ctx.maxNodesPerRun}) exceeded — node not started`];
  rec.summary = 'skipped: run-wide node cap reached';
  await writeStatus(ctx.outDir, ctx.status);
  return rec;
}
