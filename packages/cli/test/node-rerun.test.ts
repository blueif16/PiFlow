// `piflowctl node <run> <nodeId> --rerun` — a COLD single-node re-execution from FROZEN upstream, in an
// EXISTING run dir. It reuses run's `--from <id> --until <id> --no-resume` machinery: window = exactly that
// one node, seeded RUN (never reused) even when the journal already has it `ok`, upstream artifacts frozen +
// stat-preflighted (a missing pinned one hard-errors). No pi is spawned — the node.ts wrapper calls the REAL
// run.ts `runTemplate`, and we inject run's `runFromTemplate` seam with a stub BUILDER (mirroring
// core/test/journal.test.ts) so the REAL `runWorkflow` window/seed/preflight logic runs offline.
//
// The three load-bearing behaviors asserted (test-discipline — each MUST go red if --rerun stops forcing a
// re-execution): (1) a node already `ok` in the journal IS re-executed under --rerun; (2) upstream nodes stay
// reused (NOT re-executed); (3) a missing pinned upstream artifact HARD-errors (non-zero exit, names it).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runNodeCli, parseNodeArgs } from '../src/node.js';
import { runTemplate as realRunTemplate, type RunDeps, type ParsedRunArgs } from '../src/run.js';
import {
  loadTemplate,
  instantiateRun,
  compile,
  runWorkflow,
  runJsonFile,
  type RunStatus,
} from '@piflow/core';

// The offline stub builder (mirrors core/test/journal.test.ts): each node writes its declared artifact(s)
// into the sandbox output dir + returns an ok block; `ran` records which nodes actually EXECUTED (the reuse
// oracle — a reused node never calls the builder).
function stubBuilder(ran: Set<string>) {
  return (node: { id: string; io: { artifacts: { path: string }[] }; sandbox: { output: string } }): string => {
    ran.add(node.id);
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

/** The run.ts deps: stub the pi-spawning template-join with a REAL `runWorkflow` over the stub builder. The
 *  window/seed/preflight logic under test lives in `runWorkflow`, so this exercises it for real (only the
 *  agent command is faked). `ran` is shared so the tests read which nodes executed. */
function makeRunDeps(ran: Set<string>): RunDeps {
  const stubJoin: NonNullable<RunDeps['runFromTemplate']> = async (templateDir, opts) => {
    const spec = await loadTemplate(templateDir);
    await instantiateRun(templateDir, opts.runDir, { workspace: opts.workspace ?? path.resolve(templateDir, '..') });
    const wf = compile(spec);
    const { status } = await runWorkflow(wf, {
      run: opts.run,
      outDir: opts.runDir,
      workspace: opts.workspace,
      from: opts.from,
      until: opts.until,
      noResume: opts.noResume,
      rerunNodes: opts.rerunNodes,
      args: opts.args ?? {},
      buildCommand: stubBuilder(ran),
      lease: false,
    });
    return { status, outDir: opts.runDir };
  };
  return { runFromTemplate: stubJoin, print: () => {} };
}

/** Write a minimal CANONICAL linear template `n0 → n1 → n2` (each its own stage, distinct artifacts). */
async function writeLinearTemplate(templateDir: string): Promise<void> {
  await fs.mkdir(templateDir, { recursive: true });
  await fs.writeFile(
    path.join(templateDir, 'meta.json'),
    JSON.stringify({ id: 'lin', name: 'lin', description: 'linear rerun fixture', phases: ['s0', 's1', 's2'] }, null, 2),
  );
  const node = async (id: string, phase: string, deps: string[]) => {
    const dir = path.join(templateDir, 'nodes', id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'node.json'),
      JSON.stringify(
        {
          id,
          phase,
          deps,
          prompt: { file: 'prompt.md' },
          tools: { allow: ['read', 'write', 'submit_result'] },
          contract: { artifacts: [`${id}.txt`], owns: [`${id}.txt`], readScope: ['{{RUN}}'], returnMode: 'optional' },
        },
        null,
        2,
      ),
    );
    await fs.writeFile(path.join(dir, 'prompt.md'), `do ${id}`);
  };
  await node('n0', 's0', []);
  await node('n1', 's1', ['n0']);
  await node('n2', 's2', ['n1']);
}

describe('piflowctl node --rerun — cold single-node re-execution from frozen upstream', () => {
  let root: string;
  let templateDir: string;
  let runDir: string;
  let ran: Set<string>;
  let nodeRunTemplate: (parsed: ParsedRunArgs) => Promise<{ status: RunStatus; outDir: string } | undefined>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-node-rerun-'));
    // CANONICAL product tree: <root>/.piflow/lin/{template, runs/r1}. node.ts derives the template from the
    // run dir as `<run>/../../template`, and run.ts lands the run in its canonical `runs/<id>` home — so the
    // rerun writes back into the SAME existing run dir.
    templateDir = path.join(root, '.piflow', 'lin', 'template');
    runDir = path.join(root, '.piflow', 'lin', 'runs', 'r1');
    await writeLinearTemplate(templateDir);

    ran = new Set<string>();
    const runDeps = makeRunDeps(ran);
    nodeRunTemplate = (parsed: ParsedRunArgs) => realRunTemplate(parsed, runDeps);

    // Seed run 1 — a FULL run into the canonical home: every node executes ok, journal + artifacts on disk.
    await realRunTemplate(
      { templateDir, dryRun: false, run: 'r1', args: {}, sandbox: 'inmemory' },
      runDeps,
    );
    expect(ran.has('n0') && ran.has('n1') && ran.has('n2')).toBe(true);
    // sanity: the run really landed in the canonical run dir with its artifacts frozen on disk.
    expect((await fs.stat(path.join(runDir, 'n1.txt'))).isFile()).toBe(true);
    ran.clear(); // from here, `ran` records ONLY what the --rerun re-executes.
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  // (1) the headline: a node already `ok` in the journal IS re-executed under --rerun (forced RUN), while
  // (2) its upstream (and the out-of-window downstream) stay REUSED — never re-executed.
  it('re-executes the already-ok target node and leaves upstream/downstream reused', async () => {
    const errs: string[] = [];
    const code = await runNodeCli([runDir, 'n1', '--rerun'], {
      runTemplate: nodeRunTemplate,
      print: () => {},
      error: (s) => errs.push(s),
    });

    expect(code).toBe(0);
    expect(errs).toHaveLength(0);
    // #1 — n1 was already `ok` (present artifact, unchanged envelope) yet --rerun FORCED it to run again.
    expect(ran.has('n1')).toBe(true);
    // #2 — the frozen upstream (n0) was NOT re-executed; the out-of-window downstream (n2) wasn't either.
    expect(ran.has('n0')).toBe(false);
    expect(ran.has('n2')).toBe(false);

    // The observable run-record seam agrees: the frozen upstream is `reused`, the target re-ran to `ok`.
    // (n2 is out of the `--until n1` window — truncated from this partial run, never re-executed; `ran` above
    // already proves it did not run.)
    const status = JSON.parse(await fs.readFile(runJsonFile(runDir), 'utf8')) as RunStatus;
    expect(status.nodes.n0.status).toBe('reused');
    expect(status.nodes.n1.status).toBe('ok');
    expect(status.nodes.n2?.status).not.toBe('ok');
  });

  // (3) a missing PINNED upstream artifact hard-errors — the rerun never executes the target, exits non-zero,
  // and names the missing artifact (the frozen-upstream contract; a silent rerun on absent inputs is the bug).
  it('hard-errors (non-zero, names the artifact) when a frozen upstream artifact is missing', async () => {
    await fs.rm(path.join(runDir, 'n0.txt')); // delete a frozen upstream artifact
    const errs: string[] = [];
    const code = await runNodeCli([runDir, 'n1', '--rerun'], {
      runTemplate: nodeRunTemplate,
      print: () => {},
      error: (s) => errs.push(s),
    });

    expect(code).not.toBe(0);
    expect(ran.has('n1')).toBe(false); // hard-halted at preflight — the target never executed
    expect(errs.join('\n')).toMatch(/n0\.txt/); // names the missing upstream artifact
  });

  // (BUG B, generalized) a FAILED --rerun (halted before it ever re-executes) must not falsify the target's
  // OWN prior record to a blank "0 artifacts" stub — live-observed alongside the args clobber.
  it('a failed --rerun preserves the target\'s prior ok record instead of blanking it to 0 artifacts', async () => {
    const before = JSON.parse(await fs.readFile(runJsonFile(runDir), 'utf8')) as RunStatus;
    const priorN1 = before.nodes.n1;
    expect(priorN1.status).toBe('ok');
    expect(priorN1.artifacts.length).toBeGreaterThan(0);

    await fs.rm(path.join(runDir, 'n0.txt')); // delete a frozen upstream artifact → preflight HALT
    const code = await runNodeCli([runDir, 'n1', '--rerun'], {
      runTemplate: nodeRunTemplate,
      print: () => {},
      error: () => {},
    });

    expect(code).not.toBe(0);
    expect(ran.has('n1')).toBe(false); // never re-executed this attempt
    const after = JSON.parse(await fs.readFile(runJsonFile(runDir), 'utf8')) as RunStatus;
    // n1's own record — untouched this attempt — still carries its PRIOR real artifacts/duration/summary.
    expect(after.nodes.n1.artifacts).toEqual(priorN1.artifacts);
    expect(after.nodes.n1.durationMs).toBe(priorN1.durationMs);
    expect(after.nodes.n1.summary).toBe(priorN1.summary);
  });

  // WIRING — node.ts maps `<run> <id> --rerun` to run's window=[id,id] + an EXPLICIT rerun-set (force RUN the
  // target, force-REUSE the rest) over the derived template, honoring the same run flags. A SPY captures the
  // args; this is the crisp RED signal (baseline `--rerun` is an unknown flag → runTemplate is never called).
  it('threads from=until=nodeId + rerunNodes={id} (NOT noResume) + the derived templateDir/runId, honoring run flags', async () => {
    let seen: ParsedRunArgs | undefined;
    const code = await runNodeCli(
      [runDir, 'n1', '--rerun', '--sandbox', 'local', '--thinking', 'low', '--provider', 'mmgw', '--workspace', '/w'],
      {
        runTemplate: (p: ParsedRunArgs) => {
          seen = p;
          return Promise.resolve(undefined);
        },
        print: () => {},
        error: () => {},
      },
    );

    expect(code).toBe(0);
    expect(seen?.from).toBe('n1');
    expect(seen?.until).toBe('n1');
    // --rerun forces EXACTLY the target via an explicit rerun-set, NOT a blanket journal-ignore (noResume) —
    // a `noResume:true` window would re-run every SIBLING sharing the target's parallel stage (the defect).
    expect(seen?.noResume).toBeFalsy();
    expect(seen?.rerunNodes && [...seen.rerunNodes]).toEqual(['n1']);
    expect(seen?.dryRun).toBe(false);
    expect(seen?.run).toBe('r1'); // the existing run id (basename of the run dir)
    expect(seen?.templateDir).toBe(templateDir); // derived `<run>/../../template`
    expect(seen?.sandbox).toBe('local');
    expect(seen?.thinking).toBe('low');
    expect(seen?.provider).toBe('mmgw');
    expect(seen?.workspace).toBe('/w');
  });

  // `--executor <v>` on `node --rerun` — a PER-TARGET override (the one-run "run this node on claude-code"
  // door; the template's authored executor is untouched). Lands as executorOverride={[nodeId]: v}, exactly
  // the run verb's per-node form; a typo errors loudly (parity with run's parseExecutorValue).
  it('threads --executor <v> as executorOverride for the target node', async () => {
    let seen: ParsedRunArgs | undefined;
    const code = await runNodeCli(
      [runDir, 'n1', '--rerun', '--executor', 'claude-code'],
      {
        runTemplate: (p: ParsedRunArgs) => {
          seen = p;
          return Promise.resolve(undefined);
        },
        print: () => {},
        error: () => {},
      },
    );
    expect(code).toBe(0);
    expect(seen?.executorOverride).toEqual({ n1: 'claude-code' });
    expect(seen?.executor).toBeUndefined(); // per-target only — never a run-level default
  });

  it('rejects an unknown --executor value loudly (never a silent wrong binary)', async () => {
    const errors: string[] = [];
    let called = false;
    const code = await runNodeCli(
      [runDir, 'n1', '--rerun', '--executor', 'claud-code'],
      {
        runTemplate: () => {
          called = true;
          return Promise.resolve(undefined);
        },
        print: () => {},
        error: (m: string) => errors.push(m),
      },
    );
    expect(code).toBe(1);
    expect(called).toBe(false);
    expect(errors.join('\n')).toMatch(/unknown --executor/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PARALLEL STAGE — the real topology `--rerun` must handle: many nodes share ONE parallel stage (game-omni's
// producers: asset/guidance/model/shell/sound). `from=until=target` windows the WHOLE stage, so a blanket
// `noResume:true` would force EVERY sibling to re-run (re-firing their expensive merge hooks). The explicit
// rerun-set must isolate exactly ONE node: target RUNs, siblings stay REUSED. This is the coverage gap that
// hid the defect — it MUST be RED against a `noResume:true` impl (siblings re-run) and GREEN after the fix.
// ─────────────────────────────────────────────────────────────────────────────

/** Write a CANONICAL template with a 3-way PARALLEL stage `up → {sib-a, target, sib-b}` (disjoint owns). */
async function writeParallelTemplate(templateDir: string): Promise<void> {
  await fs.mkdir(templateDir, { recursive: true });
  await fs.writeFile(
    path.join(templateDir, 'meta.json'),
    JSON.stringify({ id: 'par', name: 'par', description: 'parallel-stage rerun fixture', phases: ['up', 'work'] }, null, 2),
  );
  const node = async (id: string, phase: string, deps: string[]) => {
    const dir = path.join(templateDir, 'nodes', id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'node.json'),
      JSON.stringify(
        {
          id,
          phase,
          deps,
          prompt: { file: 'prompt.md' },
          tools: { allow: ['read', 'write', 'submit_result'] },
          contract: { artifacts: [`${id}.txt`], owns: [`${id}.txt`], readScope: ['{{RUN}}'], returnMode: 'optional' },
        },
        null,
        2,
      ),
    );
    await fs.writeFile(path.join(dir, 'prompt.md'), `do ${id}`);
  };
  await node('up', 'up', []);
  // all three depend ONLY on `up` and nothing depends on them → they land in ONE parallel stage together.
  await node('sib-a', 'work', ['up']);
  await node('target', 'work', ['up']);
  await node('sib-b', 'work', ['up']);
}

describe('piflowctl node --rerun — isolates ONE node in a shared PARALLEL stage', () => {
  let root: string;
  let templateDir: string;
  let runDir: string;
  let ran: Set<string>;
  let nodeRunTemplate: (parsed: ParsedRunArgs) => Promise<{ status: RunStatus; outDir: string } | undefined>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-node-rerun-par-'));
    templateDir = path.join(root, '.piflow', 'par', 'template');
    runDir = path.join(root, '.piflow', 'par', 'runs', 'r1');
    await writeParallelTemplate(templateDir);

    ran = new Set<string>();
    const runDeps = makeRunDeps(ran);
    nodeRunTemplate = (parsed: ParsedRunArgs) => realRunTemplate(parsed, runDeps);

    // Seed run 1 — a FULL run: up + all three parallel producers execute ok, artifacts frozen on disk.
    await realRunTemplate({ templateDir, dryRun: false, run: 'r1', args: {}, sandbox: 'inmemory' }, runDeps);
    expect(ran.has('sib-a') && ran.has('target') && ran.has('sib-b')).toBe(true);
    ran.clear();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  // THE headline the linear fixture missed: only the TARGET re-runs, the siblings sharing its stage do NOT.
  it('re-runs ONLY the target; the siblings sharing its parallel stage stay reused', async () => {
    const errs: string[] = [];
    const code = await runNodeCli([runDir, 'target', '--rerun'], {
      runTemplate: nodeRunTemplate,
      print: () => {},
      error: (s) => errs.push(s),
    });

    expect(code).toBe(0);
    expect(errs).toHaveLength(0);
    // the target was already `ok`, yet --rerun forced it to run again.
    expect(ran.has('target')).toBe(true);
    // THE fix's load-bearing assertion: the stage-mates were NOT re-executed (a noResume window would).
    expect(ran.has('sib-a')).toBe(false);
    expect(ran.has('sib-b')).toBe(false);
    expect(ran.has('up')).toBe(false); // upstream reused too

    // STRONG observable-seam proof: the siblings are recorded `reused` (not merely truncated) — they are IN
    // the selected window, force-reused rather than re-run.
    const status = JSON.parse(await fs.readFile(runJsonFile(runDir), 'utf8')) as RunStatus;
    expect(status.nodes.target.status).toBe('ok');
    expect(status.nodes['sib-a'].status).toBe('reused');
    expect(status.nodes['sib-b'].status).toBe('reused');
    expect(status.nodes.up.status).toBe('reused');
  });

  // The frozen-upstream stat-preflight still applies with the rerun-set (kept via from=until=target).
  it('still hard-errors when a frozen upstream artifact is missing', async () => {
    await fs.rm(path.join(runDir, 'up.txt'));
    const errs: string[] = [];
    const code = await runNodeCli([runDir, 'target', '--rerun'], {
      runTemplate: nodeRunTemplate,
      print: () => {},
      error: (s) => errs.push(s),
    });

    expect(code).not.toBe(0);
    expect(ran.has('target')).toBe(false); // hard-halted at preflight
    expect(errs.join('\n')).toMatch(/up\.txt/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// `--arg` PARSING + the recorded-args FALLBACK (BUG A) — live-observed: `node --rerun --arg k=v` failed with
// "unresolved run arg" because `parseNodeArgs` never recognized `--arg` at all (its value was silently
// dropped as a stray positional), so a `--rerun` always executed with `args: {}` regardless of what the user
// passed. The fix: `node --rerun` parses repeated `--arg k=v` exactly like the `run` verb, and when NONE are
// given it falls back to the run's OWN recorded `.pi/run.json` args — so a zero-flag rerun of a run that
// recorded args just works.
// ─────────────────────────────────────────────────────────────────────────────

describe('parseNodeArgs — parses repeated `--arg k=v` (mirrors run.ts)', () => {
  it('parses a single --arg k=v pair', () => {
    expect(parseNodeArgs(['r1', 'n0', '--rerun', '--arg', 'bookId=1']).args).toEqual({ bookId: '1' });
  });

  it('parses REPEATED --arg flags into one map', () => {
    const parsed = parseNodeArgs(['r1', 'n0', '--rerun', '--arg', 'bookId=1', '--arg', 'sectionId=3']);
    expect(parsed.args).toEqual({ bookId: '1', sectionId: '3' });
  });

  it('does not pollute positionals with --arg values (run/nodeId stay r1/n0)', () => {
    const parsed = parseNodeArgs(['r1', 'n0', '--rerun', '--arg', 'bookId=1', '--arg', 'sectionId=3']);
    expect(parsed.run).toBe('r1');
    expect(parsed.nodeId).toBe('n0');
  });

  it('only the FIRST "=" splits key from value (a value may itself contain "=")', () => {
    expect(parseNodeArgs(['r1', 'n0', '--rerun', '--arg', 'expr=a=b']).args).toEqual({ expr: 'a=b' });
  });

  it('no --arg at all ⇒ an empty args map (the CLI fallback decides what happens next)', () => {
    expect(parseNodeArgs(['r1', 'n0', '--rerun']).args).toEqual({});
  });
});

/** A single-node template whose PROMPT references `{{arg.bookId}}` — an unresolved arg throws at
 *  token-resolution time (node-lifecycle U7), failing the node with status 'error' (never silently). This
 *  is the fixture that proves the `--rerun` args fallback actually restores real EXECUTION behavior, not
 *  just plumbing. */
async function writeArgTemplate(templateDir: string): Promise<void> {
  await fs.mkdir(templateDir, { recursive: true });
  await fs.writeFile(
    path.join(templateDir, 'meta.json'),
    JSON.stringify({ id: 'argt', name: 'argt', description: 'arg-fallback rerun fixture', phases: ['s0'] }, null, 2),
  );
  const dir = path.join(templateDir, 'nodes', 'n0');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'node.json'),
    JSON.stringify(
      {
        id: 'n0',
        phase: 's0',
        deps: [],
        prompt: { file: 'prompt.md' },
        tools: { allow: ['read', 'write', 'submit_result'] },
        contract: { artifacts: ['n0.txt'], owns: ['n0.txt'], readScope: ['{{RUN}}'], returnMode: 'optional' },
      },
      null,
      2,
    ),
  );
  await fs.writeFile(path.join(dir, 'prompt.md'), 'do node for book {{arg.bookId}}');
}

describe('piflowctl node --rerun — --arg parsing + recorded-args fallback (BUG A)', () => {
  let root: string;
  let templateDir: string;
  let runDir: string;
  let ran: Set<string>;
  let nodeRunTemplate: (parsed: ParsedRunArgs) => Promise<{ status: RunStatus; outDir: string } | undefined>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-node-rerun-args-'));
    templateDir = path.join(root, '.piflow', 'argt', 'template');
    runDir = path.join(root, '.piflow', 'argt', 'runs', 'r1');
    await writeArgTemplate(templateDir);

    ran = new Set<string>();
    const runDeps = makeRunDeps(ran);
    nodeRunTemplate = (parsed: ParsedRunArgs) => realRunTemplate(parsed, runDeps);

    // Seed run 1 — a FULL run WITH the arg the prompt needs, recorded into `.pi/run.json`.
    await realRunTemplate({ templateDir, dryRun: false, run: 'r1', args: { bookId: '7' }, sandbox: 'inmemory' }, runDeps);
    expect(ran.has('n0')).toBe(true);
    const seeded = JSON.parse(await fs.readFile(runJsonFile(runDir), 'utf8')) as RunStatus;
    expect(seeded.args).toEqual({ bookId: '7' }); // sanity: the recorded args really carry the arg
    ran.clear();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('a zero-flag --rerun falls back to the run\'s recorded args and resolves {{arg.*}}', async () => {
    const errs: string[] = [];
    const code = await runNodeCli([runDir, 'n0', '--rerun'], {
      runTemplate: nodeRunTemplate,
      print: () => {},
      error: (s) => errs.push(s),
    });

    expect(code).toBe(0);
    expect(errs).toHaveLength(0);
    expect(ran.has('n0')).toBe(true); // re-executed (not preflight-halted)
    const status = JSON.parse(await fs.readFile(runJsonFile(runDir), 'utf8')) as RunStatus;
    expect(status.nodes.n0.status).toBe('ok'); // NOT 'error' — {{arg.bookId}} resolved
  });

  it('an explicit --arg on --rerun is parsed and forwarded (like the run verb)', async () => {
    let seen: ParsedRunArgs | undefined;
    const code = await runNodeCli([runDir, 'n0', '--rerun', '--arg', 'bookId=9'], {
      runTemplate: (p: ParsedRunArgs) => {
        seen = p;
        return Promise.resolve(undefined);
      },
      print: () => {},
      error: () => {},
    });

    expect(code).toBe(0);
    expect(seen?.args).toEqual({ bookId: '9' });
  });

  it('without the fix, a zero-flag --rerun would run with args:{} and the node ends "error" (documents the live symptom)', async () => {
    // Directly exercises the OLD hardcoded shape (`args: {}`) to pin the exact failure the fix removes —
    // an unresolved {{arg.bookId}} fails the node with 'error', never a silent pass.
    const runDeps2 = makeRunDeps(ran);
    const { status } = (await realRunTemplate(
      { templateDir, dryRun: false, run: 'r1', from: 'n0', until: 'n0', rerunNodes: new Set(['n0']), args: {}, sandbox: 'inmemory' },
      runDeps2,
    ))!;
    expect(status.nodes.n0.status).toBe('error');
    expect(status.nodes.n0.issues.join(' ')).toMatch(/unresolved run arg "bookId"/);
  });
});
