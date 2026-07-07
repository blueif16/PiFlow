// Contract for `piflowctl optimize <rundir>` — the read-only Score+Triage accessor CLI
// (packages/cli/src/optimize.ts). Focus: the PERSIST gap — the accessor must write its verdict/worklist to a
// durable `<rundir>/.pi/optimize.json` artifact, matching exactly the `--json` payload, IN ADDITION to
// printing (default human markdown or `--json`), and idempotently (re-running overwrites, never appends).
// Before this, running `optimize` left NOTHING on disk — an operator had to redirect `--json` by hand.
//
// `scoreRun` is injected (the same DI convention as optimize-fix.ts's `OptimizeFixDeps`) so this needs no
// live `.pi` trace.
//
// Run: npx vitest run packages/cli/test/optimize-cli.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runOptimizeCli } from '../src/optimize.js';
import { scoreNodes } from '@piflow/core';
import type { RunDigest, NodeDigest, NodeScore } from '@piflow/core';

const dnode = (id: string, over: Partial<NodeDigest> = {}): NodeDigest => ({
  id, label: id, phase: null, outcome: 'ok', model: null, provider: null,
  durationMs: null, expectedMs: null, slowRatio: null, inputTokens: 0, outputTokens: 0, cost: 0,
  contextPeak: 0, contextWindow: null, contextPct: null, modelCalls: 0, toolCalls: 0, topTools: {},
  maxToolRepeat: 0, repeatedTool: null, retries: 0, stopReason: null, truncated: false,
  missing: [], issues: [], anomalies: [], ...over,
});

const fakeDigest = (): RunDigest => ({
  run: 'r1', done: true, ok: false, durationMs: 5,
  totals: { nodes: 1, ok: 0, failed: 1, inputTokens: 0, outputTokens: 0, cost: 0, contextPeak: 0, modelCalls: 0, toolCalls: 0 },
  nodes: [dnode('flaky', { outcome: 'error', anomalies: ['failed'] })], anomalies: [], rootCauses: [],
});

const fakeScoreRun = async () => ({
  scores: scoreNodes({ digest: fakeDigest(), tier1ByNode: new Map() }),
  digest: fakeDigest(),
});

let stdoutLines: string[];
let origWrite: typeof process.stdout.write;

describe('runOptimizeCli — PERSIST (.pi/optimize.json)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'optcli-'));
    stdoutLines = [];
    origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { stdoutLines.push(String(s)); return true; };
  });

  afterEach(() => {
    (process.stdout as unknown as { write: typeof origWrite }).write = origWrite;
  });

  it('writes <rundir>/.pi/optimize.json matching the --json payload, in addition to printing it', async () => {
    await runOptimizeCli([dir, '--json'], { scoreRun: fakeScoreRun });

    const printed = JSON.parse(stdoutLines.join(''));
    const onDiskRaw = await fs.readFile(path.join(dir, '.pi', 'optimize.json'), 'utf8');
    const onDisk = JSON.parse(onDiskRaw);

    expect(onDisk).toEqual(printed);
    expect(onDisk.defects.length).toBeGreaterThan(0); // the fixture's `flaky` node IS a defect
  });

  it('persists even in the default (non --json) human-readable mode — the printed routing markdown is unchanged', async () => {
    await runOptimizeCli([dir], { scoreRun: fakeScoreRun });

    const printed = stdoutLines.join('');
    expect(printed).toMatch(/Hermes routing/i); // renderRouting's proven shape, untouched by persistence

    const onDisk = JSON.parse(await fs.readFile(path.join(dir, '.pi', 'optimize.json'), 'utf8'));
    expect(onDisk.run).toBe('r1');
    expect(onDisk.defects.length).toBeGreaterThan(0);
    expect(Array.isArray(onDisk.scores)).toBe(true);
  });

  it('is idempotent — re-running overwrites the same file with equivalent content, never appending', async () => {
    await runOptimizeCli([dir, '--json'], { scoreRun: fakeScoreRun });
    const first = await fs.readFile(path.join(dir, '.pi', 'optimize.json'), 'utf8');

    await runOptimizeCli([dir, '--json'], { scoreRun: fakeScoreRun });
    const second = await fs.readFile(path.join(dir, '.pi', 'optimize.json'), 'utf8');

    expect(JSON.parse(second)).toEqual(JSON.parse(first));
    // a single JSON document, not N concatenated ones — proves overwrite, not append.
    expect(() => JSON.parse(second)).not.toThrow();
  });

  it('creates .pi/ when it does not yet exist (a bare run dir)', async () => {
    expect(await fs.readdir(dir)).toHaveLength(0);
    await runOptimizeCli([dir, '--json'], { scoreRun: fakeScoreRun });
    const stat = await fs.stat(path.join(dir, '.pi', 'optimize.json'));
    expect(stat.isFile()).toBe(true);
  });
});

// ── MEMORY WIRING (end-to-end) — the CLI already composes `deriveRecurrence` + `triage({ recurrence })`
// (packages/cli/src/optimize.ts), so a signature that RECURRED in the node's own Leg-A `memory.md` must flip
// a bare LAPSE into SKILL through the REAL CLI path — not just at the unit level (triage.test.ts /
// recurrence.test.ts already prove the pieces in isolation; this proves the WIRING between them: the CLI
// resolves the correct templateDir off the run dir and actually reads the file before triaging).
describe('runOptimizeCli — reads Leg-A memory.md end-to-end (LAPSE → SKILL)', () => {
  const NODE = 'flaky';

  const lapseNode = (over: Partial<NodeDigest> = {}): NodeDigest => ({
    id: NODE, label: NODE, phase: null, outcome: 'error', model: null, provider: null,
    durationMs: null, expectedMs: null, slowRatio: null, inputTokens: 0, outputTokens: 0, cost: 0,
    contextPeak: 0, contextWindow: null, contextPct: null, modelCalls: 0, toolCalls: 0, topTools: {},
    maxToolRepeat: 0, repeatedTool: null, retries: 0, stopReason: null, truncated: false,
    missing: [], issues: [], anomalies: ['failed'], ...over,
  });
  const lapseDigest = (): RunDigest => ({
    run: 'r2', done: true, ok: false, durationMs: 3,
    totals: { nodes: 1, ok: 0, failed: 1, inputTokens: 0, outputTokens: 0, cost: 0, contextPeak: 0, modelCalls: 0, toolCalls: 0 },
    nodes: [lapseNode()], anomalies: [], rootCauses: [],
  });
  const fakeLapseScoreRun = async (): Promise<{ scores: NodeScore[]; digest: RunDigest }> => ({
    scores: scoreNodes({ digest: lapseDigest(), tier1ByNode: new Map() }),
    digest: lapseDigest(),
  });

  let base: string; // …/.piflow/wf — parent of both `template/` and `runs/<id>` (the canonical run layout)
  let rundir: string;

  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'optcli-mem-'));
    rundir = path.join(base, 'runs', 'r2');
    await fs.mkdir(rundir, { recursive: true });
    stdoutLines = [];
    origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { stdoutLines.push(String(s)); return true; };
  });
  afterEach(() => {
    (process.stdout as unknown as { write: typeof origWrite }).write = origWrite;
  });

  it('a signature RECURRED (memory.md, count ≥ threshold) flips the printed+persisted defect LAPSE → SKILL', async () => {
    const memDir = path.join(base, 'template', 'nodes', NODE);
    await fs.mkdir(memDir, { recursive: true });
    await fs.writeFile(
      path.join(memDir, 'memory.md'),
      [
        `# node: ${NODE} — memory`,
        '',
        '### recurring null deref',
        `sig: ${NODE}::failed`,
        'recurrence: 2',
        '[[runner]]',
        '**Root:** update() assumed entries was defined',
        '**Prevention:** guard the null case',
        '',
      ].join('\n'),
      'utf8',
    );

    await runOptimizeCli([rundir, '--json'], { scoreRun: fakeLapseScoreRun });

    const printed = JSON.parse(stdoutLines.join(''));
    const onDisk = JSON.parse(await fs.readFile(path.join(rundir, '.pi', 'optimize.json'), 'utf8'));
    expect(onDisk).toEqual(printed);

    const defect = onDisk.defects.find((d: { node: string }) => d.node === NODE);
    expect(defect).toBeDefined();
    expect(defect.bucket).toBe('SKILL'); // NOT the LAPSE default — the recorded lesson confirmed it
    expect(defect.needsSignal).toBeUndefined();
    expect(defect.scope?.recurrence).toBe(2);
    expect(defect.scope?.root).toContain('entries was defined');
  });

  it('WITHOUT a recorded lesson (no memory.md) the same shape stays the LAPSE default (control)', async () => {
    // No template/nodes/flaky/memory.md written — deriveRecurrence degrades to an empty index.
    await runOptimizeCli([rundir, '--json'], { scoreRun: fakeLapseScoreRun });
    const onDisk = JSON.parse(await fs.readFile(path.join(rundir, '.pi', 'optimize.json'), 'utf8'));
    const defect = onDisk.defects.find((d: { node: string }) => d.node === NODE);
    expect(defect.bucket).toBe('LAPSE');
    expect(defect.needsSignal).toBeTruthy();
  });
});
