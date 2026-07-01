// A2: a multi-round `--rounds` binding that ALSO exports the optional `distill` stage — proves the LOOP wiring
// (optimize-loop.ts's memorize stage) fills each round's newly-appended lesson prose, the same as the single-shot
// `--fix` path. Its `run(round)` lays out the CANONICAL <base>/runs/<id> layout (so templateDirFor resolves to
// <base>/template and MEMORIZE appends there), and seeds a self-originating structural failure (anomaly `failed`,
// no tier1) → the injected scoreRun turns it into a LAPSE MEMORIZE APPENDS. The distiller echoes the fixer's
// foundRoot into Root so the test can read the distilled prose back off the template's memory.md.
import { mkdtemp, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const run = async (round) => {
  const base = process.env.PIFLOW_DISTILL_LOOP_BASE ?? '/tmp';
  const runsDir = path.join(base, 'runs');
  await mkdir(runsDir, { recursive: true });
  await mkdir(path.join(base, 'template'), { recursive: true });
  // canonical <base>/runs/<id> so templateDirFor(runDir) === <base>/template.
  const dir = await mkdtemp(path.join(runsDir, `round-${round}-`));
  return dir;
};
export const oracle = async () => ({ marker: 'VALIDATION_PASSED', passed: true, fidelity: [{ id: 'M2-A3', status: 'pass' }] });
export const copyScope = async (node) => `cand:${node}`;
export const fixer = async () => ({ editsApplied: 1, candidatePassedProductChecks: true, tokensSpent: 10, foundRoot: 'traced: loop root cause' });
export const distill = async ({ foundRoot }) => ({ root: `R:${foundRoot}`, prevention: 'P' });
