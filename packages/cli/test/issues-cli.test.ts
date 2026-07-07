// packages/cli/src/issues.ts — the M5.3 `piflowctl issues <list|show>` read-only ledger query. Seeds a REAL
// fixture ledger (via core writeIssueFile), so the verb's list/show + node/status filters + the severity-desc/
// firstSeen-asc order are asserted end-to-end (the sort lives in core listIssues; the verb must surface it).
//
// Run: npx vitest run packages/cli/test/issues-cli.test.ts

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeIssueFile, type Issue } from '@piflow/core';
import { parseIssuesArgs, runIssuesCli } from '../src/issues.js';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'issues-cli-'));
afterEach(() => { process.exitCode = 0; });

function makeIssue(o: { name: string; severity: Issue['severity']; status?: Issue['status']; firstSeen: string }): Issue {
  const status = o.status ?? 'open';
  return {
    id: `sha256:${'0'.repeat(64)}`, // a placeholder; every caller overrides via withId with a UNIQUE valid id
    name: o.name, title: `title of ${o.name}`, severity: o.severity, status,
    reason: status === 'resolved' ? 'fixed' : null, sig: `gameplay::${o.name}`,
    firstSeen: o.firstSeen, lastSeen: o.firstSeen, attempts: [], body: `context brief for ${o.name}\n`,
  };
}

/** Seed a real `<templateDir>/nodes/gameplay/issues/` ledger. IDs must be unique per issue, so compute a valid
 *  sha256-shaped id from the name (writeIssueFile validates the id shape + name slug). */
async function seedLedger(templateDir: string, issues: Issue[]): Promise<void> {
  const dir = path.join(templateDir, 'nodes', 'gameplay', 'issues');
  await fs.mkdir(dir, { recursive: true });
  for (const iss of issues) await writeIssueFile(path.join(dir, `${iss.name}.md`), iss);
}

// give each seeded issue a distinct, valid sha256:<64hex> id
function withId(iss: Issue, hex: string): Issue { return { ...iss, id: `sha256:${hex.padEnd(64, '0')}` }; }

describe('parseIssuesArgs', () => {
  it('defaults to list; a leading flag stays list; show takes a name positional', () => {
    expect(parseIssuesArgs(['--node', 'g']).sub).toBe('list');
    expect(parseIssuesArgs(['list', '--node', 'g'])).toMatchObject({ sub: 'list', node: 'g' });
    expect(parseIssuesArgs(['show', 'soggy-crust', '--json'])).toMatchObject({ sub: 'show', name: 'soggy-crust', json: true });
    expect(parseIssuesArgs(['list', '--status', 'open,regressed']).status).toBe('open,regressed');
  });
});

describe('runIssuesCli list — renders the ledger severity-desc then firstSeen-asc', () => {
  it('orders critical > high > low, firstSeen-asc within a tier, and filters by --status', async () => {
    const dir = await tmp();
    const templateDir = path.join(dir, 'template');
    await seedLedger(templateDir, [
      withId(makeIssue({ name: 'low-old', severity: 'low', firstSeen: '260706-01' }), 'a1'),
      withId(makeIssue({ name: 'crit', severity: 'critical', firstSeen: '260706-05' }), 'b2'),
      withId(makeIssue({ name: 'high-b', severity: 'high', firstSeen: '260706-04' }), 'c3'),
      withId(makeIssue({ name: 'high-a', severity: 'high', firstSeen: '260706-02' }), 'd4'),
      withId(makeIssue({ name: 'done', severity: 'high', status: 'resolved', firstSeen: '260706-03' }), 'e5'),
    ]);
    const lines: string[] = [];
    const code = await runIssuesCli(['list', '--node', 'gameplay'], { resolveTemplate: () => templateDir, print: (s) => lines.push(s) });
    expect(code).toBe(0);
    // the ORDER of names down the table body (skip the header row):
    const body = lines.join('\n').split('\n').slice(1);
    const order = body.map((l) => l.trim().split(/\s+/)[1]); // NAME column
    // severity-desc, then firstSeen-ASC within a tier (status does not affect order): the high tier is
    // high-a(260706-02) < done(260706-03) < high-b(260706-04).
    expect(order).toEqual(['crit', 'high-a', 'done', 'high-b', 'low-old']);

    // --status open filters out the resolved one:
    const open: string[] = [];
    await runIssuesCli(['list', '--node', 'gameplay', '--status', 'open'], { resolveTemplate: () => templateDir, print: (s) => open.push(s) });
    expect(open.join('\n')).not.toMatch(/\bdone\b/);
    expect(open.join('\n')).toMatch(/\bcrit\b/);
  });

  it('--json emits the records array (agents)', async () => {
    const dir = await tmp();
    const templateDir = path.join(dir, 'template');
    await seedLedger(templateDir, [withId(makeIssue({ name: 'only', severity: 'high', firstSeen: '260706-01' }), 'f6')]);
    let out = '';
    await runIssuesCli(['list', '--node', 'gameplay', '--json'], { resolveTemplate: () => templateDir, print: (s) => { out = s; } });
    const parsed = JSON.parse(out);
    expect(parsed[0].issue.name).toBe('only');
    expect(parsed[0].node).toBe('gameplay');
  });
});

describe('runIssuesCli show — dumps one issue file / json; misses exit 1', () => {
  it('show <name> prints the full issue file (frontmatter + body)', async () => {
    const dir = await tmp();
    const templateDir = path.join(dir, 'template');
    await seedLedger(templateDir, [withId(makeIssue({ name: 'soggy-crust', severity: 'high', firstSeen: '260706-01' }), 'a7')]);
    const lines: string[] = [];
    const code = await runIssuesCli(['show', 'soggy-crust', '--node', 'gameplay'], { resolveTemplate: () => templateDir, print: (s) => lines.push(s) });
    expect(code).toBe(0);
    expect(lines.join('\n')).toMatch(/name: soggy-crust/);
    expect(lines.join('\n')).toMatch(/context brief for soggy-crust/);
  });

  it('show of an unknown name exits 1 with an actionable error', async () => {
    const dir = await tmp();
    const templateDir = path.join(dir, 'template');
    await seedLedger(templateDir, [withId(makeIssue({ name: 'real', severity: 'low', firstSeen: '260706-01' }), 'a8')]);
    const errs: string[] = [];
    const code = await runIssuesCli(['show', 'ghost', '--node', 'gameplay'], { resolveTemplate: () => templateDir, printErr: (s) => errs.push(s) });
    expect(code).toBe(1);
    expect(errs.join('\n')).toMatch(/ghost/);
  });
});
