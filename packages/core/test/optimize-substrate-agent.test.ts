// optimize/substrate/agent.ts — the M4 ONE spawn wrapper (docs/specs/optimize-substrate-plan.md §M4). Every
// base agent (judge, later the fixer) goes through `runBaseAgent` instead of a hand-rolled
// `spawn('claude', …)`. This suite pins:
//   • model resolution speaks the SDK's tier language ONLY — 'balanced' is the default tier, resolved through
//     the REAL `resolveClaudeModel` precedence (never a hardcoded model id anywhere in agent.ts);
//   • an explicit `model` override WINS over `tier` (same precedence claude-code nodes always use);
//   • `readScope`/`owns`/`cwd`/`tools`/`timeoutMs` land VERBATIM on the compiled node's sandbox/tools — proven
//     by a `buildCommand` stub that CAPTURES the resolved `NodeSpec` at build time (the same technique
//     `spawn-child-run.test.ts`'s `observingBuild` uses), never by re-deriving what agent.ts "should" produce;
//   • the returned `text` is the REAL `parseClaudeResult(...).text` of the node's actual stdout — proven by a
//     fake shell command that emits a genuine Claude `result`-event NDJSON line, not a canned literal.
// No live claude spawn anywhere — every exec is a fake, offline shell command (the entry.test.ts pattern).
//
// Run: npx vitest run packages/core/test/optimize-substrate-agent.test.ts

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NodeSpec, ResolveResult } from '../src/types.js';
import type { CommandContext } from '../src/runner/command.js';
import type { ModelTiers } from '../src/runner/model-routing.js';
import { runBaseAgent, BASE_AGENT_DEFAULT_TIER } from '../src/optimize/substrate/agent.js';
import { driverFits } from '../src/runner/drivers/driver-fits.js';
import { builtinDrivers } from '../src/runner/drivers/table.js';
import { readRunModel } from '../src/observe/read.js';

/** A `buildCommand` stub that (a) records the resolved NodeSpec it was called with and (b) makes the fake
 *  "agent" emit `stdout` verbatim via a real shell `printf` (so the REAL exec path/parsing is exercised). */
function capturingBuilder(stdout: string, capture: { node?: NodeSpec }) {
  return (node: NodeSpec, _resolved: ResolveResult, _ctx: CommandContext): string => {
    capture.node = node;
    return `printf '%s' '${stdout.replace(/'/g, "'\\''")}'`;
  };
}

/** A genuine Claude `--output-format stream-json` capture: an init line, a turn, then the ONE authoritative
 *  `result` event carrying the final text — mirrors claude-code-driver.test.ts's own fixture shape. */
function claudeStdout(text: string): string {
  return [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1', result: text }),
  ].join('\n');
}

const BALANCED_TIERS: ModelTiers = { active: true, tiers: {}, claude: { balanced: 'claude-balanced-model' } };

describe('runBaseAgent — spec-building (M4)', () => {
  it('defaults tier to "balanced", resolved through the REAL resolveClaudeModel precedence (no hardcoded model)', async () => {
    expect(BASE_AGENT_DEFAULT_TIER).toBe('balanced');
    const capture: { node?: NodeSpec } = {};
    const { status } = await runBaseAgent({
      prompt: 'judge this node',
      cwd: process.cwd(),
      readScope: ['/tmp/a'],
      owns: ['/tmp/b'],
      buildCommand: capturingBuilder(claudeStdout('ok'), capture),
      modelRouting: { tiers: BALANCED_TIERS, modelsIndex: new Map() },
    });
    expect(capture.node?.tier).toBe('balanced');
    expect(capture.node?.executor).toBe('claude-code');
    // the EFFECTIVE model the node actually ran on, recorded by the runner off the SAME resolution.
    expect(status.model).toBe('claude-balanced-model');
  });

  it('dryRun returns the composed plan and spawns NOTHING (buildCommand never invoked, no status/text)', async () => {
    const capture: { node?: NodeSpec } = {};
    const result = await runBaseAgent({
      prompt: 'JUDGE PROMPT — the exact ingested context',
      cwd: '/tmp/ws',
      readScope: ['/tmp/ws', '/tmp/run'],
      owns: ['/tmp/ws/issues'],
      skill: 'piflow-triage',
      tier: 'balanced',
      dryRun: true,
      // if the dry-run branch ever failed to short-circuit, this builder WOULD run → capture.node set.
      buildCommand: capturingBuilder(claudeStdout('SHOULD NEVER RUN'), capture),
    });
    // NOTHING spawned: the command builder was never called; no status/text produced.
    expect(capture.node).toBeUndefined();
    expect(result.status).toBeUndefined();
    expect(result.text).toBeUndefined();
    // the composed plan surfaces the exact ingested context + the resolved base-agent config.
    expect(result.plan?.prompt).toBe('JUDGE PROMPT — the exact ingested context');
    expect(result.plan?.executor).toBe('claude-code');
    expect(result.plan?.skill).toBe('piflow-triage');
    expect(result.plan?.tier).toBe('balanced');
    expect(result.plan?.sandbox?.read).toEqual(['/tmp/ws', '/tmp/run']);
    expect(result.plan?.sandbox?.write).toEqual(['/tmp/ws/issues']);
  });

  it('an explicit `model` WINS over `tier` (same precedence every claude-code node uses)', async () => {
    const capture: { node?: NodeSpec } = {};
    const { status } = await runBaseAgent({
      prompt: 'judge this node',
      cwd: process.cwd(),
      readScope: [],
      owns: [],
      tier: 'balanced',
      model: 'claude-explicit-pin',
      buildCommand: capturingBuilder(claudeStdout('ok'), capture),
      modelRouting: { tiers: BALANCED_TIERS, modelsIndex: new Map() },
    });
    expect(capture.node?.model).toBe('claude-explicit-pin');
    expect(status.model).toBe('claude-explicit-pin');
  });

  it('readScope/owns/execCwd/tools/timeoutMs land VERBATIM on the compiled node (captured at build time)', async () => {
    const capture: { node?: NodeSpec } = {};
    await runBaseAgent({
      prompt: 'judge this node',
      cwd: '/repo/root',
      readScope: ['/run/dir', '/tpl/dir'],
      owns: ['/tpl/dir/nodes/gameplay/issues'],
      tools: { allow: ['bash', 'read'] },
      timeoutMs: 12345,
      buildCommand: capturingBuilder(claudeStdout('ok'), capture),
    });
    expect(capture.node?.sandbox.read).toEqual(['/run/dir', '/tpl/dir']);
    expect(capture.node?.sandbox.write).toEqual(['/tpl/dir/nodes/gameplay/issues']);
    expect(capture.node?.sandbox.execCwd).toBe('/repo/root');
    expect(capture.node?.sandbox.timeoutMs).toBe(12345);
    expect(capture.node?.tools).toEqual({ allow: ['bash', 'read'] });
  });

  it('declares sandbox provider "local" so the claude-code driver FITS (kills the spurious inmemory driver-fit warning)', async () => {
    const capture: { node?: NodeSpec } = {};
    await runBaseAgent({
      prompt: 'judge this node',
      cwd: '/repo/root',
      readScope: ['/run/dir'],
      owns: ['/tpl/dir/nodes/gameplay/issues'],
      buildCommand: capturingBuilder(claudeStdout('ok'), capture),
    });
    // The COMPILED node must declare `local`, NOT the compile-time `inmemory` default (dag.ts `?? 'inmemory'`)
    // that the claude-code driver (sandbox.providers === ['local']) cannot run on. Before the fix this is
    // 'inmemory' and the runner emits `[driver-fit] … cannot run on sandbox provider "inmemory"`.
    expect(capture.node?.sandbox.provider).toBe('local');
    // …and driverFits agrees: the claude-code executor raises NO sandbox-provider problem (the exact warning
    // the substrate judge/fixer spawn was emitting is gone). Asserted on the sandbox axis only so the tier
    // axis can never mask it.
    const fit = driverFits(capture.node!, builtinDrivers().get('claude-code')!);
    expect(fit.problems.some((p) => p.includes('sandbox provider'))).toBe(false);
  });

  it('tools defaults to {} (the SDK default claude-code builtin set) when omitted', async () => {
    const capture: { node?: NodeSpec } = {};
    await runBaseAgent({
      prompt: 'p',
      cwd: process.cwd(),
      readScope: [],
      owns: [],
      buildCommand: capturingBuilder(claudeStdout('ok'), capture),
    });
    expect(capture.node?.tools).toEqual({});
  });

  it('a `skill` rides VERBATIM onto the compiled node (so the runner stages it) AND degrades gracefully when absent from every ring', async () => {
    // Point Ring 1 (`<piflowHome>/skills`) at an EMPTY home + run in an empty cwd (no Ring 0
    // `.agents/skills`), so `piflow-fixer` is absent from BOTH rings. The wiring must still ride the ref
    // onto the spawned spec (else the runner never even TRIES to stage), and a not-found skill must be
    // ADVISORY — the fixer still runs its promptless playbook, never a hard fail.
    const prevHome = process.env.PIFLOW_HOME;
    const emptyHome = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-emptyhome-'));
    process.env.PIFLOW_HOME = emptyHome;
    try {
      const capture: { node?: NodeSpec } = {};
      const { status } = await runBaseAgent({
        prompt: 'fix this node',
        cwd: emptyHome,
        readScope: [],
        owns: [],
        skill: 'piflow-fixer',
        buildCommand: capturingBuilder(claudeStdout('ok'), capture),
      });
      // wiring: the skill ref landed on the node the runner compiles → its skill-staging path can fire.
      expect(capture.node?.skill).toBe('piflow-fixer');
      // graceful degrade: skill absent from every ring ⇒ advisory skill-missing, the node still runs to ok.
      expect(status.status).toBe('ok');
    } finally {
      if (prevHome === undefined) delete process.env.PIFLOW_HOME;
      else process.env.PIFLOW_HOME = prevHome;
      await fs.rm(emptyHome, { recursive: true, force: true });
    }
  });
});

describe('runBaseAgent — the OBSERVE seam: a persisted run dir readable like any node\'s run', () => {
  it('with `outDir` the spawn\'s run dir PERSISTS, is returned as `runDir`, and the observe reader resolves the agent node', async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-substrate-obs-'));
    try {
      const { status, runDir } = await runBaseAgent({
        prompt: 'judge this node',
        cwd: process.cwd(),
        readScope: [],
        owns: [],
        outDir,
        buildCommand: capturingBuilder(claudeStdout('observed'), {}),
      });
      expect(status?.status).toBe('ok');
      // RED before: the ephemeral tmpdir was always used and rm'd in the finally — no `runDir` on the
      // result and nothing left on disk for telemetry/status/trace to point at.
      expect(runDir).toBe(outDir);
      // the persisted dir IS a run dir the EXISTING observe instruments read — the same `.pi/run.json` +
      // reader every workflow node's run dir goes through (readRunModel = the status/telemetry substrate).
      const model = await readRunModel(runDir!);
      expect(model.nodes.map((n) => n.id)).toContain('agent');
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });

  it('without `outDir` the scratch run dir stays EPHEMERAL — no `runDir` on the result (nothing survives to read)', async () => {
    const { runDir } = await runBaseAgent({
      prompt: 'p',
      cwd: process.cwd(),
      readScope: [],
      owns: [],
      buildCommand: capturingBuilder(claudeStdout('ok'), {}),
    });
    expect(runDir).toBeUndefined();
  });
});

describe('runBaseAgent — {{state.*}} hydration from a caller-supplied `state` seed', () => {
  // Regression for the substrate-fixer spawn death (bug: "prompt token resolution failed: unresolved state
  // channel \"slug\"..."): a caller (fix.ts/judge.ts/gate.ts) embeds a PINNED run's text (an issue file, a
  // criteria doc) verbatim into the prompt, and that text may legitimately quote a `{{state.<channel>}}`
  // token the run actually promoted. This spawn is EPHEMERAL — its own `.pi/state.json` starts empty — so
  // without a seed, the runner's own token-resolution pass throws before a single model call.
  it('resolves {{state.<channel>}} in the prompt using the caller-supplied `state` seed', async () => {
    const capture: { node?: NodeSpec } = {};
    const { status } = await runBaseAgent({
      prompt: 'the node\'s owns pattern: {{WORKSPACE}}/.artifacts/{{state.slug}}/*',
      cwd: process.cwd(),
      readScope: [],
      owns: [],
      state: { slug: 'grade1-vol1-section-3' },
      buildCommand: capturingBuilder(claudeStdout('ok'), capture),
    });
    expect(status.status).toBe('ok');
  });

  it('a channel genuinely ABSENT from the seed still fails loud (MissingChannelError) — never invents a default', async () => {
    const { status } = await runBaseAgent({
      prompt: 'the node\'s owns pattern: {{state.slug}}',
      cwd: process.cwd(),
      readScope: [],
      owns: [],
      state: { other: 'unrelated' }, // "slug" is NOT present
      buildCommand: capturingBuilder(claudeStdout('SHOULD NEVER RUN'), {}),
    });
    expect(status.status).toBe('error');
    expect(status.issues.join(' ')).toMatch(/unresolved state channel "slug"/);
  });

  it('omitting `state` entirely is UNCHANGED from before this seam existed — the same prompt still throws', async () => {
    const { status } = await runBaseAgent({
      prompt: 'the node\'s owns pattern: {{state.slug}}',
      cwd: process.cwd(),
      readScope: [],
      owns: [],
      buildCommand: capturingBuilder(claudeStdout('SHOULD NEVER RUN'), {}),
    });
    expect(status.status).toBe('error');
    expect(status.summary).toMatch(/prompt token resolution failed/);
  });
});

describe('runBaseAgent — returns the NodeStatusRecord + the REAL parsed result text', () => {
  it('text is the actual `result` event text off the node\'s genuine stdout (parseClaudeResult, not a guess)', async () => {
    const { status, text } = await runBaseAgent({
      prompt: 'judge this node',
      cwd: process.cwd(),
      readScope: [],
      owns: [],
      buildCommand: capturingBuilder(claudeStdout('three defects found: A, B, C'), {}),
    });
    expect(status.status).toBe('ok');
    expect(text).toBe('three defects found: A, B, C');
  });

  it('text is "" when the stdout carries no `result` event (never throws, never fabricates)', async () => {
    const { status, text } = await runBaseAgent({
      prompt: 'judge this node',
      cwd: process.cwd(),
      readScope: [],
      owns: [],
      buildCommand: () => `printf '%s' 'not json at all'`,
    });
    expect(status.status).toBe('ok'); // a clean exit with no artifacts/schema declared still verifies ok
    expect(text).toBe('');
  });

  it('cleans up its own scratch run dir (no leftover tmp dir survives the call)', async () => {
    const before = (await fs.readdir(os.tmpdir())).filter((f) => f.startsWith('piflow-substrate-agent-'));
    await runBaseAgent({
      prompt: 'p',
      cwd: process.cwd(),
      readScope: [],
      owns: [],
      buildCommand: capturingBuilder(claudeStdout('ok'), {}),
    });
    const after = (await fs.readdir(os.tmpdir())).filter((f) => f.startsWith('piflow-substrate-agent-'));
    expect(after.length).toBe(before.length);
  });
});
