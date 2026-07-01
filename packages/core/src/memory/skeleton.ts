// The memory SEED skeletons (piflow-memory-v1 §4 node memory · §2.4 system memory). Leg A — self/history.
//
// These files are the OPTIMIZER's surface: the Hermes fixer / reconcile node READS + UPDATES them from a
// run's traces to improve the system (skill/prompt/config edits). They are NEVER injected into a node's
// runtime prompt — a node must not see its own failure history (it only makes the executor hesitate). The
// seed is deliberately MINIMAL: the section spine + the load-bearing invariants in the header. The full
// maintenance CONTRACT (the exclusion list, the cap mechanism, lesson>fact, retire-on-contribution) lives
// ONCE in the optimizer skill (the hermes method) — not re-pasted into every node, which is how memory rots.

/**
 * The per-node `memory.md` seed (§4). The standing state of THIS node's own behavior — current behavior,
 * the generalized failure LESSONS (not diffs), active invariants, open threads — plus the git pointer the
 * optimizer queries for the node's full change history. Pure: a deterministic function of the id.
 */
export function buildNodeMemory(id: string): string {
  return `# node: ${id} — memory
<!-- Leg A · OPTIMIZER-FACING. The Hermes fixer / reconcile node READS + UPDATES this from run traces.
     NEVER injected into ${id}'s runtime prompt — a node must not see its own failure history.
     Capped (~40 lines, top-loaded: the bottom truncates first). Maintenance contract = the optimizer skill. -->

_status: new — no runs recorded yet_

## Current behavior
<!-- what ${id} reliably does now (1–3 lines), updated from traces. -->

## Known failure modes
<!-- the generalized LESSON + WHY (not the diff). Reflect on failures, not successes.
     Write each recurring failure as a lesson block in THIS exact shape (the recurrence reader parses it, and
     the machine \`sig:\` is what flips a residual LAPSE→SKILL once it recurs; a block with no \`sig:\` is skipped):
       ### <symptom signature>
       sig: ${id}::<key>          (the machine key = signatureOf output; node::sorted-anomalies|reason)
       recurrence: <N>            (cross-run count)
       [[<okf-slice-key>]]        (the code-map slice the fixer reads)
       **Root:** <why it happens>
       **Prevention:** <the generalized guard> -->

## Active invariants
<!-- hard rules ${id} must keep (e.g. writes only within its owns/readScope). -->

## Open threads
<!-- unresolved; drop each when absorbed. -->

## History
git log --grep '^skillsys(${id})'
`;
}

/**
 * The template `memory.md` seed (§2.4) — the SYSTEM reconcile summary. Cross-node decisions, architecture
 * changes (L2 COMPOSE), DAG-level open threads. ONLY the reconcile node edits this (disjoint write
 * authority, §7); per-node fixers never touch it. Pure: a deterministic function of the workflow id.
 */
export function buildSystemMemory(wfId: string): string {
  return `# ${wfId} — system memory
<!-- SYSTEM · Leg A · the RECONCILE summary. OPTIMIZER-FACING — ONLY the reconcile node edits this
     (disjoint write authority; per-node fixers never touch it). NEVER injected into any node's prompt.
     Capped, top-loaded. Maintenance contract = the optimizer skill. -->

_status: new — no reconcile recorded yet_

## Cross-node decisions
<!-- standing decisions that span nodes: shared interfaces/contracts, how the stack runs. -->

## Architecture changes
<!-- L2 COMPOSE: nodes added / rewired and WHY. -->

## Open threads (DAG-level)
<!-- unresolved cross-node issues; drop when absorbed. -->

## History
git log --grep '^skillsys('
`;
}
