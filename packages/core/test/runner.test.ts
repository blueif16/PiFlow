import { describe, it, expect } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile, InMemorySandboxProvider, LocalSandboxProvider, DefaultToolRegistry, mcpToolsToEntries, openClawPluginToEntries } from '../src/index.js';
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
import { runJsonFile, stateFile, piDir } from '../src/runner/layout.js';

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

    // the canonical .pi/run.json written with the right shape (D7 layout).
    const onDisk = JSON.parse(await fs.readFile(runJsonFile(outDir), 'utf8'));
    expect(onDisk).toMatchObject({ run: 'e2e', done: true, ok: true, totals: { nodes: 3, ok: 3, failed: 0 } });
    expect(onDisk.startedAt).toBeTruthy();
    expect(onDisk.nodes.gamma.artifacts[0]).toMatchObject({ path: 'gamma.txt', exists: true });

    await fs.rm(outDir, { recursive: true, force: true });
  });
});

// ── 1b. concurrent collect into a SHARED dest subtree (the swallowed-EEXIST footgun) ───────────────
//   Two parallel nodes whose outputs land under a SHARED subdir (shared/a.txt, shared/b.txt) race in
//   the per-node `downloadDir` recursive copy on creating the common `shared/` dir; one copy throws
//   EEXIST. Pre-fix that error was swallowed → the file never landed → a MISLEADING "required artifact
//   missing" though the command exited 0. The fix serializes the runner's collect step (a collect
//   mutex) so the two copies never overlap. See fix(core) commit + fusion's disjoint-dir workaround.

describe('runWorkflow — concurrent collect into a shared dest subtree (parallel-safe collection)', () => {
  /**
   * A provider whose `downloadDir` DETERMINISTICALLY reproduces the production race: a timeout-barrier
   * makes two lanes that enter `downloadDir` within a short window perform their recursive copies
   * SIMULTANEOUSLY (so the shared-subdir `mkdir` collides → EEXIST, exactly as `fs.cp` does in prod).
   * A lone lane (the runner serialized the collect) waits out the tiny timeout, then copies cleanly —
   * the barrier NEVER deadlocks under serialization (it is timeout-bounded, not a 2-party hard barrier).
   * This pins the runner's CONTRACT (collect is serialized), not an `fs.cp` timing accident.
   */
  function collidingProvider(windowMs = 50) {
    const base = new InMemorySandboxProvider();
    let parked: (() => void) | null = null; // a lane currently waiting at the barrier
    const rendezvous = async (): Promise<void> => {
      if (parked) { parked(); parked = null; return; } // a partner is here → release BOTH to copy together
      await new Promise<void>((resolve) => {
        parked = resolve;
        setTimeout(() => { if (parked === resolve) { parked = null; resolve(); } }, windowMs);
      });
    };
    const provider: SandboxProvider = {
      kind: 'inmemory',
      async create(opts: CreateOpts): Promise<Sandbox> {
        const sb = await base.create(opts);
        const orig = sb.downloadDir.bind(sb);
        sb.downloadDir = async (remote: string, local: string): Promise<void> => {
          await rendezvous();        // two concurrent collects copy at the SAME instant (the prod race)
          return orig(remote, local); // the REAL recursive fs.cp — collides iff overlapped
        };
        return sb;
      },
    };
    return provider;
  }

  it('does NOT lose a file when two PARALLEL nodes collect into a SHARED subdir (both survive, both ok)', async () => {
    // A and B have no deps → ONE parallel stage; each writes a DISTINCT artifact under shared/.
    const g = compile(wf([n('A', [], ['shared/a.txt']), n('B', [], ['shared/b.txt'])]));
    expect(g.stages[0]).toMatchObject({ parallel: true, nodeIds: ['a', 'b'] });
    const outDir = await tmpOut();

    const { status } = await runWorkflow(g, {
      run: 'collide', outDir, provider: collidingProvider(), buildCommand: stubBuilder(),
    });

    // BOTH nodes finish ok — pre-fix, the lane whose copy lost the EEXIST race was marked a MISLEADING
    // 'blocked' ("required artifact missing") though its stub command exited 0.
    expect(status.nodes.a.status).toBe('ok');
    expect(status.nodes.b.status).toBe('ok');
    // …and BOTH files physically survive in the run root (the file the swallowed copy used to drop).
    expect(await fs.readFile(path.join(outDir, 'shared', 'a.txt'), 'utf8')).toBe('a');
    expect(await fs.readFile(path.join(outDir, 'shared', 'b.txt'), 'utf8')).toBe('b');
    expect(status.ok).toBe(true);

    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('SURFACES a genuine collection failure on the node status (issues), never swallows it silently', async () => {
    // A provider whose downloadDir throws a REAL fs failure (not an absent dir) for one node.
    const base = new InMemorySandboxProvider();
    const provider: SandboxProvider = {
      kind: 'inmemory',
      async create(opts: CreateOpts): Promise<Sandbox> {
        const sb = await base.create(opts);
        sb.downloadDir = async (): Promise<void> => {
          throw new Error('ENOSPC: simulated disk-full during collect');
        };
        return sb;
      },
    };
    const g = compile(wf([n('Solo', [], ['out.txt'])]));
    const outDir = await tmpOut();

    const { status } = await runWorkflow(g, { run: 'collect-err', outDir, provider, buildCommand: stubBuilder() });

    // The node exited 0 but its artifact never landed → blocked. The blocked reason MUST carry the real
    // collection-failure text (pre-fix the bare `catch {}` discarded it → an undiagnosable 'missing').
    expect(status.nodes.solo.status).toBe('blocked');
    expect(status.nodes.solo.issues.join(' ')).toMatch(/collect|ENOSPC|disk-full/i);
    expect(status.ok).toBe(false);

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

  it('PRESERVES reused nodes\' prior records and ACCUMULATES the run clock across a rerun (does not reset to the rerun window)', async () => {
    const g = compile(wf([n('Stage1', [], ['s1.txt']), n('Stage2', ['s1.txt'], ['s2.txt'])]));
    const outDir = await tmpOut();

    // RUN 1 — full run; Stage1 takes a measurable ~200ms so it carries a real prior durationMs the
    // rerun must preserve (and carry into the run-level clock baseline).
    const slowStage1 = (node: { id: string; io: { artifacts: { path: string }[] }; sandbox: { output: string } }): string => {
      const base = stubBuilder()(node);
      return node.id === 'stage1' ? `sleep 0.2 && ${base}` : base;
    };
    const r1 = await runWorkflow(g, { run: 'rerun-clock', outDir, buildCommand: slowStage1 });
    expect(r1.status.nodes.stage1.status).toBe('ok');
    const priorS1Dur = r1.status.nodes.stage1.durationMs!;
    const priorS1Start = r1.status.nodes.stage1.startedAt!;
    expect(priorS1Dur).toBeGreaterThanOrEqual(120); // the sleep is really recorded on the prior run

    // RUN 2 — rerun FROM Stage2 (Stage1 pinned-reused; noResume forces Stage2 to actually re-execute).
    let stage2Reran = false;
    const r2Builder = (node: { id: string; io: { artifacts: { path: string }[] }; sandbox: { output: string } }): string => {
      if (node.id === 'stage2') stage2Reran = true;
      return stubBuilder()(node);
    };
    const r2 = await runWorkflow(g, { run: 'rerun-clock', outDir, from: 'stage2', noResume: true, buildCommand: r2Builder });

    // Stage2 actually re-ran; Stage1 was reused (the rerun started at the earliest redone node).
    expect(stage2Reran).toBe(true);
    expect(r2.status.nodes.stage2.status).toBe('ok');
    expect(r2.status.nodes.stage1.status).toBe('reused');

    // PRESERVED: the reused node keeps its PRIOR record (duration + start) verbatim — not blanked.
    expect(r2.status.nodes.stage1.durationMs).toBe(priorS1Dur);
    expect(r2.status.nodes.stage1.startedAt).toBe(priorS1Start);

    // ACCUMULATED: the run clock carries the reused prefix's time (baseline ≥ Stage1's prior duration)
    // instead of resetting to only the (fast) Stage2 rerun window — both in-memory and on disk (what
    // every viewer reads via run.json).
    expect(r2.status.durationMs!).toBeGreaterThanOrEqual(priorS1Dur);
    const onDisk = JSON.parse(await fs.readFile(runJsonFile(outDir), 'utf8'));
    expect(onDisk.durationMs).toBeGreaterThanOrEqual(priorS1Dur);

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

// ── G1 per-node model routing (the runner threads the effective model into the command ctx) ──────────

describe('per-node model routing (G1)', () => {
  it('routes a per-node model into the command context; a node without one inherits the run default', async () => {
    const g = compile(wf([
      n('Router', [], ['r.txt'], { model: 'm-node' }),
      n('Plain', [], ['p.txt']),
    ]));
    const seen: Record<string, { model?: string; provider?: string }> = {};
    // A builder that RECORDS the ctx it was handed, then still writes the artifacts (clean run).
    const recording = (node: NodeSpec, resolved: any, ctx: { model?: string; provider?: string }) => {
      seen[node.id] = { model: ctx.model, provider: ctx.provider };
      return stubBuilder()(node);
    };
    const outDir = await tmpOut();
    const { status } = await runWorkflow(g, {
      run: 'g1', outDir, buildCommand: recording, model: 'm-run', providerName: 'cp',
    });
    expect(seen.router.model).toBe('m-node'); // the node override wins
    expect(seen.plain.model).toBe('m-run');   // no node model ⇒ the run-level default
    // a fake id is in no models.json, so provider falls back to the run default for both
    expect(seen.router.provider).toBe('cp');
    // the EFFECTIVE model is recorded on the status record (observability)
    expect(status.nodes.router.model).toBe('m-node');
    expect(status.nodes.plain.model).toBe('m-run');
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

// ── S1: token resolution at node launch — {{arg.*}}/{{WORKSPACE}}/{{RUN}} made physical in the prompt ─

describe('runWorkflow — prompt token resolution at node launch (S1)', () => {
  /** A recording provider that captures every writeFile (so a test can inspect the STAGED prompt bytes). */
  function recorder(): { provider: SandboxProvider; writes: { path: string; data: string }[] } {
    const writes: { path: string; data: string }[] = [];
    const base = new InMemorySandboxProvider();
    const provider: SandboxProvider = {
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
    return { provider, writes };
  }

  it('resolves {{arg.*}} and {{WORKSPACE}}/{{RUN}} in the prompt BEFORE staging it on disk', async () => {
    // The prompt prose carries logical tokens (exactly like w0-classify/prompt.md's {{arg.prompt}}).
    const node: NodeIntent = {
      label: 'Classify',
      prompt: 'Build: {{arg.prompt}} | canon={{WORKSPACE}}/skills | out={{RUN}}/spec',
      tools: {},
      io: { reads: [], produces: ['s.txt'], artifacts: [{ path: 's.txt' }] },
    };
    const outDir = await tmpOut();
    const { provider, writes } = recorder();

    const { status } = await runWorkflow(compile(wf([node])), {
      run: 'argres',
      outDir,
      provider,
      buildCommand: stubBuilder(),
      args: { prompt: 'a fast platformer' },
      workspace: '/canon-root',
    });
    expect(status.nodes.classify.status).toBe('ok');

    const staged = writes.find((w) => w.path === '_pi/classify/prompt.md')!;
    expect(staged).toBeTruthy();
    // The tokens are PHYSICAL on disk — not the verbatim {{…}} the pre-S1 runner staged.
    expect(staged.data).toContain('Build: a fast platformer');
    expect(staged.data).toContain('canon=/canon-root/skills');
    expect(staged.data).toContain(`out=${outDir}/spec`); // {{RUN}} resolves to outDir
    expect(staged.data).not.toContain('{{arg.prompt}}');
    expect(staged.data).not.toContain('{{WORKSPACE}}');

    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('a missing {{arg.*}} fails the node loudly (MissingArgError) — never a silent unresolved prompt', async () => {
    const node: NodeIntent = {
      label: 'Need',
      prompt: 'requires {{arg.absent}}',
      tools: {},
      io: { reads: [], produces: ['s.txt'], artifacts: [{ path: 's.txt' }] },
    };
    const outDir = await tmpOut();
    // No `args` supplied → the {{arg.absent}} token cannot resolve.
    const { status } = await runWorkflow(compile(wf([node])), { run: 'argmiss', outDir, buildCommand: stubBuilder() });
    expect(status.nodes.need.status).toBe('error');
    expect(status.nodes.need.issues.join(' ')).toMatch(/absent/);
    expect(status.ok).toBe(false);

    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('a prompt with NO tokens is staged byte-identical (additive — non-token prompts unchanged)', async () => {
    const outDir = await tmpOut();
    const { provider, writes } = recorder();
    await runWorkflow(compile(wf([n('Plain', [], ['p.txt'])])), { run: 'plain-res', outDir, provider, buildCommand: stubBuilder() });
    const staged = writes.find((w) => w.path === '_pi/plain/prompt.md')!;
    // 'do Plain' prose survives intact (the markers tail still appends, as before).
    expect(staged.data).toContain('do Plain');
    await fs.rm(outDir, { recursive: true, force: true });
  });
});

// ── S2: the seed PRE op — a node's starting artifact is staged (host + sandbox) BEFORE the model runs ─

describe('runWorkflow — seed PRE op staging (S2)', () => {
  function recorder(): { provider: SandboxProvider; writes: { path: string; data: string }[] } {
    const writes: { path: string; data: string }[] = [];
    const base = new InMemorySandboxProvider();
    const provider: SandboxProvider = {
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
    return { provider, writes };
  }

  it('stages a {to,from} seed onto the host run dir AND into the sandbox before exec', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-ws-'));
    await fs.mkdir(path.join(workspace, 'tpl'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'tpl', 'skeleton.json'), '{"seed":"shape"}');
    const outDir = await tmpOut();
    const { provider, writes } = recorder();

    // The node declares a seed via ops (as the template loader carries it).
    const node: NodeIntent = {
      label: 'Scaffold',
      prompt: 'fill the skeleton',
      tools: {},
      io: { reads: [], produces: ['out.txt'], artifacts: [{ path: 'out.txt' }] },
      ops: { seed: [{ to: 'spec/skeleton.json', from: '{{WORKSPACE}}/tpl/skeleton.json' }] },
    };

    let cmdSawSeed = false;
    // The builder runs AFTER staging; by then the seed must already be on the host run dir.
    const builder = (nd: { id: string; io: { artifacts: { path: string }[] }; sandbox: { output: string } }): string => {
      cmdSawSeed = existsSync(path.join(outDir, 'spec', 'skeleton.json'));
      const a = nd.io.artifacts[0].path;
      return `mkdir -p ${nd.sandbox.output} && printf '%s' done > ${nd.sandbox.output}/${a}`;
    };

    const { status } = await runWorkflow(compile(wf([node])), { run: 'seedrun', outDir, provider, workspace, buildCommand: builder });
    expect(status.nodes.scaffold.status).toBe('ok');

    // (1) host run dir: the seed bytes landed at ${RUN}/spec/skeleton.json.
    expect(await fs.readFile(path.join(outDir, 'spec', 'skeleton.json'), 'utf8')).toBe('{"seed":"shape"}');
    // (2) it was staged INTO the sandbox (so the model can read it) BEFORE the command ran.
    const staged = writes.find((w) => w.path === 'spec/skeleton.json');
    expect(staged?.data).toBe('{"seed":"shape"}');
    // (3) and it was physically present on disk by the time the command was built.
    expect(cmdSawSeed).toBe(true);

    await fs.rm(outDir, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('a node with NO seed ops runs exactly as before (additive)', async () => {
    const outDir = await tmpOut();
    const { status } = await runWorkflow(compile(wf([n('Plain', [], ['p.txt'])])), { run: 'noseed', outDir, buildCommand: stubBuilder() });
    expect(status.nodes.plain.status).toBe('ok');
    await fs.rm(outDir, { recursive: true, force: true });
  });
});

// ── S3: promote + barrier-merge + state I/O — a node lifts an output into a RunState channel; the driver ─
//        merges every parallel lane's promote SERIALLY at the stage barrier, persists once, and the next
//        stage resolves {{state.*}} against the merged state.

describe('runWorkflow — promote + barrier-merge + state I/O (S3)', () => {
  // A builder that writes an artifact carrying a JSON field the node promotes (an ARTIFACT-source promote).
  function jsonArtifactBuilder(contents: (id: string) => Record<string, string>) {
    return (node: { id: string; sandbox: { output: string } }): string => {
      const out = node.sandbox.output;
      const writes = Object.entries(contents(node.id))
        .map(([p, c]) => {
          const dest = `${out}/${p}`;
          const dir = dest.slice(0, dest.lastIndexOf('/'));
          return `mkdir -p ${dir} && printf '%s' '${c}' > ${dest}`;
        })
        .join(' && ');
      return `${writes} && printf '%s' '\`\`\`json\\n{"status":"ok"}\\n\`\`\`'`;
    };
  }

  it('promotes a channel to ${RUN}/.pi/state.json and a downstream node resolves {{state.x}} from it', async () => {
    // w0 promotes archetype (from its artifact) → state; a downstream node's prompt reads {{state.archetype}}.
    const classify: NodeIntent = {
      label: 'Classify',
      prompt: 'classify',
      tools: {},
      io: { reads: [], produces: ['spec/classification.json'], artifacts: [{ path: 'spec/classification.json' }] },
      ops: { promote: [{ from: 'spec/classification.json:archetype', to: 'archetype', merge: 'set' }] },
    };
    const build: NodeIntent = {
      label: 'Build',
      prompt: 'build for {{state.archetype}}',
      tools: {},
      io: { reads: ['spec/classification.json'], produces: ['out.txt'], artifacts: [{ path: 'out.txt' }] },
    };
    const outDir = await tmpOut();
    const { provider, writes } = (() => {
      const w: { path: string; data: string }[] = [];
      const base = new InMemorySandboxProvider();
      const p: SandboxProvider = {
        kind: 'inmemory',
        async create(opts: CreateOpts): Promise<Sandbox> {
          const sb = await base.create(opts);
          const orig = sb.writeFile.bind(sb);
          sb.writeFile = async (pp: string, d: Uint8Array | string) => {
            w.push({ path: pp, data: typeof d === 'string' ? d : Buffer.from(d).toString('utf8') });
            return orig(pp, d);
          };
          return sb;
        },
      };
      return { provider: p, writes: w };
    })();

    const { status } = await runWorkflow(compile(wf([classify, build])), {
      run: 'promote',
      outDir,
      provider,
      buildCommand: jsonArtifactBuilder((id) => (id === 'classify' ? { 'spec/classification.json': '{"archetype":"platformer"}' } : { 'out.txt': 'built' })),
    });

    expect(status.nodes.classify.status).toBe('ok');
    expect(status.nodes.build.status).toBe('ok');

    // (1) state.json holds the promoted channel.
    const state = JSON.parse(await fs.readFile(stateFile(outDir), 'utf8'));
    expect(state.archetype).toBe('platformer');

    // (2) the downstream prompt resolved {{state.archetype}} to the promoted value (physical on disk).
    const buildPrompt = writes.find((x) => x.path === '_pi/build/prompt.md')!;
    expect(buildPrompt.data).toContain('build for platformer');
    expect(buildPrompt.data).not.toContain('{{state.archetype}}');

    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('barrier-merges two PARALLEL lanes that each promote a DIFFERENT channel (both land, persisted once)', async () => {
    // Two independent producers (one parallel stage), each promoting its own channel.
    const a: NodeIntent = {
      label: 'A', prompt: 'a', tools: {},
      io: { reads: [], produces: ['a.json'], artifacts: [{ path: 'a.json' }] },
      ops: { promote: [{ from: 'a.json:k', to: 'alpha', merge: 'set' }] },
    };
    const b: NodeIntent = {
      label: 'B', prompt: 'b', tools: {},
      io: { reads: [], produces: ['b.json'], artifacts: [{ path: 'b.json' }] },
      ops: { promote: [{ from: 'b.json:k', to: 'beta', merge: 'set' }] },
    };
    const outDir = await tmpOut();
    const { status } = await runWorkflow(compile(wf([a, b])), {
      run: 'barrier',
      outDir,
      buildCommand: jsonArtifactBuilder((id) => (id === 'a' ? { 'a.json': '{"k":"AA"}' } : { 'b.json': '{"k":"BB"}' })),
    });
    expect(status.ok).toBe(true);
    const state = JSON.parse(await fs.readFile(stateFile(outDir), 'utf8'));
    expect(state).toMatchObject({ alpha: 'AA', beta: 'BB' });
    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('a SET channel promoted by TWO parallel lanes is a ConflictError (the run fails loudly)', async () => {
    // Both parallel lanes promote the SAME 'shared' channel under the default 'set' reducer → a conflict.
    const a: NodeIntent = {
      label: 'A', prompt: 'a', tools: {},
      io: { reads: [], produces: ['a.json'], artifacts: [{ path: 'a.json' }] },
      ops: { promote: [{ from: 'a.json:k', to: 'shared', merge: 'set' }] },
    };
    const b: NodeIntent = {
      label: 'B', prompt: 'b', tools: {},
      io: { reads: [], produces: ['b.json'], artifacts: [{ path: 'b.json' }] },
      ops: { promote: [{ from: 'b.json:k', to: 'shared', merge: 'set' }] },
    };
    const outDir = await tmpOut();
    const { status } = await runWorkflow(compile(wf([a, b])), {
      run: 'conflict',
      outDir,
      buildCommand: jsonArtifactBuilder((id) => (id === 'a' ? { 'a.json': '{"k":"AA"}' } : { 'b.json': '{"k":"BB"}' })),
    });
    expect(status.ok).toBe(false);
    expect(JSON.stringify(status.nodes)).toMatch(/conflict|concurrent/i);
    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('promotes from the STRUCTURED @return (lastJsonBlock widened to carry arbitrary fields)', async () => {
    // A zero-artifact-promote-source node that promotes a field from its @return JSON (not an artifact).
    const gate: NodeIntent = {
      label: 'Decide', prompt: 'decide', tools: {},
      io: { reads: [], produces: ['d.txt'], artifacts: [{ path: 'd.txt' }] },
      ops: { promote: [{ from: '@return:verdict', to: 'verdict', merge: 'set' }] },
    };
    const outDir = await tmpOut();
    // The stub writes the artifact AND emits a fenced return carrying an extra `verdict` field.
    const builder = (node: { sandbox: { output: string } }): string =>
      `mkdir -p ${node.sandbox.output} && printf '%s' x > ${node.sandbox.output}/d.txt && ` +
      `printf '%s' '\`\`\`json\\n{"status":"ok","verdict":"DESIGN_PASSED"}\\n\`\`\`'`;
    const { status } = await runWorkflow(compile(wf([gate])), { run: 'atreturn', outDir, buildCommand: builder });
    expect(status.nodes.decide.status).toBe('ok');
    const state = JSON.parse(await fs.readFile(stateFile(outDir), 'utf8'));
    expect(state.verdict).toBe('DESIGN_PASSED');
    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('loads PRE-EXISTING state at run start (a {{state.*}} from a prior run resolves on the first node)', async () => {
    // Pre-seed state.json (as a prior run's barrier would have) → the first node's prompt reads it.
    const outDir = await tmpOut();
    await fs.mkdir(piDir(outDir), { recursive: true });
    await fs.writeFile(stateFile(outDir), JSON.stringify({ archetype: 'voxel' }));
    const node: NodeIntent = { label: 'Use', prompt: 'use {{state.archetype}}', tools: {}, io: { reads: [], produces: ['u.txt'], artifacts: [{ path: 'u.txt' }] } };
    const { provider, writes } = (() => {
      const w: { path: string; data: string }[] = [];
      const base = new InMemorySandboxProvider();
      const p: SandboxProvider = { kind: 'inmemory', async create(opts: CreateOpts): Promise<Sandbox> { const sb = await base.create(opts); const orig = sb.writeFile.bind(sb); sb.writeFile = async (pp: string, d: Uint8Array | string) => { w.push({ path: pp, data: typeof d === 'string' ? d : Buffer.from(d).toString('utf8') }); return orig(pp, d); }; return sb; } };
      return { provider: p, writes: w };
    })();
    const { status } = await runWorkflow(compile(wf([node])), { run: 'preload', outDir, provider, buildCommand: stubBuilder() });
    expect(status.nodes.use.status).toBe('ok');
    expect(writes.find((x) => x.path === '_pi/use/prompt.md')!.data).toContain('use voxel');
    await fs.rm(outDir, { recursive: true, force: true });
  });
});

// ── S4: a merge `run` op that PRODUCES the node's required artifact (the asset gen-hook shape) ─────
//    The DERIVE families (project/registryProject/merge) must run BEFORE the artifact-existence gate,
//    exactly as the canonical run.mjs does ("strictly BEFORE the artifact/schema gates below verify
//    them"). Otherwise a node whose REQUIRED artifact is generated by its own merge `run` op deadlocks:
//    verify-first sees it missing → blocked → the merge op (gated on st==='ok') never runs → never
//    produced. This is the live asset-node failure (asset-prompts.json written by the model, but the
//    REQUIRED public/assets/asset-manifest.json produced by the gen `run` hook).

describe('runWorkflow — merge run-op PRODUCES a required artifact (derive-before-verify, S4)', () => {
  it('runs the merge `run` op that GENERATES the required artifact, then verifies ok (NOT blocked)', async () => {
    const node: NodeIntent = {
      label: 'Asset',
      prompt: 'author prompts',
      tools: {},
      // TWO required artifacts: the model writes the first; the merge `run` op generates the second.
      io: {
        reads: [],
        produces: ['asset-prompts.json', 'derived/manifest.json'],
        artifacts: [{ path: 'asset-prompts.json' }, { path: 'derived/manifest.json' }],
      },
      // the gen hook: a deterministic `run` op that writes the REQUIRED manifest under {project}.
      ops: {
        merge: {
          ops: [
            { run: { cmd: 'sh', args: ['-c', 'mkdir -p {project}/derived && printf %s generated > {project}/derived/manifest.json'] } },
          ],
        },
      },
    };
    const outDir = await tmpOut();
    // The node's OWN command writes ONLY asset-prompts.json — NOT the manifest (the merge op does that).
    const builder = stubBuilder((nd) => (nd.id === 'asset' ? ['asset-prompts.json'] : []));

    const { status } = await runWorkflow(compile(wf([node])), { run: 's4-merge-produce', outDir, buildCommand: builder });

    // THE load-bearing assertion: the merge op produced the required artifact BEFORE verification, so ok.
    expect(status.nodes.asset.status).toBe('ok');
    expect(status.nodes.asset.artifacts).toEqual([
      { path: 'asset-prompts.json', exists: true, bytes: 'asset'.length },
      { path: 'derived/manifest.json', exists: true, bytes: 'generated'.length },
    ]);
    expect(await fs.readFile(path.join(outDir, 'derived', 'manifest.json'), 'utf8')).toBe('generated');
    expect(status.ok).toBe(true);

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
    const onDisk = JSON.parse(await fs.readFile(runJsonFile(outDir), 'utf8'));
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
    const file = runJsonFile(dir);
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

  // ── the writer re-point: writeStatus publishes the CANONICAL `.pi/run.json` (D7 layout) ───────────
  // The status is the SINGLE source of truth the observe pipeline (readRunModel/watchRun) + the cli/tui
  // consumers poll — and they read the engine-owned `.pi/run.json` via runJsonFile(), NEVER the legacy
  // `run-status.json`. So the writer must publish THERE.
  it('publishes to <dir>/.pi/run.json (runJsonFile), parseable to the RunStatus shape', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-repoint-'));
    const status: RunStatus = {
      run: 'rp', startedAt: 'x', updatedAt: 'x', done: true, ok: true, durationMs: 5,
      stage: null, totals: { nodes: 1, ok: 1, failed: 0 },
      nodes: { a: { id: 'a', label: 'A', status: 'ok', artifacts: [], issues: [] } },
    };
    await writeStatus(dir, status);

    // It lands at the CANONICAL .pi/run.json path (the consumers' read surface), parseable.
    const onDisk = JSON.parse(await fs.readFile(runJsonFile(dir), 'utf8'));
    expect(onDisk).toMatchObject({ run: 'rp', done: true, ok: true, totals: { nodes: 1, ok: 1, failed: 0 } });
    expect(onDisk.nodes.a.id).toBe('a');
    // And NOT at the legacy run-status.json path (that surface is retired in @piflow/core).
    await expect(fs.access(path.join(dir, 'run-status.json'))).rejects.toThrow();

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

// ── S4: project/merge POST DERIVE ops — the discriminated DRIVER-MERGE grammar (fold|concat|reconcile|run)
//        wired into runNode POST, ordered project → merge → promote. Stub exec + in-memory provider; the
//        executor REACHED is proven by its on-disk effect (bypass the wiring ⇒ the effect is absent ⇒ RED).

describe('runWorkflow — project/merge POST DERIVE ops (S4)', () => {
  // A builder that writes EXACT file contents (JSON or text) into the node's sandbox output dir, then a
  // return fence. Reused shape from contentBuilder, but single-quote-safe JSON via base64 is overkill —
  // the contents here are single-quote-free.
  function filesBuilder(files: (id: string) => Record<string, string>) {
    return (node: { id: string; sandbox: { output: string } }): string => {
      const out = node.sandbox.output;
      const writes = Object.entries(files(node.id))
        .map(([p, c]) => {
          const dest = `${out}/${p}`;
          const dir = dest.slice(0, dest.lastIndexOf('/'));
          return `mkdir -p ${dir} && printf '%s' '${c}' > ${dest}`;
        })
        .join(' && ');
      return `${writes} && printf '%s' '\`\`\`json\\n{"status":"ok"}\\n\`\`\`'`;
    };
  }

  it('a `fold` merge op SETS blueprint[into] = the fragment (siblings intact) — the executor is REACHED', async () => {
    // The node authors spec/shell.fragment.json AND a base spec/blueprint.json with a STALE shell + a meta
    // sibling; its merge fold op must overwrite blueprint.shell with the fragment and leave meta untouched.
    const node: NodeIntent = {
      label: 'Shell',
      prompt: 'author the shell fragment',
      tools: {},
      io: { reads: [], produces: ['spec/shell.fragment.json'], artifacts: [{ path: 'spec/shell.fragment.json' }] },
      ops: { merge: { ops: [{ fold: { from: 'spec/shell.fragment.json', to: 'spec/blueprint.json', into: 'shell' } }] } },
    };
    const outDir = await tmpOut();
    const { status } = await runWorkflow(compile(wf([node])), {
      run: 'fold',
      outDir,
      buildCommand: filesBuilder(() => ({
        'spec/shell.fragment.json': '{"hud":["score"],"intro":"go"}',
        'spec/blueprint.json': '{"meta":{"x":1},"shell":{"STALE":true}}',
      })),
    });
    expect(status.nodes.shell.status).toBe('ok');
    const bp = JSON.parse(await fs.readFile(path.join(outDir, 'spec', 'blueprint.json'), 'utf8'));
    // REACHED: blueprint.shell is the FRAGMENT (not the stale value), and the sibling survived. If the merge
    // wiring were bypassed, blueprint.shell would still be {STALE:true} → this assertion goes RED.
    expect(bp.shell).toEqual({ hud: ['score'], intro: 'go' });
    expect(bp.meta).toEqual({ x: 1 });
    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('a `concat` merge op concatenates the glob set into one file, each under a heading', async () => {
    const node: NodeIntent = {
      label: 'Scaffold',
      prompt: 'write memory fragments',
      tools: {},
      io: { reads: [], produces: ['MEMORY.a.md', 'MEMORY.b.md'], artifacts: [{ path: 'MEMORY.a.md' }, { path: 'MEMORY.b.md' }] },
      ops: { merge: { ops: [{ concat: { glob: 'MEMORY.*.md', to: 'MEMORY.md', heading: '## {name}' } }] } },
    };
    const outDir = await tmpOut();
    const { status } = await runWorkflow(compile(wf([node])), {
      run: 'concat',
      outDir,
      buildCommand: filesBuilder(() => ({ 'MEMORY.a.md': 'A body', 'MEMORY.b.md': 'B body' })),
    });
    expect(status.nodes.scaffold.status).toBe('ok');
    // Concatenated, stable lexical order, each under its heading, dest excluded.
    expect(await fs.readFile(path.join(outDir, 'MEMORY.md'), 'utf8')).toBe(
      '## MEMORY.a.md\n\nA body\n\n## MEMORY.b.md\n\nB body\n',
    );
    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('resolves {{WORKSPACE}}/{{RUN}} tokens in a `run` merge op before the executor runs', async () => {
    // A run op whose cmd path tokens must be made physical by the per-node resolver ctx (not the executor's
    // own {project} token). The node script reads {{RUN}}/marker.txt (proving {{RUN}} resolved) + a script at
    // {{WORKSPACE}}/scripts/derive.js (proving {{WORKSPACE}} resolved) and writes a receipt.
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-ws4-'));
    await fs.mkdir(path.join(workspace, 'scripts'), { recursive: true });
    await fs.writeFile(
      path.join(workspace, 'scripts', 'derive.js'),
      `const fs=require('fs');const run=process.argv[2];fs.writeFileSync(run+'/receipt.txt','derived from '+fs.readFileSync(run+'/marker.txt','utf8'));`,
    );
    const node: NodeIntent = {
      label: 'Derive',
      prompt: 'author the marker',
      tools: {},
      io: { reads: [], produces: ['marker.txt'], artifacts: [{ path: 'marker.txt' }] },
      ops: { merge: { ops: [{ run: { cmd: 'node', args: ['{{WORKSPACE}}/scripts/derive.js', '{{RUN}}'] } }] } },
    };
    const outDir = await tmpOut();
    const { status } = await runWorkflow(compile(wf([node])), {
      run: 'runtok',
      outDir,
      workspace,
      buildCommand: filesBuilder(() => ({ 'marker.txt': 'M1' })),
    });
    expect(status.nodes.derive.status).toBe('ok');
    // The run op fired with BOTH tokens resolved physically (else node would ENOENT on the script / marker).
    expect(await fs.readFile(path.join(outDir, 'receipt.txt'), 'utf8')).toBe('derived from M1');
    await fs.rm(outDir, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('runs project BEFORE merge BEFORE promote (the run.mjs POST order)', async () => {
    // The ordering is proven by DATA DEPENDENCY across the three ops:
    //  - project `copy` derives spec/derived.json from a frozen source subtree;
    //  - merge `run` executes a script that writes order.txt = "project-first" IFF spec/derived.json EXISTS
    //    when it runs (i.e. project already ran), else "merge-first";
    //  - promote lifts a field from spec/source.json → the `phase` channel, landing in state.json LAST.
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-ws-ord-'));
    await fs.mkdir(path.join(workspace, 'scripts'), { recursive: true });
    await fs.writeFile(
      path.join(workspace, 'scripts', 'order.js'),
      `const fs=require('fs');const run=process.argv[2];const had=fs.existsSync(run+'/spec/derived.json');fs.writeFileSync(run+'/order.txt',had?'project-first':'merge-first');`,
    );
    const node: NodeIntent = {
      label: 'Derive',
      prompt: 'author the source',
      tools: {},
      io: { reads: [], produces: ['spec/source.json'], artifacts: [{ path: 'spec/source.json' }] },
      ops: {
        // project: copy the `payload` subtree of spec/source.json → spec/derived.json (a discriminated op).
        project: [{ to: 'spec/derived.json', source: 'spec/source.json', copy: 'payload' } as unknown as { to: string; from: string }],
        // merge: a run op that records whether the projection already landed.
        merge: { ops: [{ run: { cmd: 'node', args: ['{{WORKSPACE}}/scripts/order.js', '{{RUN}}'] } }] },
        // promote: lift a channel LAST (it lands at the stage barrier, after project+merge in-node).
        promote: [{ from: 'spec/source.json:phase', to: 'phase', merge: 'set' }],
      },
    };
    const outDir = await tmpOut();
    const { status } = await runWorkflow(compile(wf([node])), {
      run: 'order',
      outDir,
      workspace,
      buildCommand: filesBuilder(() => ({ 'spec/source.json': '{"phase":"P1","payload":{"k":"v"}}' })),
    });
    expect(status.nodes.derive.status).toBe('ok');
    // (1) project ran: spec/derived.json holds the copied subtree.
    expect(JSON.parse(await fs.readFile(path.join(outDir, 'spec', 'derived.json'), 'utf8'))).toEqual({ k: 'v' });
    // (2) merge ran AFTER project (the script saw spec/derived.json already on disk).
    expect(await fs.readFile(path.join(outDir, 'order.txt'), 'utf8')).toBe('project-first');
    // (3) promote ran (the barrier persisted the channel to state.json) — the LAST of the three.
    const state = JSON.parse(await fs.readFile(stateFile(outDir), 'utf8'));
    expect(state.phase).toBe('P1');
    await fs.rm(outDir, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('a node with NO project/merge ops runs exactly as before (additive)', async () => {
    const outDir = await tmpOut();
    const { status } = await runWorkflow(compile(wf([n('Plain', [], ['p.txt'])])), { run: 'noderive', outDir, buildCommand: stubBuilder() });
    expect(status.nodes.plain.status).toBe('ok');
    await fs.rm(outDir, { recursive: true, force: true });
  });
});

// ── G2: concurrency cap (maxConcurrent) ───────────────────────────────────────────────────────────
//
// The observable seam is the injected `execRunner` — the per-node spawn primitive each node passes
// through exactly once per attempt. A `gateExec` factory makes every exec PARK on a manual release so
// admitted lanes pile up; it counts in-flight execs and records the PEAK. With the cap wrapping the
// stage map, peak must never exceed `maxConcurrent`; with no cap it equals the stage size.

/**
 * An execRunner that PARKS each call until released, tracking in-flight + peak concurrency. After a
 * release it delegates to `defaultExecRunner` so the stub builder's artifact-writing command actually
 * runs in the sandbox (the node verifies green) — the park is the only thing the gate adds, so it
 * measures EXACTLY the admission cap. `failFor(cmd)` (optional) forces a non-zero exit (drives the
 * retry/error path) for the matching node, identified by a substring of its command.
 */
function gateExec(opts: { failFor?: (cmd: string) => boolean } = {}) {
  let inFlight = 0;
  let peak = 0;
  const releases: Array<() => void> = [];
  const calls: string[] = [];
  const exec: ExecRunner = async (sandbox, cmd, watchOpts) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    calls.push(cmd);
    try {
      await new Promise<void>((resolve) => releases.push(resolve));
      if (opts.failFor?.(cmd)) {
        return { result: { stdout: '', stderr: 'forced failure', code: 1 }, killed: null };
      }
      return await defaultExecRunner(sandbox, cmd, watchOpts);
    } finally {
      inFlight--;
    }
  };
  return {
    exec,
    get peak() { return peak; },
    get inFlight() { return inFlight; },
    get callCount() { return releases.length; },
    get totalCalls() { return calls.length; },
    /** Release the next-oldest parked exec (FIFO). */
    releaseOne() { releases.shift()?.(); },
    /** Release every currently-parked exec. */
    releaseAll() { while (releases.length) releases.shift()!(); },
  };
}

/** Spin the event loop a few macrotasks so any newly-admitted lane reaches its `execRunner` call. */
async function settle(ticks = 5): Promise<void> {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 2));
}

/**
 * Wait until `count()` reaches `want` (a lane's pre-exec async setup — create/stage/resolve — must
 * complete before it parks at the gate, so a fixed sleep is racy). Polls up to `timeoutMs`. Returns
 * once reached; if it OVERSHOOTS (more than `want` admitted — a broken cap) it returns immediately so
 * the caller's equality assertion catches it. Throws on timeout (the gate never filled — a dead-queue).
 */
async function waitForCount(count: () => number, want: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (count() >= want) return; // reached (>= so an overshoot returns and the caller asserts ===)
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitForCount: never reached ${want} (last ${count()})`);
}

describe('runWorkflow — G2 concurrency cap', () => {
  it('T1: peak concurrent spawns never exceeds maxConcurrent over a wide stage', async () => {
    // 5 independent nodes (no reads between them) → compile puts them in ONE parallel stage.
    const g = compile(wf([0, 1, 2, 3, 4].map((i) => n(`Node${i}`, [], [`n${i}.txt`]))));
    expect(g.stages[0].nodeIds).toHaveLength(5);
    const outDir = await tmpOut();
    const gate = gateExec();

    const runP = runWorkflow(g, { run: 't1', outDir, buildCommand: stubBuilder(), execRunner: gate.exec, maxConcurrent: 2 });

    // Wait for the cap to admit its first wave, then give the loop extra ticks: a BROKEN cap would
    // admit all 5, so we must let any over-admission surface before asserting the peak.
    await waitForCount(() => gate.inFlight, 2);
    await settle();
    expect(gate.inFlight).toBe(2); // exactly the cap is parked — no more, no fewer
    expect(gate.peak).toBe(2);

    // Drain all 5 lanes; release one, wait for the next to be admitted+parked (or for the run to
    // finish), and re-assert the peak after each. All 5 nodes pass through the gate exactly once.
    for (let released = 0; released < 5; released++) {
      gate.releaseOne();
      // wait until either a new lane parks (callCount climbs) or every lane has been seen (totalCalls===5)
      const before = gate.totalCalls;
      await waitForCount(() => (gate.totalCalls > before || gate.totalCalls === 5 ? 1 : 0), 1).catch(() => {});
      await settle(2);
      expect(gate.peak).toBe(2); // NEVER exceeds the cap
    }
    const { status } = await runP;
    expect(gate.totalCalls).toBe(5); // every node spawned exactly once
    expect(gate.peak).toBe(2);
    expect(status.ok).toBe(true);
    expect(Object.values(status.nodes).every((nd) => nd.status === 'ok')).toBe(true);

    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('T2: admits exactly one queued lane per release (FIFO) and fully drains', async () => {
    const g = compile(wf([0, 1, 2, 3, 4].map((i) => n(`Node${i}`, [], [`n${i}.txt`]))));
    const outDir = await tmpOut();
    const gate = gateExec();

    const runP = runWorkflow(g, { run: 't2', outDir, buildCommand: stubBuilder(), execRunner: gate.exec, maxConcurrent: 2 });

    await waitForCount(() => gate.totalCalls, 2);
    await settle();
    expect(gate.totalCalls).toBe(2); // only the first 2 admitted

    // Releasing ONE admits exactly ONE more (total seen climbs by 1, never by 2+).
    gate.releaseOne();
    await waitForCount(() => gate.totalCalls, 3);
    await settle();
    expect(gate.totalCalls).toBe(3);
    expect(gate.inFlight).toBe(2); // still exactly the cap in flight

    // Drain the rest; the run completes and every node is terminal (no dead-queue). A self-pumping
    // releaser is robust to event-loop pressure from sibling tests (a fixed sleep is not).
    const pump = setInterval(() => gate.releaseAll(), 5);
    const { status } = await runP.finally(() => clearInterval(pump));
    expect(gate.totalCalls).toBe(5);
    expect(Object.values(status.nodes).every((nd) => nd.status === 'ok')).toBe(true);
    expect(status.done).toBe(true);

    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('T3: a retrying node holds ONE slot across all its attempts (no sibling interleaves)', async () => {
    // 3 nodes, cap 1 (serial). node1 has retries:2 and its exec is forced to fail, so runNode runs 3×.
    // Because the limiter wraps the WHOLE runNodeWithRetries (OUTSIDE the retry loop), node1 keeps its
    // ONE slot for all 3 attempts — its exec calls are CONTIGUOUS in admission order, with NO sibling
    // exec between them. A wrap INSIDE the retry loop would RELEASE the slot after each failed attempt,
    // and the FIFO limiter would admit a waiting sibling in the gap — interleaving node0/node2 between
    // node1's attempts. Asserting contiguity catches that; asserting peak alone would NOT (cap 1 forbids
    // overlap regardless of wrap placement).
    const g = compile(
      wf([
        n('Node0', [], ['n0.txt']),
        n('Node1', [], ['n1.txt'], { io: { reads: [], produces: ['n1.txt'], artifacts: [{ path: 'n1.txt' }], retries: 2 } }),
        n('Node2', [], ['n2.txt']),
      ]),
    );
    expect(g.stages[0].nodeIds).toHaveLength(3);
    const outDir = await tmpOut();
    // Record the NODE id of each exec, in admission order. Force node1 to fail (exhaust its retries).
    const order: string[] = [];
    const baseGate = gateExec({ failFor: (cmd) => cmd.includes('node1') });
    const recordingExec: ExecRunner = async (sandbox, cmd, o) => {
      order.push(cmd.includes('node0') ? 'node0' : cmd.includes('node1') ? 'node1' : 'node2');
      return baseGate.exec(sandbox, cmd, o);
    };

    const runP = runWorkflow(g, { run: 't3', outDir, buildCommand: stubBuilder(), execRunner: recordingExec, maxConcurrent: 1 });
    const pump = setInterval(() => baseGate.releaseAll(), 5);
    const { status } = await runP.finally(() => clearInterval(pump));

    expect(baseGate.peak).toBe(1); // cap 1 honored
    // node1 attempted 3× (1 + 2 retries); node0/node2 once each ⇒ 5 execs.
    expect(order.filter((id) => id === 'node1')).toHaveLength(3);
    expect(order).toHaveLength(5);
    // CONTIGUITY: node1's three execs occupy three ADJACENT positions — its slot was never yielded to a
    // sibling mid-retry. (firstIdx..lastIdx span is exactly 3.)
    const firstN1 = order.indexOf('node1');
    const lastN1 = order.lastIndexOf('node1');
    expect(lastN1 - firstN1).toBe(2); // 3 attempts back-to-back, no sibling wedged between
    expect(status.nodes.node1.status).toBe('error'); // exhausted retries → error

    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('T4: maxNodesPerRun halts the run; the over-cap node never spawns', async () => {
    // Two SERIAL stages (node2 reads node1's artifact). maxNodesPerRun:1 ⇒ node1 acquires the only
    // slot, node2 is refused at admission, gets a synthetic error, and the run halts.
    const g = compile(wf([n('Node1', [], ['n1.txt']), n('Node2', ['n1.txt'], ['n2.txt'])]));
    expect(g.stages).toHaveLength(2); // serial: a 2-stage spine
    const outDir = await tmpOut();
    let node2Spawned = false;
    const builder = stubBuilder((node) => {
      if (node.id === 'node2') node2Spawned = true;
      return node.io.artifacts.map((a) => a.path);
    });

    const { status } = await runWorkflow(g, {
      run: 't4', outDir, buildCommand: builder, execRunner: defaultExecRunner, maxNodesPerRun: 1,
    });

    expect(status.done).toBe(true);
    expect(status.ok).toBe(false); // the cap halted the run
    expect(status.nodes.node1.status).toBe('ok'); // the one node under the cap ran
    expect(status.nodes.node2.status).toBe('error'); // refused admission
    expect(status.nodes.node2.issues.join(' ')).toMatch(/total node cap.*exceeded/i);
    expect(node2Spawned).toBe(false); // node2's command was NEVER built/spawned

    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('T5: a stage smaller than the cap is inert — both lanes run concurrently, result unchanged', async () => {
    const mkWf = () => compile(wf([n('Alpha', [], ['a.txt']), n('Beta', [], ['b.txt'])]));
    const outDir1 = await tmpOut();
    const outDir2 = await tmpOut();

    // Concurrency-observing runner (overlap via a small delay, like the e2e test) — under a generous cap.
    const track = () => {
      let inFlight = 0; let peak = 0;
      const exec: ExecRunner = async (sandbox, cmd, o) => {
        inFlight++; peak = Math.max(peak, inFlight);
        try { await new Promise((r) => setTimeout(r, 5)); return await defaultExecRunner(sandbox, cmd, o); }
        finally { inFlight--; }
      };
      return { exec, get peak() { return peak; } };
    };
    const capped = track();
    const uncapped = track();

    const { status: a } = await runWorkflow(mkWf(), { run: 't5a', outDir: outDir1, buildCommand: stubBuilder(), execRunner: capped.exec, maxConcurrent: 16 });
    const { status: b } = await runWorkflow(mkWf(), { run: 't5b', outDir: outDir2, buildCommand: stubBuilder(), execRunner: uncapped.exec });

    expect(capped.peak).toBe(2); // under-cap stage still runs both lanes concurrently
    expect(uncapped.peak).toBe(2);
    // Byte-identical verdict to a no-maxConcurrent run.
    expect(a.ok).toBe(true);
    expect(a.ok).toBe(b.ok);
    expect(a.totals).toEqual(b.totals);
    expect(a.nodes.alpha.status).toBe(b.nodes.alpha.status);
    expect(a.nodes.beta.status).toBe(b.nodes.beta.status);

    await fs.rm(outDir1, { recursive: true, force: true });
    await fs.rm(outDir2, { recursive: true, force: true });
  });
});

// ── U7-IO: token resolution at node launch ALSO covers the IO / sandbox / checks PATHS ───────────────
//   The prompt is made physical at launch (S1), but a node's CONTRACT paths — io.artifacts[].path,
//   sandbox.write (owns), sandbox.read (read-scope), checks[].path — carried their {{…}} tokens RAW into
//   the existence gate (artifactState), the DRIVER-* markers (markersFromNode), and scope.create. A raw
//   `{{WORKSPACE}}/…/{{arg.lessonId}}/x.md` is not absolute (starts with `{`), so the gate joins it under
//   the run dir with braces intact → the stat fails / the marker lies / the read-scope is wrong. These
//   tests pin that EVERY io/sandbox/check path is resolved with the SAME launch ctx as the prompt.

describe('runWorkflow — io/sandbox/checks token resolution at node launch (U7-IO)', () => {
  /** Records both staged prompt bytes AND each CreateOpts (so we can inspect the read-scope handed to create). */
  function recorder(): { provider: SandboxProvider; writes: { path: string; data: string }[]; createOpts: CreateOpts[] } {
    const writes: { path: string; data: string }[] = [];
    const createOpts: CreateOpts[] = [];
    const base = new InMemorySandboxProvider();
    const provider: SandboxProvider = {
      kind: 'inmemory',
      async create(opts: CreateOpts): Promise<Sandbox> {
        createOpts.push(opts);
        const sb = await base.create(opts);
        const orig = sb.writeFile.bind(sb);
        sb.writeFile = async (p: string, d: Uint8Array | string) => {
          writes.push({ path: p, data: typeof d === 'string' ? d : Buffer.from(d).toString('utf8') });
          return orig(p, d);
        };
        return sb;
      },
    };
    return { provider, writes, createOpts };
  }

  it('resolves io.artifacts/owns/read-scope/checks tokens BEFORE the gate, the markers, and scope.create', async () => {
    // A node whose CONTRACT paths all carry tokens. The gated artifact uses a {{arg.*}}-only RELATIVE path
    // so the stub can write it (the file gate then proves it sees the RESOLVED path); owns/read-scope/checks
    // use the fuller {{WORKSPACE}}/…/{{arg.lessonId}}/… shape (exactly the lesson-build template form).
    const node: NodeIntent = {
      label: 'Pedagogy',
      prompt: 'write pedagogy for {{arg.lessonId}}',
      tools: {},
      io: {
        reads: [],
        produces: ['data/{{arg.lessonId}}/out.md'],
        artifacts: [{ path: 'data/{{arg.lessonId}}/out.md' }],
        // A tokenized check path that POINTS AT THE SAME produced artifact (resolves to data/kp4/out.md):
        // pre-fix the `exists` check stat()d the braces-laden path → fail; post-fix it resolves and passes.
        checks: [{ kind: 'exists', path: 'data/{{arg.lessonId}}/out.md' }],
      },
      sandbox: {
        read: ['{{WORKSPACE}}/lesson-data/{{arg.lessonId}}'],
        write: ['{{WORKSPACE}}/data/{{arg.lessonId}}'],
      },
    };
    const outDir = await tmpOut();
    const { provider, writes, createOpts } = recorder();

    const { status } = await runWorkflow(compile(wf([node])), {
      run: 'iores',
      outDir,
      provider,
      buildCommand: stubBuilder(),
      args: { lessonId: 'kp4' },
      workspace: '/tmp/ws',
    });

    // (1) THE EXISTENCE GATE saw the RESOLVED path: the node is ok (the gated artifact is reported as the
    //     physical `data/kp4/out.md`, exists:true). Pre-fix the gate stat()d `data/{{arg.lessonId}}/out.md`
    //     verbatim → braces on disk → missing → blocked.
    expect(status.nodes.pedagogy.status).toBe('ok');
    expect(status.nodes.pedagogy.artifacts).toEqual([{ path: 'data/kp4/out.md', exists: true, bytes: 'pedagogy'.length }]);
    expect(JSON.stringify(status.nodes.pedagogy.artifacts)).not.toContain('{{');

    // (2) THE DRIVER-* MARKERS are physical (markersFromNode rendered RESOLVED io/sandbox paths).
    const staged = writes.find((w) => w.path === '_pi/pedagogy/prompt.md')!;
    expect(staged).toBeTruthy();
    expect(staged.data).toContain('DRIVER-ARTIFACTS: data/kp4/out.md');
    expect(staged.data).toContain('DRIVER-OWNS: /tmp/ws/data/kp4');
    expect(staged.data).toContain('DRIVER-READ-SCOPE: /tmp/ws/lesson-data/kp4');
    // not one {{…}} left anywhere in the staged prompt (prose + every marker).
    expect(staged.data).not.toContain('{{');

    // (3) scope.create got the RESOLVED read-scope (the OS-enforced / staging read law is physical).
    expect(createOpts).toHaveLength(1);
    expect(createOpts[0].readScope).toEqual(['/tmp/ws/lesson-data/kp4']);

    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('a missing {{arg.*}} in an io PATH fails the node loudly (MissingArgError), like the prompt path', async () => {
    // The artifact path references an arg that was never supplied → resolution must THROW, not stat a
    // braces-laden path silently. Mirrors the S1 prompt-path discipline.
    const node: NodeIntent = {
      label: 'NeedArg',
      prompt: 'plain prompt, no tokens',
      tools: {},
      io: { reads: [], produces: ['out/{{arg.absent}}.md'], artifacts: [{ path: 'out/{{arg.absent}}.md' }] },
    };
    const outDir = await tmpOut();
    // No `args` supplied → {{arg.absent}} cannot resolve.
    const { status } = await runWorkflow(compile(wf([node])), { run: 'ioargmiss', outDir, buildCommand: stubBuilder() });

    expect(status.nodes.needarg.status).toBe('error');
    expect(status.nodes.needarg.issues.join(' ')).toMatch(/absent/);
    expect(status.ok).toBe(false);

    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('a node with NO io tokens is byte-identical (additive — non-token contracts unchanged)', async () => {
    const outDir = await tmpOut();
    const { provider, writes, createOpts } = recorder();
    const { status } = await runWorkflow(compile(wf([n('Plain', [], ['p.txt'])])), { run: 'iores-plain', outDir, provider, buildCommand: stubBuilder() });
    expect(status.nodes.plain.status).toBe('ok');
    expect(status.nodes.plain.artifacts).toEqual([{ path: 'p.txt', exists: true, bytes: 'plain'.length }]);
    const staged = writes.find((w) => w.path === '_pi/plain/prompt.md')!;
    expect(staged.data).toContain('DRIVER-ARTIFACTS: p.txt');
    expect(createOpts[0].readScope).toEqual([]); // no read-scope declared ⇒ empty, unchanged
    await fs.rm(outDir, { recursive: true, force: true });
  });
});

// ── 17. IN-PLACE collection is an identity NO-OP (the LocalSandbox / `--sandbox local` contract) ─────
//   The live regression (lesson-build ctt-2): an in-place node's `sandbox.output` is the compile default
//   `out/<id>` (a WORKSPACE-root subdir), but `ctx.outDir` is the run dir — DIFFERENT real paths. The
//   runner blindly called `sandbox.downloadDir('out/<id>', outDir)`; `LocalSandbox.downloadDir` is a
//   GUARDED IDENTITY (no-op iff realpath(remote)===realpath(local), else THROW), so it THREW
//   "in-place collection is identity-only …" on EVERY in-place node. The throw was caught at the success
//   collect site (→ a spurious "output collection failed" issue on the node) — w4b-sketch surfaced exactly
//   that issue yet ended `ok` (its absolute-path artifacts existed), and w4a-composer ALSO carried it
//   (then blocked on its merge.run). FIX: for an in-place provider the deliverable already lives in the
//   real workspace, so the runner must NOT attempt a download — collection is a clean no-op. The local.ts
//   identity THROW stays as the guard; the CALLER (the runner) stops violating it.
//
//   Faithful reproduction: a REAL LocalSandboxProvider, `outDir` UNDER the workspace (the live layout),
//   nodes whose `sandbox.output` is the compile default `out/<id>` (≠ outDir), one PLAIN (w4b shape) and
//   one with a CLEAN post `run`/merge op (the w4a code path). Both must end `ok` with NO collection-failure
//   issue. On UNPATCHED source the empty `out/<id>` exists at the workspace root → downloadDir THROWS →
//   caught → "output collection failed" issue present → these assertions FAIL (RED).

describe('runWorkflow — in-place LocalSandbox collection is an identity no-op (no spurious downloadDir throw)', () => {
  /**
   * The in-place stub: the LocalSandbox roots at the WORKSPACE, so the node writes its declared artifacts
   * DIRECTLY to their host location (an absolute path under `outDir`) — exactly as the live composer did
   * (absolute / run-relative writes), NOT into `out/<id>`. A clean ok-return on stdout. `outDir` is closed
   * over so the command targets the real run dir the artifact gate stats.
   */
  function inPlaceBuilder(outDir: string) {
    return (node: { id: string; io: { artifacts: { path: string }[] }; sandbox: { output: string } }): string => {
      const writes = node.io.artifacts
        .map((a) => {
          const dest = path.join(outDir, a.path); // absolute host path = where the in-place deliverable lives
          const dir = path.dirname(dest);
          return `mkdir -p ${JSON.stringify(dir)} && printf '%s' ${node.id} > ${JSON.stringify(dest)}`;
        })
        .join(' && ');
      const ret = `printf '%s' '\`\`\`json\\n{"status":"ok","summary":"${node.id} done"}\\n\`\`\`'`;
      return writes ? `${writes} && ${ret}` : ret;
    };
  }

  it('a plain in-place node AND one with a post-run op both collect as a no-op (ok, no "output collection failed")', async () => {
    // Workspace = a throwaway tree; outDir = a run dir UNDER it (the live `.piflow/<wf>/runs/<id>` layout,
    // which is a workspace subdir). enforceReadScope:false so the kernel jail never interferes with the
    // test's own absolute writes/reads — the collection bug is orthogonal to the jail.
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-inplace-ws-'));
    const outDir = path.join(workspace, '.piflow', 'runs', 'r');
    await fs.mkdir(outDir, { recursive: true });
    try {
      const plain = n('Plain', [], ['plain.txt']);
      // The w4a shape: a node with a CLEAN post `run` op (the merge.run code path) — it must reach collection
      // and that collection must be a no-op too (the run op exits 0, so it never blocks on its own).
      const withRun: NodeIntent = {
        ...n('WithRun', [], ['composed.txt']),
        op: [{ when: 'post', run: { cmd: 'node', args: ['-e', 'process.exit(0)'] } }],
      };
      const provider = new LocalSandboxProvider({ enforceReadScope: false });
      const { status } = await runWorkflow(compile(wf([plain, withRun])), {
        run: 'r',
        outDir,
        repoRoot: workspace,
        workspace,
        provider,
        buildCommand: inPlaceBuilder(outDir),
      });

      // The compile default really does set output to a workspace-root subdir ≠ outDir (the bug's premise).
      expect(status.nodes.plain.status, status.nodes.plain.issues.join(' | ')).toBe('ok');
      expect(status.nodes.withrun.status, status.nodes.withrun.issues.join(' | ')).toBe('ok');

      // The load-bearing assertion: collection was a clean no-op — NO "output collection failed" issue on
      // EITHER node. RED on unpatched source: the runner's downloadDir('out/<id>' → outDir) throws the
      // identity-only error, which is caught and recorded as exactly this issue.
      for (const id of ['plain', 'withrun'] as const) {
        expect(
          status.nodes[id].issues.join(' | '),
          `in-place node "${id}" must NOT carry a spurious collection-failure issue`,
        ).not.toMatch(/output collection failed|identity-only/i);
      }

      // The in-place deliverables are present on the host (the artifact gate passed against the real run dir).
      expect(await fs.readFile(path.join(outDir, 'plain.txt'), 'utf8')).toBe('plain');
      expect(await fs.readFile(path.join(outDir, 'composed.txt'), 'utf8')).toBe('withrun');
      expect(status.ok).toBe(true);
    } finally {
      // dispose is a no-op for LocalSandbox; the TEST owns teardown of the tree it created.
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});
