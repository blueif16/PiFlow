// optimize/blame/memorize.ts — WS-B6 blame-memorize (docs/design/optimize-blame.md §7). Distills a finished
// blame pass's attributions into TEMPLATE-ROOT `memory.md`, and proves the writer/reader ROUND-TRIP against
// the REAL `deriveRecurrence` (recurrence.ts) — the cross-oracle the design doc names: a block this module
// writes must be exactly the block the next blame judge's recurrence context reads.
//
// Run: npx vitest run packages/core/test/optimize-blame-memorize.test.ts --project default

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memorizeBlame } from '../src/optimize/blame/memorize.js';
import { blameSummaryPath, blameFilePath, blameDissentPath, blameDir } from '../src/optimize/blame/paths.js';
import { renderBlameSummaryTail, type BlameSummary } from '../src/optimize/blame/summary.js';
import { deriveRecurrence } from '../src/optimize/recurrence.js';

const tmpDirs: string[] = [];
const scratch = async (prefix = 'piflow-blame-memorize-'): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** Write `blame/blame.md` for `runDir`: the prose body + the fenced tail `parseBlameSummaryTail` reads. */
async function writeSummary(runDir: string, summary: BlameSummary, prose = '# blame summary\n\nprose.\n'): Promise<void> {
  await fs.mkdir(blameDir(runDir), { recursive: true });
  await fs.writeFile(blameSummaryPath(runDir), `${prose}\n${renderBlameSummaryTail(summary)}\n`);
}

/** Write one node's prose blame file with a defect line the extractor should lift as the symptom. */
async function writeBlameFile(runDir: string, node: string, defectLine: string): Promise<void> {
  await fs.mkdir(blameDir(runDir), { recursive: true });
  await fs.writeFile(blameFilePath(runDir, node), `# blame — ${node} @ r1\n\n${defectLine}\n\nmore prose follows.\n`);
}

async function writeDissentFile(runDir: string, node: string, contestLine: string): Promise<void> {
  await fs.mkdir(blameDir(runDir), { recursive: true });
  await fs.writeFile(blameDissentPath(runDir, node), `# dissent — ${node} @ r1\n\n${contestLine}\n`);
}

// ── (1) the caller-bug guard — no blame pass, no memorize ────────────────────────────────────────────────
describe('memorizeBlame — no blame summary on disk', () => {
  it('throws (memorize without a blame pass is a caller bug), never a silent no-op', async () => {
    const dir = await scratch();
    const runDir = join(dir, 'run');
    const templateDir = join(dir, 'template');
    await fs.mkdir(runDir, { recursive: true });
    await fs.mkdir(templateDir, { recursive: true });
    await expect(memorizeBlame(runDir, templateDir)).rejects.toThrow(/no blame summary|blame pass/i);
  });
});

// ── (2) seed-if-absent + the writer/reader round-trip vs the REAL deriveRecurrence ───────────────────────
describe('memorizeBlame — writer/reader round-trip', () => {
  it('seeds template-root memory.md when absent, writes ONE block per blamed node, and deriveRecurrence reads it back at count 1', async () => {
    const dir = await scratch();
    const runDir = join(dir, 'run');
    const templateDir = join(dir, 'template');
    await fs.mkdir(templateDir, { recursive: true });
    await writeSummary(runDir, { blamed: [{ node: 'gameplay', severity: 'high', observedAt: ['gameplay'] }], edges: [], unattributed: [] });
    await writeBlameFile(runDir, 'gameplay', 'The combat loop drops enemy hits below the 3-hit combo threshold.');

    // memory.md did not exist before this call.
    await expect(fs.access(join(templateDir, 'memory.md'))).rejects.toThrow();

    const result = await memorizeBlame(runDir, templateDir);
    expect(result.file).toBe(join(templateDir, 'memory.md'));
    expect(result.written).toBe(1);
    expect(result.updated).toBe(0);

    const body = await fs.readFile(result.file, 'utf8');
    expect(body).toContain('sig: blame:gameplay::');
    expect(body).toContain('recurrence: 1');
    expect(body).toContain('**Root:** (pending');
    expect(body).toContain('**Prevention:** (pending');

    // the REAL reader (recurrence.ts), not a re-implementation — the cross-oracle the design doc requires.
    const index = deriveRecurrence({ templateDir, nodes: [] });
    const hit = [...index.entries()].find(([sig]) => sig.startsWith('blame:gameplay::'));
    expect(hit).toBeDefined();
    expect(hit?.[1].count).toBe(1);
  });

  it('a SECOND memorizeBlame over the SAME RUN is idempotent — recurrence STAYS 1 (generations, not invocations), NO duplicate block', async () => {
    const dir = await scratch();
    const runDir = join(dir, 'run');
    const templateDir = join(dir, 'template');
    await fs.mkdir(templateDir, { recursive: true });
    await writeSummary(runDir, { blamed: [{ node: 'gameplay', severity: 'high', observedAt: ['gameplay'] }], edges: [], unattributed: [] });
    await writeBlameFile(runDir, 'gameplay', 'The combat loop drops enemy hits below the 3-hit combo threshold.');

    const first = await memorizeBlame(runDir, templateDir);
    expect(first.written).toBe(1);
    // blame is idempotent/re-runnable — re-memorizing the SAME run is NOT a second observation of the defect.
    const second = await memorizeBlame(runDir, templateDir);
    expect(second.written).toBe(0);
    expect(second.updated).toBe(0); // same generation → NO recurrence bump

    const body = await fs.readFile(second.file, 'utf8');
    const occurrences = body.split('sig: blame:gameplay::').length - 1;
    expect(occurrences).toBe(1); // never duplicated
    expect(body).toContain('recurrence: 1'); // STILL one generation, not two

    const index = deriveRecurrence({ templateDir, nodes: [] });
    const hit = [...index.entries()].find(([sig]) => sig.startsWith('blame:gameplay::'));
    expect(hit?.[1].count).toBe(1);
  });

  it('the SAME defect re-observed in a DIFFERENT run bumps recurrence to 2 (one block, two run ids)', async () => {
    const dir = await scratch();
    const runDir1 = join(dir, 'gen1');
    const runDir2 = join(dir, 'gen2');
    const templateDir = join(dir, 'template');
    await fs.mkdir(templateDir, { recursive: true });
    const blamed: BlameSummary = { blamed: [{ node: 'gameplay', severity: 'high', observedAt: ['gameplay'] }], edges: [], unattributed: [] };
    const defect = 'The combat loop drops enemy hits below the 3-hit combo threshold.';

    await writeSummary(runDir1, blamed);
    await writeBlameFile(runDir1, 'gameplay', defect);
    expect((await memorizeBlame(runDir1, templateDir)).written).toBe(1);

    // the SAME defect (same symptom → same sig) exhibited by a SEPARATE run = a new generation.
    await writeSummary(runDir2, blamed);
    await writeBlameFile(runDir2, 'gameplay', defect);
    const second = await memorizeBlame(runDir2, templateDir);
    expect(second.written).toBe(0);
    expect(second.updated).toBe(1); // a distinct generation → recurrence bumps

    const body = await fs.readFile(second.file, 'utf8');
    expect(body.split('sig: blame:gameplay::').length - 1).toBe(1); // ONE block
    expect(body).toContain('recurrence: 2');
    expect(body).toMatch(/runs: gen1, gen2/); // both generations recorded

    const index = deriveRecurrence({ templateDir, nodes: [] });
    const hit = [...index.entries()].find(([sig]) => sig.startsWith('blame:gameplay::'));
    expect(hit?.[1].count).toBe(2);
  });

  it('a DIFFERENT defect on the same node gets its OWN block (different tag), not an update of the first', async () => {
    const dir = await scratch();
    const runDir1 = join(dir, 'run1');
    const runDir2 = join(dir, 'run2');
    const templateDir = join(dir, 'template');
    await fs.mkdir(templateDir, { recursive: true });

    await writeSummary(runDir1, { blamed: [{ node: 'gameplay', severity: 'high', observedAt: ['gameplay'] }], edges: [], unattributed: [] });
    await writeBlameFile(runDir1, 'gameplay', 'The combat loop drops enemy hits below the 3-hit combo threshold.');
    await memorizeBlame(runDir1, templateDir);

    await writeSummary(runDir2, { blamed: [{ node: 'gameplay', severity: 'medium', observedAt: ['gameplay'] }], edges: [], unattributed: [] });
    await writeBlameFile(runDir2, 'gameplay', 'The inventory UI never refreshes after a pickup event.');
    const second = await memorizeBlame(runDir2, templateDir);

    expect(second.written).toBe(1);
    expect(second.updated).toBe(0);
    const body = await fs.readFile(second.file, 'utf8');
    const sigLines = body.split('\n').filter((l) => l.trim().startsWith('sig: blame:gameplay::'));
    expect(sigLines.length).toBe(2);
  });

  it('preserves curated content already in template-root memory.md (create-if-absent, never clobber)', async () => {
    const dir = await scratch();
    const runDir = join(dir, 'run');
    const templateDir = join(dir, 'template');
    await fs.mkdir(templateDir, { recursive: true });
    await fs.writeFile(join(templateDir, 'memory.md'), '# t — system memory\n\nCURATED RECONCILE NOTE\n');
    await writeSummary(runDir, { blamed: [{ node: 'gameplay', severity: 'low', observedAt: [] }], edges: [], unattributed: [] });
    await writeBlameFile(runDir, 'gameplay', 'Some defect line here.');

    const result = await memorizeBlame(runDir, templateDir);
    const body = await fs.readFile(result.file, 'utf8');
    expect(body).toContain('CURATED RECONCILE NOTE');
    expect(body).toContain('sig: blame:gameplay::');
  });
});

// ── (3) dissent blocks (§4.1) ─────────────────────────────────────────────────────────────────────────────
describe('memorizeBlame — dissent traces', () => {
  it('writes a blame-dissent: sig block for every dissent.<node>.md on disk, distinct from the blamed sig', async () => {
    const dir = await scratch();
    const runDir = join(dir, 'run');
    const templateDir = join(dir, 'template');
    await fs.mkdir(templateDir, { recursive: true });
    await writeSummary(runDir, { blamed: [{ node: 'gameplay', severity: 'high', observedAt: ['gameplay'] }], edges: [], unattributed: [] });
    await writeBlameFile(runDir, 'gameplay', 'The combat loop drops enemy hits below the 3-hit combo threshold.');
    await writeDissentFile(runDir, 'gameplay', 'Node-local evidence contradicts: the combo counter is correct; the defect is upstream in matchmaking.');

    const result = await memorizeBlame(runDir, templateDir);
    expect(result.written).toBe(2); // one blamed + one dissent block
    const body = await fs.readFile(result.file, 'utf8');
    expect(body).toContain('sig: blame:gameplay::');
    expect(body).toContain('sig: blame-dissent:gameplay::');

    const index = deriveRecurrence({ templateDir, nodes: [] });
    const blamedHit = [...index.keys()].some((sig) => sig.startsWith('blame:gameplay::'));
    const dissentHit = [...index.keys()].some((sig) => sig.startsWith('blame-dissent:gameplay::'));
    expect(blamedHit).toBe(true);
    expect(dissentHit).toBe(true);
  });

  it('a dissent for a node the summary never blamed is still recorded (contest scanned off disk, not the summary)', async () => {
    const dir = await scratch();
    const runDir = join(dir, 'run');
    const templateDir = join(dir, 'template');
    await fs.mkdir(templateDir, { recursive: true });
    await writeSummary(runDir, { blamed: [], edges: [], unattributed: ['some end-to-end defect'] });
    await writeDissentFile(runDir, 'ui', 'Contested: blame named this node but node-local evidence shows it is clean.');

    const result = await memorizeBlame(runDir, templateDir);
    expect(result.written).toBe(1);
    const body = await fs.readFile(result.file, 'utf8');
    expect(body).toContain('sig: blame-dissent:ui::');
  });
});
