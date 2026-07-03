// `piflowctl reply` — the CLI courier for a PARKED human-checkpoint (HITL) node. THIN integration test
// (test-discipline §0, "pipeline/orchestration glue" row): a real on-disk run dir + a real marker, driven
// through `runReplyCli` end to end, then verified against the runner's OWN readers (`readReply` +
// `validateReply`) — the same oracle the checkpoint lane itself uses. No mocks: every dependency here is
// the real core module.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runReplyCli } from '../src/reply.js';
import { buildMarker, writeMarker, readReply, validateReply, checkpointMarkerFile, piDir } from '@piflow/core';

describe('runReplyCli — answers a pending checkpoint end to end', () => {
  let TMP: string;
  let runDir: string;

  beforeEach(async () => {
    TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-reply-cli-'));
    runDir = path.join(TMP, 'run');
    await fs.mkdir(piDir(runDir), { recursive: true }); // makes resolveNodeRunDir treat runDir as a real run
  });
  afterEach(async () => {
    await fs.rm(TMP, { recursive: true, force: true });
  });

  it('a confirm checkpoint: "yes" writes a reply readReply/validateReply ACCEPT with value===true, and exits 0', async () => {
    const marker = buildMarker('gate', 'Gate', { kind: 'confirm', prompt: 'proceed?' }, 'now');
    await writeMarker(runDir, marker);

    const code = await runReplyCli([runDir, 'gate', 'yes']);
    expect(code).toBe(0);

    const reply = await readReply(runDir, 'gate');
    expect(reply).not.toBeNull();
    const verdict = validateReply(marker, reply!);
    expect(verdict).toEqual({ ok: true, value: true });
  });

  it('no pending marker for that checkpoint id: exits 1 and writes NO reply file', async () => {
    const code = await runReplyCli([runDir, 'no-such-checkpoint', 'yes']);
    expect(code).toBe(1);

    const reply = await readReply(runDir, 'no-such-checkpoint');
    expect(reply).toBeNull();
  });

  it('an invalid value for the marker kind (bad confirm word): exits 1 and writes NO reply file', async () => {
    const marker = buildMarker('gate', 'Gate', { kind: 'confirm', prompt: 'proceed?' }, 'now');
    await writeMarker(runDir, marker);

    const code = await runReplyCli([runDir, 'gate', 'maybe']);
    expect(code).toBe(1);

    const reply = await readReply(runDir, 'gate');
    expect(reply).toBeNull();
  });

  it('a select checkpoint: an in-choices value round-trips through the marker file untouched', async () => {
    const marker = buildMarker('gate', 'Gate', { kind: 'select', prompt: 'A or B?', choices: ['A', 'B'], default: 'A' }, 'now');
    await writeMarker(runDir, marker);

    const code = await runReplyCli([runDir, 'gate', 'B', '--by', 'operator']);
    expect(code).toBe(0);

    // The marker itself is untouched (the reply is a SEPARATE file) — proves the CLI never mutates the question.
    const onDisk = JSON.parse(await fs.readFile(checkpointMarkerFile(runDir, 'gate'), 'utf8'));
    expect(onDisk).toEqual(marker);

    const reply = await readReply(runDir, 'gate');
    expect(validateReply(marker, reply!)).toEqual({ ok: true, value: 'B' });
    expect(reply!.by).toBe('operator');
  });
});
