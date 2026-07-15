// Contract for optimize/substrate/issues.ts — the M2 issue LEDGER (optimize-substrate-plan.md §M2). Physical
// shape: one markdown file per issue (`<issues-dir>/<name>.md`) — the directory IS the table. This suite pins
// the load-bearing invariants a downstream fixer/triage loop (M4/M6) will lean on without re-deriving them:
//   • the strict minimal frontmatter format ROUND-TRIPS byte-for-byte (no yaml dep in @piflow/core's deps).
//   • the id hash is a PURE function of (nodeId, sig) ONLY — title/prose/attempts churn must never flip it.
//   • reopening a resolved issue with the SAME sig lands on the SAME file (status → regressed), never a dup.
//   • `attempts` is append-only — writeIssueFile rejects any write that mutates a past row (the ONE sanctioned
//     exception being reopen() attaching `regressedIn` to the LAST existing row).
//   • the status machine's guards throw on any edge not in the documented graph.
//   • listIssues filters by node/status and sorts severity-desc then firstSeen-asc.
//
// Run: npx vitest run packages/core/test/optimize-substrate-issues.test.ts

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseIssueFile, writeIssueFile, validateIssue, listIssues, stampAttempt, reopen,
  assertTransition, transitionIssue, computeIssueId,
  type Issue, type Status,
} from '../src/optimize/substrate/issues.js';

const tmpDirs: string[] = [];
const scratch = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), 'piflow-issues-'));
  tmpDirs.push(d);
  return d;
};
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A minimal, valid issue — override fields per test. */
function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: computeIssueId('gameplay', 'gameplay::compose-in-thinking'),
    name: 'soggy-crust',
    title: 'compose() thinks 9-13s before writing',
    severity: 'high',
    status: 'open',
    reason: null,
    sig: 'gameplay::compose-in-thinking',
    firstSeen: '260706-01',
    lastSeen: '260706-01',
    attempts: [],
    body: 'The compose step burns long thinking spans before any tool call.\n',
    ...overrides,
  };
}

// ── frontmatter round-trip ──────────────────────────────────────────────────────────────────────────
describe('parseIssueFile / writeIssueFile — byte-stable round-trip', () => {
  it('reads back an equal Issue after a write, and re-writing the SAME issue produces IDENTICAL bytes', async () => {
    const dir = await scratch();
    const file = join(dir, 'soggy-crust.md');
    const issue = makeIssue();

    await writeIssueFile(file, issue);
    const raw1 = await fs.readFile(file, 'utf8');
    const roundTripped = await parseIssueFile(file);
    expect(roundTripped).toEqual(issue);

    // re-parse then re-write the SAME logical issue — bytes must not drift (deterministic serialization).
    await writeIssueFile(file, roundTripped);
    const raw2 = await fs.readFile(file, 'utf8');
    expect(raw2).toBe(raw1);
  });

  it('round-trips a non-empty attempts array + a null reason vs a set reason on resolve', async () => {
    const dir = await scratch();
    const file = join(dir, 'x.md');
    const issue = makeIssue({
      status: 'resolved',
      reason: 'fixed',
      attempts: [{ commit: 'abc123', verifiedByRun: 'tS2.gameplay' }],
    });
    await writeIssueFile(file, issue);
    expect(await parseIssueFile(file)).toEqual(issue);
  });

  it('fails CLOSED on a malformed frontmatter block (missing required key)', async () => {
    const dir = await scratch();
    const file = join(dir, 'broken.md');
    // hand-write a file missing `sig` — the strict parser must reject it, not silently default.
    await fs.writeFile(file, [
      '---',
      `id: ${computeIssueId('gameplay', 'x')}`,
      'name: broken',
      'title: t',
      'severity: high',
      'status: open',
      'reason: null',
      'firstSeen: 260706-01',
      'lastSeen: 260706-01',
      'attempts: []',
      '---',
      'body',
    ].join('\n'));
    await expect(parseIssueFile(file)).rejects.toThrow(/sig/);
  });

  it('fails CLOSED on an unknown extra frontmatter key', async () => {
    const dir = await scratch();
    const file = join(dir, 'extra.md');
    await fs.writeFile(file, [
      '---',
      `id: ${computeIssueId('gameplay', 'x')}`,
      'name: extra',
      'title: t',
      'severity: high',
      'status: open',
      'reason: null',
      'sig: gameplay::x',
      'firstSeen: 260706-01',
      'lastSeen: 260706-01',
      'attempts: []',
      'fixConfig: nope', // ⚠ explicitly excluded by the plan — must be rejected, not silently accepted
      '---',
      'body',
    ].join('\n'));
    await expect(parseIssueFile(file)).rejects.toThrow(/unknown/i);
  });
});

// ── verify tier — the optional per-issue frontmatter field (WS3) ──────────────────────────────────────
describe('verify tier — the OPTIONAL per-issue frontmatter field (WS3)', () => {
  it('round-trips each tier; unset ⇒ NO verify line at all (a pre-WS3 file stays byte-stable)', async () => {
    const dir = await scratch();
    for (const tier of ['none', 'rerun', 'full'] as const) {
      const file = join(dir, `${tier}.md`);
      const issue = makeIssue({ verify: tier });
      await writeIssueFile(file, issue);
      expect(await fs.readFile(file, 'utf8')).toContain(`verify: ${tier}`);
      expect(await parseIssueFile(file)).toEqual(issue); // reads the tier back exactly
    }
    // an issue with NO verify tier renders no `verify:` line and reads back undefined.
    const bare = join(dir, 'bare.md');
    await writeIssueFile(bare, makeIssue());
    expect(await fs.readFile(bare, 'utf8')).not.toContain('verify:');
    expect((await parseIssueFile(bare)).verify).toBeUndefined();
  });

  it('accepts a hand-written frontmatter carrying `verify` (an OPTIONAL key — allowed, never required)', async () => {
    const dir = await scratch();
    const file = join(dir, 'v.md');
    await fs.writeFile(file, [
      '---',
      `id: ${computeIssueId('gameplay', 'gameplay::x')}`,
      'name: v', 'title: t', 'severity: high', 'status: open', 'reason: null',
      'sig: gameplay::x', 'firstSeen: 260706-01', 'lastSeen: 260706-01',
      'verify: rerun',
      'attempts: []',
      '---', 'body',
    ].join('\n'));
    expect((await parseIssueFile(file)).verify).toBe('rerun');
  });

  it('fails CLOSED on an invalid verify tier value', () => {
    expect(() => validateIssue(makeIssue({ verify: 'sometimes' as never }))).toThrow(/verify/);
  });
});

// ── identity: the hash recipe ────────────────────────────────────────────────────────────────────────
describe('computeIssueId — pure hash of (nodeId, sig) ONLY', () => {
  it('is STABLE when title/prose/attempts change (same nodeId + sig)', () => {
    const id1 = computeIssueId('gameplay', 'gameplay::compose-in-thinking');
    const draftA = makeIssue({ id: id1, title: 'first title', attempts: [] });
    const draftB = makeIssue({
      id: id1, title: 'a completely rewritten title', body: 'totally different prose\n',
      attempts: [{ commit: 'c1', verifiedByRun: 'r1' }],
    });
    expect(computeIssueId('gameplay', draftA.sig)).toBe(id1);
    expect(computeIssueId('gameplay', draftB.sig)).toBe(id1); // sig unchanged ⇒ id unchanged, regardless of title/prose/attempts
  });

  it('CHANGES when sig changes (even for the same node)', () => {
    const id1 = computeIssueId('gameplay', 'gameplay::compose-in-thinking');
    const id2 = computeIssueId('gameplay', 'gameplay::tool-loop-genre-lookup');
    expect(id2).not.toBe(id1);
  });

  it('CHANGES when nodeId changes (even for the same sig text)', () => {
    const idA = computeIssueId('gameplay', 'shared::sig');
    const idB = computeIssueId('narrative', 'shared::sig');
    expect(idA).not.toBe(idB);
  });

  it('renders as `sha256:<64-hex>`', () => {
    expect(computeIssueId('gameplay', 'gameplay::x')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

// ── reopen: dedup backstop, never a duplicate file ──────────────────────────────────────────────────
describe('reopen — hash re-match of a RESOLVED issue reopens the SAME file, never a duplicate', () => {
  it('a second draft with the SAME sig resolves (via computeIssueId + listIssues) to the SAME file; reopen sets regressed, keeps attempts intact + stamps regressedIn on the last row', async () => {
    const dir = await scratch();
    const node = 'gameplay';
    const issuesDir = join(dir, 'nodes', node, 'issues');
    const file = join(issuesDir, 'soggy-crust.md');
    const sig = 'gameplay::compose-in-thinking';
    const id = computeIssueId(node, sig);

    // an issue that was FIXED and RESOLVED in an earlier pass.
    const resolved = makeIssue({
      id, sig, status: 'resolved', reason: 'fixed',
      attempts: [{ commit: 'abc123', verifiedByRun: 'tS2.gameplay' }],
    });
    await writeIssueFile(file, resolved);

    // a NEW triage draft surfaces the identical failure sig on a later run — its computed id matches the
    // existing file's id (the mechanical dedup backstop), so the caller finds the SAME record, not a fresh one.
    const draftId = computeIssueId(node, sig);
    const found = (await listIssues(dir, { node })).find((r) => r.issue.id === draftId);
    expect(found?.file).toBe(file); // SAME file — no duplicate was minted

    const reopened = await reopen(found!.file, { run: 'tS3.gameplay' });

    expect(reopened.status).toBe('regressed');
    expect(reopened.lastSeen).toBe('tS3.gameplay');
    expect(reopened.attempts).toHaveLength(1); // attempts INTACT — nothing dropped
    expect(reopened.attempts[0]).toMatchObject({ commit: 'abc123', verifiedByRun: 'tS2.gameplay', regressedIn: 'tS3.gameplay' });
    expect(reopened.reason).toBeNull(); // no longer closed — the close reason is cleared on reopen

    // and it's durable — re-reading the file off disk shows the same state.
    expect(await parseIssueFile(file)).toEqual(reopened);
  });

  it('refuses to reopen an issue that is not currently resolved (guards the same status machine)', async () => {
    const dir = await scratch();
    const file = join(dir, 'x.md');
    await writeIssueFile(file, makeIssue({ status: 'open' }));
    await expect(reopen(file, { run: 'r2' })).rejects.toThrow();
  });
});

// ── attempts: append-only, mutation of past rows rejected ───────────────────────────────────────────
describe('attempts — append-only (writeIssueFile rejects mutation of an existing row)', () => {
  it('stampAttempt APPENDS a new row and leaves prior rows byte-identical', async () => {
    const dir = await scratch();
    const file = join(dir, 'x.md');
    await writeIssueFile(file, makeIssue({ attempts: [{ commit: 'c1', verifiedByRun: 'r1' }] }));

    const updated = await stampAttempt(file, { commit: 'c2', verifiedByRun: 'r2' });

    expect(updated.attempts).toEqual([
      { commit: 'c1', verifiedByRun: 'r1' },
      { commit: 'c2', verifiedByRun: 'r2' },
    ]);
  });

  it('REJECTS a write that mutates a field on a past (non-last) attempt row', async () => {
    const dir = await scratch();
    const file = join(dir, 'x.md');
    const original = makeIssue({
      attempts: [
        { commit: 'c1', verifiedByRun: 'r1' },
        { commit: 'c2', verifiedByRun: 'r2' },
      ],
    });
    await writeIssueFile(file, original);

    const corrupted: Issue = {
      ...original,
      attempts: [
        { commit: 'REWRITTEN', verifiedByRun: 'r1' }, // row 0 (not the last row) mutated
        { commit: 'c2', verifiedByRun: 'r2' },
      ],
    };
    await expect(writeIssueFile(file, corrupted)).rejects.toThrow(/append-only/);
    // the on-disk file is untouched by the rejected write.
    expect((await parseIssueFile(file)).attempts).toEqual(original.attempts);
  });

  it('REJECTS a write that drops an existing attempt row', async () => {
    const dir = await scratch();
    const file = join(dir, 'x.md');
    const original = makeIssue({ attempts: [{ commit: 'c1', verifiedByRun: 'r1' }, { commit: 'c2', verifiedByRun: 'r2' }] });
    await writeIssueFile(file, original);

    const truncated: Issue = { ...original, attempts: [{ commit: 'c1', verifiedByRun: 'r1' }] };
    await expect(writeIssueFile(file, truncated)).rejects.toThrow(/append-only/);
  });

  it('ALLOWS the one sanctioned mutation: attaching `regressedIn` to the LAST row (what reopen does) but rejects changing its commit/verifiedByRun at the same time', async () => {
    const dir = await scratch();
    const file = join(dir, 'x.md');
    const original = makeIssue({ status: 'resolved', reason: 'fixed', attempts: [{ commit: 'c1', verifiedByRun: 'r1' }] });
    await writeIssueFile(file, original);

    const okRegression: Issue = {
      ...original, status: 'regressed', reason: null,
      attempts: [{ commit: 'c1', verifiedByRun: 'r1', regressedIn: 'r2' }],
    };
    await expect(writeIssueFile(file, okRegression)).resolves.toBeUndefined();

    const dir2 = await scratch();
    const file2 = join(dir2, 'y.md');
    await writeIssueFile(file2, original);
    const badRegression: Issue = {
      ...original, status: 'regressed', reason: null,
      attempts: [{ commit: 'CHANGED', verifiedByRun: 'r1', regressedIn: 'r2' }],
    };
    await expect(writeIssueFile(file2, badRegression)).rejects.toThrow(/append-only/);
  });
});

// ── status machine guards ───────────────────────────────────────────────────────────────────────────
describe('status machine — assertTransition throws on any edge outside the documented graph', () => {
  const validEdges: [Status, Status][] = [
    ['open', 'active'],
    ['active', 'fix-landed'],
    ['active', 'open'], // GAP1 crash drop-back: a fixIssue that dies right after activating (e.g. the fixer
                         // spawn itself throws, before any commit) needs a legal edge back to `open`, else the
                         // issue is stranded `active` forever with no re-select/re-fix path.
    ['fix-landed', 'verifying'],
    ['fix-landed', 'resolved'], // the skip-proof path
    ['fix-landed', 'open'], // the adopt-train stale-base BOUNCE of a skip-proof fix (re-fixable, never stranded)
    ['verifying', 'resolved'],
    ['verifying', 'open'], // TASK 0: a proven-REJECT walks the candidate back to open (nothing landed)
    ['resolved', 'regressed'],
    ['regressed', 'active'], // regressed behaves like open for selection/dispatch
  ];
  it.each(validEdges)('allows %s → %s', (from, to) => {
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  const invalidEdges: [Status, Status][] = [
    ['open', 'resolved'],       // skipping the whole pipeline
    ['open', 'fix-landed'],
    ['active', 'resolved'],
    ['active', 'verifying'],
    ['verifying', 'active'],
    ['resolved', 'open'],       // reopen must go through 'regressed', not back to fresh 'open'
    ['regressed', 'resolved'],  // must re-earn fix-landed/verifying again
  ];
  it.each(invalidEdges)('throws on %s → %s', (from, to) => {
    expect(() => assertTransition(from, to)).toThrow();
  });

  it('transitionIssue persists a valid transition and requires a reason to resolve', async () => {
    const dir = await scratch();
    const file = join(dir, 'x.md');
    await writeIssueFile(file, makeIssue({ status: 'fix-landed' }));

    await expect(transitionIssue(file, 'resolved')).rejects.toThrow(/reason/);

    const resolved = await transitionIssue(file, 'resolved', { reason: 'wontfix' });
    expect(resolved.status).toBe('resolved');
    expect(resolved.reason).toBe('wontfix');
  });

  it('transitionIssue throws on an invalid edge and leaves the file untouched', async () => {
    const dir = await scratch();
    const file = join(dir, 'x.md');
    await writeIssueFile(file, makeIssue({ status: 'open' }));
    await expect(transitionIssue(file, 'resolved', { reason: 'fixed' })).rejects.toThrow();
    expect((await parseIssueFile(file)).status).toBe('open');
  });
});

// ── validateIssue — the standalone fail-closed validator ────────────────────────────────────────────
describe('validateIssue — standalone structural validation', () => {
  it('rejects reason set while status is not resolved', () => {
    expect(() => validateIssue(makeIssue({ status: 'open', reason: 'fixed' }))).toThrow();
  });
  it('rejects a resolved issue with no reason', () => {
    expect(() => validateIssue(makeIssue({ status: 'resolved', reason: null }))).toThrow();
  });
  it('rejects an unknown severity/status value', () => {
    expect(() => validateIssue(makeIssue({ severity: 'urgent' as never }))).toThrow();
    expect(() => validateIssue(makeIssue({ status: 'closed' as never }))).toThrow();
  });
  it('accepts a well-formed issue', () => {
    expect(() => validateIssue(makeIssue())).not.toThrow();
  });
});

// ── listIssues — filter + sort ──────────────────────────────────────────────────────────────────────
describe('listIssues — filters by node/status, sorts severity-desc then firstSeen-asc', () => {
  it('sorts severity-desc (critical > high > medium > low), firstSeen-asc within a tier, and filters by node + status', async () => {
    const dir = await scratch();
    const seed = async (node: string, name: string, sev: Issue['severity'], firstSeen: string, status: Issue['status'] = 'open') => {
      const d = join(dir, 'nodes', node, 'issues');
      await fs.mkdir(d, { recursive: true });
      await writeIssueFile(join(d, `${name}.md`), makeIssue({
        id: computeIssueId(node, `${node}::${name}`), sig: `${node}::${name}`, name, severity: sev, firstSeen, lastSeen: firstSeen, status,
        reason: status === 'resolved' ? 'fixed' : null,
      }));
    };
    await seed('gameplay', 'low-early', 'low', '260701-01');
    await seed('gameplay', 'high-late', 'high', '260703-01');
    await seed('gameplay', 'high-early', 'high', '260701-02');
    await seed('gameplay', 'critical-one', 'critical', '260702-01');
    await seed('gameplay', 'a-resolved-one', 'critical', '260605-01', 'resolved');
    await seed('narrative', 'other-node', 'critical', '260601-01');

    const all = await listIssues(dir, { node: 'gameplay' });
    expect(all.map((r) => r.issue.name)).toEqual([
      'a-resolved-one', // critical, firstSeen earliest among criticals
      'critical-one',
      'high-early',      // high tier, earlier firstSeen before high-late
      'high-late',
      'low-early',
    ]);

    // node filter excludes the other node entirely.
    expect(all.some((r) => r.node === 'narrative')).toBe(false);

    // status filter.
    const openOnly = await listIssues(dir, { node: 'gameplay', status: 'open' });
    expect(openOnly.map((r) => r.issue.name)).not.toContain('a-resolved-one');
    expect(openOnly).toHaveLength(4);

    // no node filter ⇒ scans every node dir.
    const everything = await listIssues(dir);
    expect(everything.some((r) => r.node === 'narrative')).toBe(true);
    expect(everything).toHaveLength(6);
  });

  it('returns an empty list (never throws) when the node has no issues dir yet', async () => {
    const dir = await scratch();
    await expect(listIssues(dir, { node: 'brand-new-node' })).resolves.toEqual([]);
  });
});
