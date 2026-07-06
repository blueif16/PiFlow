// observe/issues.ts — M8's ISSUES projection (docs/specs/optimize-substrate-plan.md §M8.2). This is NOT a
// second reader: the optimize-substrate issue LEDGER (`<templateDir>/nodes/<node>/issues/<name>.md`) already
// has its one source of truth — `listIssues` (optimize/substrate/issues.ts). This module exists only so the
// server/GUI import from `observe` (the one surface every view already depends on) instead of reaching into
// `optimize/substrate` directly, mirroring how `projectRunDigest` (telemetry.ts) fronts `runView.ts` for the
// run-digest route. `nodeIssuesProjection`'s output is BYTE-IDENTICAL to `listIssues(templateDir, {node})` —
// no reshaping, no filtering, no re-sorting beyond what `listIssues` already does.

import { listIssues, type IssueRecord } from '../optimize/substrate/issues.js';

/**
 * The node-TYPE-scoped issue ledger for `<templateDir>/nodes/<nodeId>/issues/` — a thin wrapper over
 * `listIssues`, severity-desc then firstSeen-asc (listIssues' own sort). Used by the `GET
 * /__piflow/issues/<run>?node=<id>` route (handlers.ts) — node-TYPE-scoped, not run-scoped: the ledger
 * accumulates across every run of the node, so a viewer badges rows against the run it opened the card from
 * client-side (the row's `firstSeen`/`lastSeen`/`attempts[].verifiedByRun`/`regressedIn`), rather than this
 * projection filtering by run.
 */
export async function nodeIssuesProjection(templateDir: string, nodeId: string): Promise<IssueRecord[]> {
  return listIssues(templateDir, { node: nodeId });
}
