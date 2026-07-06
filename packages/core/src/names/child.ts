// ─────────────────────────────────────────────────────────────────────────────
// childRunName — a spawned CHILD run's id (optimize/substrate replay-from-node-start, M1.4):
// `<parentId>.<nodeId>`, then `.<n>` from `n=2` on a collision. The dot is the LINEAGE separator — a
// top-level run's own name is minted dot-free (generateDateSeqName / generateRunName), so `parentId`
// carries no dot itself; a child of a child (`spawnChildRun` re-fixing an already-fixed node) just grows
// the same dotted chain (`<parent>.<node>.<node2>`), still unambiguous.
//
// SAME collision contract as `generateRunName`/`generateDateSeqName`: `existing` is every sibling run name
// already in use (scanned against the SAME runs-home directory the parent lives in); the function never
// returns a name already taken.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mint `<parentId>.<nodeId>` (or, on a collision, `<parentId>.<nodeId>.<n>` starting at `n=2`) — a child
 * run's id, NOT present in `existing`.
 *
 * @param parentId the parent run's id (its run-dir basename).
 * @param nodeId   the node being replayed into the child (the lineage's disambiguator).
 * @param existing sibling run names already in use (the runs-home dir's basenames).
 */
export function childRunName(parentId: string, nodeId: string, existing: Iterable<string> = []): string {
  const taken = new Set(existing);
  const base = `${parentId}.${nodeId}`;
  if (!taken.has(base)) return base;
  let n = 2;
  let name = `${base}.${n}`;
  while (taken.has(name)) name = `${base}.${++n}`;
  return name;
}
