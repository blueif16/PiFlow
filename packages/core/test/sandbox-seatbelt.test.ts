import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile } from '../src/dag.js';
import { runWorkflow } from '../src/runner/runner.js';
import type { NodeIntent, WorkflowSpec } from '../src/types.js';
import {
  SeatbeltSandbox,
  SeatbeltSandboxProvider,
  buildSeatbeltProfile,
} from '../src/sandbox/seatbelt.js';

// ── platform gate ─────────────────────────────────────────────────────────────────────────────────
// The EPERM enforcement test only means anything where sandbox-exec actually applies a kernel boundary.
// On non-darwin the provider runs UNSANDBOXED (by design), so an out-of-scope read would SUCCEED — that
// is correct behavior there, not a bug, so we SKIP the denial assertion with a clear message.
const darwinIt = process.platform === 'darwin' ? it : it.skip;
const SKIP_MSG = `(skipped on ${process.platform}: SeatbeltSandbox runs unsandboxed off darwin — no OS read boundary to assert)`;

// A denial-capable out-of-scope location. CRITICAL: the read-scope.sb template grants the broad
// toolchain roots wholesale — /private/var (where os.tmpdir()/mkdtemp live), /private/tmp, /usr, /System,
// $TMPDIR. A sibling staged under any of those would be readable via that grant, so a naive "sibling in
// tmp" test could never observe a denial. We therefore stage the out-of-scope tree under $HOME (the
// template grants only specific ~/.pi, ~/.npm, ~/.cache, ~/.config, ~/.nvm subpaths, NOT $HOME itself),
// which is genuinely outside every template grant and so is denied unless explicitly in readScope.
async function homeScratch(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.homedir(), `.piflow-seatbelt-test-${prefix}-`));
}

// ── helpers for the runner-lifecycle test (mirrors runner.test.ts) ─────────────────────────────────

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
  return fs.mkdtemp(path.join(os.tmpdir(), 'piflow-seatbelt-run-'));
}
// The stub command builder (port of runner.test.ts): writes each declared artifact into the node's
// sandbox OUTPUT dir at <output>/<artifactPath> (the convention downloadDir flattens onto the host run
// dir), plus a return-protocol JSON block — exercising the REAL lifecycle with no live pi.
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

// ── 1. EPERM enforcement (the core — the port of demo.sh) ──────────────────────────────────────────

describe('SeatbeltSandbox — read-scope EPERM enforcement (darwin)', () => {
  darwinIt(
    'reads an in-scope file but EPERMs a sibling out-of-scope path under the sandbox',
    async () => {
      // Stage TWO sibling trees under $HOME (outside every template grant): `granted/` is handed to the
      // sandbox via readScope; `denied/` is NOT. The exec runs under sandbox-exec, so reading the granted
      // file must SUCCEED and reading the denied sibling must return a permission error (Operation not
      // permitted), proving readScope IS the kernel-enforced boundary.
      const scratch = await homeScratch('eperm');
      const grantedDir = path.join(scratch, 'granted');
      const deniedDir = path.join(scratch, 'denied');
      await fs.mkdir(grantedDir, { recursive: true });
      await fs.mkdir(deniedDir, { recursive: true });
      await fs.writeFile(path.join(grantedDir, 'in.txt'), 'IN_SCOPE_CONTENT');
      await fs.writeFile(path.join(deniedDir, 'secret.txt'), 'OUT_OF_SCOPE_SECRET');

      const sb = await SeatbeltSandbox.create({
        readScope: [grantedDir], // grant ONLY the granted sibling; deniedDir is deliberately omitted
        outputDir: 'out',
        workdir: '.',
      });

      try {
        // In-scope read SUCCEEDS and returns the real bytes.
        const okRead = await sb.exec(`cat ${JSON.stringify(path.join(grantedDir, 'in.txt'))}`);
        expect(okRead.code).toBe(0);
        expect(okRead.stdout).toContain('IN_SCOPE_CONTENT');

        // Out-of-scope read FAILS with a kernel permission denial — NOT a missing file, NOT a profile
        // parse error. We assert: nonzero exit, the secret never leaked to stdout, and the stderr is a
        // permission denial whose source is NOT sandbox-exec itself (a profile parse error prints
        // "sandbox-exec:" and must not be mistaken for a real denial — the exact demo.sh discipline).
        const denied = await sb.exec(`cat ${JSON.stringify(path.join(deniedDir, 'secret.txt'))}`);
        expect(denied.code).not.toBe(0);
        expect(denied.stdout).not.toContain('OUT_OF_SCOPE_SECRET');
        expect(denied.stderr).not.toMatch(/^sandbox-exec:/m); // the profile loaded (not a parse error)
        expect(denied.stderr).toMatch(/Operation not permitted|Permission denied/i);

        // CONTROL: the same file reads fine UNSANDBOXED (so the denial is the sandbox, not a missing
        // file). Read it directly on the host.
        expect(await fs.readFile(path.join(deniedDir, 'secret.txt'), 'utf8')).toBe('OUT_OF_SCOPE_SECRET');
      } finally {
        await sb.dispose();
        await fs.rm(scratch, { recursive: true, force: true });
      }
    },
    20000,
  );

  it(`gates platform: profile generation is darwin-independent, EPERM assertion is darwin-only ${SKIP_MSG}`, () => {
    // The profile generator runs on ANY platform (it is pure string assembly) — assert it renders the
    // declared scope + a deny-all-reads base regardless of OS, so the gating is ONLY about whether
    // sandbox-exec wraps the exec, not about whether the profile can be built.
    const profile = buildSeatbeltProfile({ workdir: '/tmp/piflow-x', readScope: ['/some/granted/root'] });
    expect(profile).toContain('(deny file-read*)');
    expect(profile).toContain('(allow file-read-metadata)');
    expect(profile).toContain('/some/granted/root'); // the declared scope made it into the allow block
    expect(profile).not.toContain('@SCOPE_ALLOWS@'); // the token was substituted
    expect(profile).not.toContain('@HOME@');
    expect(profile).not.toContain('@TMPDIR@');
  });
});

// ── 2. plugs into the runner UNCHANGED ─────────────────────────────────────────────────────────────

describe('SeatbeltSandboxProvider — plugs into runWorkflow unchanged', () => {
  it('runs a 2-node workflow under the Seatbelt sandbox: nodes ok, artifacts verified, status ok', async () => {
    // The whole point: `provider: new SeatbeltSandboxProvider()` drops into the EXISTING runner with no
    // runner change. A producer → consumer (the consumer reads the producer's artifact, staged across
    // sandboxes via the host run dir). On darwin each node's exec is wrapped in sandbox-exec; off darwin
    // it runs unsandboxed — EITHER WAY the create→stage→exec→downloadDir→host-stat→dispose lifecycle
    // must complete and both artifacts must land on the host run dir.
    const g = compile(wf([n('Producer', [], ['a.txt']), n('Consumer', ['a.txt'], ['b.txt'])]));
    const outDir = await tmpOut();

    const { status } = await runWorkflow(g, {
      run: 'seatbelt-e2e',
      outDir,
      provider: new SeatbeltSandboxProvider(),
      buildCommand: stubBuilder(),
      nodeTimeoutMs: 15000,
    });

    expect(status.ok).toBe(true);
    expect(status.done).toBe(true);
    expect(status.nodes.producer.status).toBe('ok');
    expect(status.nodes.consumer.status).toBe('ok');
    // Artifacts verified by host-stat (downloadDir flattened <output>/<path> → <hostRunDir>/<path>).
    expect(status.nodes.consumer.artifacts).toEqual([{ path: 'b.txt', exists: true, bytes: 'consumer'.length }]);
    expect(await fs.readFile(path.join(outDir, 'a.txt'), 'utf8')).toBe('producer');
    expect(await fs.readFile(path.join(outDir, 'b.txt'), 'utf8')).toBe('consumer');

    await fs.rm(outDir, { recursive: true, force: true });
  }, 30000);
});

// ── 3. honors cancellation (process-group kill) ────────────────────────────────────────────────────

describe('SeatbeltSandbox — honors ExecOpts.signal (process-group kill, like InMemorySandbox)', () => {
  it('aborting the signal reaps the whole group: a grandchild deferred write never lands', async () => {
    // Drive ExecOpts.signal DIRECTLY against the sandbox (not via the runner) so the process-group kill
    // is observed deterministically, WITHOUT the runner's killGraceMs liveness-fallback masking whether
    // the real kill happened. A HOST marker OUTSIDE the sandbox temp dir: the command sleeps, then would
    // `touch` it — but we abort mid-sleep, which SIGTERMs the process GROUP (`-pid`, sandbox-exec → sh →
    // sleep). With detached:true the whole group dies → `sleep` is reaped → the deferred `touch` never
    // runs → the marker never appears, and exec resolves PROMPTLY (124) rather than blocking the full
    // sleep. If the provider did NOT make the child a group leader (detached:false), kill(-pid) is a
    // no-op (ESRCH), the orphaned sleep runs to completion, the marker appears, AND exec resolves only
    // after the full sleep — both of the two assertions below then fail.
    const sb = await SeatbeltSandbox.create({ readScope: [], outputDir: 'out', workdir: '.' });
    const marker = path.join(os.tmpdir(), `piflow-seatbelt-latekill-${Date.now()}.marker`);
    const ac = new AbortController();

    const t0 = Date.now();
    const execP = sb.exec(`sleep 2 && touch ${marker}`, { signal: ac.signal });
    setTimeout(() => ac.abort(), 100); // abort well before the 2s sleep ends
    const r = await execP;
    const elapsed = Date.now() - t0;

    // (a) exec resolved PROMPTLY — the group was killed, not waited out (the orphan would take ~2s).
    expect(elapsed).toBeLessThan(1500);
    expect(r.code).not.toBe(0); // signal-killed child surfaces nonzero (124)

    // (b) wait well past the would-be 2s touch; the marker must NOT appear (the grandchild was reaped).
    await new Promise((res) => setTimeout(res, 2200));
    await expect(fs.access(marker)).rejects.toThrow();

    await fs.rm(marker, { force: true }).catch(() => {});
    await sb.dispose();
  }, 15000);

  it('a node-timeout under the Seatbelt provider marks the node error (killedTimeout) via the runner', async () => {
    // The runner-level companion: a sleeping stub under SeatbeltSandboxProvider that exceeds the tiny
    // node timeout is classified error+killedTimeout (the provider honors the runner's abort). Proves the
    // cancellation wiring reaches the real status ladder, not just the bare sandbox.
    const g = compile(wf([n('Slow', [], ['slow.txt'])]));
    const outDir = await tmpOut();
    const builder = (node: { sandbox: { output: string } }): string =>
      `sleep 5 && mkdir -p ${node.sandbox.output} && printf '%s' slow > ${node.sandbox.output}/slow.txt`;

    const start = Date.now();
    const { status } = await runWorkflow(g, {
      run: 'seatbelt-timeout',
      outDir,
      provider: new SeatbeltSandboxProvider(),
      buildCommand: builder,
      nodeTimeoutMs: 80,
      killGraceMs: 50,
    });
    expect(status.nodes.slow.status).toBe('error');
    expect(status.nodes.slow.killedTimeout).toBe(true);
    expect(status.nodes.slow.artifacts).toEqual([{ path: 'slow.txt', exists: false, bytes: 0 }]);
    expect(Date.now() - start).toBeLessThan(4000); // returned promptly, not blocked ~5s on the sleep

    await fs.rm(outDir, { recursive: true, force: true });
  }, 15000);
});
