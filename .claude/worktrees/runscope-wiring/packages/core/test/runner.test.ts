import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile, InMemorySandboxProvider, DefaultToolRegistry, mcpToolsToEntries } from '../src/index.js';
import type { NodeIntent, WorkflowSpec } from '../src/index.js';
import {
  runWorkflow,
  defaultExecRunner,
  defaultPiCommand,
  writeStatus,
  type ExecRunner,
  type RunStatus,
} from '../src/runner/index.js';
import type { Sandbox, SandboxProvider, CreateOpts, OpenRunOpts } from '../src/types.js';

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────

/** A NodeIntent factory (mirrors dag.test): reads/produces; artifacts default to produces. */
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

/** A fresh host run dir under the OS tmp (so a test never writes into the repo). */
async function tmpOut(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'piflow-run-'));
}

/**
 * THE STUB COMMAND BUILDER — the offline injection point. Instead of spawning `pi`, it returns a
 * shell command that writes each of the node's declared artifacts into its sandbox OUTPUT dir at
 * `<output>/<artifactPath>` (the path convention downloadDir flattens onto the host run dir), plus a
 * tiny return-protocol JSON block on stdout. This exercises the REAL lifecycle (stage → exec →
 * downloadDir → host-stat verify → hooks → dispose) with no live pi, no creds, no network.
 *
 * `producePaths` lets a test make a node NOT write a declared artifact (to drive the blocked path).
 */
function stubBuilder(producePaths?: (node: { id: string }) => string[]) {
  return (node: { id: string; io: { artifacts: { path: string }[] }; sandbox: { output: string } }): string => {
    const paths = producePaths ? producePaths(node) : node.io.artifacts.map((a) => a.path);
    const writes = paths
      .map((p) => {
        const dest = `${node.sandbox.output}/${p}`;
        const dir = dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : '.';
        return `mkdir -p ${dir} && printf '%s' ${node.id} > ${dest}`;
      })
      .join(' && ');
    const ret = `printf '%s' '\`\`\`json\\n{"status":"ok","summary":"${node.id} done"}\\n\`\`\`'`;
    return writes ? `${writes} && ${ret}` : ret;
  };
}

// ── 1. end-to-end ───────────────────────────────────────────────────────────────────────────────

describe('runWorkflow — end-to-end on InMemorySandboxProvider (no live pi)', () => {
  it('runs a parallel stage then a consumer, verifies artifacts, and writes run-status.json', async () => {
    // Two independent producers (parallel stage 1) → one consumer that reads BOTH (stage 2).
    const g = compile(
      wf([
        n('Alpha', [], ['alpha.txt']),
        n('Beta', [], ['beta.txt']),
        n('Gamma', ['alpha.txt', 'beta.txt'], ['gamma.txt']),
      ]),
    );
    expect(g.stages[0]).toMatchObject({ parallel: true, nodeIds: ['alpha', 'beta'] });

    const outDir = await tmpOut();
    // Observe concurrency: wrap the default exec runner, tracking how many execs are in flight at once.
    let inFlight = 0;
    let maxInFlight = 0;
    const tracking: ExecRunner = async (sandbox, cmd, opts) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        // a tick of overlap so the two parallel-lane execs are both counted in-flight
        await new Promise((r) => setTimeout(r, 5));
        return await defaultExecRunner(sandbox, cmd, opts);
      } finally {
        inFlight--;
      }
    };

    const { status } = await runWorkflow(g, { run: 'e2e', outDir, buildCommand: stubBuilder(), execRunner: tracking });

    // Parallel stage actually ran both lanes concurrently.
    expect(maxInFlight).toBe(2);

    // Stage order: Gamma's consumed inputs were staged from the host run dir (cross-sandbox flow),
    // so its own artifact exists only if Alpha/Beta landed first.
    expect(status.ok).toBe(true);
    expect(status.done).toBe(true);
    expect(status.nodes.alpha.status).toBe('ok');
    expect(status.nodes.beta.status).toBe('ok');
    expect(status.nodes.gamma.status).toBe('ok');

    // Artifacts verified by host-stat (path convention: <output>/<artifactPath> → <hostRunDir>/<path>).
    expect(status.nodes.gamma.artifacts).toEqual([{ path: 'gamma.txt', exists: true, bytes: 'gamma'.length }]);
    for (const f of ['alpha.txt', 'beta.txt', 'gamma.txt']) {
      expect(await fs.readFile(path.join(outDir, f), 'utf8')).toBeTruthy();
    }

    // run-status.json written with the right shape.
    const onDisk = JSON.parse(await fs.readFile(path.join(outDir, 'run-status.json'), 'utf8'));
    expect(onDisk).toMatchObject({ run: 'e2e', done: true, ok: true, totals: { nodes: 3, ok: 3, failed: 0 } });
    expect(onDisk.startedAt).toBeTruthy();
    expect(onDisk.nodes.gamma.artifacts[0]).toMatchObject({ path: 'gamma.txt', exists: true });

    await fs.rm(outDir, { recursive: true, force: true });
  });
});

// ── 2. halt-on-failure ──────────────────────────────────────────────────────────────────────────

describe('runWorkflow — halt-on-failure', () => {
  it('blocks a node that does not produce its declared artifact and never runs downstream', async () => {
    const g = compile(wf([n('Up', [], ['up.txt']), n('Down', ['up.txt'], ['down.txt'])]));
    const outDir = await tmpOut();

    let downRan = false;
    // `Up` produces NOTHING (empty produce list for it); `Down` would run normally if reached.
    const builder = stubBuilder((node) => {
      if (node.id === 'down') downRan = true;
      return node.id === 'up' ? [] : ['down.txt'];
    });

    const { status } = await runWorkflow(g, { run: 'halt', outDir, buildCommand: builder });

    expect(status.nodes.up.status).toBe('blocked');
    expect(status.nodes.up.issues.join(' ')).toMatch(/required artifact.*missing/i);
    expect(downRan).toBe(false); // downstream never executed
    expect(status.nodes.down.status).toBe('pending'); // never advanced past pending
    expect(status.ok).toBe(false);
    expect(status.done).toBe(true);

    await fs.rm(outDir, { recursive: true, force: true });
  });
});

// ── 3. resume (--from) ──────────────────────────────────────────────────────────────────────────

describe('runWorkflow — --from resume', () => {
  it('reuses present upstream artifacts and runs only the suffix', async () => {
    const g = compile(wf([n('Stage1', [], ['s1.txt']), n('Stage2', ['s1.txt'], ['s2.txt'])]));
    const outDir = await tmpOut();
    // Pre-place the upstream artifact on the host (as a prior run would have).
    await fs.writeFile(path.join(outDir, 's1.txt'), 'from-prior-run');

    let stage1Ran = false;
    const builder = stubBuilder((node) => {
      if (node.id === 'stage1') stage1Ran = true;
      return node.io.artifacts.map((a) => a.path);
    });

    const { status } = await runWorkflow(g, { run: 'resume', outDir, from: 'stage2', buildCommand: builder });

    expect(stage1Ran).toBe(false); // upstream NOT re-executed
    expect(status.nodes.stage1.status).toBe('reused');
    expect(status.nodes.stage1.artifacts).toEqual([{ path: 's1.txt', exists: true, bytes: 'from-prior-run'.length }]);
    expect(status.nodes.stage2.status).toBe('ok');
    expect(status.ok).toBe(true);
    // The downstream node consumed the reused upstream file (staged from the host run dir).
    expect(await fs.readFile(path.join(outDir, 's2.txt'), 'utf8')).toBe('stage2');

    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('HALTs when a required upstream artifact is missing', async () => {
    const g = compile(wf([n('Stage1', [], ['s1.txt']), n('Stage2', ['s1.txt'], ['s2.txt'])]));
    const outDir = await tmpOut(); // s1.txt NOT placed → preflight must halt

    let anyRan = false;
    const builder = stubBuilder((node) => { anyRan = true; return node.io.artifacts.map((a) => a.path); });

    const { status } = await runWorkflow(g, { run: 'resume-miss', outDir, from: 'stage2', buildCommand: builder });

    expect(anyRan).toBe(false); // halted BEFORE any node ran
    expect(status.ok).toBe(false);
    expect(status.done).toBe(true);
    expect(JSON.stringify(status.nodes)).toMatch(/missing upstream artifact/i);

    await fs.rm(outDir, { recursive: true, force: true });
  });
});

// ── 4. watchdog (node timeout) ────────────────────────────────────────────────────────────────────

describe('runWorkflow — node-timeout watchdog', () => {
  it('kills a node that sleeps beyond nodeTimeoutMs and marks it error (killedTimeout), not hung', async () => {
    const g = compile(wf([n('Slow', [], ['slow.txt'])]));
    const outDir = await tmpOut();

    // A stub that sleeps far longer than the tiny node timeout and only writes its artifact AFTER.
    const slowBuilder = (node: { sandbox: { output: string } }): string =>
      `sleep 5 && mkdir -p ${node.sandbox.output} && printf '%s' slow > ${node.sandbox.output}/slow.txt`;

    const start = Date.now();
    const { status } = await runWorkflow(g, {
      run: 'watchdog',
      outDir,
      buildCommand: slowBuilder,
      nodeTimeoutMs: 60, // tiny
      killGraceMs: 10,
    });
    const elapsed = Date.now() - start;

    expect(status.nodes.slow.status).toBe('error');
    expect(status.nodes.slow.killedTimeout).toBe(true);
    expect(status.nodes.slow.artifacts).toEqual([{ path: 'slow.txt', exists: false, bytes: 0 }]);
    expect(status.ok).toBe(false);
    // It returned promptly (watchdog abandoned the wait) rather than blocking ~5s on the sleep.
    expect(elapsed).toBeLessThan(3000);

    await fs.rm(outDir, { recursive: true, force: true });
  });
});

// ── command builder (the production default's flag shape) ────────────────────────────────────────

describe('defaultPiCommand — production headless flags', () => {
  it('builds the headless pi invocation with provider, tools, and @prompt', () => {
    const node = compile(wf([n('X', [], ['x.txt'])])).nodes.x;
    const cmd = defaultPiCommand(node, { piTools: ['read', 'write'] }, { promptFile: '_pi/prompt.md', provider: 'cp', model: 'm1' });
    expect(cmd).toContain('pi -p --mode json -a --no-session --offline --no-extensions --no-context-files');
    expect(cmd).toContain('--provider cp');
    expect(cmd).toContain('--model m1');
    expect(cmd).toContain('--tools read,write');
    expect(cmd).toMatch(/@'_pi\/prompt\.md'$/);
  });
});

// ── tool wiring: bind pre-check + generated -e extension staged for outside tools ─────────────────

describe('runWorkflow — tool binding (the per-node pre-check + the generated -e extension)', () => {
  it('BLOCKS a node that declares a tool absent from the catalog, before spawning pi', async () => {
    // The node asks for an MCP tool nobody registered → it cannot bind → blocked before any pi spawn.
    const g = compile(wf([n('Solo', [], ['s.txt'], { tools: { allow: ['mcp.slack:post_message'] } })]));
    const outDir = await tmpOut();

    let built = false;
    const builder = (node: { sandbox: { output: string } }): string => {
      built = true; // would mean we tried to build a pi command → the bind gate failed to stop us
      return `mkdir -p ${node.sandbox.output} && printf x > ${node.sandbox.output}/s.txt`;
    };

    const { status } = await runWorkflow(g, { run: 'bind-miss', outDir, buildCommand: builder });

    expect(status.nodes.solo.status).toBe('blocked');
    expect(status.nodes.solo.issues.join(' ')).toMatch(/mcp\.slack:post_message/);
    expect(built).toBe(false); // pi was NEVER spawned — the gate fired first
    expect(status.ok).toBe(false);

    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('stages the GENERATED extension and passes it via -e for a declared MCP tool', async () => {
    // Register an MCP tool (the effortless fetch), then a node binds it alongside a builtin.
    const registry = new DefaultToolRegistry();
    for (const e of mcpToolsToEntries('github', [{ name: 'create_issue', description: 'Open an issue.' }])) {
      registry.register(e);
    }
    const g = compile(wf([n('Issue', [], ['out.txt'], { tools: { allow: ['fs:write', 'mcp.github:create_issue'] } })]));
    const outDir = await tmpOut();

    // Record every file staged into the sandbox so we can prove the generated extension landed.
    const writes: { path: string; data: string }[] = [];
    const base = new InMemorySandboxProvider();
    const recording: SandboxProvider = {
      kind: 'inmemory',
      async create(opts: CreateOpts): Promise<Sandbox> {
        const sb = await base.create(opts);
        const orig = sb.writeFile.bind(sb);
        sb.writeFile = async (p: string, d: Uint8Array | string) => {
          writes.push({ path: p, data: typeof d === 'string' ? d : Buffer.from(d).toString('utf8') });
          return orig(p, d);
        };
        return sb;
      },
    };

    // The builder both CAPTURES the real headless command and writes the artifact (so the node is ok).
    let captured = '';
    const builder = (node: Parameters<typeof defaultPiCommand>[0], resolved: Parameters<typeof defaultPiCommand>[1], ctx: Parameters<typeof defaultPiCommand>[2]): string => {
      captured = defaultPiCommand(node, resolved, ctx);
      return `mkdir -p ${node.sandbox.output} && printf x > ${node.sandbox.output}/out.txt`;
    };

    const { status } = await runWorkflow(g, { run: 'wire', outDir, provider: recording, registry, buildCommand: builder });

    expect(status.nodes.issue.status).toBe('ok');
    // the allowlist carries the builtin AND the prefixed MCP bare name; -e points at the staged file.
    expect(captured).toContain('--tools write,github_create_issue');
    expect(captured).toContain("-e '_pi/tools.ts'");
    // the generated extension was actually staged, and it BINDS the declared tool (registerTool + bridge).
    const ext = writes.find((w) => w.path === '_pi/tools.ts');
    expect(ext).toBeTruthy();
    expect(ext!.data).toContain('name: "github_create_issue"');
    expect(ext!.data).toContain('from "@piflow/tool-bridge"');
    expect(ext!.data).toContain('callTool("mcp.github:create_issue"');

    await fs.rm(outDir, { recursive: true, force: true });
  });
});

// ── run scope: openRun lifecycle (worktree/cloud share ONE resource across a run) ─────────────────

describe('runWorkflow — run scope (the openRun lifecycle for worktree/cloud providers)', () => {
  it('opens the scope ONCE, routes every node sandbox through it, and disposes it once, last', async () => {
    const g = compile(
      wf([n('A', [], ['a.txt']), n('B', [], ['b.txt']), n('C', ['a.txt', 'b.txt'], ['c.txt'])]),
    );
    const outDir = await tmpOut();

    const base = new InMemorySandboxProvider();
    const events: string[] = [];
    let openRunCalls = 0;
    let providerCreateCalls = 0; // the bare per-node provider.create — MUST stay 0 when openRun exists
    let scopeCreateCalls = 0;
    let disposeCalls = 0;
    let openRunArgs: OpenRunOpts | null = null;

    const provider: SandboxProvider = {
      kind: 'worktree',
      create(opts: CreateOpts): Promise<Sandbox> {
        providerCreateCalls++; // if the runner bypasses the scope, this fires instead of scope.create
        return base.create(opts);
      },
      async openRun(opts: OpenRunOpts) {
        openRunCalls++;
        openRunArgs = opts;
        events.push('openRun');
        return {
          root: `/wt/${opts.run}`,
          create: (o: CreateOpts): Promise<Sandbox> => {
            scopeCreateCalls++;
            events.push('create');
            return base.create(o);
          },
          dispose: async (): Promise<void> => {
            disposeCalls++;
            events.push('dispose');
          },
        };
      },
    };

    const { status } = await runWorkflow(g, {
      run: 'scoped',
      outDir,
      repoRoot: '/some/repo',
      provider,
      buildCommand: stubBuilder(),
    });

    expect(status.ok).toBe(true);
    expect(openRunCalls).toBe(1); // ONE shared resource per run, not per node
    expect(openRunArgs!.run).toBe('scoped'); // run identity is threaded in
    expect(openRunArgs!.repoRoot).toBe('/some/repo');
    expect(openRunArgs!.outDir).toBe(outDir);
    expect(scopeCreateCalls).toBe(3); // each node's sandbox came FROM the scope
    expect(providerCreateCalls).toBe(0); // …never the bare provider.create — it was routed through scope
    expect(disposeCalls).toBe(1); // torn down exactly once
    // openRun is first, dispose is the very LAST event (run-level teardown after every node).
    expect(events[0]).toBe('openRun');
    expect(events[events.length - 1]).toBe('dispose');
    expect(events.filter((e) => e === 'create')).toHaveLength(3);

    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('disposes the run scope even when a node fails (teardown runs in finally)', async () => {
    const g = compile(wf([n('Up', [], ['up.txt'])]));
    const outDir = await tmpOut();

    const base = new InMemorySandboxProvider();
    let disposeCalls = 0;
    const provider: SandboxProvider = {
      kind: 'worktree',
      create: (opts: CreateOpts): Promise<Sandbox> => base.create(opts),
      async openRun() {
        return {
          root: '/wt',
          create: (o: CreateOpts): Promise<Sandbox> => base.create(o),
          dispose: async (): Promise<void> => { disposeCalls++; },
        };
      },
    };

    // `Up` produces nothing → blocked → the run halts; the scope MUST still be disposed.
    const { status } = await runWorkflow(g, {
      run: 'scoped-fail',
      outDir,
      provider,
      buildCommand: stubBuilder(() => []),
    });

    expect(status.ok).toBe(false);
    expect(status.nodes.up.status).toBe('blocked');
    expect(disposeCalls).toBe(1); // finally-block teardown fired despite the failure

    await fs.rm(outDir, { recursive: true, force: true });
  });
});

// ── 5. lane isolation: a throw in one parallel lane must NOT crash the whole run ──────────────────

describe('runWorkflow — lane isolation (parallel-lane failures are contained, not fail-fast)', () => {
  it('contains a sandbox-create throw in one lane as `error` and still resolves with the other lane done', async () => {
    // Two independent producers run as one parallel stage. The provider throws on the 2nd create() —
    // i.e. one lane fails to even stand up its sandbox. With the bug, that throw escapes runNode, the
    // stage's Promise.all rejects, and runWorkflow REJECTS — discarding Alpha's completed work and the
    // halt/finalize. The fix marks Beta `error` and the run halts cleanly (run.mjs's runNode never
    // rejects its lane).
    const g = compile(wf([n('Alpha', [], ['alpha.txt']), n('Beta', [], ['beta.txt'])]));
    expect(g.stages[0]).toMatchObject({ parallel: true });
    const outDir = await tmpOut();

    let creates = 0;
    const base = new InMemorySandboxProvider();
    const flaky: SandboxProvider = {
      kind: 'inmemory',
      create(opts: CreateOpts): Promise<Sandbox> {
        creates++;
        if (creates === 2) throw new Error('provider boom in lane 2');
        return base.create(opts);
      },
    };

    // Must RESOLVE (not throw). With the bug this await rejects and the test fails.
    const { status } = await runWorkflow(g, { run: 'lane', outDir, provider: flaky, buildCommand: stubBuilder() });

    expect(status.done).toBe(true);
    expect(status.ok).toBe(false); // the failed lane halts the run cleanly
    const verdicts = Object.values(status.nodes).map((x) => x.status).sort();
    // exactly one node errored, the other completed ok — siblings' work was NOT discarded.
    expect(verdicts).toEqual(['error', 'ok']);
    const errored = Object.values(status.nodes).find((x) => x.status === 'error');
    expect(errored?.summary).toMatch(/sandbox create failed/i);

    // The terminal status is DURABLE on disk (finishNode awaits the write) and equals memory.
    const onDisk = JSON.parse(await fs.readFile(path.join(outDir, 'run-status.json'), 'utf8'));
    expect(onDisk.done).toBe(true);
    expect(onDisk.ok).toBe(false);

    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('contains a throw from an injected execRunner in one lane (post-create failure) as `error`', async () => {
    // The exec primitive throwing (vs resolving) after the sandbox exists must also be contained to the
    // node, never reject the lane. Covers the `catch` around the post-create body.
    const g = compile(wf([n('P', [], ['p.txt']), n('Q', [], ['q.txt'])]));
    const outDir = await tmpOut();

    let n0 = 0;
    const explodingExec: ExecRunner = async (sandbox, cmd, opts) => {
      n0++;
      if (n0 === 1) throw new Error('exec primitive blew up');
      return defaultExecRunner(sandbox, cmd, opts);
    };

    const { status } = await runWorkflow(g, { run: 'lane2', outDir, buildCommand: stubBuilder(), execRunner: explodingExec });
    expect(status.done).toBe(true);
    expect(status.ok).toBe(false);
    expect(Object.values(status.nodes).filter((x) => x.status === 'error')).toHaveLength(1);
    expect(JSON.stringify(status.nodes)).toMatch(/node failed/i);

    await fs.rm(outDir, { recursive: true, force: true });
  });
});

// ── 6. status writer: serialized + atomic under concurrent writers (no torn reads, last-write-wins) ─

describe('writeStatus — concurrent-writer safety (atomic publish, ordered, no torn reads)', () => {
  it('never yields a torn/partial file to a concurrent reader and lands the last-enqueued value', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-status-'));
    const file = path.join(dir, 'run-status.json');
    const mk = (i: number): RunStatus => ({
      run: 'r', startedAt: 'x', updatedAt: 'x', done: false, ok: null, durationMs: i, stage: null, totals: null,
      // a large payload so a non-atomic write spans multiple syscalls (maximizes the torn-read window).
      nodes: Object.fromEntries(
        Array.from({ length: 400 }, (_, k) => [
          `n${k}`, { id: `n${k}`, label: `L${k}`, status: 'ok' as const, artifacts: [], issues: ['x'.repeat(64)], summary: 's'.repeat(200) },
        ]),
      ),
    });

    // A reader polling the file concurrently must NEVER see unparseable bytes (the watcher invariant).
    let torn = 0;
    let reads = 0;
    let stop = false;
    const reader = (async () => {
      while (!stop) {
        reads++;
        try { JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) {
          // ENOENT before the first publish is fine; a parse error on present bytes is a TORN read.
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') torn++;
        }
      }
    })();

    // Fire many overlapping writes (mimicking parallel lanes + the loop). The LAST enqueued is i=199.
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 200; i++) writes.push(writeStatus(dir, mk(i)));
    await Promise.all(writes);
    stop = true;
    await reader;

    expect(reads).toBeGreaterThan(0);
    expect(torn).toBe(0); // atomic temp+rename ⇒ a reader sees only whole files
    // Serialized chain ⇒ the last-ENQUEUED value is the one on disk (ordering preserved).
    const finalOnDisk = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(finalOnDisk.durationMs).toBe(199);

    await fs.rm(dir, { recursive: true, force: true });
  });
});

// ── real cancellation (process-group kill + closed stdin) ────────────────────────────────────────

describe('runWorkflow — real cancellation (ExecOpts.signal)', () => {
  it('kills the whole process group: a grandchild deferred write never lands', async () => {
    const g = compile(wf([n('Slow', [], ['slow.txt'])]));
    const outDir = await tmpOut();
    // A HOST marker OUTSIDE the (disposed) sandbox temp dir. The stub sleeps, then would touch it — but
    // the node-timeout aborts ExecOpts.signal, killing the process GROUP, so `sleep` (a grandchild of
    // the shell) dies and the `touch` after it never runs. Pre-fix (abandon, no real kill) the orphaned
    // sleep fired the touch ~1s later.
    const marker = path.join(os.tmpdir(), `piflow-latekill-${Date.now()}.marker`);
    const builder = (): string => `sleep 1 && touch ${marker}`;

    const { status } = await runWorkflow(g, { run: 'realkill', outDir, buildCommand: builder, nodeTimeoutMs: 60, killGraceMs: 50 });
    expect(status.nodes.slow.status).toBe('error');
    expect(status.nodes.slow.killedTimeout).toBe(true);

    // Wait well past the grandchild's 1s sleep; the marker must NOT appear (the group was reaped).
    await new Promise((r) => setTimeout(r, 1500));
    await expect(fs.access(marker)).rejects.toThrow();

    await fs.rm(marker, { force: true }).catch(() => {});
    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('closes stdin so a stdin-reading command gets EOF instead of hanging', async () => {
    const g = compile(wf([n('Reader', [], ['r.txt'])]));
    const outDir = await tmpOut();
    // `cat` with no args reads stdin to EOF. With stdin closed (/dev/null) it returns immediately and
    // the node finishes `ok`; an OPEN stdin with no TTY would hang `cat` until the timeout kills it.
    const builder = (node: { sandbox: { output: string } }): string =>
      `cat && mkdir -p ${node.sandbox.output} && printf '%s' x > ${node.sandbox.output}/r.txt`;

    const { status } = await runWorkflow(g, { run: 'stdin', outDir, buildCommand: builder, nodeTimeoutMs: 2000 });
    expect(status.nodes.reader.status).toBe('ok');
    expect(status.nodes.reader.killedTimeout).toBeFalsy();

    await fs.rm(outDir, { recursive: true, force: true });
  });
});
