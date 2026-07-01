// A fake `optimize --rounds` binding — like fake-binding.mjs but ALSO exports the `run(round)` stage the
// multi-round loop needs (the product runs its workflow and returns the round's run dir). Here `run` mkdtemps a
// fresh run dir under PIFLOW_FAKE_LOOP_BASE per round and seeds the incumbent's recorded verify report (a
// degraded fail → baseScore 0) so the trace miner reads a base the strict-improvement gate can beat. The
// injected scoreRun supplies the worklist; the fake oracle passes the candidate (base 0 → cand 1.0 → accept).
// fixer/copyScope are trivial.
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const run = async (round) => {
  const base = process.env.PIFLOW_FAKE_LOOP_BASE ?? '/tmp';
  const dir = await mkdtemp(path.join(base, `round-${round}-`));
  // seed the incumbent report the trace miner reads for baseScore (a real-shaped degraded fail → 0), matching
  // the single-shot test's fixture. The node w4-execute-m2 maps to milestone M2.
  await mkdir(path.join(dir, 'verify'), { recursive: true });
  await writeFile(
    path.join(dir, 'verify', 'report.M2.json'),
    JSON.stringify({ milestoneId: 'M2', marker: 'VALIDATION_FAILED', passed: false, fixOutcome: 'exhausted' }),
  );
  return dir;
};
export const oracle = async () => ({ marker: 'VALIDATION_PASSED', passed: true, fidelity: [{ id: 'M2-A3', status: 'pass' }] });
export const copyScope = async (node) => `cand:${node}`;
export const fixer = async () => ({ editsApplied: 1, candidatePassedProductChecks: true, tokensSpent: 10 });
