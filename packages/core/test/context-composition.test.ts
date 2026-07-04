// Tests for the context-composition "element tree" (packages/core/src/observe/contextComposition.ts) — the
// ordered per-op reconstruction of what reached the model (force-injected prompt + every agent read, each
// with range/coverage/sha/order) + the advertised-vs-read blind-spot. Driven off a fixture DERIVED from
// gm10's real gameplay `events.jsonl` (a trimmed slice copied into test/fixtures/context-composition).
//
// Each assertion FAILS when the code is wrong: the anti-footgun case (a truncated:true log preview must NOT
// become covered:'partial'), the coverage math (half-file range → ~0.5 partial), and the blind-spot
// (design-rules.md advertised but never read). Also covers the reads-manifest emit (correct run-time sha).
//
// Run: npx vitest run packages/core/test/context-composition.test.ts

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { buildNodeContext, type ContextOp, type NodeContext } from '../src/observe/contextComposition.js';
import { makeDisplayPath, scopeKind } from '../src/observe/runView.js';
import { emitReadsManifest } from '../src/runner/node-lifecycle.js';

const FIX = path.join(__dirname, 'fixtures', 'context-composition');

// The fixture's absolute-path roots (baked into events.jsonl + reads-manifest.json — independent of the
// tmp dir the events file physically lives in).
const WS = '/ws';
const RUN = '/ws/run';

/** Stage the fixture events.jsonl into a real tmp run dir and build the node context off it. */
async function buildFromFixture(): Promise<NodeContext> {
  const [events, promptText, manifestRaw] = await Promise.all([
    fs.readFile(path.join(FIX, 'events.jsonl'), 'utf8'),
    fs.readFile(path.join(FIX, 'prompt.md'), 'utf8'),
    fs.readFile(path.join(FIX, 'reads-manifest.json'), 'utf8'),
  ]);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxcomp-'));
  const nodeDir = path.join(tmp, '.pi', 'nodes', 'gameplay');
  await fs.mkdir(nodeDir, { recursive: true });
  await fs.writeFile(path.join(nodeDir, 'events.jsonl'), events);

  const displayPath = makeDisplayPath(RUN, WS);
  const underRun = (abs: string) => abs === RUN || abs.startsWith(RUN + '/');
  return buildNodeContext(tmp, 'gameplay', {
    displayPath,
    scopeOf: (abs, dp) => (underRun(abs) ? 'run' : scopeKind(dp)),
    promptText,
    promptPath: path.join(RUN, '.pi', 'nodes', 'gameplay', 'prompt.md'),
    manifest: JSON.parse(manifestRaw),
  });
}

const byCallId = (ctx: ContextOp[], id: string) => ctx.find((o) => o.toolCallId === id);

describe('buildNodeContext — ordered element tree', () => {
  it('prepends the staged prompt.md as seq 0, op:"inject", full coverage', async () => {
    const { context } = await buildFromFixture();
    const inject = context[0];
    expect(inject.seq).toBe(0);
    expect(inject.op).toBe('inject');
    expect(inject.toolCallId).toBeNull();
    expect(inject.displayPath).toBe('.pi/nodes/gameplay/prompt.md');
    expect(inject.scope).toBe('run');
    expect(inject.coverage).toBe(1);
    expect(inject.covered).toBe('full');
    expect(inject.sha256).toMatch(/^sha256:/); // computed off the prompt text
    expect(inject.fileBytes).toBeGreaterThan(0);
  });

  it('keeps ops in chronological order with monotonically increasing seq', async () => {
    const { context } = await buildFromFixture();
    for (let i = 0; i < context.length; i++) expect(context[i].seq).toBe(i);
    // the first agent read comes AFTER the inject (seq 0)
    const firstRead = context.find((o) => o.op === 'read');
    expect(firstRead!.seq).toBeGreaterThan(0);
  });

  it('classifies scope per file (skill vs run) and surfaces a read error type', async () => {
    const { context } = await buildFromFixture();
    const eperm = byCallId(context, 'call_eperm')!;
    expect(eperm.displayPath).toBe('packages/skills/harden-blueprint/SKILL.md');
    expect(eperm.scope).toBe('skill');
    expect(eperm.ok).toBe(false);
    expect(eperm.errorType).toBe('EPERM');
    const runSkill = byCallId(context, 'call_skill_full')!;
    expect(runSkill.scope).toBe('run');
  });

  it('a FAILED read (EPERM) is NOT counted as delivered — covered:"unknown", no coverage, no bytes', async () => {
    const { context } = await buildFromFixture();
    // The reads-manifest HAS sizes for this EPERM'd path (380 lines) — a naive impl reports it as FULLY
    // covered (the review's MAJOR finding). A read that delivered NOTHING to the model must not read as full.
    const eperm = byCallId(context, 'call_eperm')!;
    expect(eperm.ok).toBe(false);
    expect(eperm.fileLines).toBe(380);       // size still shown (for display) …
    expect(eperm.covered).toBe('unknown');   // … but the model got nothing
    expect(eperm.coverage).toBeNull();
    expect(eperm.returnedBytes).toBeNull();  // the EPERM error text is NOT "bytes delivered"
  });
});

describe('buildNodeContext — advertised blind-spot', () => {
  it('lists design-rules.md as advertised AND advertisedUnread (the prompt names it, 0 reads)', async () => {
    const { composition } = await buildFromFixture();
    expect(composition.advertised.some((a) => a.endsWith('design-rules.md'))).toBe(true);
    expect(composition.advertisedUnread.some((a) => a.endsWith('design-rules.md'))).toBe(true);
    // NOISE must NOT pollute the blind-spot: globs / bare dirs / decimals / slash-prose are not files-to-read.
    expect(composition.advertised).not.toContain('spec/**');
    expect(composition.advertised.some((a) => a === 'templates/modules' || a.endsWith('/modules'))).toBe(false);
    expect(composition.advertised.some((a) => a.includes('5.6'))).toBe(false);
    expect(composition.advertised.some((a) => a.includes('jump/dash/move'))).toBe(false);
    // a real ABSOLUTE DRIVER-scope file is captured WHOLE (leading slash) then display-stripped.
    expect(composition.advertised).toContain('templates/genres.json');
  });

  it('does NOT flag a file that WAS read (SKILL.md, blueprint.json) as unread', async () => {
    const { composition } = await buildFromFixture();
    expect(composition.advertised.some((a) => a.endsWith('SKILL.md'))).toBe(true);
    expect(composition.advertisedUnread.some((a) => a.endsWith('SKILL.md'))).toBe(false);
    expect(composition.advertisedUnread.some((a) => a.endsWith('blueprint.json'))).toBe(false);
  });

  it('counts distinct read files (dedup paged reads of the same file)', async () => {
    const { composition } = await buildFromFixture();
    // run SKILL.md (read twice, one path) + blueprint.json + gdd.md + bigmap.json = 4.
    // The packages/skills SKILL.md read FAILED (EPERM) → delivered nothing → NOT a counted read.
    expect(composition.readFiles).toBe(4);
    expect(composition.injectedBytes).toBeGreaterThan(0);
  });
});

describe('buildNodeContext — the ANTI-FOOTGUN (log cap ≠ model truncation)', () => {
  it('a SKILL.md read whose event carried truncated:true is covered:"full" + logPreviewCapped:true', async () => {
    const { context } = await buildFromFixture();
    // call_skill_full: a NO-OFFSET read of a 380-line / 12KB file → whole-file → FULL coverage, even though
    // its tool_execution_end.result carried "truncated":true (that is the events.jsonl 2048 PREVIEW cap).
    const op = byCallId(context, 'call_skill_full')!;
    expect(op.logPreviewCapped).toBe(true);   // the cosmetic log note is surfaced …
    expect(op.covered).toBe('full');          // … but MUST NOT drive coverage
    expect(op.coverage).toBe(1);
    // MUTATION GUARD: if the code mapped the log-preview cap to covered:'partial', this fails.
    expect(op.covered).not.toBe('partial');
  });
});

describe('buildNodeContext — coverage math on a genuinely large file', () => {
  it('a ranged read covering half a large file → coverage ≈ 0.5, covered:"partial"', async () => {
    const { context, composition } = await buildFromFixture();
    // call_bigmap: offset 2000 / limit 2000 over a 4000-line file → exactly half.
    const op = byCallId(context, 'call_bigmap')!;
    expect(op.range).toEqual({ offset: 2000, limit: 2000 });
    expect(op.fileLines).toBe(4000);
    expect(op.coverage).toBeCloseTo(0.5, 5);
    expect(op.covered).toBe('partial');
    expect(op.sha256).toBe('sha256:eee5'); // carried from the run-time reads-manifest, not the on-disk file
    expect(composition.partialReads).toContain('spec/bigmap.json');
    // a fully-covered small file is NOT partial
    expect(composition.partialReads).not.toContain('spec/blueprint.json');
  });
});

describe('emitReadsManifest — the ONE new collection (run-time sha)', () => {
  it('writes a manifest with the correct sha/bytes/lines for every read path', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'readsmanifest-'));
    // a known file the node "read"
    const known = path.join(tmp, 'known.md');
    const content = 'alpha\nbeta\ngamma\n'; // 3 newline-terminated lines
    await fs.writeFile(known, content);
    const gone = path.join(tmp, 'gone.md'); // referenced but never on disk → must be SKIPPED
    // stage the node's events.jsonl
    const nodeDir = path.join(tmp, '.pi', 'nodes', 'n1');
    await fs.mkdir(nodeDir, { recursive: true });
    const events = [
      JSON.stringify({ type: 'tool_execution_start', toolName: 'read', toolCallId: 'a', args: { path: known } }),
      JSON.stringify({ type: 'tool_execution_start', toolName: 'read', toolCallId: 'b', args: { path: gone } }),
      JSON.stringify({ type: 'tool_execution_start', toolName: 'bash', toolCallId: 'c', args: { command: 'ls' } }),
    ].join('\n') + '\n';
    await fs.writeFile(path.join(nodeDir, 'events.jsonl'), events);

    await emitReadsManifest(tmp, 'n1');

    const manifest = JSON.parse(await fs.readFile(path.join(nodeDir, 'reads-manifest.json'), 'utf8'));
    const expectedSha = 'sha256:' + createHash('sha256').update(content).digest('hex');
    expect(manifest[known].sha256).toBe(expectedSha);
    expect(manifest[known].bytes).toBe(Buffer.byteLength(content));
    expect(manifest[known].lines).toBe(3);
    expect(manifest[gone]).toBeUndefined();   // skipped: no longer exists
    expect(Object.keys(manifest)).not.toContain('ls'); // bash is not a read
  });
});
