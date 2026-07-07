import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NodeIntent, WorkflowSpec, Sandbox, SandboxProvider, CreateOpts } from '../src/index.js';
import { InMemorySandboxProvider } from '../src/index.js';
import { runFromConfig, runFromTemplate } from '../src/runner/index.js';
import { nodeDir, runJsonFile } from '../src/runner/layout.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARG_TEMPLATE = path.join(HERE, 'fixtures', 'template-arg');

// A node factory (mirrors runner.test).
function n(label: string, reads: string[], produces: string[]): NodeIntent {
  return { label, prompt: `do ${label}`, tools: {}, io: { reads, produces, artifacts: produces.map((p) => ({ path: p })) } };
}
const spec = (): WorkflowSpec => ({ meta: { name: 't', description: 'd' }, nodes: [n('Solo', [], ['s.txt'])] });
const tmpOut = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'piflow-entry-'));

// The offline stub builder (writes each declared artifact + a return fence) — reused from runner.test's shape.
function stubBuilder() {
  return (node: { id: string; io: { artifacts: { path: string }[] }; sandbox: { output: string } }): string => {
    const writes = node.io.artifacts
      .map((a) => {
        const dest = `${node.sandbox.output}/${a.path}`;
        const dir = dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : '.';
        return `mkdir -p ${dir} && printf '%s' ${node.id} > ${dest}`;
      })
      .join(' && ');
    const ret = `printf '%s' '\`\`\`json\\n{"status":"ok","summary":"${node.id} done"}\\n\`\`\`'`;
    return writes ? `${writes} && ${ret}` : ret;
  };
}

describe('runFromConfig — the env-AGNOSTIC run entry (U8, D5)', () => {
  it('takes a resolved-config OBJECT with a workflowSpec, compiles + runs it, produces its artifacts', async () => {
    const outDir = await tmpOut();
    const result = await runFromConfig({
      workflowSpec: spec(),
      run: 'cfg',
      outDir,
      buildCommand: stubBuilder(),
    });
    expect(result.status.ok).toBe(true);
    expect(result.status.nodes.solo.status).toBe('ok');
    expect(await fs.readFile(path.join(outDir, 's.txt'), 'utf8')).toBe('solo');
    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('accepts buildWorkflowSpec (a consumer-injected async factory) instead of a literal spec', async () => {
    const outDir = await tmpOut();
    let built = false;
    const result = await runFromConfig({
      buildWorkflowSpec: async () => {
        built = true;
        return spec();
      },
      run: 'cfg-build',
      outDir,
      buildCommand: stubBuilder(),
    });
    expect(built).toBe(true); // the injected factory was invoked
    expect(result.status.ok).toBe(true);
    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('forwards run opts (returnProtocol) through to the run path', async () => {
    // returnProtocol:'required' on an artifact-backed node whose builder emits a fence ⇒ still ok, but the
    // node's effective returnMode proves the option threaded through.
    const outDir = await tmpOut();
    const result = await runFromConfig({
      workflowSpec: spec(),
      run: 'cfg-rp',
      outDir,
      buildCommand: stubBuilder(),
      returnProtocol: 'required',
    });
    expect(result.status.nodes.solo.returnMode).toBe('required');
    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('FAILS LOUDLY when NEITHER workflowSpec nor buildWorkflowSpec is provided (no silent no-op)', async () => {
    await expect(runFromConfig({ run: 'cfg-empty' } as never)).rejects.toThrow(/workflowSpec|buildWorkflowSpec/i);
  });
});

// ── Phase 2 (T2.4): the run path honors fusion — a `fusion` node runs as its EXPANDED DAG ──────────────
describe('runFromConfig — fusion expansion is wired into the run path', () => {
  /** A moa fusion node `synth` (panel of 2) + a downstream `publish` that reads its artifact. */
  function fusionSpec(): WorkflowSpec {
    return {
      meta: { name: 'fz', description: 'd' },
      nodes: [
        {
          label: 'synth',
          prompt: 'TASK',
          tools: {},
          model: 'base',
          io: { reads: [], produces: ['out/answer.md'], artifacts: [{ path: 'out/answer.md' }] },
          sandbox: { read: [], write: ['out/**'] },
          fusion: { mode: 'moa', panel: ['model-a', 'model-b'] },
        },
        n('publish', ['out/answer.md'], ['out/final.md']),
      ],
    };
  }

  it('runs the siblings + judge end-to-end; the judge keeps the original id + artifact so publish still runs', async () => {
    const outDir = await tmpOut();
    const result = await runFromConfig({
      workflowSpec: fusionSpec(),
      run: 'fz',
      outDir,
      buildCommand: stubBuilder(),
    });
    expect(result.status.ok).toBe(true);
    // the node became a 4-node sub-graph: two siblings + the judge (original id) + the untouched successor.
    expect(Object.keys(result.status.nodes).sort()).toEqual(['publish', 'synth', 'synth-p1', 'synth-p2']);
    for (const id of ['synth-p1', 'synth-p2', 'synth', 'publish']) {
      expect(result.status.nodes[id].status).toBe('ok');
    }
    // the judge (id 'synth') produced the ORIGINAL artifact → the downstream edge to publish survived.
    expect(await fs.readFile(path.join(outDir, 'out/answer.md'), 'utf8')).toBe('synth');
    expect(await fs.readFile(path.join(outDir, 'out/final.md'), 'utf8')).toBe('publish');
    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('leaves a NON-fusion spec byte-identical (additive — only fusion nodes expand)', async () => {
    const outDir = await tmpOut();
    const result = await runFromConfig({ workflowSpec: spec(), run: 'nf', outDir, buildCommand: stubBuilder() });
    expect(result.status.ok).toBe(true);
    expect(Object.keys(result.status.nodes)).toEqual(['solo']); // no expansion
    await fs.rm(outDir, { recursive: true, force: true });
  });
});

// ── S5: runFromTemplate — the TEMPLATE-run join (loadTemplate → instantiateRun → compile → runWorkflow) ──

describe('runFromTemplate — the template-run join (U8, §10)', () => {
  // HERMETIC (M3): `runFromTemplate` self-registers `workspace` (derived here to `process.cwd()`, since
  // ARG_TEMPLATE isn't `.piflow/<wf>/template`-shaped and no explicit workspace/repoRoot is passed) into
  // `~/.piflow/products.json` — point PIFLOW_HOME at a scratch dir for this suite and restore it after.
  let piflowHome: string;
  let savedPiflowHome: string | undefined;
  beforeEach(async () => {
    piflowHome = await tmpOut();
    savedPiflowHome = process.env.PIFLOW_HOME;
    process.env.PIFLOW_HOME = piflowHome;
  });
  afterEach(async () => {
    if (savedPiflowHome === undefined) delete process.env.PIFLOW_HOME;
    else process.env.PIFLOW_HOME = savedPiflowHome;
    await fs.rm(piflowHome, { recursive: true, force: true });
  });

  // A provider that records every staged write (so the test can capture the RESOLVED prompt on disk).
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

  // The offline stub: write each declared artifact (run-relative path) into the sandbox output, + a fence.
  function stubBuilder() {
    return (node: { id: string; io: { artifacts: { path: string }[] }; sandbox: { output: string } }): string => {
      const writes = node.io.artifacts
        .map((a) => {
          const dest = `${node.sandbox.output}/${a.path}`;
          const dir = dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : '.';
          return `mkdir -p ${dir} && printf '%s' ${node.id} > ${dest}`;
        })
        .join(' && ');
      const ret = `printf '%s' '\`\`\`json\\n{"status":"ok","summary":"${node.id} done"}\\n\`\`\`'`;
      return writes ? `${writes} && ${ret}` : ret;
    };
  }

  it('materializes ${RUN}/.pi/nodes/<id>/ AND runs (stub exec) to a terminal run.json; {{arg.x}} resolves', async () => {
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-tpl-run-'));
    const { provider, writes } = recorder();

    const result = await runFromTemplate(ARG_TEMPLATE, {
      run: 'argrun',
      runDir,
      provider,
      buildCommand: stubBuilder(),
      args: { greeting: 'hello-from-arg' }, // ← the --arg k=v delivery the resolver makes physical
    });

    // (1) THE INSTANTIATE HALF: the run thread folder was materialized (.pi/nodes/<id>/ with node.json+prompt).
    const ndir = nodeDir(runDir, 'greet');
    expect(await fs.readFile(path.join(ndir, 'node.json'), 'utf8')).toContain('"id": "greet"');
    expect(await fs.stat(path.join(ndir, 'prompt.md'))).toBeTruthy();

    // (2) THE RUN HALF: it ran to a TERMINAL run.json (done:true, ok:true) — the spec-compile and folder-
    // materialize halves are joined into one end-to-end run.
    expect(result.status.done).toBe(true);
    expect(result.status.ok).toBe(true);
    expect(result.status.nodes.greet.status).toBe('ok');
    const onDisk = JSON.parse(await fs.readFile(runJsonFile(runDir), 'utf8'));
    expect(onDisk).toMatchObject({ run: 'argrun', done: true, ok: true });

    // (3) THE ARG CHANNEL: the staged prompt has {{arg.greeting}} RESOLVED to the supplied value (proving
    // args threaded RunOptions → resolver ctx → node launch). The recorder captured the on-disk prompt.
    const stagedPrompt = writes.find((w) => w.path.endsWith('prompt.md'))?.data ?? '';
    expect(stagedPrompt).toContain('hello-from-arg');
    expect(stagedPrompt).not.toContain('{{arg.greeting}}');

    await fs.rm(runDir, { recursive: true, force: true });
  });

  it('a MISSING {{arg.x}} fails the node loudly (MissingArgError), never a silent empty', async () => {
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-tpl-argmiss-'));
    const result = await runFromTemplate(ARG_TEMPLATE, {
      run: 'argmiss',
      runDir,
      buildCommand: stubBuilder(),
      // no `args` → {{arg.greeting}} has no value → the node errors on prompt resolution.
    });
    expect(result.status.nodes.greet.status).toBe('error');
    expect(result.status.nodes.greet.issues?.join(' ')).toMatch(/arg|greeting/i);
    await fs.rm(runDir, { recursive: true, force: true });
  });
});

// ── ADDITIVE PROFILE OVERLAY on the RUN PATH — the `--profile <name>` overlay must MERGE through the ──
// runFromTemplate join (loadTemplate → … → runWorkflow), so a profile that adds an `agentic` gate
// materializes its `<producer>__judge` node and it actually RUNS. The bug: runFromTemplate called
// loadTemplate(dir) with NO opts, so the overlay never merged and no judge ever materialized on the live
// path (dead flag). This drives the REAL runFromTemplate (stub executor, no model) and asserts the judge
// node appears in the terminal run — the direct witness that the profile threaded into loadTemplate.
describe('runFromTemplate — an additive profile overlay materializes + runs its judge on the run path', () => {
  let piflowHome: string;
  let savedPiflowHome: string | undefined;
  beforeEach(async () => {
    piflowHome = await tmpOut();
    savedPiflowHome = process.env.PIFLOW_HOME;
    process.env.PIFLOW_HOME = piflowHome;
  });
  afterEach(async () => {
    if (savedPiflowHome === undefined) delete process.env.PIFLOW_HOME;
    else process.env.PIFLOW_HOME = savedPiflowHome;
    await fs.rm(piflowHome, { recursive: true, force: true });
  });

  // Clone the runnable single-node ARG fixture (loadTemplate rewrites its workflow.json lock, so clone) and
  // drop in an OVERLAY-ONLY profile that appends an `agentic` gate to `greet` (judge tier `deep` differs from
  // the producer's undefined tier — a valid judge). No meta.json.profiles declaration ⇒ this also exercises
  // the overlay-only reconciliation (applyProfileByName must NOT throw UnknownProfileError for it).
  async function cloneArgWithOverlay(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-entry-profile-'));
    await fs.cp(ARG_TEMPLATE, dir, { recursive: true });
    const pdir = path.join(dir, 'profiles');
    await fs.mkdir(pdir, { recursive: true });
    await fs.writeFile(
      path.join(pdir, 'production.json'),
      JSON.stringify(
        { description: 'adds a judge', nodes: { greet: [{ type: 'agentic', judgeTier: 'deep', rubric: 'The greeting must be warm.' }] } },
        null,
        2,
      ),
    );
    return dir;
  }

  const hasJudge = (nodes: Record<string, unknown>): boolean => Object.keys(nodes).some((k) => k.includes('judge'));

  it('--profile <overlay> materializes the greet__judge node into the terminal run; a bare run does NOT', async () => {
    const tpl = await cloneArgWithOverlay();
    const bareDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-entry-bare-'));
    const profDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-entry-prof-'));

    // BARE run (no profile): the overlay is inert → NO judge (the additive-off control).
    const bare = await runFromTemplate(tpl, { run: 'bare', runDir: bareDir, buildCommand: stubBuilder(), args: { greeting: 'hi' } });
    expect(hasJudge(bare.status.nodes), 'no --profile ⇒ the overlay is inert, no judge').toBe(false);

    // PROFILED run: the overlay MERGES through the run path → the judge materializes AND runs (stub → ok).
    // Drop the `{ profile }` threading into loadTemplate (the bug) ⇒ no judge key ⇒ this goes red.
    const prof = await runFromTemplate(tpl, { run: 'prof', runDir: profDir, buildCommand: stubBuilder(), profile: 'production', args: { greeting: 'hi' } });
    const judgeId = Object.keys(prof.status.nodes).find((k) => k.includes('judge'));
    // The load-bearing witness: the judge node is in the terminal run's node set ⇒ the overlay merged through
    // loadTemplate on the run path. (Its stub-exec status is incidental to what this proves.)
    expect(judgeId, '--profile production ⇒ the overlay judge materializes on the run path').toBeDefined();

    for (const d of [tpl, bareDir, profDir]) await fs.rm(d, { recursive: true, force: true });
  });
});

// ── F1: the skill `requires` FLOOR is wired into the live run path at entry (before catalogForSpec) ──
// A node bound to a skill whose manifest declares `requires` gets those tool addresses unioned into its
// effective `tools.allow` at run start — so an UNPROVISIONED `mcp.*` floor fails FAST at the node's
// existing pre-spawn bind check, instead of the skill silently running without its declared tools.
describe('runFromConfig — a bound skill\'s requires FLOOR wires into the run path', () => {
  let WS: string; // workspace root carrying `.agents/skills/<id>/SKILL.md`
  let HOME: string; // PIFLOW_HOME → empty catalog + empty installed-skill ring (hermetic)
  let SAVED: string | undefined;

  beforeEach(async () => {
    WS = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-floor-run-ws-'));
    HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-floor-run-home-'));
    SAVED = process.env.PIFLOW_HOME;
    process.env.PIFLOW_HOME = HOME; // catalogForSpec.globalDir() + the wire's Ring 1 both read this
  });
  afterEach(async () => {
    if (SAVED === undefined) delete process.env.PIFLOW_HOME;
    else process.env.PIFLOW_HOME = SAVED;
    await fs.rm(WS, { recursive: true, force: true });
    await fs.rm(HOME, { recursive: true, force: true });
  });

  async function writeSkill(id: string, fm: string): Promise<void> {
    const dir = path.join(WS, '.agents', 'skills', id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), `---\n${fm}\n---\nBody.\n`);
  }

  /** A one-node spec binding `skill`, default (builtin) tools. */
  function skillSpec(skill: string): WorkflowSpec {
    return {
      meta: { name: 'sk', description: 'd' },
      nodes: [{ label: 'work', prompt: 'do work', skill, tools: {}, io: { reads: [], produces: ['w.txt'], artifacts: [{ path: 'w.txt' }] } }],
    };
  }

  it('an UNPROVISIONED mcp.* floor blocks the node (fail-fast) — proving the floor reached the run path', async () => {
    // Without the wire the node (builtins only) would run `ok`; the wire adds mcp.absent:tool → the
    // pre-spawn bind check finds it missing from the catalog → `blocked`. THAT is the fail-fast preflight.
    await writeSkill('needs-mcp', 'name: needs-mcp\nrequires: [mcp.absent:tool]\nallowed: [mcp.absent:tool]');
    const outDir = await tmpOut();
    const result = await runFromConfig({
      workflowSpec: skillSpec('needs-mcp'),
      run: 'floor-block',
      outDir,
      workspace: WS,
      buildCommand: stubBuilder(),
    });
    expect(result.status.ok).toBe(false);
    expect(result.status.nodes.work.status).toBe('blocked');
    expect(result.status.nodes.work.issues?.join(' ')).toMatch(/mcp\.absent:tool/);
    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('a bound skill that does NOT resolve wires nothing and the run still succeeds (loud-miss stays advisory)', async () => {
    const outDir = await tmpOut();
    const result = await runFromConfig({
      workflowSpec: skillSpec('ghost-skill-not-installed'),
      run: 'floor-ghost',
      outDir,
      workspace: WS,
      buildCommand: stubBuilder(),
    });
    expect(result.status.ok).toBe(true);
    expect(result.status.nodes.work.status).toBe('ok');
    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('a MALFORMED manifest (requires ⊄ allowed) fails the run at start with the parser message', async () => {
    await writeSkill('malformed', 'name: malformed\nrequires: [mcp.x:y]\nallowed: [fs:read]');
    const outDir = await tmpOut();
    await expect(
      runFromConfig({ workflowSpec: skillSpec('malformed'), run: 'floor-bad', outDir, workspace: WS, buildCommand: stubBuilder() }),
    ).rejects.toThrow(/manifest violation — requires ⊄ allowed/);
    await fs.rm(outDir, { recursive: true, force: true });
  });
});
