// A fake `optimize --binding` module for the A2 distiller-wire test — like fake-binding.mjs but its `fixer`
// reports a traced `foundRoot`, and it exports an optional `distill` stage. The real product distiller (game-omni)
// is a `claude -p` call; this echoes the foundRoot into the Root prose so the test can prove the thread end-to-end
// (fixer.foundRoot → record → distillAppendedLessons → distillLesson → the lesson block's **Root:**).
export const oracle = async () => ({ marker: 'VALIDATION_PASSED', passed: true, fidelity: [{ id: 'M2-A3', status: 'pass' }] });
export const copyScope = async (node) => `cand:${node}`;
export const fixer = async () => ({ editsApplied: 1, candidatePassedProductChecks: true, tokensSpent: 10, foundRoot: 'traced: empty artifact before write barrier' });
// the injected distiller: echoes the fixer's foundRoot into Root (proves the thread), a fixed Prevention.
export const distill = async ({ foundRoot }) => ({ root: `R:${foundRoot}`, prevention: 'P' });
