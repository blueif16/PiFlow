// observe/issues.ts — M8.2's `nodeIssuesProjection`. It is a THIN WRAPPER over `listIssues`
// (optimize/substrate/issues.ts) — no reshaping, no re-sorting, no filtering of its own. This suite pins
// exactly that: the projection's output is byte-identical (deep-equal) to calling `listIssues` directly with
// the same `{node}` scope, over a REAL fixture ledger (written via the module's own `writeIssueFile`, never a
// hand-rolled frontmatter string) — so a reimplementation drifting from `listIssues` (a different sort, a
// dropped field, a silently-swallowed node) turns this test RED.
//
// Run: npx vitest run packages/core/test/observe-issues.test.ts

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeIssueFile, listIssues, computeIssueId, type Issue } from '../src/optimize/substrate/issues.js';
import { nodeIssuesProjection, allIssuesProjection } from '../src/observe/issues.js';

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

describe('allIssuesProjection — the run-level aggregate (all nodes, viewer-tolerant)', () => {
  it("aggregates every node's ledger into one list", async () => {
    const templateDir = await scratch();
    await writeIssueFile(join(templateDir, 'nodes', 'gameplay', 'issues', 'soggy-crust.md'), makeIssue('gameplay', 'soggy-crust', { severity: 'critical' }));
    await writeIssueFile(join(templateDir, 'nodes', 'gameplay', 'issues', 'slow-compose.md'), makeIssue('gameplay', 'slow-compose', { severity: 'medium' }));
    await writeIssueFile(join(templateDir, 'nodes', 'research', 'issues', 'stale-cache.md'), makeIssue('research', 'stale-cache'));

    const all = await allIssuesProjection(templateDir);

    expect(all).toHaveLength(3);
    expect(new Set(all.map((r) => `${r.node}/${r.issue.name}`))).toEqual(
      new Set(['gameplay/soggy-crust', 'gameplay/slow-compose', 'research/stale-cache']),
    );
  });

  it('TOLERATES a node with an unreadable/legacy ledger — skips it, still returns the valid nodes, never throws', async () => {
    const templateDir = await scratch();
    await writeIssueFile(join(templateDir, 'nodes', 'gameplay', 'issues', 'soggy-crust.md'), makeIssue('gameplay', 'soggy-crust'));
    // a bespoke/legacy file that the fail-closed M2 parser rejects (missing required keys) — must NOT
    // blank the whole run-level view, unlike the fail-closed per-node route.
    await mkdir(join(templateDir, 'nodes', 'w1-design', 'issues'), { recursive: true });
    await writeFile(join(templateDir, 'nodes', 'w1-design', 'issues', 'legacy.md'), '---\nissue: legacy\nfoot: bespoke\n---\nold format\n');

    // fail-closed per-node route DOES throw on that node (the contract we keep) …
    await expect(listIssues(templateDir, { node: 'w1-design' })).rejects.toThrow();

    // … but the run-level aggregate degrades gracefully.
    const all = await allIssuesProjection(templateDir);
    expect(all.map((r) => `${r.node}/${r.issue.name}`)).toEqual(['gameplay/soggy-crust']);
  });

  it('returns [] when the template has no nodes dir — never throws', async () => {
    const templateDir = await scratch();
    expect(await allIssuesProjection(templateDir)).toEqual([]);
  });
});
