// observe/issues.ts — M8.2's `nodeIssuesProjection`. It is a THIN WRAPPER over `listIssues`
// (optimize/substrate/issues.ts) — no reshaping, no re-sorting, no filtering of its own. This suite pins
// exactly that: the projection's output is byte-identical (deep-equal) to calling `listIssues` directly with
// the same `{node}` scope, over a REAL fixture ledger (written via the module's own `writeIssueFile`, never a
// hand-rolled frontmatter string) — so a reimplementation drifting from `listIssues` (a different sort, a
// dropped field, a silently-swallowed node) turns this test RED.
//
// Run: npx vitest run packages/core/test/observe-issues.test.ts

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeIssueFile, listIssues, computeIssueId, type Issue } from '../src/optimize/substrate/issues.js';
import { nodeIssuesProjection } from '../src/observe/issues.js';

const tmpDirs: string[] = [];
const scratch = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), 'piflow-observe-issues-'));
  tmpDirs.push(d);
  return d;
};
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function makeIssue(node: string, tag: string, overrides: Partial<Issue> = {}): Issue {
  const sig = `${node}::${tag}`;
  return {
    id: computeIssueId(node, sig),
    name: tag,
    title: `issue: ${tag}`,
    severity: 'high',
    status: 'open',
    reason: null,
    sig,
    firstSeen: '260706-01',
    lastSeen: '260706-01',
    attempts: [],
    body: `context brief for ${tag}\n`,
    ...overrides,
  };
}

describe('nodeIssuesProjection — byte-parity with listIssues', () => {
  it('returns EXACTLY what listIssues(templateDir, {node}) returns, for a node with several issues', async () => {
    const templateDir = await scratch();
    await writeIssueFile(join(templateDir, 'nodes', 'gameplay', 'issues', 'soggy-crust.md'), makeIssue('gameplay', 'soggy-crust', { severity: 'critical' }));
    await writeIssueFile(join(templateDir, 'nodes', 'gameplay', 'issues', 'slow-compose.md'), makeIssue('gameplay', 'slow-compose', { severity: 'medium' }));
    // a DIFFERENT node's issue must never leak into the 'gameplay' projection.
    await writeIssueFile(join(templateDir, 'nodes', 'research', 'issues', 'stale-cache.md'), makeIssue('research', 'stale-cache'));

    const projected = await nodeIssuesProjection(templateDir, 'gameplay');
    const direct = await listIssues(templateDir, { node: 'gameplay' });

    expect(projected).toEqual(direct);
    expect(projected.map((r) => r.issue.name)).toEqual(['soggy-crust', 'slow-compose']); // severity-desc order
    expect(projected.every((r) => r.node === 'gameplay')).toBe(true);
  });

  it('returns [] for a node with no issues dir yet — never throws', async () => {
    const templateDir = await scratch();
    const projected = await nodeIssuesProjection(templateDir, 'never-triaged');
    expect(projected).toEqual(await listIssues(templateDir, { node: 'never-triaged' }));
    expect(projected).toEqual([]);
  });
});
