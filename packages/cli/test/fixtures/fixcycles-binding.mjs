// A fake `optimize --binding` module that ALSO exports its OWN fix-cycle counter port (readFixCycles/
// bumpFixCycles) — the game-omni case. It PROVES precedence: when a binding hand-rolls the port, the CLI's
// makeDefaultFixCyclesPort must NOT override it, and no default `<runDir>/optimize/.fixcycles-*.json` sidecar
// is created. To make "the binding's own port was consulted" OBSERVABLE from the test without a shared global,
// the port writes to a DISTINCT sidecar path keyed off PIFLOW_TEST_FIXCYCLES_DIR (a dir the test owns), never
// the default `<runDir>/optimize/` location.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const dir = () => process.env.PIFLOW_TEST_FIXCYCLES_DIR ?? path.join(process.cwd(), '.piflow-test-fixcycles');
const sidecar = (node) => path.join(dir(), `own-${String(node).replace(/[^\w.-]/g, '_')}.json`);

export const oracle = async () => ({ marker: 'VALIDATION_PASSED', passed: true, fidelity: [{ id: 'M2-A3', status: 'pass' }] });
export const copyScope = async (node) => `cand:${node}`;
export const fixer = async () => ({ editsApplied: 1, candidatePassedProductChecks: true, tokensSpent: 10 });

export function readFixCycles(node) {
  const p = sidecar(node);
  if (!existsSync(p)) return 0;
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'));
    return Number.isInteger(data.cycles) && data.cycles >= 0 ? data.cycles : 0;
  } catch {
    return 0;
  }
}

export function bumpFixCycles(node) {
  const p = sidecar(node);
  const cycles = readFixCycles(node);
  mkdirSync(dir(), { recursive: true });
  writeFileSync(p, JSON.stringify({ node, cycles: cycles + 1 }, null, 2) + '\n', 'utf8');
}
