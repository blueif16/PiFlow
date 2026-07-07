// observe/issues.ts — M8's ISSUES projection (docs/specs/optimize-substrate-plan.md §M8.2). This is NOT a
// second reader: the optimize-substrate issue LEDGER (`<templateDir>/nodes/<node>/issues/<name>.md`) already
// has its one source of truth — `listIssues` (optimize/substrate/issues.ts). This module exists only so the
// server/GUI import from `observe` (the one surface every view already depends on) instead of reaching into
// `optimize/substrate` directly, mirroring how `projectRunDigest` (telemetry.ts) fronts `runView.ts` for the
// run-digest route. `nodeIssuesProjection`'s output is BYTE-IDENTICAL to `listIssues(templateDir, {node})` —
// no reshaping, no filtering, no re-sorting beyond what `listIssues` already does.

import { promises as fs } from 'node:fs';
import path from 'node:path';
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

/**
 * The run-LEVEL aggregate for the M8 issues card's "characterized by node" view: every node's ledger under
 * `<templateDir>/nodes`, concatenated. Deliberately VIEWER-TOLERANT and thus NOT byte-identical to a single
 * `listIssues(templateDir)` call: a whole-tree `listIssues` is fail-closed (one unreadable/legacy file throws
 * and blanks the entire run's issues view), which is wrong for an aggregate viewer. So this walks node dirs and
 * calls the fail-closed per-node `listIssues` inside a per-node try/catch — a node whose ledger can't be parsed
 * is SKIPPED (logged), never fatal. The per-node route (`nodeIssuesProjection`) stays exact/fail-closed for
 * precision; only this aggregate degrades. Granularity is per-NODE (a node with one bad file among valid ones
 * is dropped whole) — acceptable until finer per-file tolerance is needed.
 */
export async function allIssuesProjection(templateDir: string): Promise<IssueRecord[]> {
  let nodeDirs: string[];
  try {
    const entries = await fs.readdir(path.join(templateDir, 'nodes'), { withFileTypes: true });
    nodeDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return []; // no nodes dir yet
  }
  const out: IssueRecord[] = [];
  for (const node of nodeDirs) {
    try {
      out.push(...(await listIssues(templateDir, { node })));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[observe] allIssuesProjection: skipping unreadable issue ledger for node "${node}" — ${String(e)}`);
    }
  }
  return out;
}
