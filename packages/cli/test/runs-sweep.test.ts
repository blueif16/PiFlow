// `piflowctl runs sweep [--dry-run|--apply] [--include-frozen] [--json]` — the REGISTRY-WIDE audit (every
// registered product, not one workflow) that force-closes STUCK `!done` runs the live orphan-detection
// (observe/read.ts's `isRunOrphaned`) can never resolve on its own: a run with no `controllerPid` recorded
// at all, or a `frozen:true` run that never got resumed. Real fixture repos + the real
// discoverRunDirs/readRunJson/finalizeRun (via `@piflow/core`) — only `loadRegistry` is injected (pointing at
// the fixture repos), so no test ever touches the real `~/.piflow/products.json`.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runJsonFile, readRunJson, type Registry, type RunStatus } from '@piflow/core';
import { parseRunsSweepArgs, runRunsSweepCli, type SweepRow } from '../src/runs-sweep.js';

/** A repo with one workflow template — the discoverNamespaces/discoverRunDirs canonical §D9 shape. */
function fixtureRepo(wf: string): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'piflow-sweep-repo-'));
  const tpl = path.join(repo, '.piflow', wf, 'template', 'meta.json');
  mkdirSync(path.dirname(tpl), { recursive: true });
  writeFileSync(tpl, JSON.stringify({ id: wf, name: wf }));
  return repo;
}

/** Materialize `<repo>/.piflow/<wf>/runs/<id>/.pi/run.json`. */
function writeRun(repo: string, wf: string, id: string, over: Partial<RunStatus> = {}): string {
  const runDir = path.join(repo, '.piflow', wf, 'runs', id);
  const rj = runJsonFile(runDir);
  mkdirSync(path.dirname(rj), { recursive: true });
  const full: RunStatus = {
    run: id,
    startedAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    done: false,
    ok: null,
    durationMs: null,
    stage: null,
    totals: null,
    nodes: { n1: { id: 'n1', label: 'N1', status: 'running', artifacts: [], issues: [] } },
    ...over,
  };
  writeFileSync(rj, JSON.stringify(full));
  return runDir;
}

function registryOf(...roots: string[]): Registry {
  return { products: roots.map((root, i) => ({ id: `p${i}`, name: `p${i}`, root })) };
}

describe('parseRunsSweepArgs', () => {
  it('defaults to dry-run (apply:false) when NEITHER flag is passed', () => {
    expect(parseRunsSweepArgs([])).toMatchObject({ apply: false, includeFrozen: false, json: false });
  });
  it('--apply sets apply:true', () => {
    expect(parseRunsSweepArgs(['--apply']).apply).toBe(true);
  });
  it('--dry-run always wins over --apply, regardless of order — --apply is NEVER the default under any combination', () => {
    expect(parseRunsSweepArgs(['--apply', '--dry-run']).apply).toBe(false);
    expect(parseRunsSweepArgs(['--dry-run', '--apply']).apply).toBe(false);
  });
  it('--include-frozen and --json parse independently of --apply', () => {
    expect(parseRunsSweepArgs(['--include-frozen', '--json'])).toMatchObject({ apply: false, includeFrozen: true, json: true });
  });
});

describe('runRunsSweepCli — classification + write gating', () => {
  it('no flags: writes ZERO files (a stuck-no-pid run.json is byte- and mtime-unchanged)', async () => {
    const repo = fixtureRepo('wf1');
    const runDir = writeRun(repo, 'wf1', 'stuck-1'); // done:false, no controllerPid, not frozen
    const rj = runJsonFile(runDir);
    const beforeContent = readFileSync(rj, 'utf8');
    const beforeMtime = statSync(rj).mtimeMs;

    const code = await runRunsSweepCli([], { loadRegistry: () => registryOf(repo) });

    expect(code).toBe(0);
    expect(readFileSync(rj, 'utf8')).toBe(beforeContent);
    expect(statSync(rj).mtimeMs).toBe(beforeMtime);
    const after = await readRunJson(runDir);
    expect(after!.done).toBe(false); // untouched
  });

  it('--dry-run explicit: also writes ZERO files', async () => {
    const repo = fixtureRepo('wf1');
    const runDir = writeRun(repo, 'wf1', 'stuck-1');
    const rj = runJsonFile(runDir);
    const beforeContent = readFileSync(rj, 'utf8');
    const beforeMtime = statSync(rj).mtimeMs;

    await runRunsSweepCli(['--dry-run'], { loadRegistry: () => registryOf(repo) });

    expect(readFileSync(rj, 'utf8')).toBe(beforeContent);
    expect(statSync(rj).mtimeMs).toBe(beforeMtime);
  });

  it('--apply (no --include-frozen): finalizes stuck-no-pid, leaves a frozen run COMPLETELY untouched', async () => {
    const repo = fixtureRepo('wf1');
    const stuckDir = writeRun(repo, 'wf1', 'stuck-1'); // no controllerPid, not frozen
    const frozenDir = writeRun(repo, 'wf1', 'frozen-1', { frozen: true, controllerPid: 4242 });

    const code = await runRunsSweepCli(['--apply'], { loadRegistry: () => registryOf(repo) });

    expect(code).toBe(0);
    const stuckAfter = await readRunJson(stuckDir);
    expect(stuckAfter!.done).toBe(true);
    expect(stuckAfter!.ok).toBe(false);

    const frozenAfter = await readRunJson(frozenDir);
    expect(frozenAfter!.done).toBe(false); // completely untouched
    expect(frozenAfter!.frozen).toBe(true);
  });

  it('--apply --include-frozen: finalizes BOTH stuck-no-pid AND frozen', async () => {
    const repo = fixtureRepo('wf1');
    const stuckDir = writeRun(repo, 'wf1', 'stuck-1');
    const frozenDir = writeRun(repo, 'wf1', 'frozen-1', { frozen: true, controllerPid: 4242 });

    await runRunsSweepCli(['--apply', '--include-frozen'], { loadRegistry: () => registryOf(repo) });

    expect((await readRunJson(stuckDir))!.done).toBe(true);
    expect((await readRunJson(frozenDir))!.done).toBe(true);
  });

  it('an auto-heals run (controllerPid + NOT frozen) is NEVER written, under --apply --include-frozen or any combination', async () => {
    const repo = fixtureRepo('wf1');
    const autoHealDir = writeRun(repo, 'wf1', 'live-1', { controllerPid: 99999 }); // has a pid, not frozen
    const rj = runJsonFile(autoHealDir);
    const beforeContent = readFileSync(rj, 'utf8');

    await runRunsSweepCli(['--apply', '--include-frozen'], { loadRegistry: () => registryOf(repo) });

    expect(readFileSync(rj, 'utf8')).toBe(beforeContent); // byte-identical — never written
    expect((await readRunJson(autoHealDir))!.done).toBe(false);
  });

  it('classifies each bucket correctly and reports via --json (one row per !done run, done runs excluded)', async () => {
    const repo = fixtureRepo('wf1');
    writeRun(repo, 'wf1', 'stuck-1');
    writeRun(repo, 'wf1', 'frozen-1', { frozen: true });
    writeRun(repo, 'wf1', 'live-1', { controllerPid: 123 });
    writeRun(repo, 'wf1', 'finished-1', { done: true, ok: true }); // done ⇒ excluded entirely

    const printed: string[] = [];
    await runRunsSweepCli(['--json'], { loadRegistry: () => registryOf(repo), print: (s) => printed.push(s) });

    const rows = JSON.parse(printed.join('')) as SweepRow[];
    expect(rows).toHaveLength(3); // finished-1 excluded
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId['stuck-1'].bucket).toBe('stuck-no-pid');
    expect(byId['frozen-1'].bucket).toBe('frozen');
    expect(byId['live-1'].bucket).toBe('auto-heals');
    expect(byId['finished-1']).toBeUndefined();
  });

  it('scans EVERY registered product, not just one — registry-wide, not one-workflow scoped', async () => {
    const repoA = fixtureRepo('wfA');
    const repoB = fixtureRepo('wfB');
    writeRun(repoA, 'wfA', 'a-stuck');
    writeRun(repoB, 'wfB', 'b-stuck');

    const printed: string[] = [];
    await runRunsSweepCli(['--json'], { loadRegistry: () => registryOf(repoA, repoB), print: (s) => printed.push(s) });

    const rows = JSON.parse(printed.join('')) as SweepRow[];
    expect(rows.map((r) => r.id).sort()).toEqual(['a-stuck', 'b-stuck']);
  });
});
