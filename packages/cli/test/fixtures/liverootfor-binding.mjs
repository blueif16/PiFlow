// A fake `optimize --binding` module that ALSO exports the OPTIONAL `liveRootFor` stage — the product-side reverse
// of copyScope (the LIVE dir each candidate mirrors), so `--fix` records a non-empty `liveRoot` per manifest record
// (which `--adopt` then replays). oracle passes (base 0 → candidate 1.0 → the strict-improvement gate accepts).
export const oracle = async () => ({ marker: 'VALIDATION_PASSED', passed: true, fidelity: [{ id: 'M2-A3', status: 'pass' }] });
export const copyScope = async (node) => `cand:${node}`;
export const fixer = async () => ({ editsApplied: 1, candidatePassedProductChecks: true, tokensSpent: 10 });
// the injected reverse-of-copyScope: a fixed live dir keyed off the defect's node (a real product computes the path).
export const liveRootFor = (defect) => `/live/${defect.node}`;
