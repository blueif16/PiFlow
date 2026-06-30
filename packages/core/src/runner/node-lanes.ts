// The three NO-PI node lanes (the §0 highest-value move) — runCheckpoint+finishCheckpoint,
// runRerouteGate, runProgrammatic — each a self-contained `(ctx, node) → Promise<NodeStatusRecord>` that
// spawns no `pi`. Extracted verbatim from runner.ts (the §2.1 cluster H split). They import `RunContext`
// from the leaf ./run-context.js and `finishNode` from ./node-lifecycle.js — a one-way edge into the
// lifecycle module (RISK 2: finishNode lives WITH runNode so this import never points back at runner.ts).

import { promises as fs, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { NodeSpec, CheckpointSpec, OnFailure } from '../types.js';
import type { RunContext } from './run-context.js';
import { effectiveChecks, evaluateChecks, actionForVerdict, type FileBytes } from '../checks.js';
import { validateArtifactSchemas } from './schema.js';
import { runHooks } from '../hooks/index.js';
import { resolveTokens, resolveDeep, type ResolveCtx } from '../workflow/resolver.js';
import { stageSeed } from '../workflow/ops/seed.js';
import { runMerge, applyMergeOp } from '../workflow/ops/merge.js';
import { applyProjectionOp, runProjection } from '../workflow/ops/project.js';
import { readJsonSafe, absUnder } from '../workflow/ops/util.js';
import { parsePromote, extractPromoteValue, type ResolvedPromote } from '../workflow/ops/promote.js';
import { derivesFromOp, gatesFromOp, runOpsFromOp } from './op-dispatch.js';
import { effectiveSandboxLocation } from './env-staging.js';
import {
  type NodeStatusRecord,
  type ArtifactState,
  nowISO,
  writeStatus,
  artifactState,
} from './status.js';
import {
  type JournalNode,
  envelopeHash,
  writeJournalEntry,
} from './journal.js';
import {
  type CheckpointReply,
  type CheckpointJournalSlot,
  buildMarker,
  validateReply,
  writeMarker,
  readMarker,
  readReply,
  readCheckpointJournal,
  journalCheckpoint,
} from './checkpoint.js';
import { finishNode } from './node-lifecycle.js';

// ── (G5) the HUMAN CHECKPOINT lane — no `pi`, no slot held while parked ──────────────────────────────

/**
 * Run a checkpoint node: write a marker, PARK watching for a reply (no `pi`, no sandbox), validate it, and
 * resolve `ok` carrying the chosen value — or, headlessly, take the declared `default` (journaled) so a
 * background run never hangs. CRASH-SAFE: the pending wait is journaled into `.pi/state.json`
 * `__checkpoints__`; if a journaled entry is already `resolved` (a prior run answered it), this REPLAYS
 * that value and does NOT re-ask. The reply is the RUNNER's to validate — a malformed/stale reply is
 * ignored and the wait persists. Called OUTSIDE the G2 limiter (see the stage fan-out), so a parked
 * checkpoint never holds a concurrency slot.
 */
export async function runCheckpoint(ctx: RunContext, node: NodeSpec, spec: CheckpointSpec): Promise<NodeStatusRecord> {
  const rec = ctx.status.nodes[node.id];
  const t0 = Date.now();

  // CRASH-RESUME REPLAY: a prior run that already journaled a `resolved` reply for THIS question replays it
  // (does NOT re-ask / re-journal). Match on the question hash so an edited question (new hash) re-prompts.
  const journalSlot = (await readCheckpointJournal(ctx.outDir))[node.id];
  const marker = buildMarker(node.id, node.label, spec, nowISO());
  if (journalSlot && journalSlot.status === 'resolved' && journalSlot.hash === marker.hash) {
    return finishCheckpoint(ctx, node, rec, t0, 'ok', journalSlot.reply, 'replayed prior reply');
  }

  // WRITE THE MARKER (status pending). Crash-safe: also journal the pending wait into `.pi/state.json`
  // `__checkpoints__` (preserve `askedAt` across a crash so the wait is stable). Reuse a prior marker's
  // `askedAt` when the question is unchanged so a re-entered wait keeps one identity.
  if (journalSlot && journalSlot.status === 'pending' && journalSlot.hash === marker.hash) {
    marker.askedAt = journalSlot.askedAt;
  }
  rec.status = 'awaiting-input';
  rec.startedAt = marker.askedAt;
  await writeMarker(ctx.outDir, marker);
  await journalCheckpoint(ctx.outDir, node.id, { status: 'pending', hash: marker.hash, askedAt: marker.askedAt });
  await writeStatus(ctx.outDir, ctx.status);

  // DECIDE: a DETACHED run (`checkpointReply:'default'`) skips the wait; an ATTENDED run parks up to
  // `timeoutMs` (Infinity ⇒ untimed). The wait/poll is the injectable seam (deterministic tests).
  let reply: CheckpointReply | null = null;
  if (ctx.checkpointReply === 'interactive') {
    const deadline = spec.timeoutMs !== undefined ? Date.now() + spec.timeoutMs : Infinity;
    reply = await ctx.checkpointWait({
      run: ctx.outDir,
      nodeId: node.id,
      deadline,
      read: () => readReply(ctx.outDir, node.id),
      // THE RUNNER IS THE AUTHORITY: only a reply that validates against the marker the runner wrote ends
      // the wait. A malformed/stale/bad-choice reply fails `accept` → the wait persists.
      accept: (r) => validateReply(marker, r).ok,
    });
  }

  // RESOLVED by a valid reply → journal the value, finish ok.
  if (reply) {
    const verdict = validateReply(marker, reply); // re-validate (authority) — accept() already passed
    if (verdict.ok) {
      return finishCheckpoint(ctx, node, rec, t0, 'ok', verdict.value, 'reply accepted');
    }
  }

  // NO (valid) reply within the bound → the headless SAFETY policy.
  const headless = marker.headless;
  if (headless === 'abort') {
    // Finish `error` so the run HALTS at the barrier (the loud-failure convention). Journal nothing.
    rec.issues = ['checkpoint aborted: no reply and headless:abort'];
    return finishCheckpoint(ctx, node, rec, t0, 'error', undefined, 'checkpoint aborted (headless:abort)');
  }
  // `headless:'default'` → take the declared default and JOURNAL it (mirrors the competitor; never hangs).
  return finishCheckpoint(ctx, node, rec, t0, 'ok', spec.default, 'headless default taken');
}

/**
 * Stamp a checkpoint node's terminal record, flip the marker + `__checkpoints__` journal to `resolved` (on
 * `ok`), and write the §G4 journal entry carrying `checkpointReply` (so a future content-hash resume
 * REPLAYS the value). On `error` (headless:abort) nothing is journaled — the next resume re-asks.
 */
async function finishCheckpoint(
  ctx: RunContext,
  node: NodeSpec,
  rec: NodeStatusRecord,
  t0: number,
  status: 'ok' | 'error',
  value: unknown,
  summary: string,
): Promise<NodeStatusRecord> {
  rec.status = status;
  rec.endedAt = nowISO();
  rec.durationMs = Date.now() - t0;
  rec.artifacts = [];
  rec.summary = summary;

  if (status === 'ok') {
    const resolvedAt = nowISO();
    const slot: CheckpointJournalSlot = {
      status: 'resolved',
      hash: ctx.journal.envHash[node.id] ?? '',
      askedAt: rec.startedAt ?? resolvedAt,
      reply: value,
      resolvedAt,
    };
    // The crash-safety journal carries the QUESTION hash (re-asked-question guard); recompute it from the
    // marker so it survives a value-only edit elsewhere. Use the marker's question hash, not the envelope.
    const marker = await readMarker(ctx.outDir, node.id);
    if (marker) {
      slot.hash = marker.hash;
      marker.status = 'resolved';
      await writeMarker(ctx.outDir, marker);
    }
    await journalCheckpoint(ctx.outDir, node.id, slot);
    rec.summary = `${summary}: ${JSON.stringify(value)}`;
  }
  await writeStatus(ctx.outDir, ctx.status);

  // §G4 journal: a checkpoint node has no inputs/outputs to hash; record the envelope hash + the reply so a
  // resume whose question is unchanged REPLAYS the value (a changed question flips the envelope hash → re-run).
  if (status === 'ok') {
    const entry: JournalNode = {
      hash: ctx.journal.envHash[node.id] ?? envelopeHash(node, { piTools: [] }, ctx.model),
      inputHashes: {},
      outputHashes: {},
      status: 'ok',
      producedAt: nowISO(),
      checkpointReply: value,
    };
    await writeJournalEntry(ctx.outDir, ctx.journal.meta, node.id, entry);
  }
  return rec;
}

/**
 * (G12 — M3 · #17) Run a GENERATED reroute EXISTENCE-GATE node: stat the prior attempt's canonical verify
 * artifact and SHORT-CIRCUIT the bounded re-entry when it is present. Spawns NO `pi`, holds no sandbox. On a
 * PASS (the artifact exists): COPY it forward to each `copyTo` dest (so the downstream that was re-pointed
 * onto this attempt's output has its input), MARK every cloned body id `reused` so it never spawns, write
 * the gate's own `gate.ok` sentinel (the forward edge the re-entry root reads), and finish `ok`. On a MISS
 * (the prior attempt failed): write the sentinel and finish `ok`, leaving the cloned body `pending` so the
 * fix attempt runs. Mirrors `runCheckpoint` as a no-pi node-kind; the run loop calls it OUTSIDE the G2 limiter.
 */
export async function runRerouteGate(ctx: RunContext, node: NodeSpec): Promise<NodeStatusRecord> {
  const gate = node.rerouteGate!;
  const rec = ctx.status.nodes[node.id];
  rec.status = 'running';
  rec.startedAt = nowISO();
  const t0 = Date.now();

  const priorOk = gate.artifact ? (await artifactState(path.resolve(ctx.outDir, gate.artifact), gate.artifact)).exists : false;
  // The forward-edge sentinel (the re-entry root reads it, so the gate orders BEFORE the clones).
  const sentinel = node.io.produces[0];
  if (sentinel) {
    const dest = path.resolve(ctx.outDir, sentinel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, priorOk ? 'pass' : 'fix');
  }

  if (priorOk) {
    // Short-circuit: copy the passing artifact forward to this attempt's output(s), so the downstream node
    // (re-pointed onto this attempt) reads it WITHOUT the clone running.
    for (const to of gate.copyTo) {
      const src = path.resolve(ctx.outDir, gate.artifact);
      const dst = path.resolve(ctx.outDir, to);
      await fs.mkdir(path.dirname(dst), { recursive: true });
      try { await fs.copyFile(src, dst); } catch { /* best-effort: a missing src is the gate's own miss */ }
    }
    // Mark every cloned body `reused` — the run loop SKIPS a `reused` lane (it never spawns `pi`, never holds
    // a slot). The bodies live in LATER stages (the gate is upstream), so flipping their seeded status here
    // takes effect when the loop reaches them. This is the #17 short-circuit: the cloned bodies provably do
    // not spawn on a passing attempt.
    for (const id of gate.skip) {
      const r = ctx.status.nodes[id];
      if (r && r.status !== 'ok') r.status = 'reused';
    }
  }

  const states = await Promise.all(
    node.io.artifacts.map((a) => artifactState(path.resolve(ctx.outDir, a.path), a.path)),
  );
  rec.status = 'ok';
  rec.endedAt = nowISO();
  rec.durationMs = Date.now() - t0;
  rec.artifacts = states;
  rec.summary = priorOk ? 'reroute gate: prior attempt PASSED — re-entry short-circuited' : 'reroute gate: prior attempt failed — running fix';
  await writeStatus(ctx.outDir, ctx.status);
  return rec;
}

// ── (PROGRAMMATIC NODE) the no-pi DECLARATIVE-OPS lane ──────────────────────────────────────────────

/**
 * Run a PROGRAMMATIC node: a node carrying `programmatic:true` runs its DECLARATIVE ops deterministically
 * and spawns NO `pi` — NO `buildCommand`, NO exec. It is the no-pi twin of `runCheckpoint`/`runRerouteGate`,
 * for a purely-deterministic step (e.g. a render) that should be an honest DAG vertex with no vestigial
 * agent. The lifecycle MIRRORS `runNode` but DROPS everything model-specific (sandbox, prompt staging,
 * skill/MCP/tool resolution, the command build + exec, COLLECT/downloadDir, the return handshake, the G8
 * schema-repair loop): PRE seeds (staged onto the host run dir = `{{RUN}}`) → PRE gates → POST DERIVE ops
 * (project/registryProject/merge/`run`) → POST checks → status ladder → POST hooks → promote → finishNode.
 * The op executors (`stageSeed`/`applyProjectionOp`/`runProjection`/`runMerge`/`applyMergeOp`/`evaluateChecks`)
 * and `finishNode` are REUSED UNCHANGED — this lane only changes the dispatch frame (no model, no pi). Called
 * OUTSIDE the G2 limiter (it holds no process/slot), exactly like the other no-pi node kinds.
 *
 * UNJAILED, the NO-LLM sibling of `fullAccess`. A programmatic node also runs unjailed (host ops, never
 * `scope.create`), but for a DIFFERENT reason: its command is fixed + repo-authored (no LLM to contain →
 * safe by construction), whereas a `fullAccess` pi node reaches the jail seam (`scope.create` →
 * `LocalSandbox.exec`) and the author explicitly opts an LLM out of it. ONE concept (unjailed = programmatic
 * ∨ fullAccess), TWO code paths — so there is deliberately NO shared `nodeIsUnjailed` predicate (it would be
 * dead code); the config records both slices (`programmatic`, `fullAccess`) for a viewer to reason together.
 */
export async function runProgrammatic(ctx: RunContext, srcNode: NodeSpec): Promise<NodeStatusRecord> {
  const rec = ctx.status.nodes[srcNode.id];
  rec.status = 'running';
  rec.startedAt = nowISO();
  const t0 = Date.now();
  // A re-run STARTS FRESH (mirrors runNode): clear the prior attempt's signals.
  ctx.failureSignals.delete(srcNode.id);
  await writeStatus(ctx.outDir, ctx.status);

  // IO TOKEN RESOLUTION AT LAUNCH (U7, mirrors runNode): make `{{arg.*}}`/`{{WORKSPACE}}`/`{{RUN}}`/
  // `{{state.*}}` PHYSICAL in the node's CONTRACT paths (io.artifacts[].path, io.checks[].path) so the
  // artifact/check gates stat the resolved path, never a raw `{{…}}`. A missing arg/channel throws loudly.
  const resolveCtx: ResolveCtx = { run: ctx.outDir, workspace: ctx.workspace, state: ctx.runState, args: ctx.args };
  let node = srcNode;
  try {
    node = {
      ...srcNode,
      io: {
        ...srcNode.io,
        artifacts: srcNode.io.artifacts.map((a) => ({ ...a, path: resolveTokens(a.path, resolveCtx) })),
        checks: srcNode.io.checks?.map((c) => (c.path ? { ...c, path: resolveTokens(c.path, resolveCtx) } : c)),
      },
    };
  } catch (e) {
    return finishNode(ctx, srcNode, rec, t0, 'error', `io token resolution failed: ${(e as Error).message}`, [], [(e as Error).message]);
  }

  // (U1a/U1b) The derive DISPATCH now reads the canonical `op[]` (via `derivesFromOp`), NOT `node.ops`.
  // One reconstruction per node; each derive site below iterates the matching family list. The resolution +
  // executor calls are byte-identical to the legacy `node.ops?.{…}` sites — only the SOURCE changed.
  const derived = derivesFromOp(node.op);

  try {
    // PRE SEED ops (S2): stage each declared starting artifact onto the host run dir (= `{{RUN}}`). No
    // sandbox mirror (a programmatic node spawns no pi). A `{{state.*}}` naming a not-yet-promoted channel
    // throws → fail loudly (a real wiring error), never a silent skip.
    try {
      for (const seed of derived.seeds) {
        await stageSeed(seed, resolveCtx, ctx.outDir);
      }
    } catch (e) {
      return finishNode(ctx, node, rec, t0, 'error', `seed staging failed: ${(e as Error).message}`, [], [(e as Error).message]);
    }

    // PRE-GATE — fire the node's `when:'pre'` gate ops over the staged inputs (mirrors runNode's #11 block).
    // A blocking pre-gate failure fails the node here. Each gate's `onFailure` (default 'block') decides;
    // an `advisory`/`warn` gate records but does not block.
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
        return finishNode(ctx, node, rec, t0, 'blocked', `pre-gate FAILED — ${detail}`, [], [`pre-gate: ${detail}`]);
      }
    }

    // PRE hooks — deterministic plumbing; a blocking failure throws → error (mirrors runNode).
    // In-place hooks run IN the run dir (sbLoc.workdir = outDir), so a no-pi lane's relative writes land
    // under {{RUN}} like a pi node's; isolated kinds resolve to the same workspace as before.
    const hookCtx = {
      workspace: effectiveSandboxLocation(ctx.providerKind, ctx.outDir, node.sandbox).workdir,
      inputs: node.io.reads,
      outputs: node.io.produces,
    };
    try {
      await runHooks(node.hooks?.pre, hookCtx, { outcome: 'success' });
    } catch (e) {
      return finishNode(ctx, node, rec, t0, 'error', `pre-hook failed: ${(e as Error).message}`, []);
    }

    // POST DERIVE ops (project → registryProject → merge → `run`). The SAME executors runNode reuses, in the
    // SAME order — only there is no model exit to gate on (the deterministic ops always run). A `run`/`merge`
    // op's non-zero exit routes through the op's `onFailure` (default 'block'), collected here and applied in
    // the status ladder below.
    const opFailures: { detail: string; onFailure: OnFailure }[] = [];
    // project: derive from a FROZEN source JSON read once (graceful no-op on an authoring-only spec).
    for (const rawOp of derived.projects) {
      const op = resolveDeep(rawOp as Record<string, unknown>, resolveCtx);
      const srcRel = (op.source as string) ?? (Array.isArray(op.from) ? (op.from[0] as string) : (op.from as string));
      const spec = srcRel ? await readJsonSafe(absUnder(ctx.outDir, srcRel)) : undefined;
      const name = String(op.op ?? Object.keys(op).find((k) => k === 'copy' || k === 'assemble' || k === 'merge') ?? 'project');
      await applyProjectionOp(name, op, spec, ctx.outDir);
    }
    // registryProject: the op-map lives in the registry record (mapRef), resolved by `key`. The single
    // `derived.registryProjects` loop covers BOTH hooks- and op[]-authored nodes (the legacy `if` arm folded in).
    for (const rp of derived.registryProjects) {
      const pg = resolveDeep({ source: rp.source, mapRef: rp.mapRef, key: rp.key }, resolveCtx) as { source: string; mapRef: string; key: string };
      await runProjection({ source: pg.source, mapRef: pg.mapRef, key: pg.key }, ctx.outDir);
    }
    // merge: the `{ ops:[...] }` MergeSpec (fold|concat|reconcile|run) — incl. a gen-hook `run` op.
    for (const m of derived.merges) {
      const mergeOnFailure = ((node.op ?? []).find((o) => o.transform?.kind === 'merge')?.onFailure ?? 'block') as OnFailure;
      const merged = await runMerge(resolveDeep(m, resolveCtx), ctx.outDir);
      for (const r of merged?.ops ?? []) {
        if (r.failed) opFailures.push({ detail: `merge ${r.op} failed${r.exit != null ? ` (exit ${r.exit})` : ''}${r.stderr ? `: ${r.stderr}` : ''}`, onFailure: mergeOnFailure });
      }
    }
    // AUTHORABLE `run` body — a POST `op` with a `run:{cmd,args,cwd}` body is a deterministic derive/side-
    // effect step. Reuse the merge executor's `run` impl, then route a non-zero exit through `onFailure`.
    const runOps = runOpsFromOp(node.op); // (C2) the SINGLE run→executor-input adapter (was inlined here).
    for (const { body, onFailure } of runOps.runnable) {
      const r = await applyMergeOp({ run: { cmd: body.cmd, args: body.args, cwd: body.cwd } }, ctx.outDir);
      if (r.failed) {
        opFailures.push({ detail: `run ${r.cmd ?? body.cmd} failed${r.exit != null ? ` (exit ${r.exit})` : ''}${r.stderr ? `: ${r.stderr}` : ''}`, onFailure });
      }
    }
    // (B-fix) FAIL LOUD: a run op the runner has NO executor for (when:'pre'/'on-failure', the {fn} variant, or
    // a cmd-less body) is surfaced as an op failure here — never the old silent `continue` that dropped it.
    for (const rej of runOps.rejected) opFailures.push(rej);

    // VERIFY by host-stat (mirrors runNode): a node is `ok` only if its declared artifacts exist on disk.
    const artifacts: ArtifactState[] = await Promise.all(
      node.io.artifacts.map((a) => artifactState(path.resolve(ctx.outDir, a.path), a.path)),
    );
    const missing = artifacts.filter((a) => !a.exists).map((a) => a.path);

    // POST-NODE SCHEMA GATE — a present-but-invalid artifact (vs its declared schema) is a contract breach.
    const schema = await validateArtifactSchemas(node.io.artifacts, {
      outDir: ctx.outDir,
      roots: [ctx.outDir],
      validate: ctx.validateSchema,
    });
    if (schema.invalid.length) rec.schemaInvalid = schema.invalid;
    if (schema.checked) rec.schemaChecked = schema.checked;
    if (schema.skipped) rec.schemaSkipped = schema.skipped;

    // DECLARATIVE INTEGRITY CHECKS (explicit ∪ the auto fill-sentinel completeness check) through the
    // verdict→action POLICY — IDENTICAL to runNode.
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

    const blockingOpFailures = opFailures.filter((f) => f.onFailure !== 'warn');
    const warningOpFailures = opFailures.filter((f) => f.onFailure === 'warn');

    // The status ladder — the driver-verified contract breaches (no model exit to read, no return handshake:
    // a programmatic node proves its work by its artifacts + checks, never a fenced-JSON tail). missing →
    // schema-invalid → blocking integrity check → blocking op failure → ok.
    let st: NodeStatusRecord['status'];
    const issues: string[] = [];
    if (missing.length) {
      st = 'blocked';
      issues.push(`contract breach — required artifact(s) missing: ${missing.join(', ')}`);
    } else if (schema.invalid.length) {
      st = 'blocked';
      issues.push(`contract breach — artifact(s) violate the declared schema: ${schema.invalid.map((x) => `${x.path} [${x.errors.join('; ')}]`).join(' | ')}`);
    } else if (blockingChecks.length) {
      st = 'blocked';
      issues.push(`integrity check FAILED — ${blockingChecks.map((c) => `${c.kind} ${c.path || ''}: ${c.reason}`).join(' | ')}`);
    } else if (blockingOpFailures.length) {
      st = 'blocked';
      issues.push(`op FAILED — ${blockingOpFailures.map((f) => f.detail).join(' | ')}`);
    } else {
      st = 'ok';
    }
    if (warningChecks.length) issues.push(`integrity warn — ${warningChecks.map((c) => `${c.kind} ${c.path || ''}: ${c.reason}`).join(' | ')}`);
    if (warningOpFailures.length) issues.push(`op warn — ${warningOpFailures.map((f) => f.detail).join(' | ')}`);
    if (schema.skipped) issues.push(`schema gate skipped — ${schema.skipped}`);

    // POST hooks — fire with the node's outcome; a blocking failure downgrades the node to error.
    try {
      await runHooks(node.hooks?.post, hookCtx, { outcome: st === 'ok' ? 'success' : 'failure' });
    } catch (e) {
      st = 'error';
      issues.push(`post-hook failed: ${(e as Error).message}`);
    }

    // PROMOTE POST op (S3): on an OK node, LIFT each declared output into a RunState channel (the driver
    // merges it at the stage barrier). A programmatic node has no parsed return, so an `@return:` source has
    // no value to drill — an artifact source reads under `{{RUN}}`. A promote of nothing throws → error.
    if (st === 'ok' && derived.promotes.length) {
      try {
        const promotes: ResolvedPromote[] = [];
        for (const raw of derived.promotes) {
          const spec = parsePromote(raw);
          const value = await extractPromoteValue(spec, { run: ctx.outDir, returnValue: undefined });
          promotes.push({ to: spec.to, value, merge: spec.merge });
        }
        ctx.promotesByNode.set(node.id, { nodeId: node.id, promotes });
      } catch (e) {
        st = 'error';
        issues.push(`promote failed: ${(e as Error).message}`);
      }
    }

    // CAPTURE the EMPIRICAL failure signals (mirrors runNode) so a node-level retry/rerouteTo can classify
    // a programmatic node's failure. Set ONLY on a non-ok verdict (a clean node leaves none).
    if (st !== 'ok') {
      ctx.failureSignals.set(node.id, {
        status: st,
        issues: [...issues],
        summary: '',
        missing,
        schemaInvalid: schema.invalid,
        returnSchemaInvalid: [],
        failedChecks: failedChecks.map((c) => ({ kind: c.kind, path: c.path, reason: c.reason })),
        killedTimeout: false,
        killedStall: false,
        exitCode: 0,
        stderrTail: '',
        parsedOk: false,
      });
    }

    const summary = st === 'ok' ? 'programmatic ops ran' : issues[0] ?? 'programmatic node failed';
    return finishNode(ctx, node, rec, t0, st, summary, artifacts, issues);
  } catch (e) {
    // Anything thrown is contained to THIS node as `error` — never a rejected lane (mirrors runNode).
    return finishNode(ctx, node, rec, t0, 'error', `node failed: ${(e as Error).message}`, []);
  }
}
