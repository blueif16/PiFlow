// `piflowctl reply <run> <checkpointId> <value> [--by <who>]` — answer a PARKED human-checkpoint (HITL)
// node from the CLI. The runner's checkpoint lane (runner/checkpoint.ts) watches for a reply file at
// `.pi/checkpoints/<id>.reply.json`; this command IS a reply courier, same contract as the GUI's
// `POST /__piflow/checkpoint/<run>` (gui/scripts/lib/checkpoint-reply.mjs) — it reads the pending
// MARKER (`.pi/checkpoints/<id>.json`) to get the question's `hash`/`kind`/`choices`, coerces the raw
// CLI string into the typed value the marker's `kind` needs, and writes the reply the runner is
// already polling for. It NEVER writes a reply the runner would silently ignore: `buildReply` (coerce)
// and `validateReply` (the runner's own authority) both gate the write, in that order — fail loud
// BEFORE touching disk.
import { promises as fs } from 'node:fs';
import {
  readMarker,
  validateReply,
  buildReply,
  checkpointsDir,
  checkpointReplyFile,
  type CheckpointReply,
} from '@piflow/core';
import { resolveNodeRunDir } from './node.js';

/** Parsed `piflowctl reply` args. */
interface ReplyArgs {
  run: string;
  checkpointId: string;
  value: string;
  by?: string;
}

function parseReplyArgs(argv: string[]): ReplyArgs {
  const positionals: string[] = [];
  let by: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--by') by = argv[++i];
    else positionals.push(a);
  }
  const out: ReplyArgs = { run: positionals[0] ?? '', checkpointId: positionals[1] ?? '', value: positionals[2] ?? '' };
  if (by !== undefined) out.by = by;
  return out;
}

const USAGE = 'usage: piflowctl reply <run> <checkpointId> <value> [--by <who>]';

/**
 * The `piflowctl reply` handler. Returns the process exit code (0 on success).
 *
 * Sequence: resolve the run dir → read the pending marker (else fail: no such checkpoint) → coerce +
 * assemble the reply via `buildReply` (else fail: bad value for this kind) → belt-and-suspenders
 * `validateReply` against the runner's own authority (else fail) → write the reply file ATOMICALLY
 * (tmp + rename, mirroring `writeMarker`) → print confirmation.
 */
export async function runReplyCli(argv: string[]): Promise<number> {
  const error = (s: string): void => {
    process.stderr.write(s + '\n');
  };
  const print = (s: string): void => {
    process.stdout.write(s + '\n');
  };

  const { run, checkpointId, value, by } = parseReplyArgs(argv);
  if (!run || !checkpointId || !value) {
    error(`piflowctl reply: a run, a checkpoint id, and a value are required.\n${USAGE}`);
    return 1;
  }

  let runDir: string;
  try {
    runDir = resolveNodeRunDir({ run });
  } catch (e) {
    error((e as Error).message);
    return 1;
  }

  const marker = await readMarker(runDir, checkpointId);
  if (!marker) {
    error(`piflowctl reply: no pending checkpoint "${checkpointId}" in ${run}`);
    return 1;
  }

  // Coerce the raw string into the typed value this marker's `kind` needs. Fails LOUD before any write —
  // a reply the runner would reject never reaches disk.
  const built = buildReply(marker, value, by);
  if (!built.ok) {
    error(`piflowctl reply: ${built.reason}`);
    return 1;
  }

  // Belt: re-check against the runner's own authority. Should never fire given `buildReply` above, but a
  // reply is never written without this gate passing (the runner would otherwise silently ignore it).
  const verdict = validateReply(marker, built.reply);
  if (!verdict.ok) {
    error(`piflowctl reply: ${verdict.reason}`);
    return 1;
  }

  const reply: CheckpointReply = { ...built.reply, at: new Date().toISOString() };
  await fs.mkdir(checkpointsDir(runDir), { recursive: true });
  const file = checkpointReplyFile(runDir, checkpointId);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(reply, null, 2));
  await fs.rename(tmp, file);

  print(`✓ replied to checkpoint "${checkpointId}" (${marker.kind}): ${String(built.reply.value)} — the parked run will resume.`);
  return 0;
}
