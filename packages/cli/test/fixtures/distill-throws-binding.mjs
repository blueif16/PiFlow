// A2: a binding whose injected `distill` THROWS — proves the CLI's off-critical-path wrapper swallows a bad
// distiller (distillLesson already degrades to 'skipped'; the --fix run must still complete + stage). Same
// fixer/oracle/copyScope shape as distill-binding.mjs; only the distiller differs.
export const oracle = async () => ({ marker: 'VALIDATION_PASSED', passed: true, fidelity: [{ id: 'M2-A3', status: 'pass' }] });
export const copyScope = async (node) => `cand:${node}`;
export const fixer = async () => ({ editsApplied: 1, candidatePassedProductChecks: true, tokensSpent: 10, foundRoot: 'traced: something' });
export const distill = async () => { throw new Error('model timed out at 20min'); };
