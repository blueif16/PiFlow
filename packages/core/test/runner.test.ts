import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile, InMemorySandboxProvider, DefaultToolRegistry, mcpToolsToEntries, openClawPluginToEntries } from '../src/index.js';
import type { NodeIntent, WorkflowSpec } from '../src/index.js';
import {
  runWorkflow,
  defaultExecRunner,
  defaultPiCommand,
  writeStatus,
  selectedBridgedTool,
  type ExecRunner,
  type RunStatus,
  type SecretResolver,
} from '../src/runner/index.js';
import type { NodeSpec, Sandbox, SandboxProvider, CreateOpts, OpenRunOpts } from '../src/types.js';

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

/**
 * A builder that writes EXACT bytes to each artifact (so a test can drive the schema/checks/sentinel
 * gates), and optionally emits a PARSEABLE return block. Content must be single-quote-free (it is
 * shell-single-quoted); newlines/backticks are fine. `emitReturn` defaults false (artifact-backed
 * nodes prove via the file); when true it emits a fence the forgiving parser recovers.
 */
function contentBuilder(contentFn: (node: { id: string; io: { artifacts: { path: string }[] }; sandbox: { output: string } }) => Record<string, string>, opts: { emitReturn?: boolean; status?: string } = {}) {
  return (node: { id: string; io: { artifacts: { path: string }[] }; sandbox: { output: string } }): string => {
    const out = node.sandbox.output;
    const contents = contentFn(node);
    const writes = Object.entries(contents)
      .map(([p, c]) => {
        const dest = `${out}/${p}`;
        const dir = dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : '.';
        return `mkdir -p ${dir} && printf '%s' '${c}' > ${dest}`;
      })
      .join(' && ');
    const ret = opts.emitReturn ? `printf '%s' '\`\`\`json{"status":"${opts.status ?? 'ok'}"}\`\`\`'` : '';
    const cmd = [writes, ret].filter(Boolean).join(' && ');
    return cmd || 'true';
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
    // back-compat: the 3-arg call carries NEITHER of U4's new flags.
    expect(cmd).not.toContain('--exclude-tools');
    expect(cmd).not.toContain('--thinking');
  });

  it('emits --exclude-tools from resolved.excludeTools (NOT a node.tools read)', () => {
    // The load-bearing assertion: exclude derives from the RESOLVED result. The node declares NO deny,
    // so a node.tools-direct builder would emit nothing — only reading `resolved.excludeTools` works.
    const node = compile(wf([n('X', [], ['x.txt'])])).nodes.x;
    const cmd = defaultPiCommand(node, { piTools: ['read'], excludeTools: ['bash', 'web'] }, { promptFile: '_pi/prompt.md' });
    expect(cmd).toContain('--exclude-tools bash,web');
  });

  it('emits --thinking ONLY when opts.thinking is set', () => {
    const node = compile(wf([n('X', [], ['x.txt'])])).nodes.x;
    const resolved = { piTools: ['read'] };
    const ctx = { promptFile: '_pi/prompt.md' };
    expect(defaultPiCommand(node, resolved, ctx, { thinking: 'high' })).toContain('--thinking high');
    // absent opts ⇒ no flag.
    expect(defaultPiCommand(node, resolved, ctx)).not.toContain('--thinking');
  });

  it('places each opts.extraExtensions -e BEFORE the ctx.extensionFile -e (order is load-bearing)', () => {
    const node = compile(wf([n('X', [], ['x.txt'])])).nodes.x;
    const cmd = defaultPiCommand(
      node,
      { piTools: ['read'] },
      { promptFile: '_pi/prompt.md', extensionFile: '_pi/x/tools.ts' },
      { extraExtensions: ['/abs/a.ts', '/abs/b.ts'] },
    );
    // each extra is an -e; the ctx extension is the LAST -e.
    expect(cmd).toContain("-e '/abs/a.ts' -e '/abs/b.ts'");
    expect(cmd).toContain("-e '_pi/x/tools.ts'");
    // ORDER: both extras must come before the ctx extension in the argv string.
    expect(cmd.indexOf("-e '/abs/a.ts'")).toBeLessThan(cmd.indexOf("-e '_pi/x/tools.ts'"));
    expect(cmd.indexOf("-e '/abs/b.ts'")).toBeLessThan(cmd.indexOf("-e '_pi/x/tools.ts'"));
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
    expect(captured).toContain("-e '_pi/issue/tools.ts'");
    // the generated extension was actually staged (at the node's per-node staging dir), and it BINDS the
    // declared tool (registerTool + bridge).
    const ext = writes.find((w) => w.path === '_pi/issue/tools.ts');
    expect(ext).toBeTruthy();
    expect(ext!.data).toContain('name: "github_create_issue"');
    // the staged extension is now the self-contained BUNDLE (the bundle seam): the @piflow/tool-bridge
    // import is INLINED (so it resolves on any sandbox — temp dir / cloud VM), while the tool still binds
    // the declared MCP tool BY ADDRESS through the (now inlined) bridge.
    expect(ext!.data).toContain('mcp.github:create_issue');
    const extImports = ext!.data.split('\n').filter((l) => /^\s*import\s/.test(l));
    expect(extImports.some((l) => /@piflow\/tool-bridge/.test(l))).toBe(false);

    await fs.rm(outDir, { recursive: true, force: true });
  });
});

// ── per-node staging isolation: _pi/<id>/* (parallel nodes never clobber the staged prompt/ext) ───

describe('runWorkflow — per-node staging isolation (parallel nodes never clobber _pi/*)', () => {
  it('stages each node prompt at a per-node path _pi/<id>/prompt.md (distinct across a parallel stage)', async () => {
    // A and B have no deps → ONE parallel stage. With a FIXED _pi/prompt.md, two nodes sharing an
    // in-place workspace clobber each other's prompt (the OPEN-1 bug). Per-node namespacing prevents it.
    const g = compile(wf([n('A', [], ['a.txt']), n('B', [], ['b.txt'])]));
    const outDir = await tmpOut();

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

    const { status } = await runWorkflow(g, { run: 'stage-iso', outDir, provider: recording, buildCommand: stubBuilder() });
    expect(status.ok).toBe(true);

    // distinct, node-id-namespaced — NOT a shared '_pi/prompt.md' (the clobber the fix prevents).
    const promptPaths = writes.filter((w) => w.path.endsWith('prompt.md')).map((w) => w.path).sort();
    expect(promptPaths).toEqual(['_pi/a/prompt.md', '_pi/b/prompt.md']);
    // …and each prompt kept ITS node's content (proves they did not overwrite one another).
    expect(writes.find((w) => w.path === '_pi/a/prompt.md')!.data).toContain('do A');
    expect(writes.find((w) => w.path === '_pi/b/prompt.md')!.data).toContain('do B');

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

// ── MCP config staging: _pi/mcp.json + PIFLOW_MCP_CONFIG (absolute) + referenced-secret env injection ─
// The runner writes the node's MCP server map (with $VAR refs, never literals) to _pi/mcp.json and sets
// PIFLOW_MCP_CONFIG to its ABSOLUTE in-sandbox path, plus the referenced secret env vars. On CLOUD
// providers (daytona/e2b) it forwards ONLY the referenced (allowlisted) vars — never the whole host env.

describe('runWorkflow — MCP config staging (_pi/mcp.json + PIFLOW_MCP_CONFIG + referenced-secret env)', () => {
  /**
   * A recording provider: captures the env handed to create() and every writeFile path+data, so a test
   * can prove what was staged and what env crossed into the sandbox. `kind` is parameterized so the same
   * harness exercises the local (full-passthrough) and cloud (allowlist) policies.
   */
  function recordingProvider(kind: 'inmemory' | 'daytona') {
    const writes: { path: string; data: string }[] = [];
    const createEnvs: (Record<string, string> | undefined)[] = [];
    const base = new InMemorySandboxProvider();
    const provider: SandboxProvider = {
      kind,
      async create(opts: CreateOpts): Promise<Sandbox> {
        createEnvs.push(opts.env);
        const sb = await base.create(opts);
        const orig = sb.writeFile.bind(sb);
        sb.writeFile = async (p: string, d: Uint8Array | string) => {
          writes.push({ path: p, data: typeof d === 'string' ? d : Buffer.from(d).toString('utf8') });
          return orig(p, d);
        };
        return sb;
      },
    };
    return { provider, writes, createEnvs };
  }

  /** Register an MCP tool so a node can actually select an `mcp.<server>:<tool>` address. */
  function mcpRegistry(server: string, tool: string): DefaultToolRegistry {
    const registry = new DefaultToolRegistry();
    for (const e of mcpToolsToEntries(server, [{ name: tool, description: `${tool} tool` }])) registry.register(e);
    return registry;
  }

  /** Register a gateway-coupled OpenClaw tool so a node can select an `oc.<plugin>:<tool>` address. */
  function ocRegistry(plugin: string, tool: string): DefaultToolRegistry {
    const registry = new DefaultToolRegistry();
    // git-source-pinned ref → the entry is gateway-coupled (routes through the bridge), like the real community catalog.
    for (const e of openClawPluginToEntries({ id: plugin, contracts: { tools: [tool] } }, { ref: `openclaw@1#extensions/${plugin}` })) {
      registry.register(e);
    }
    return registry;
  }

  const mcpConfig = {
    servers: {
      github: { transport: 'http', url: 'https://api.example.com/mcp', headers: { Authorization: 'Bearer $GH_TOKEN' } },
    },
  };

  it('stages _pi/mcp.json and injects PIFLOW_MCP_CONFIG (absolute) + the referenced secret into the node env (local)', async () => {
    const registry = mcpRegistry('github', 'create_issue');
    const g = compile(wf([n('Issue', [], ['out.txt'], { tools: { allow: ['fs:write', 'mcp.github:create_issue'] } })]));
    const outDir = await tmpOut();
    const { provider, writes, createEnvs } = recordingProvider('inmemory');

    // Make the referenced secret resolvable from the host env (local passthrough territory).
    process.env.GH_TOKEN = 'ghp_runner_secret';
    try {
      const { status } = await runWorkflow(g, {
        run: 'mcp-local',
        outDir,
        provider,
        registry,
        mcpConfig,
        buildCommand: stubBuilder(),
      });

      expect(status.nodes.issue.status).toBe('ok');

      // (1) the MCP config was staged VERBATIM at the node's per-node staging dir (_pi/<id>/mcp.json).
      const cfg = writes.find((w) => w.path === '_pi/issue/mcp.json');
      expect(cfg).toBeTruthy();
      expect(JSON.parse(cfg!.data)).toEqual(mcpConfig);

      // (2) PIFLOW_MCP_CONFIG is set to an ABSOLUTE path ending in the node's _pi/<id>/mcp.json, plus the secret.
      const env = createEnvs.find((e) => e && 'PIFLOW_MCP_CONFIG' in e);
      expect(env).toBeTruthy();
      expect(path.isAbsolute(env!.PIFLOW_MCP_CONFIG)).toBe(true);
      expect(env!.PIFLOW_MCP_CONFIG.endsWith('_pi/issue/mcp.json') || env!.PIFLOW_MCP_CONFIG.endsWith(path.join('_pi', 'issue', 'mcp.json'))).toBe(true);
      expect(env!.GH_TOKEN).toBe('ghp_runner_secret');
    } finally {
      delete process.env.GH_TOKEN;
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });

  it('does NOT write _pi/mcp.json for a node that selected NO mcp tools', async () => {
    // Builtin-only node: no extension, no mcp address → nothing MCP to stage even though mcpConfig is present.
    const g = compile(wf([n('Plain', [], ['out.txt'], { tools: { allow: ['fs:write'] } })]));
    const outDir = await tmpOut();
    const { provider, writes, createEnvs } = recordingProvider('inmemory');

    const { status } = await runWorkflow(g, { run: 'mcp-none', outDir, provider, mcpConfig, buildCommand: stubBuilder() });

    expect(status.nodes.plain.status).toBe('ok');
    expect(writes.find((w) => w.path.endsWith('mcp.json'))).toBeUndefined();
    // …and PIFLOW_MCP_CONFIG was NOT injected for a node with no MCP tools.
    expect(createEnvs.every((e) => !(e && 'PIFLOW_MCP_CONFIG' in e))).toBe(true);

    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('CLOUD allowlist: forwards ONLY the referenced var (+ PIFLOW_MCP_CONFIG), never the whole host process.env', async () => {
    const registry = mcpRegistry('github', 'create_issue');
    const g = compile(wf([n('Issue', [], ['out.txt'], { tools: { allow: ['fs:write', 'mcp.github:create_issue'] } })]));
    const outDir = await tmpOut();
    const { provider, writes, createEnvs } = recordingProvider('daytona');

    // A SENTINEL host secret that is NOT referenced by the config — it must NOT cross into the cloud env.
    process.env.GH_TOKEN = 'ghp_cloud_secret';
    process.env.UNRELATED_HOST_SECRET = 'do-not-leak-me';
    try {
      const { status } = await runWorkflow(g, {
        run: 'mcp-cloud',
        outDir,
        provider,
        registry,
        mcpConfig,
        buildCommand: stubBuilder(),
      });

      expect(status.nodes.issue.status).toBe('ok');
      expect(writes.find((w) => w.path === '_pi/issue/mcp.json')).toBeTruthy();

      const env = createEnvs.find((e) => e && 'PIFLOW_MCP_CONFIG' in e)!;
      expect(env).toBeTruthy();
      // The referenced var crossed; the unrelated host secret did NOT (allowlist, not passthrough).
      expect(env.GH_TOKEN).toBe('ghp_cloud_secret');
      expect(env).not.toHaveProperty('UNRELATED_HOST_SECRET');
      // Hard invariant: the host env was NOT spread wholesale into the cloud node env.
      expect(Object.keys(env).length).toBeLessThan(Object.keys(process.env).length);
      // Only the expected keys are present (whatever the node already carried + our two injections).
      expect(Object.keys(env).sort()).toEqual(['GH_TOKEN', 'PIFLOW_MCP_CONFIG']);
    } finally {
      delete process.env.GH_TOKEN;
      delete process.env.UNRELATED_HOST_SECRET;
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });

  it('stages _pi/mcp.json for an oc.* node (the OpenClaw gateway lane triggers staging just like mcp.)', async () => {
    // A node that selected ONLY an oc.* tool must stage the config (so the `openclaw` server reaches the
    // bridge in-child). Before the runner predicate accepted `oc.`, this node staged NOTHING and the
    // gateway was never configured → callTool would fail not-configured. This is the regression guard.
    const registry = ocRegistry('memory-core', 'memory_get');
    const g = compile(wf([n('Recall', [], ['out.txt'], { tools: { allow: ['oc.memory-core:memory_get'] } })]));
    const outDir = await tmpOut();
    const { provider, writes, createEnvs } = recordingProvider('inmemory');

    // The host supplies the OpenClaw gateway under the reserved `openclaw` server key, exactly like any MCP server.
    const ocMcpConfig = {
      servers: { openclaw: { transport: 'http', url: 'https://gw.example.com/mcp', headers: { Authorization: 'Bearer $OPENCLAW_TOKEN' } } },
    };
    process.env.OPENCLAW_TOKEN = 'ocp_runner_secret';
    try {
      const { status } = await runWorkflow(g, { run: 'oc-stage', outDir, provider, registry, mcpConfig: ocMcpConfig, buildCommand: stubBuilder() });

      expect(status.nodes.recall.status).toBe('ok');
      // the config was staged VERBATIM at the node's per-node staging dir (carries the openclaw server $VAR ref).
      const cfg = writes.find((w) => w.path === '_pi/recall/mcp.json');
      expect(cfg).toBeTruthy();
      expect(JSON.parse(cfg!.data)).toEqual(ocMcpConfig);
      // PIFLOW_MCP_CONFIG + the referenced secret were injected into the node env.
      const env = createEnvs.find((e) => e && 'PIFLOW_MCP_CONFIG' in e);
      expect(env).toBeTruthy();
      expect(env!.OPENCLAW_TOKEN).toBe('ocp_runner_secret');
    } finally {
      delete process.env.OPENCLAW_TOKEN;
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });

  // The staging-trigger predicate in isolation (the unit under the integration test above).
  it('selectedBridgedTool: true for mcp./oc. selections, false for builtins and for a denied bridge tool', () => {
    const node = (allow: string[], deny: string[] = []): NodeSpec =>
      ({ tools: { allow, deny } } as unknown as NodeSpec);
    expect(selectedBridgedTool(node(['oc.memory-core:memory_get']))).toBe(true);
    expect(selectedBridgedTool(node(['mcp.s:t']))).toBe(true);
    expect(selectedBridgedTool(node(['fs:read']))).toBe(false);
    // a bridge tool that is denied does NOT count as selected.
    expect(selectedBridgedTool(node(['oc.memory-core:memory_get'], ['oc.memory-core:memory_get']))).toBe(false);
    expect(selectedBridgedTool(node(['mcp.s:t'], ['mcp.s:t']))).toBe(false);
  });

  // ── SecretResolver seam: scoped-token / sealing broker (host mints a short-lived token per node) ──
  // With NO resolver the runner reads process.env (today's behavior). With one plugged, the MINTED value
  // is what crosses into the node env — the raw process.env value is NEVER injected — so the real
  // long-lived credential need never enter a cloud VM. The cloud allowlist still bounds what crosses.

  const ocMcpConfig = {
    servers: { openclaw: { transport: 'http', url: 'https://gw.example.com/mcp', headers: { Authorization: 'Bearer $OPENCLAW_TOKEN' } } },
  };

  it('DEFAULT resolver (none plugged): injects the raw $OPENCLAW_TOKEN from process.env (preserves today)', async () => {
    const registry = ocRegistry('memory-core', 'memory_get');
    const g = compile(wf([n('Recall', [], ['out.txt'], { tools: { allow: ['oc.memory-core:memory_get'] } })]));
    const outDir = await tmpOut();
    const { provider, createEnvs } = recordingProvider('inmemory');

    process.env.OPENCLAW_TOKEN = 'raw_host_secret';
    try {
      // No `secretResolver` ⇒ defaultSecretResolver ⇒ value comes straight from process.env.
      const { status } = await runWorkflow(g, { run: 'sr-default', outDir, provider, registry, mcpConfig: ocMcpConfig, buildCommand: stubBuilder() });

      expect(status.nodes.recall.status).toBe('ok');
      const env = createEnvs.find((e) => e && 'PIFLOW_MCP_CONFIG' in e);
      expect(env).toBeTruthy();
      expect(env!.OPENCLAW_TOKEN).toBe('raw_host_secret');
    } finally {
      delete process.env.OPENCLAW_TOKEN;
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });

  it('BROKER plugged: the MINTED scoped token wins over process.env, and the resolver gets { nodeId, isCloud }', async () => {
    const registry = ocRegistry('memory-core', 'memory_get');
    const g = compile(wf([n('Recall', [], ['out.txt'], { tools: { allow: ['oc.memory-core:memory_get'] } })]));
    const outDir = await tmpOut();
    const { provider, createEnvs } = recordingProvider('inmemory');

    // A DIFFERENT raw value lives in the host env — if the seam is wrong and process.env is read, this
    // (not the minted token) would cross, and the assertions below would fail.
    process.env.OPENCLAW_TOKEN = 'raw_host_secret_DO_NOT_USE';
    const calls: { varName: string; nodeId: string; isCloud: boolean }[] = [];
    const broker: SecretResolver = (varName, ctx) => {
      calls.push({ varName, nodeId: ctx.nodeId, isCloud: ctx.isCloud });
      return `scoped-${varName}-${ctx.nodeId}`;
    };
    try {
      const { status } = await runWorkflow(g, {
        run: 'sr-broker', outDir, provider, registry, mcpConfig: ocMcpConfig, secretResolver: broker, buildCommand: stubBuilder(),
      });

      expect(status.nodes.recall.status).toBe('ok');
      const env = createEnvs.find((e) => e && 'PIFLOW_MCP_CONFIG' in e);
      expect(env).toBeTruthy();
      // The MINTED token crossed; the raw host secret did NOT.
      expect(env!.OPENCLAW_TOKEN).toBe('scoped-OPENCLAW_TOKEN-recall');
      expect(env!.OPENCLAW_TOKEN).not.toBe(process.env.OPENCLAW_TOKEN);
      // The resolver was called once per referenced var with the correct context (inmemory ⇒ not cloud).
      expect(calls).toEqual([{ varName: 'OPENCLAW_TOKEN', nodeId: 'recall', isCloud: false }]);
    } finally {
      delete process.env.OPENCLAW_TOKEN;
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });

  it('BROKER + CLOUD: allowlist still holds — PIFLOW_MCP_CONFIG + the minted var only, no host-env leak', async () => {
    const registry = ocRegistry('memory-core', 'memory_get');
    const g = compile(wf([n('Recall', [], ['out.txt'], { tools: { allow: ['oc.memory-core:memory_get'] } })]));
    const outDir = await tmpOut();
    const { provider, createEnvs } = recordingProvider('daytona');

    // A non-referenced host secret that must NOT ride along into the cloud VM (allowlist, not passthrough).
    process.env.UNRELATED_HOST_SECRET = 'do-not-leak-me';
    const calls: { isCloud: boolean }[] = [];
    const broker: SecretResolver = (varName, ctx) => {
      calls.push({ isCloud: ctx.isCloud });
      return `scoped-${varName}-${ctx.nodeId}`;
    };
    try {
      const { status } = await runWorkflow(g, {
        run: 'sr-cloud', outDir, provider, registry, mcpConfig: ocMcpConfig, secretResolver: broker, buildCommand: stubBuilder(),
      });

      expect(status.nodes.recall.status).toBe('ok');
      const env = createEnvs.find((e) => e && 'PIFLOW_MCP_CONFIG' in e)!;
      expect(env).toBeTruthy();
      // The cloud broker was told it IS cloud (so it can mint cloud-scoped), and the minted var crossed…
      expect(calls).toEqual([{ isCloud: true }]);
      expect(env.OPENCLAW_TOKEN).toBe('scoped-OPENCLAW_TOKEN-recall');
      // …while the allowlist still dropped the unrelated host secret and never blasted the rest.
      expect(env).not.toHaveProperty('UNRELATED_HOST_SECRET');
      expect(Object.keys(env).sort()).toEqual(['OPENCLAW_TOKEN', 'PIFLOW_MCP_CONFIG']);
    } finally {
      delete process.env.UNRELATED_HOST_SECRET;
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });
});

// ── unified node contract: the schema gate, integrity checks, fill-sentinel, generalized handshake ─

describe('runWorkflow — post-node SCHEMA gate (DRIVER-SCHEMA / ArtifactReq.schema)', () => {
  // A deterministic injected validator (no ajv dependency): "speed" must be a number.
  const validate = (_schema: object, data: unknown): { ok: boolean; errors: string[] } => {
    const ok = typeof (data as { speed?: unknown }).speed === 'number';
    return { ok, errors: ok ? [] : ['/speed must be a number'] };
  };

  it('BLOCKS a present-but-schema-invalid artifact (driver-verified breach, beats the self-report)', async () => {
    const g = compile(wf([n('Make', [], [], { io: { reads: [], produces: ['a.json'], artifacts: [{ path: 'a.json', schema: 'schema.json' }] } })]));
    const outDir = await tmpOut();
    await fs.writeFile(path.join(outDir, 'schema.json'), '{}'); // present + readable; the injected validator decides

    // Writes a STRING speed → invalid; emits an "ok" return so only the schema gate can fail it.
    const builder = contentBuilder(() => ({ 'a.json': '{"speed":"fast"}' }), { emitReturn: true, status: 'ok' });
    const { status } = await runWorkflow(g, { run: 'schema-bad', outDir, buildCommand: builder, validateSchema: validate });

    expect(status.nodes.make.status).toBe('blocked');
    expect(status.nodes.make.issues.join(' ')).toMatch(/violate the declared schema/i);
    expect(status.nodes.make.schemaInvalid?.[0]).toMatchObject({ path: 'a.json' });
    expect(status.ok).toBe(false);
    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('passes a schema-VALID artifact', async () => {
    const g = compile(wf([n('Make', [], [], { io: { reads: [], produces: ['a.json'], artifacts: [{ path: 'a.json', schema: 'schema.json' }] } })]));
    const outDir = await tmpOut();
    await fs.writeFile(path.join(outDir, 'schema.json'), '{}');
    const builder = contentBuilder(() => ({ 'a.json': '{"speed":220}' }));
    const { status } = await runWorkflow(g, { run: 'schema-ok', outDir, buildCommand: builder, validateSchema: validate });
    expect(status.nodes.make.status).toBe('ok');
    expect(status.nodes.make.schemaChecked).toBe(1);
    await fs.rm(outDir, { recursive: true, force: true });
  });
});

describe('runWorkflow — DRIVER-FILL-SENTINEL completeness check', () => {
  it('BLOCKS a required artifact that STILL contains the fill sentinel (incomplete), passes a clean one', async () => {
    const node = (over = {}): NodeIntent => ({ label: 'Harden', prompt: 'harden', tools: {}, io: { reads: [], produces: ['spec.json'], artifacts: [{ path: 'spec.json' }], fillSentinel: '<FILL:' }, ...over });

    // (a) sentinel still present → blocked
    let outDir = await tmpOut();
    let { status } = await runWorkflow(compile(wf([node()])), { run: 'fill-bad', outDir, buildCommand: contentBuilder(() => ({ 'spec.json': '{"speed":"<FILL:number>"}' })) });
    expect(status.nodes.harden.status).toBe('blocked');
    expect(status.nodes.harden.issues.join(' ')).toMatch(/integrity check FAILED/i);
    await fs.rm(outDir, { recursive: true, force: true });

    // (b) sentinel resolved → ok
    outDir = await tmpOut();
    ({ status } = await runWorkflow(compile(wf([node()])), { run: 'fill-ok', outDir, buildCommand: contentBuilder(() => ({ 'spec.json': '{"speed":220}' })) }));
    expect(status.nodes.harden.status).toBe('ok');
    await fs.rm(outDir, { recursive: true, force: true });
  });
});

describe('runWorkflow — declarative integrity checks + verdict→action policy', () => {
  it('BLOCKS on a failing block-severity check (truncated fenced tail)', async () => {
    const node: NodeIntent = { label: 'Gdd', prompt: 'gdd', tools: {}, io: { reads: [], produces: ['gdd.md'], artifacts: [{ path: 'gdd.md' }], checks: [{ kind: 'fenced-tail', path: 'gdd.md', param: { minItems: 1 } }] } };
    const outDir = await tmpOut();
    // No fenced JSON tail at all → the fenced-tail check fails at block severity.
    const { status } = await runWorkflow(compile(wf([node])), { run: 'tail-bad', outDir, buildCommand: contentBuilder(() => ({ 'gdd.md': 'a design doc with no machine tail' })) });
    expect(status.nodes.gdd.status).toBe('blocked');
    expect(status.nodes.gdd.checks?.find((c) => c.kind === 'fenced-tail')?.verdict).toBe('fail');
    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('does NOT block when policy downgrades the failing check to a warn (detection ⊥ consequence)', async () => {
    const node: NodeIntent = { label: 'Gdd', prompt: 'gdd', tools: {}, io: { reads: [], produces: ['x.json'], artifacts: [{ path: 'x.json' }], checks: [{ kind: 'count-floor', path: 'x.json', param: { path: 'items', min: 5 } }], policy: { fail: 'warn' } } };
    const outDir = await tmpOut();
    // items has 1 (< 5) → the check fails, but policy maps fail→warn, so the node stays ok with a warn issue.
    const { status } = await runWorkflow(compile(wf([node])), { run: 'policy-warn', outDir, buildCommand: contentBuilder(() => ({ 'x.json': '{"items":[1]}' })) });
    expect(status.nodes.gdd.status).toBe('ok');
    expect(status.nodes.gdd.issues.join(' ')).toMatch(/integrity warn/i);
    await fs.rm(outDir, { recursive: true, force: true });
  });
});

describe('runWorkflow — generalized return handshake (the W1 fix)', () => {
  it('an artifact-backed node is OK even with NO return block (handshake is advisory when artifacts exist)', async () => {
    const g = compile(wf([n('Build', [], ['out.txt'])]));
    const outDir = await tmpOut();
    // Writes the artifact but emits NO return block.
    const { status } = await runWorkflow(g, { run: 'no-handshake-arts', outDir, buildCommand: contentBuilder(() => ({ 'out.txt': 'done' }), { emitReturn: false }) });
    expect(status.nodes.build.status).toBe('ok');
    expect(status.nodes.build.returnMode).toBe('optional');
    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('a ZERO-artifact gate node with NO return block is ERROR (handshake required when nothing else proves work)', async () => {
    const gate: NodeIntent = { label: 'Gate', prompt: 'gate', tools: {}, io: { reads: [], produces: [], artifacts: [] } };
    const outDir = await tmpOut();
    // No artifact, no return → the only proof-of-work is the handshake, which is required here.
    const { status } = await runWorkflow(compile(wf([gate])), { run: 'gate-no-ret', outDir, buildCommand: contentBuilder(() => ({}), { emitReturn: false }) });
    expect(status.nodes.gate.status).toBe('error');
    expect(status.nodes.gate.returnMode).toBe('required');
    expect(status.nodes.gate.issues.join(' ')).toMatch(/return:required/i);
    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('the same zero-artifact gate node is OK when it DOES emit a return block', async () => {
    const gate: NodeIntent = { label: 'Gate', prompt: 'gate', tools: {}, io: { reads: [], produces: [], artifacts: [] } };
    const outDir = await tmpOut();
    const { status } = await runWorkflow(compile(wf([gate])), { run: 'gate-ret', outDir, buildCommand: contentBuilder(() => ({}), { emitReturn: true, status: 'ok' }) });
    expect(status.nodes.gate.status).toBe('ok');
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
