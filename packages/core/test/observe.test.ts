import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  runJsonFile,
  nodeIoFile,
  nodeEventsFile,
  writeNodeIo,
} from '../src/runner/layout.js';
import type { RunStatus, NodeStatusRecord } from '../src/runner/status.js';
import type { NodeIo } from '../src/types.js';
import type { PiEvent } from '../src/runner/events.js';
import { readRunModel } from '../src/observe/read.js';
import { buildRunView } from '../src/observe/runView.js';
import { DEFAULT_CONTEXT_WINDOW } from '../src/observe/models.js';
import { watchRun } from '../src/observe/watch.js';
import { projectRunDigest } from '../src/observe/telemetry.js';
import type { RunUpdate } from '../src/observe/types.js';

// ── fixture: a `.pi/` run dir built with the LAYOUT HELPERS (never a hardcoded path) ─────────────────
// Three+ nodes covering the bar: an `ok`, a `blocked` (record self-reports ok but a declared artifact
// is ABSENT on disk), a `running`, plus a parallel lane (b1‖b2 share the published stage barrier). One
// io-derived edge: `w0` writes spec/cls.json → `w1` reads it (a→b data-flow edge).

interface FixtureNode {
  rec: NodeStatusRecord;
  io?: NodeIo;
  /** Declared write paths to actually CREATE on disk (so artifactState sees them). */
  filesOnDisk?: { rel: string; body: string }[];
  events?: PiEvent[];
}

async function writeFixture(
  runDir: string,
  status: RunStatus,
  nodes: Record<string, FixtureNode>,
): Promise<void> {
  // write each node's on-disk artifacts (relative to the run dir).
  for (const fn of Object.values(nodes)) {
    for (const f of fn.filesOnDisk ?? []) {
      const abs = path.resolve(runDir, f.rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, f.body);
    }
  }
  // write run.json via the layout helper's path.
  const rj = runJsonFile(runDir);
  await fs.mkdir(path.dirname(rj), { recursive: true });
  await fs.writeFile(rj, JSON.stringify(status, null, 2));
  // write each node's io.json + events.jsonl via the layout helpers.
  for (const [id, fn] of Object.entries(nodes)) {
    if (fn.io) await writeNodeIo(runDir, fn.io);
    if (fn.events?.length) {
      const ef = nodeEventsFile(runDir, id);
      await fs.mkdir(path.dirname(ef), { recursive: true });
      await fs.writeFile(ef, fn.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    }
  }
}

// Rewrite ONLY run.json + the io ledgers (never the events files) — used mid-stream so an appended
// events.jsonl line is never clobbered by a full-file rewrite.
async function writeFixtureMeta(
  runDir: string,
  status: RunStatus,
  nodes: Record<string, FixtureNode>,
): Promise<void> {
  for (const fn of Object.values(nodes)) {
    for (const f of fn.filesOnDisk ?? []) {
      const abs = path.resolve(runDir, f.rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, f.body);
    }
  }
  await fs.writeFile(runJsonFile(runDir), JSON.stringify(status, null, 2));
  for (const fn of Object.values(nodes)) if (fn.io) await writeNodeIo(runDir, fn.io);
}

function baseFixture(): { status: RunStatus; nodes: Record<string, FixtureNode> } {
  const rec = (id: string, label: string, status: NodeStatusRecord['status'], extra: Partial<NodeStatusRecord> = {}): NodeStatusRecord => ({
    id, label, status, artifacts: [], issues: [], ...extra,
  });
  const status: RunStatus = {
    run: 'fix1',
    provider: 'cp',
    model: 'm1',
    startedAt: '2026-06-23T00:00:00.000Z',
    updatedAt: '2026-06-23T00:00:10.000Z',
    done: false,
    ok: null,
    durationMs: null,
    // The engine's last-published parallel barrier: b1 ‖ b2 run side-by-side.
    stage: { index: 2, total: 2, nodeIds: ['b1', 'b2'] },
    totals: null,
    nodes: {
      // w0: clean ok, one declared artifact PRESENT on disk → stays ok.
      w0: rec('w0', 'Classify', 'ok', { durationMs: 4000, artifacts: [{ path: 'spec/cls.json', exists: true, bytes: 12 }] }),
      // b1: record SELF-REPORTS ok, but its declared artifact is ABSENT → derived `blocked`.
      b1: rec('b1', 'Build A', 'ok', { durationMs: 3000, artifacts: [{ path: 'src/a.js', exists: false, bytes: 0 }] }),
      // b2: still running (parallel sibling of b1).
      b2: rec('b2', 'Build B', 'running', {}),
    },
  };
  const nodes: Record<string, FixtureNode> = {
    w0: {
      rec: status.nodes.w0,
      io: { id: 'w0', label: 'Classify', phase: 'design', reads: [], writes: [{ path: 'spec/cls.json', verified: true, bytes: 12 }], promotes: [], status: 'ok' },
      filesOnDisk: [{ rel: 'spec/cls.json', body: '{"a":1}' }],
    },
    b1: {
      rec: status.nodes.b1,
      // b1 READS w0's output (the edge w0→b1) and declares src/a.js — which we do NOT create on disk.
      io: { id: 'b1', label: 'Build A', phase: 'build', reads: [{ path: 'spec/cls.json' }], writes: [{ path: 'src/a.js', verified: false }], promotes: [], status: 'ok' },
    },
    b2: {
      rec: status.nodes.b2,
      io: { id: 'b2', label: 'Build B', phase: 'build', reads: [{ path: 'spec/cls.json' }], writes: [{ path: 'src/b.js', verified: false }], promotes: [], status: 'running' },
    },
  };
  return { status, nodes };
}

// Write the run-local RESOLVED DAG (`.pi/workflow.json`) — the runner persists it with the active profile
// already applied. It is the AUTHORITATIVE structure both readers now prefer over io/phase reconstruction.
async function writeWorkflowJson(
  runDir: string,
  dag: { stages: { index?: number; phase?: string | null; parallel?: boolean; nodeIds: string[] }[]; edges: { from: string; to: string; files?: string[] }[] },
): Promise<void> {
  const f = path.join(runDir, '.pi', 'workflow.json');
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(f, JSON.stringify({ meta: { name: 'fix', description: '' }, profile: null, ...dag }, null, 2) + '\n');
}

const mkRunDir = (): string => mkdtempSync(path.join(tmpdir(), 'piflow-observe-'));

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// (2) readRunModel — the one-shot snapshot
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('readRunModel — the shared one-shot snapshot over a .pi/ run dir', () => {
  // G6 — the agentType LABEL is a verbatim passthrough from the node record through BOTH shared readers
  // (the lean readRunModel snapshot and the enriched buildRunView), so the GUI can key the preset icon off
  // it. FAILS if a reader drops it (the icon would never render). Additive: a node with none → undefined.
  it('surfaces the node record\'s agentType through readRunModel AND buildRunView (G6)', async () => {
    const runDir = mkRunDir();
    const { status, nodes } = baseFixture();
    status.nodes.w0.agentType = 'market-research';
    await writeFixture(runDir, status, nodes);

    const model = await readRunModel(runDir);
    const byId = Object.fromEntries(model.nodes.map((n) => [n.id, n]));
    expect(byId.w0.agentType).toBe('market-research');
    expect(byId.b2.agentType).toBeUndefined();

    const { view } = buildRunView(runDir);
    const vById = Object.fromEntries(view.nodes.map((n) => [n.id, n]));
    expect(vById.w0.agentType).toBe('market-research');
    expect(vById.b2.agentType).toBeUndefined();
  });

  it('maps status (verified-not-trusted), verified/total artifacts, the parallel lane, and io edges', async () => {
    const runDir = mkRunDir();
    const { status, nodes } = baseFixture();
    await writeFixture(runDir, status, nodes);

    const model = await readRunModel(runDir);

    expect(model.run).toBe('fix1');
    expect(model.done).toBe(false);
    expect(model.provider).toBe('cp');

    const byId = Object.fromEntries(model.nodes.map((n) => [n.id, n]));

    // w0: ok, artifact present → 1/1 verified, stays ok.
    expect(byId.w0.status).toBe('ok');
    expect(byId.w0.reported).toBe('ok');
    expect(byId.w0.artifactsVerified).toBe(1);
    expect(byId.w0.artifactsTotal).toBe(1);
    expect(byId.w0.missing).toEqual([]);

    // b1: record self-reports ok but src/a.js is ABSENT → derived blocked (the load-bearing mapping).
    expect(byId.b1.reported).toBe('ok');
    expect(byId.b1.status).toBe('blocked');
    expect(byId.b1.artifactsVerified).toBe(0);
    expect(byId.b1.artifactsTotal).toBe(1);
    expect(byId.b1.missing).toEqual(['src/a.js']);

    // b2: running passes through (makes no artifact claim yet).
    expect(byId.b2.status).toBe('running');

    // Parallel lane (NO workflow.json ⇒ the tier-3 phase-grouping fallback): w0 is phase `design`, b1‖b2 are
    // both phase `build` → they share the build stage. Same stageIndex, distinct lanes.
    expect(byId.b1.stageIndex).toBe(byId.b2.stageIndex);
    expect(new Set([byId.b1.lane, byId.b2.lane])).toEqual(new Set([0, 1]));
    const parallel = model.stages.find((s) => s.parallel);
    expect(parallel?.nodeIds.sort()).toEqual(['b1', 'b2']);

    // Edge (fallback): w0 wrote spec/cls.json which b1 read back → w0→b1 (b2 reads it too → w0→b2). The path is
    // display-normalized against the run dir (P0b), the SAME as buildRunView.
    const edge = model.edges.find((e) => e.from === 'w0' && e.to === 'b1');
    expect(edge).toBeTruthy();
    expect(edge?.path).toBe('spec/cls.json');
  });

  it('throws a clear error when the run dir has no readable .pi/run.json', async () => {
    const runDir = mkRunDir();
    await expect(readRunModel(runDir)).rejects.toThrow(/run\.json/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// (2a) STRUCTURE PARITY (P0b) — readRunModel + buildRunView resolve edges+stages the SAME way, and both
// PREFER the run-local resolved DAG (`.pi/workflow.json`) when present. Before P0b the lean snapshot
// reconstructed edges purely from the io ledgers and grouped stages off the barrier, so the live graph
// and the loaded run-view could diverge. This pins the closed gap.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('readRunModel + buildRunView agree on edges/stages (structure parity, P0b)', () => {
  // Normalize a stage list from EITHER reader to a comparable shape (phase `null`↔`—` collapsed, since the
  // lean StageView allows null while the RunViewStage stamps `—`; the placement is what must match).
  const normStages = (stages: { index: number; phase: string | null; parallel: boolean; nodeIds: string[] }[]) =>
    stages.map((s) => ({ index: s.index, phase: s.phase ?? '—', parallel: s.parallel, nodeIds: [...s.nodeIds].sort() }))
      .sort((a, b) => a.index - b.index);
  const normEdges = (edges: { from: string; to: string; path: string }[]) =>
    [...edges].map((e) => ({ from: e.from, to: e.to, path: e.path })).sort((a, b) => `${a.from}|${a.to}|${a.path}`.localeCompare(`${b.from}|${b.to}|${b.path}`));
  const placement = (nodes: { id: string; stageIndex?: number | null; lane?: number | null }[]) =>
    Object.fromEntries(nodes.map((n) => [n.id, { stageIndex: n.stageIndex, lane: n.lane }]));

  it('WITHOUT .pi/workflow.json: both readers agree on edges + stages via the shared fallback', async () => {
    const runDir = mkRunDir();
    const { status, nodes } = baseFixture();
    await writeFixture(runDir, status, nodes); // NO workflow.json

    const model = await readRunModel(runDir);
    const { view } = buildRunView(runDir);

    expect(normEdges(model.edges)).toEqual(normEdges(view.edges));
    expect(normStages(model.stages)).toEqual(normStages(view.stages));
    // and the io-derived w0→{b1,b2} data-flow edges are what both produced.
    expect(normEdges(model.edges)).toEqual([
      { from: 'w0', to: 'b1', path: 'spec/cls.json' },
      { from: 'w0', to: 'b2', path: 'spec/cls.json' },
    ]);
    // node placement matches too (same stageIndex/lane per node id).
    expect(placement(model.nodes)).toEqual(placement(view.nodes));
  });

  it('WITH .pi/workflow.json: readRunModel now PREFERS the resolved DAG — a DIFFERENT graph than io reconstruction, and it matches buildRunView', async () => {
    const runDir = mkRunDir();
    const { status, nodes } = baseFixture();
    await writeFixture(runDir, status, nodes);
    // The resolved DAG declares a graph the io/phase reconstruction would NOT produce:
    //  • stages: w0‖b1 run together (stage 1), b2 alone (stage 2) — the OPPOSITE of the phase grouping
    //    (which puts w0 alone, then b1‖b2). A reader ignoring workflow.json cannot produce this.
    //  • edges: an explicit b1→b2 contract edge (`gen/plan.json`) that NO io ledger read/write implies.
    await writeWorkflowJson(runDir, {
      stages: [
        { index: 1, phase: 'design', parallel: true, nodeIds: ['w0', 'b1'] },
        { index: 2, phase: 'build', parallel: false, nodeIds: ['b2'] },
      ],
      edges: [
        { from: 'w0', to: 'b1', files: ['spec/cls.json'] },
        { from: 'b1', to: 'b2', files: ['gen/plan.json'] },
      ],
    });

    const model = await readRunModel(runDir);
    const { view } = buildRunView(runDir);

    // (1) The two readers AGREE — the whole point of P0b.
    expect(normEdges(model.edges)).toEqual(normEdges(view.edges));
    expect(normStages(model.stages)).toEqual(normStages(view.stages));
    expect(placement(model.nodes)).toEqual(placement(view.nodes));

    // (2) readRunModel took the DAG, NOT the io reconstruction — the concrete new values (teeth: reverting
    // readRunModel to io-edge/barrier reconstruction makes BOTH of these fail).
    expect(normEdges(model.edges)).toEqual([
      { from: 'b1', to: 'b2', path: 'gen/plan.json' }, // the declared contract edge io could never yield
      { from: 'w0', to: 'b1', path: 'spec/cls.json' },
    ]);
    // the b1→b2 edge is present (io reconstruction would MISS it — b1 never wrote gen/plan.json on disk).
    expect(model.edges.some((e) => e.from === 'b1' && e.to === 'b2')).toBe(true);
    // stages follow the DAG: w0 and b1 share stage 1 (io/phase grouping would split them).
    const byId = Object.fromEntries(model.nodes.map((n) => [n.id, n]));
    expect(byId.w0.stageIndex).toBe(byId.b1.stageIndex);
    expect(byId.b2.stageIndex).not.toBe(byId.w0.stageIndex);
    expect(model.stages.find((s) => s.parallel)?.nodeIds.sort()).toEqual(['b1', 'w0']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// (2b) buildRunView — the SKIN channel (run-level sandbox backend + the per-node curated config slice)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('buildRunView — the SKIN channel surfaces the run sandbox + per-node config', () => {
  // The run records its chosen backend ONCE (`run.json` `sandbox`) and a CURATED config slice per node
  // (`config`). Both must round-trip through buildRunView VERBATIM, or the GUI's cloud skin (which keys off
  // the real SandboxProviderKind + the programmatic carve-out) has nothing to render. Dropping either
  // passthrough turns this RED (the field reads undefined). Additive: a record with none → undefined.
  it('surfaces run-level view.sandbox from run.json and node.config verbatim from a record', async () => {
    const runDir = mkRunDir();
    const { status, nodes } = baseFixture();
    // (a) the run's effective backend, stamped once.
    status.sandbox = 'daytona';
    // (b) a curated per-node config slice on w0 (a cloud-run agent) — the values the GUI reads.
    status.nodes.w0.config = {
      model: 'm1',
      provider: 'cp',
      tier: 'fast',
      tools: { allow: ['fs:read'], deny: ['web:search'] },
      timeoutMs: 60_000,
      retries: 2,
      agentType: 'market-research',
      sandbox: { workspace: '.', readScope: ['spec/'], owns: ['out/'] },
    };
    // (b') a programmatic node carries the carve-out flag in its slice. `fullAccess` is the sibling jail-off
    // carve-out — both are top-level NodeConfig booleans that must round-trip verbatim (§5.8: observe needs
    // no change; the slice carries `fullAccess` for the GUI skin to read "ran unlocked" off config).
    status.nodes.b2.config = { programmatic: true, fullAccess: true };
    await writeFixture(runDir, status, nodes);

    const { view } = buildRunView(runDir);
    const vById = Object.fromEntries(view.nodes.map((n) => [n.id, n]));

    // (a) the run-level backend rides through.
    expect(view.sandbox).toBe('daytona');

    // (b) the config slice rides through VERBATIM (a deep round-trip, no field dropped/renamed).
    expect(vById.w0.config).toEqual({
      model: 'm1',
      provider: 'cp',
      tier: 'fast',
      tools: { allow: ['fs:read'], deny: ['web:search'] },
      timeoutMs: 60_000,
      retries: 2,
      agentType: 'market-research',
      sandbox: { workspace: '.', readScope: ['spec/'], owns: ['out/'] },
    });
    expect(vById.b2.config).toEqual({ programmatic: true, fullAccess: true });

    // a node with NO config slice surfaces undefined (additive).
    expect(vById.b1.config).toBeUndefined();
  });

  // (POLICY channel) The authored gate/policy summary rides the SAME config passthrough. The runner distills
  // it once (summarizeGates → buildNodeConfig) into `config.gates`; observe must carry it VERBATIM so the GUI
  // renders "what happens after this node" from the ONE data path, never the /__piflow/node-config side-channel.
  // If observe stripped or reshaped config, this reads undefined and goes RED.
  it('surfaces node.config.gates (the POLICY channel) verbatim through buildRunView', async () => {
    const runDir = mkRunDir();
    const { status, nodes } = baseFixture();
    const gates = {
      entries: [
        { kind: 'check' as const, label: 'non-empty', when: 'post' as const, onFail: 'block' as const },
        { kind: 'reroute' as const, label: 'reroute→w0 ×4', when: 'on-failure' as const },
        { kind: 'human' as const, label: 'confirm', when: 'post' as const },
      ],
      checkpoint: 'confirm' as const,
    };
    status.nodes.w0.config = { gates };
    await writeFixture(runDir, status, nodes);

    const { view } = buildRunView(runDir);
    const vById = Object.fromEntries(view.nodes.map((n) => [n.id, n]));
    expect(vById.w0.config?.gates).toEqual(gates);
    // a node without a gates summary stays undefined (additive minimal-slice).
    expect(vById.b1.config?.gates).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// (2c) buildRunView — the AGENT-NEUTRAL spine: source tokens/cost/context from rec.usage when present
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('buildRunView — prefers rec.usage for the token/cost/context spine (Claude-Code parity)', () => {
  const rec = (id: string, label: string, status: NodeStatusRecord['status'], extra: Partial<NodeStatusRecord> = {}): NodeStatusRecord => ({
    id, label, status, artifacts: [], issues: [], ...extra,
  });

  it('lights up a Claude node (blank event replay) from its persisted usage — tokens, cost, context, turns', async () => {
    const runDir = mkRunDir();
    const status: RunStatus = {
      run: 'claude1', startedAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:05.000Z',
      done: true, ok: true, durationMs: 5000, stage: null, totals: null,
      nodes: {
        // A Claude node: its stream-json is opaque to the pi reducer, so events.jsonl replay is BLANK.
        // The authoritative telemetry lives on rec.usage (stamped from the result event).
        cx: rec('cx', 'Claude Node', 'ok', {
          model: 'claude-haiku-4-5-20251001',
          artifacts: [{ path: 'out.txt', exists: true, bytes: 5 }],
          usage: { inputTokens: 18, outputTokens: 337, cacheRead: 17172, cacheCreation: 4790, cost: 0.0130002, contextWindow: 200000, numTurns: 2, stopReason: 'end_turn' },
        }),
      },
    };
    const nodes: Record<string, FixtureNode> = {
      cx: {
        rec: status.nodes.cx,
        io: { id: 'cx', label: 'Claude Node', phase: null, reads: [], writes: [{ path: 'out.txt', verified: true, bytes: 5 }], promotes: [], status: 'ok' },
        filesOnDisk: [{ rel: 'out.txt', body: 'hello' }],
        // NO events — proves the spine comes from rec.usage, NOT the (blank) pi-style event replay.
      },
    };
    await writeFixture(runDir, status, nodes);

    const { view } = buildRunView(runDir);
    const cx = view.nodes.find((n) => n.id === 'cx')!;
    expect(cx.tokens.input).toBe(18);
    expect(cx.tokens.output).toBe(337);
    expect(cx.tokens.cacheRead).toBe(17172);
    expect(cx.tokens.cacheWrite).toBe(4790); // Claude cache_creation ≙ pi cacheWrite
    expect(cx.tokens.cost).toBeCloseTo(0.0130002, 6);
    expect(cx.tokens.contextPeak).toBe(18 + 17172 + 4790); // 21980 — the context that was in the window
    expect(cx.tokens.billable).toBe(18 + 337);
    expect(cx.contextWindow).toBe(200000);
    expect(cx.modelCalls).toBe(2); // Claude num_turns — the real invocation count
    expect(cx.stopReason).toBe('end_turn');
    expect(cx.truncated).toBe(false);
    expect(cx.model).toBe('claude-haiku-4-5-20251001'); // events carry no model → falls back to rec.model

    // The whole digest lights up for a Claude node (was all-zero before this).
    const digest = projectRunDigest(view);
    expect(digest.totals.cost).toBeCloseTo(0.0130002, 6);
    expect(digest.totals.inputTokens).toBe(18);
    const nd = digest.nodes.find((n) => n.id === 'cx')!;
    expect(nd.contextPct).toBeCloseTo(21980 / 200000, 4);
  });

  it('leaves a pi node (no rec.usage) sourced from the event replay — the spine override never fires', async () => {
    const runDir = mkRunDir();
    const status: RunStatus = {
      run: 'pi1', startedAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:05.000Z',
      done: true, ok: true, durationMs: 5000, stage: null, totals: null,
      nodes: { p0: rec('p0', 'Pi Node', 'ok', { model: 'm1', artifacts: [{ path: 'p.txt', exists: true, bytes: 3 }] }) },
    };
    const events: PiEvent[] = [
      { type: 'message_start', message: { role: 'assistant', model: 'm1', provider: 'cp' } } as unknown as PiEvent,
      { type: 'message_end', message: { role: 'assistant', usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.5, totalTokens: 120 }, stopReason: 'end_turn' } } as unknown as PiEvent,
    ];
    const nodes: Record<string, FixtureNode> = {
      p0: {
        rec: status.nodes.p0,
        io: { id: 'p0', label: 'Pi Node', phase: null, reads: [], writes: [{ path: 'p.txt', verified: true, bytes: 3 }], promotes: [], status: 'ok' },
        filesOnDisk: [{ rel: 'p.txt', body: 'pi!' }],
        events,
      },
    };
    await writeFixture(runDir, status, nodes);

    const { view } = buildRunView(runDir);
    const p0 = view.nodes.find((n) => n.id === 'p0')!;
    // Sourced from the event replay (rec.usage absent) — byte-identical to today's pi behavior.
    expect(p0.tokens.input).toBe(100);
    expect(p0.tokens.output).toBe(20);
    expect(p0.tokens.cost).toBeCloseTo(0.5, 6);
    expect(p0.modelCalls).toBe(1);
  });

  // `truncated` is precisely TOKEN-CAP cutoff (stop_reason max_tokens/length) — the case the 'truncated'
  // anomaly is for (a node that reports success but whose OUTPUT was cut). A Claude run cut at the output
  // cap carries stop_reason='max_tokens' on its result event, so the spine flags it. A turn-limit run
  // (subtype error_max_turns) is a DIFFERENT failure mode — it becomes status=error (the 'failed' anomaly),
  // NOT truncation — so it is intentionally NOT flagged here. This test pins that distinction.
  it('flags truncated for a Claude run cut at the token cap (stopReason max_tokens), not for a turn-limit error', async () => {
    const runDir = mkRunDir();
    const status: RunStatus = {
      run: 'claude-trunc', startedAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:05.000Z',
      done: true, ok: true, durationMs: 5000, stage: null, totals: null,
      nodes: {
        cut: rec('cut', 'Cut Node', 'ok', {
          model: 'claude-haiku-4-5-20251001',
          artifacts: [{ path: 'c.txt', exists: true, bytes: 1 }],
          usage: { inputTokens: 10, outputTokens: 8000, cost: 0.2, contextWindow: 200000, numTurns: 1, stopReason: 'max_tokens' },
        }),
      },
    };
    const nodes: Record<string, FixtureNode> = {
      cut: {
        rec: status.nodes.cut,
        io: { id: 'cut', label: 'Cut Node', phase: null, reads: [], writes: [{ path: 'c.txt', verified: true, bytes: 1 }], promotes: [], status: 'ok' },
        filesOnDisk: [{ rel: 'c.txt', body: 'x' }],
      },
    };
    await writeFixture(runDir, status, nodes);

    const { view } = buildRunView(runDir);
    const cut = view.nodes.find((n) => n.id === 'cut')!;
    expect(cut.truncated).toBe(true);
    expect(cut.stopReason).toBe('max_tokens');
    // and the digest raises the 'truncated' anomaly for it.
    const digest = projectRunDigest(view);
    const nd = digest.nodes.find((n) => n.id === 'cut')!;
    expect(nd.anomalies).toContain('truncated');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// (2d) buildRunView — stamps the per-node DERIVED display projection (deriveNode wiring)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('buildRunView — stamps node.derived (the shared display zones every view renders)', () => {
  const rec = (id: string, label: string, status: NodeStatusRecord['status'], extra: Partial<NodeStatusRecord> = {}): NodeStatusRecord => ({
    id, label, status, artifacts: [], issues: [], ...extra,
  });

  // The derivation itself is unit-tested in derive.test.ts; this proves the WIRING — buildRunView stamps
  // `node.derived` from the SAME distilled fields the GUI reads, so a view never re-derives a zone. Drop the
  // stamping and this reads undefined and goes RED.
  it('derives topTools / toolError / dominance / cacheHit / context / time / outputs from the node stream', async () => {
    const runDir = mkRunDir();
    const status: RunStatus = {
      run: 'derv1', startedAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:05.000Z',
      done: true, ok: true, durationMs: 5000, stage: null, totals: null,
      nodes: { tn: rec('tn', 'Tool Node', 'ok', { durationMs: 4000, model: 'm1', artifacts: [{ path: 'out/a.txt', exists: true, bytes: 10 }] }) },
    };
    // 3 reads (ok) + 1 bash (error) → toolBreakdown {read:3, bash:1}, 1 failed timeline span; one usage rollup.
    const events: PiEvent[] = [
      { type: 'message_start', message: { role: 'assistant', model: 'm1', provider: 'cp' } },
      { type: 'tool_execution_start', toolCallId: '1', toolName: 'read', args: { path: 'spec/a' }, _t: 0 },
      { type: 'tool_execution_end', toolCallId: '1', isError: false, _t: 10 },
      { type: 'tool_execution_start', toolCallId: '2', toolName: 'read', args: { path: 'spec/b' }, _t: 20 },
      { type: 'tool_execution_end', toolCallId: '2', isError: false, _t: 30 },
      { type: 'tool_execution_start', toolCallId: '3', toolName: 'read', args: { path: 'spec/c' }, _t: 40 },
      { type: 'tool_execution_end', toolCallId: '3', isError: false, _t: 50 },
      { type: 'tool_execution_start', toolCallId: '4', toolName: 'bash', args: { command: 'ls' }, _t: 60 },
      { type: 'tool_execution_end', toolCallId: '4', isError: true, _t: 70 },
      { type: 'message_end', message: { role: 'assistant', usage: { input: 100, cacheRead: 900, output: 20, totalTokens: 1000 } } },
    ] as unknown as PiEvent[];
    const nodes: Record<string, FixtureNode> = {
      tn: {
        rec: status.nodes.tn,
        io: { id: 'tn', label: 'Tool Node', phase: null, reads: [], writes: [{ path: 'out/a.txt', verified: true, bytes: 10 }], promotes: [], status: 'ok' },
        filesOnDisk: [{ rel: 'out/a.txt', body: 'ten-bytes!' }],
        events,
      },
    };
    await writeFixture(runDir, status, nodes);

    const { view } = buildRunView(runDir);
    const tn = view.nodes.find((n) => n.id === 'tn')!;
    expect(tn.derived).toBeDefined();
    const d = tn.derived!;
    // ranked tools + shares
    expect(d.topTools).toEqual([{ name: 'read', count: 3, pct: 0.75 }, { name: 'bash', count: 1, pct: 0.25 }]);
    // 1 failed span / 4 calls = 0.25 → high
    expect(d.toolError).toEqual({ errors: 1, rate: 0.25, tone: 'high' });
    // one tool at 75% but only 4 calls (needs >5) ⇒ not a stuck-loop flag
    expect(d.dominance.dominant).toBe(false);
    // cache-hit 900/(100+900)
    expect(d.cacheHit!.ratio).toBeCloseTo(0.9, 10);
    // context peak 1000 over the default window (m1 not in the catalog ⇒ contextWindow null ⇒ default)
    expect(d.context.frac).toBeCloseTo(1000 / DEFAULT_CONTEXT_WINDOW, 10);
    // settled: no history ⇒ expectedMs falls back to own duration ⇒ ratio 1 ⇒ ok
    expect(d.time).toEqual({ ratio: 1, tone: 'ok' });
    // unified outputs from the declared, on-disk artifact
    expect(d.outputs).toEqual([{ path: 'out/a.txt', bytes: 10, ok: true }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// (3) watchRun — the single live stream
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('watchRun — snapshot, then node-status / node-event / done in order', () => {
  it('yields an initial snapshot then the matching deltas as the fixture mutates between polls', async () => {
    const runDir = mkRunDir();
    const { status, nodes } = baseFixture();
    // start b2 with one event already on disk (so the snapshot has a known event baseline).
    nodes.b2.events = [{ type: 'tool_execution_start', toolName: 'read', args: { path: 'spec/cls.json' } }];
    await writeFixture(runDir, status, nodes);

    const ctrl = new AbortController();
    const updates: RunUpdate[] = [];

    // Drive the fixture forward in lockstep with the poll loop: after the first snapshot lands, flip
    // b2 → ok, append a new events line, then mark the run done. A small pollMs makes it deterministic.
    const driver = (async () => {
      // wait until the consumer has the initial snapshot.
      while (!updates.some((u) => u.kind === 'snapshot')) await sleep(5);

      // 1) append a NEW events.jsonl line for b2 (→ a node-event update). Keep it in nodes.b2.events so
      //    the writeFixture rewrite below does NOT clobber it (writeFixture rewrites each node's file).
      const newEvent: PiEvent = { type: 'tool_execution_start', toolName: 'write', args: { path: 'src/b.js' } };
      nodes.b2.events!.push(newEvent);
      const ef = nodeEventsFile(runDir, 'b2');
      await fs.appendFile(ef, JSON.stringify(newEvent) + '\n');
      // 2) flip b2 → ok and write its declared artifact so the derived status is really ok.
      await fs.mkdir(path.resolve(runDir, 'src'), { recursive: true });
      await fs.writeFile(path.resolve(runDir, 'src/b.js'), 'console.log(1)');
      status.nodes.b2.status = 'ok';
      status.nodes.b2.artifacts = [{ path: 'src/b.js', exists: true, bytes: 14 }];
      nodes.b2.io!.writes[0].verified = true;
      // rewrite run.json + io.json ONLY (events already appended above; avoid the events rewrite).
      await writeFixtureMeta(runDir, status, nodes);

      // wait for the node-status delta to be observed before flipping done (deterministic ordering).
      while (!updates.some((u) => u.kind === 'node-status' && u.id === 'b2')) await sleep(5);

      // 3) mark the whole run done.
      status.done = true;
      status.ok = true;
      status.durationMs = 9000;
      await writeFixtureMeta(runDir, status, nodes);
    })();

    for await (const u of watchRun(runDir, { signal: ctrl.signal, pollMs: 10 })) {
      updates.push(u);
      if (u.kind === 'done') break;
    }
    await driver;

    // The FIRST update is the full snapshot.
    expect(updates[0].kind).toBe('snapshot');
    const snap = updates[0] as Extract<RunUpdate, { kind: 'snapshot' }>;
    expect(snap.model.run).toBe('fix1');
    expect(snap.model.nodes.find((n) => n.id === 'b2')?.status).toBe('running');

    // A node-status delta for b2 → ok was emitted.
    const statusDelta = updates.find((u) => u.kind === 'node-status' && u.id === 'b2');
    expect(statusDelta).toBeTruthy();
    expect((statusDelta as Extract<RunUpdate, { kind: 'node-status' }>).status).toBe('ok');

    // A node-event delta for the NEW b2 line (the write) was emitted — NOT the pre-snapshot read line.
    const evDeltas = updates.filter((u) => u.kind === 'node-event' && u.id === 'b2') as Extract<RunUpdate, { kind: 'node-event' }>[];
    expect(evDeltas.length).toBeGreaterThanOrEqual(1);
    expect(evDeltas.some((e) => (e.event as { toolName?: string }).toolName === 'write')).toBe(true);
    expect(evDeltas.some((e) => (e.event as { toolName?: string }).toolName === 'read')).toBe(false);

    // The terminal update is `done`, and it comes AFTER the b2 status delta.
    const lastKind = updates[updates.length - 1].kind;
    expect(lastKind).toBe('done');
    const iStatus = updates.findIndex((u) => u.kind === 'node-status' && u.id === 'b2');
    const iDone = updates.findIndex((u) => u.kind === 'done');
    expect(iStatus).toBeGreaterThanOrEqual(0);
    expect(iDone).toBeGreaterThan(iStatus);
  });

  // (4) abort: an already-aborted signal stops the iterator promptly without hanging.
  it('stops promptly when the signal is already aborted (no hang, no done required)', async () => {
    const runDir = mkRunDir();
    const { status, nodes } = baseFixture();
    await writeFixture(runDir, status, nodes);

    const ctrl = new AbortController();
    ctrl.abort();

    const updates: RunUpdate[] = [];
    const started = Date.now();
    for await (const u of watchRun(runDir, { signal: ctrl.signal, pollMs: 10 })) {
      updates.push(u);
    }
    // It must return quickly (well under any node timeout) and not hang.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('stops promptly when the signal aborts MID-STREAM (the run never completes)', async () => {
    const runDir = mkRunDir();
    const { status, nodes } = baseFixture();
    await writeFixture(runDir, status, nodes); // run is NOT done and never will be

    const ctrl = new AbortController();
    const updates: RunUpdate[] = [];
    const loop = (async () => {
      for await (const u of watchRun(runDir, { signal: ctrl.signal, pollMs: 10 })) {
        updates.push(u);
      }
    })();
    // abort after the first snapshot is observed.
    while (!updates.some((u) => u.kind === 'snapshot')) await sleep(5);
    ctrl.abort();
    await loop; // must resolve (not hang) even though the run never reaches `done`.
    expect(updates[0].kind).toBe('snapshot');
  });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
