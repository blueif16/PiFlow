// driver-runtime.test.ts — P3 of the AgentDriver registry (docs/design/agent-driver-registry.md §6 P3).
//
// P0 froze the parity contract, P1 shipped piDriver + the table, P2 shipped claudeCodeDriver — all ADDITIVE:
// the runtime still forks on `node.executor === 'claude-code'` and never consults `ctx.drivers`. P3 is the
// COLLAPSE — the runner must route command-build / model / sandbox / verdict through
// `ctx.drivers.get(node.executor)`, so a THIRD executor (registered per-run via `RunOptions.drivers`) becomes
// expressible and RUNS, while pi + claude stay byte-identical (guarded by the existing suite).
//
// These are the NET-NEW P3 behaviors, written test-first (RED against the pre-implementation HEAD):
//   1. THIRD-EXECUTOR e2e   — a test-only `echo` driver, registered per-run, runs a node END-TO-END (its
//                             buildCommand writes the artifact; its parseResult yields the verdict).
//   2. UNKNOWN-EXECUTOR      — a node whose executor is not in the table FAILS at compile with a WorkflowError
//                             whose message LISTS the known driver ids (fail-closed, legible).
//   3. STAMP                 — after a run, each node's record carries {driverId, driverVersion} for the
//                             executor that ran it.
//
// The echoDriver is a MINIMAL REAL AgentDriver (implements the frozen interface), defined here and registered
// HERMETICALLY per-run via RunOptions.drivers — never a global mutation of builtinDrivers().

import { describe, it, expect } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile, builtinDrivers, WorkflowError } from '../src/index.js';
import type { NodeIntent, WorkflowSpec, AgentDriver } from '../src/index.js';
import { runWorkflow } from '../src/runner/index.js';
import type { NodeSpec } from '../src/types.js';

// ── helpers (mirror runner.test / executor-override.test) ───────────────────────────────────────────

/** A NodeIntent factory; artifacts default to produces. `over` can set `executor`. */
function n(label: string, reads: string[], produces: string[], over: Partial<NodeIntent> = {}): NodeIntent {
  return {
    label,
    prompt: `do ${label}`,
    tools: {},
    io: { reads, produces, artifacts: produces.map((p) => ({ path: p })) },
    ...over,
  };
}
const wf = (nodes: NodeIntent[]): WorkflowSpec => ({ meta: { name: 't', description: 'd' }, nodes });

async function tmpOut(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'piflow-driver-runtime-'));
}

// ── the test-only THIRD driver ──────────────────────────────────────────────────────────────────────
//
// A minimal REAL AgentDriver, id 'echo'. It has NO builtin equivalent — the runtime CANNOT run it via the
// hardcoded pi/claude ternary; the ONLY way a node with executor 'echo' completes is if the runner routes
// command-build + verdict through `ctx.drivers.get('echo')`. buildCommand writes each declared artifact into
// the sandbox output dir (the downloadDir convention) so the DEFAULT execRunner drives the full lifecycle
// green with NO live binary; parseResult yields a clean, self-report-less verdict (falls straight to the
// driver's artifact gates, like a clean claude success). No LLM — a pure integration proof.
const echoDriver: AgentDriver = {
  id: 'echo',
  version: 1,
  describe() {
    return {
      id: 'echo',
      label: 'echo',
      version: 1,
      runtime: 'cli',
      binary: 'echo',
      model: { tierAware: false, providerRouting: false, resolvesThrows: false },
      tools: { grammar: 'pi-bare', supportsCustom: false, supportsMcp: false, supportsSkills: false, builtinMap: () => ({}) },
      sandbox: { providers: ['local'] },
      // usageRollup:false ⇒ parity is unconstrained (echo self-reports no NodeUsage); it also keeps the pi
      // handshake path harmlessly live without demanding a usage spine.
      telemetry: { usageRollup: false, perToolTimeline: 'none', loopSignal: false, costReported: false },
      costModel: 'unknown',
    };
  },
  // No model pin — echo runs no model.
  resolveModel() {
    return {};
  },
  // Write each declared artifact into the sandbox output dir so the lifecycle completes clean (mirrors
  // executor-override.test's artifactBuilder). This is the ONLY command that produces the artifact — the
  // pi/claude ternary would NOT emit it, so a green node proves the driver's buildCommand actually ran.
  buildCommand(node: NodeSpec): string {
    const out = node.sandbox.output;
    return node.io.artifacts
      .map((a) => `mkdir -p ${out} && printf '%s' ${node.id} > ${out}/${a.path}`)
      .join(' && ');
  },
  // A clean verdict: ok on a zero exit / not killed, no self-report block (so the node's verdict falls to the
  // artifact gates), no usage.
  parseResult(raw) {
    return { verdict: { ok: raw.exitCode === 0 && raw.killed === null, selfReport: null }, usage: undefined };
  },
  // context-window denominator: none.
  modelCaps() {
    return null;
  },
};

// The OAuth resolver a claude node needs host-side; harmless for echo/pi (they never ask for it).
const oauthResolver = (name: string): string | undefined =>
  name === 'CLAUDE_CODE_OAUTH_TOKEN' ? 'test-oauth-token' : undefined;

describe('AgentDriver runtime collapse (P3) — a third executor runs through ctx.drivers', () => {
  // ── 1. THIRD-EXECUTOR e2e ─────────────────────────────────────────────────────────────────────────
  it('runs a node whose executor is a per-run-registered THIRD driver ("echo") END-TO-END, producing its artifact + verdict', async () => {
    // A single node authored with executor 'echo'. Registered ONLY via opts.drivers (per-run, hermetic) —
    // builtinDrivers() alone does NOT know 'echo', so the runtime must consult ctx.drivers to run it.
    const g = compile(wf([n('EchoNode', [], ['echo.txt'], { executor: 'echo' })]));
    expect(g.nodes.echonode.executor).toBe('echo');

    const drivers = builtinDrivers().register(echoDriver); // hermetic: a fresh table, echo added per-run
    const outDir = await tmpOut();

    // NO opts.buildCommand injection — the point is that the runner's DEFAULT command path routes through the
    // per-run driver table (echoDriver.buildCommand), not the pi/claude ternary. Default execRunner + the
    // in-memory sandbox run the returned command.
    // A short nodeTimeoutMs bounds the RED deterministically: at pre-P3 HEAD the runner routes 'echo' through
    // the pi/claude ternary → `defaultPiCommand` (a `pi …` invocation that HANGS on this machine, where `pi`
    // is installed) → the watchdog kills it → node `error`, so the assertions below FAIL fast rather than
    // hitting the vitest 20s cap. Once P3 routes 'echo' → echoDriver.buildCommand, the artifact-writing shell
    // command finishes in ms (well under this cap) → green.
    const { status } = await runWorkflow(g, {
      run: 'echo-e2e',
      outDir,
      drivers,
      secretResolver: oauthResolver,
      nodeTimeoutMs: 5000,
      killGraceMs: 50,
    });

    // The echo node ran end-to-end: green verdict.
    expect(status.nodes.echonode.status).toBe('ok');
    expect(status.ok).toBe(true);

    // The artifact echoDriver.buildCommand declared is on disk with the node-id contents (the pi/claude
    // ternary would never have emitted it) — proof the driver's own command ran.
    const artifact = path.join(outDir, 'echo.txt');
    expect(existsSync(artifact)).toBe(true);
    expect(await fs.readFile(artifact, 'utf8')).toBe('echonode');

    await fs.rm(outDir, { recursive: true, force: true });
  });

  // ── 2. UNKNOWN-EXECUTOR compile-fail ────────────────────────────────────────────────────────────────
  it('a node whose executor is not in the driver table FAILS at compile, listing the known ids', () => {
    // 'nope' is registered nowhere. Compile must validate NodeSpec.executor against the run's driver ids and
    // reject fail-closed, with a message that lists the known executors so the miss is legible.
    const drivers = builtinDrivers().register(echoDriver);
    const spec = wf([n('Bad', [], ['bad.txt'], { executor: 'nope' })]);

    // compile(spec, knownExecutors) — the second arg is the P3 seam that threads the run's driver ids into the
    // compile-time gate. (At HEAD compile ignores extra args, so this call does NOT throw — the RED signal.)
    expect(() => compile(spec, drivers.ids())).toThrow(WorkflowError);

    let caught: unknown;
    try {
      compile(spec, drivers.ids());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WorkflowError);
    const msg = (caught as Error).message;
    // The message names the offending executor AND lists every known id (pi, claude-code, echo).
    expect(msg).toMatch(/nope/);
    expect(msg).toMatch(/pi/);
    expect(msg).toMatch(/claude-code/);
    expect(msg).toMatch(/echo/);
  });

  it('a node with a KNOWN executor ("echo", registered per-run) compiles cleanly against the driver ids', () => {
    // The positive counterpart: an executor that IS in the table passes the same compile-time gate.
    const drivers = builtinDrivers().register(echoDriver);
    const spec = wf([n('Good', [], ['good.txt'], { executor: 'echo' })]);
    expect(() => compile(spec, drivers.ids())).not.toThrow();
  });

  // ── 3. STAMP ─────────────────────────────────────────────────────────────────────────────────────────
  it('stamps {driverId, driverVersion} on each per-node record for the executor that ran it', async () => {
    // The stamp is proven for BOTH a non-builtin (echo) and a builtin (pi) executor, in SEPARATE runs so each
    // reaches green via the right command seam:
    //   • echo node — carried by echoDriver.buildCommand (the DEFAULT table-routed path); stamps driverId:echo.
    //   • pi node   — carried by an injected opts.buildCommand (a stub that writes the artifact); stamps
    //                 driverId:pi (table.get(undefined)→pi at finishNode).
    const drivers = builtinDrivers().register(echoDriver);

    // ECHO run — default path routes to echoDriver. Short nodeTimeoutMs bounds the RED (see the e2e test):
    // pre-P3, 'echo' routes to the pi ternary → a hanging `pi …` → watchdog kill → error, so the `ok` +
    // stamp assertions FAIL fast rather than timing out.
    const gEcho = compile(wf([n('EchoStamp', [], ['e.txt'], { executor: 'echo' })]));
    const outEcho = await tmpOut();
    const { status: sEcho } = await runWorkflow(gEcho, {
      run: 'stamp-echo', outDir: outEcho, drivers, secretResolver: oauthResolver,
      nodeTimeoutMs: 5000, killGraceMs: 50,
    });
    expect(sEcho.nodes.echostamp.status).toBe('ok');
    // The P3 stamp: the executor driver that ran this node + its seal version. (Absent at HEAD ⇒ RED.)
    const echoRec = sEcho.nodes.echostamp as unknown as { driverId?: string; driverVersion?: number };
    expect(echoRec.driverId).toBe('echo');
    expect(echoRec.driverVersion).toBe(1);

    // PI run — a plain authored-pi node, artifact written by an injected builder so the lifecycle is green
    // without a live pi. It must still stamp driverId:pi (the default lane).
    const gPi = compile(wf([n('PiStamp', [], ['p.txt'])]));
    expect(gPi.nodes.pistamp.executor).toBeUndefined(); // authored pi (no executor)
    const piBuild = ((node: NodeSpec): string => {
      const out = node.sandbox.output;
      return node.io.artifacts.map((a) => `mkdir -p ${out} && printf '%s' ${node.id} > ${out}/${a.path}`).join(' && ');
    }) as unknown as Parameters<typeof runWorkflow>[1]['buildCommand'];
    const outPi = await tmpOut();
    const { status: sPi } = await runWorkflow(gPi, { run: 'stamp-pi', outDir: outPi, drivers, buildCommand: piBuild });
    expect(sPi.nodes.pistamp.status).toBe('ok');
    const piRec = sPi.nodes.pistamp as unknown as { driverId?: string; driverVersion?: number };
    expect(piRec.driverId).toBe('pi');
    expect(piRec.driverVersion).toBe(1);

    await fs.rm(outEcho, { recursive: true, force: true });
    await fs.rm(outPi, { recursive: true, force: true });
  });
});
