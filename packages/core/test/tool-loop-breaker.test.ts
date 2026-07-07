// Tests for the LIVE, deterministic tool-loop circuit breaker (packages/core/src/runner/tool-loop-breaker.ts)
// and its wiring into the run plane. The breaker rides the SAME identical-args detector the post-hoc telemetry
// anomaly reads (createNodeAccumulator / createClaudeAccumulator → maxToolRepeat), so a runaway loop is KILLED
// on the critical path with a first-class reason instead of grinding to context exhaustion. Every fixture uses
// SYNTHETIC tool names/args (never copied from any real run).
//
// Run: npx vitest run packages/core/test/tool-loop-breaker.test.ts

import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createToolLoopBreaker,
  DEFAULT_TOOL_LOOP_LIMIT,
} from '../src/runner/tool-loop-breaker.js';
import { createNodeAccumulator, toolLoopDetail } from '../src/observe/distill.js';
import { createClaudeAccumulator } from '../src/observe/claude-distill.js';
import { NodeRecorder, recordingSandbox, type PiEvent } from '../src/runner/events.js';
import { defaultExecRunner, runWorkflow, type RunStatus } from '../src/runner/index.js';
import { compile, InMemorySandbox } from '../src/index.js';
import { buildRunView } from '../src/observe/runView.js';
import { projectRunDigest } from '../src/observe/telemetry.js';
import { runJsonFile, nodeEventsFile } from '../src/runner/layout.js';
import type {
  WorkflowSpec, NodeIntent, Sandbox, ExecOpts, ExecResult, CreateOpts, SandboxProvider,
} from '../src/types.js';

// ── synthetic fixtures ──────────────────────────────────────────────────────────────────────────────

/** ONE pi-vocabulary tool call event (`tool_execution_start` — what the recorder archives + the reducer folds). */
const piCall = (name: string, args: Record<string, unknown>, id: string): PiEvent =>
  ({ type: 'tool_execution_start', toolName: name, args, toolCallId: id });

/** ONE Claude-vocabulary tool call — a `tool_use` block nested in an assistant message (the count-only twin). */
const claudeCall = (name: string, input: Record<string, unknown>, id: string): PiEvent =>
  ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });

const IDENTICAL = { target: 'widget-A', mode: 'scan' } as const;

/**
 * A wa13-shaped pi event stream: `synth_probe` called with IDENTICAL args, interleaved with OTHER distinct
 * calls, until it has fired `identicalCount` times; then `tail` more identical calls that a tripped breaker
 * must NOT let through. The interleave proves the peak is per-fingerprint (not a naive consecutive counter).
 */
function loopStream(identicalCount: number, tail = 0): PiEvent[] {
  const evs: PiEvent[] = [];
  let seq = 0;
  for (let i = 0; i < identicalCount; i++) {
    evs.push(piCall('synth_probe', { ...IDENTICAL }, `p${i}`));
    // interleave a DISTINCT call between probes (different tool or different args) — not part of the loop.
    evs.push(piCall('synth_read', { path: `file-${i}.txt` }, `r${seq++}`));
  }
  for (let i = 0; i < tail; i++) evs.push(piCall('synth_probe', { ...IDENTICAL }, `t${i}`));
  return evs;
}

// ── the breaker unit — trip / reason / off-switch / below-threshold / both drivers / mutation ──────────

describe('createToolLoopBreaker — the deterministic identical-args detector', () => {
  it('trips ONCE at the threshold; reason names the tool, the count, and "identical args"', () => {
    const onTrip = vi.fn();
    const breaker = createToolLoopBreaker(createNodeAccumulator(), 4, onTrip);
    for (const ev of loopStream(4, /* tail */ 3)) breaker.push(ev);

    expect(breaker.tripped).toBe(true);
    expect(onTrip).toHaveBeenCalledTimes(1); // fires exactly once, even though the tail keeps pushing
    expect(breaker.reason).toBe('synth_probe called 4× with identical args');
    // names the tool, the count, and the phrase "identical args" (the bar).
    expect(breaker.reason).toContain('synth_probe');
    expect(breaker.reason).toContain('4');
    expect(breaker.reason).toContain('identical args');
  });

  it('does NOT trip on legitimate repetition BELOW the threshold', () => {
    const onTrip = vi.fn();
    const breaker = createToolLoopBreaker(createNodeAccumulator(), 4, onTrip);
    for (const ev of loopStream(3)) breaker.push(ev); // 3 identical, threshold 4
    expect(breaker.tripped).toBe(false);
    expect(breaker.reason).toBeNull();
    expect(onTrip).not.toHaveBeenCalled();
  });

  it('OFF SWITCH: limit <= 0 never trips, however long the loop runs', () => {
    const onTrip = vi.fn();
    const breaker = createToolLoopBreaker(createNodeAccumulator(), 0, onTrip);
    for (const ev of loopStream(20)) breaker.push(ev);
    expect(breaker.tripped).toBe(false);
    expect(onTrip).not.toHaveBeenCalled();
  });

  // MUTATION GUARD: the trip must be GATED by the threshold. A breaker whose default no longer separates the
  // kill from the loop (e.g. a mutant that trips regardless of count) turns this RED — 20 identical calls under
  // a limit of 1000 is legitimate and must pass through untouched.
  it('does NOT trip when the count stays below a high threshold (the trip is threshold-gated)', () => {
    const onTrip = vi.fn();
    const breaker = createToolLoopBreaker(createNodeAccumulator(), 1000, onTrip);
    for (const ev of loopStream(20)) breaker.push(ev);
    expect(breaker.tripped).toBe(false);
    expect(onTrip).not.toHaveBeenCalled();
  });

  it('is driver-agnostic: the SAME breaker trips on the Claude stream-json vocabulary', () => {
    const onTrip = vi.fn();
    const breaker = createToolLoopBreaker(createClaudeAccumulator(), 4, onTrip);
    for (let i = 0; i < 4; i++) {
      breaker.push(claudeCall('synth_probe', { ...IDENTICAL }, `u${i}`));
      breaker.push(claudeCall('synth_read', { path: `file-${i}.txt` }, `v${i}`)); // interleaved distinct call
    }
    expect(breaker.tripped).toBe(true);
    expect(breaker.reason).toBe('synth_probe called 4× with identical args');
    expect(onTrip).toHaveBeenCalledTimes(1);
  });

  it('the DEFAULT limit sits ABOVE the shipped advisory anomaly threshold (backstop, not the same trip)', () => {
    // DEFAULT_THRESHOLDS.toolRepeat = 3 (advisory). The live KILL default must be strictly higher so short
    // legitimate repetition trips only the advisory surface, never the kill.
    expect(DEFAULT_TOOL_LOOP_LIMIT).toBeGreaterThan(3);
  });
});

// ── the live kill seam — defaultExecRunner + the recorder tee actually aborts the exec ────────────────

/** A minimal Sandbox whose exec STREAMS the scripted event lines through onStdout one at a time, honoring the
 *  abort signal — so when the breaker aborts mid-stream the exec resolves `killed` and the stream STOPS. */
function streamingSandbox(lines: PiEvent[]): Sandbox {
  return {
    putFiles: async () => {},
    writeFile: async () => {},
    readFile: async () => '',
    downloadDir: async () => {},
    dispose: async () => {},
    exec: (_cmd: string, opts?: ExecOpts): Promise<ExecResult> =>
      new Promise<ExecResult>((resolve) => {
        const signal = opts?.signal;
        let i = 0;
        const pump = (): void => {
          if (signal?.aborted) return resolve({ stdout: '', stderr: 'killed', code: 124 });
          if (i >= lines.length) return resolve({ stdout: '', stderr: '', code: 0 });
          opts?.onStdout?.(JSON.stringify(lines[i++]) + '\n'); // may synchronously abort via the breaker
          setTimeout(pump, 0);
        };
        setTimeout(pump, 0);
      }),
  };
}

describe('the live kill seam — defaultExecRunner honors the breaker abort', () => {
  it('aborts the exec with killed="tool-loop" and STOPS the stream at the threshold', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-breaker-'));
    const recorder = new NodeRecorder(dir, 'looper', (_id, ev) => breaker.push(ev));
    const breakerAc = new AbortController();
    const breaker = createToolLoopBreaker(createNodeAccumulator(), 4, () => breakerAc.abort());
    // 4 identical to trip at the 4th, + 5 tail calls the kill must prevent from ever being recorded.
    const sandbox = recordingSandbox(streamingSandbox(loopStream(4, 5)), recorder);

    const { killed } = await defaultExecRunner(sandbox, 'noop', {
      nodeTimeoutMs: 30_000, stallMs: 0, killGraceMs: 1000, breakerSignal: breakerAc.signal,
    });
    await recorder.close();

    expect(killed).toBe('tool-loop');
    expect(breaker.reason).toBe('synth_probe called 4× with identical args');

    // The stream was CUT: exactly 4 identical probe calls landed in the archive, not the 9 the stream held.
    const archived = (await fs.readFile(nodeEventsFile(dir, 'looper'), 'utf8'))
      .split('\n').filter(Boolean).map((l) => JSON.parse(l) as PiEvent)
      .filter((e) => e.type === 'tool_execution_start' && e.toolName === 'synth_probe');
    expect(archived).toHaveLength(4);
  });
});

// ── end-to-end through runWorkflow: run.json issues AND the telemetry anomaly both show it, and AGREE ──

const n = (label: string, produces: string[], over: Partial<NodeIntent> = {}): NodeIntent => ({
  label, prompt: `do ${label}`, tools: {},
  io: { reads: [], produces, artifacts: produces.map((p) => ({ path: p })) },
  ...over,
});

/** A provider that hands every node a streamingSandbox over the scripted loop (reuses InMemorySandbox for the
 *  rest of the filesystem plumbing so downloadDir/dispose/workdir behave like a real run). */
function loopProvider(lines: PiEvent[]): SandboxProvider {
  return {
    kind: 'inmemory',
    async create(opts: CreateOpts): Promise<Sandbox> {
      const inner = await InMemorySandbox.create(opts);
      const stream = streamingSandbox(lines);
      return {
        putFiles: (f) => inner.putFiles(f),
        writeFile: (p, d) => inner.writeFile(p, d),
        readFile: (p, o) => inner.readFile(p, o),
        downloadDir: (r, l) => inner.downloadDir(r, l),
        dispose: () => inner.dispose(),
        exec: (cmd, o) => stream.exec(cmd, o),
      };
    },
  };
}

describe('runWorkflow — the tool-loop kill surfaces on run.json AND telemetry, in agreement', () => {
  it('kills the looping node with a first-class reason both surfaces name identically', async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-breaker-run-'));
    const spec: WorkflowSpec = { meta: { name: 't', description: 'd' }, nodes: [n('looper', ['out.json'])] };
    const wf = compile(spec);

    const { status } = await runWorkflow(wf, {
      run: 'loop-run',
      outDir,
      provider: loopProvider(loopStream(4, 5)),
      execRunner: defaultExecRunner,
      buildCommand: () => 'noop',
      toolLoopLimit: 4,
    });

    // (1) run.json — the node is a first-class deterministic kill, exactly like a timeout/stall.
    const node = status.nodes.looper;
    expect(node.status).toBe('error');
    expect(node.killedToolLoop).toBe(true);
    const issue = node.issues.find((s) => s.includes('identical args'));
    expect(issue).toBeDefined();
    expect(issue).toContain('synth_probe');
    expect(issue).toContain('4');

    // Persisted to disk too (not just the in-memory return).
    const onDisk = JSON.parse(await fs.readFile(runJsonFile(outDir), 'utf8')) as RunStatus;
    expect(onDisk.nodes.looper.killedToolLoop).toBe(true);

    // (2) the telemetry anomaly surface, folded independently from the archived events, AGREES on the detail.
    const { view } = buildRunView(outDir);
    const digest = projectRunDigest(view);
    const anomaly = digest.anomalies.find((a) => a.kind === 'tool-loop' && a.nodeId === 'looper');
    expect(anomaly).toBeDefined();
    expect(anomaly!.detail).toBe(toolLoopDetail('synth_probe', 4));

    // the two surfaces name the loop IDENTICALLY (single-data-path: one detector, two consumers).
    expect(issue).toContain(anomaly!.detail);
  });
});
