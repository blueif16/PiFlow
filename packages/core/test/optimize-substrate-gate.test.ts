// optimize/substrate/gate.ts — the GATE agent (third base-agent turn). Three independently-testable layers,
// none of which ever spawns a real agent:
//   (1) buildGatePrompt — prompt ASSEMBLY: the bar (optimize.judge), the issue, the diff, the account, and the
//       exact verdict-file path all land in the string; a declared-but-missing judge file HALTS.
//   (2) parseGateVerdict — the FAIL-CLOSED verdict-file parse: a malformed / mislabeled verdict throws, never
//       a silent accept.
//   (3) runSubstrateGate — the full WIRING, with the agent spawn replaced by an injected runAgent stub that
//       writes a fake verdict.json (never a live claude spawn — a live gate proves agent behavior, not this).
//
// Run: npx vitest run packages/core/test/optimize-substrate-gate.test.ts

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildGatePrompt,
  parseGateVerdict,
  runSubstrateGate,
  GATE_SKILL,
} from '../src/optimize/substrate/gate.js';
import type { RunBaseAgentOpts, RunBaseAgentResult } from '../src/optimize/substrate/agent.js';

const tmpDirs: string[] = [];
const scratch = async (prefix = 'piflow-gate-'): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** Write `<templateDir>/nodes/<node>/node.json` carrying just the `optimize` block gate.ts reads via fs. */
async function writeNodeJson(templateDir: string, node: string, optimize: Record<string, unknown>): Promise<void> {
  const dir = join(templateDir, 'nodes', node);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'node.json'), JSON.stringify({ label: node, optimize }, null, 2));
}

// ── (1) buildGatePrompt ────────────────────────────────────────────────────────────────────────────────────

describe('buildGatePrompt', () => {
  it('embeds the bar, the issue, the diff, the account, and the exact verdict path', async () => {
    const templateDir = await scratch();
    await writeNodeJson(templateDir, 'w0-classify', { judge: 'criteria.md' });
    await fs.writeFile(join(templateDir, 'criteria.md'), 'CRITERION: every prompt-named mechanic is classified.');

    const prompt = await buildGatePrompt('w0-classify', {
      runDir: '/runs/child01',
      workspace: templateDir,
      templateDir,
      issueFileText: 'ISSUE: the ladder mechanic is silently dropped.',
      fixerDiff: 'DIFF: +classify(ladder)',
      fixerAccount: 'ACCOUNT: I added a rule to enumerate every named mechanic.',
      verdictPath: '/runs/child01/optimize/substrate/gate/verdict.json',
    });

    expect(prompt).toContain('CRITERION: every prompt-named mechanic is classified.');
    expect(prompt).toContain('ISSUE: the ladder mechanic is silently dropped.');
    expect(prompt).toContain('DIFF: +classify(ladder)');
    expect(prompt).toContain('ACCOUNT: I added a rule to enumerate every named mechanic.');
    expect(prompt).toContain('/runs/child01/optimize/substrate/gate/verdict.json');
    // the separation law + refute-by-default framing must be present (the gate never fixes/adopts)
    expect(prompt).toMatch(/never adopt|SEPARATION LAW/i);
  });

  it('resolves the bar via optimize.criteria (the WS3 rename), not only the legacy judge alias', async () => {
    const templateDir = await scratch();
    await writeNodeJson(templateDir, 'w0-classify', { criteria: 'criteria.md' });
    await fs.writeFile(join(templateDir, 'criteria.md'), 'CRITERION-VIA-CRITERIA-KEY');
    const prompt = await buildGatePrompt('w0-classify', {
      runDir: '/r', workspace: templateDir, templateDir,
      issueFileText: 'x', fixerDiff: '', fixerAccount: '', verdictPath: '/r/v.json',
    });
    expect(prompt).toContain('CRITERION-VIA-CRITERIA-KEY');
  });

  it('HALTS when the node declares neither optimize.criteria nor the judge alias (the gate has no bar)', async () => {
    const templateDir = await scratch();
    await writeNodeJson(templateDir, 'w0-classify', {}); // no bar
    await expect(
      buildGatePrompt('w0-classify', {
        runDir: '/r', workspace: templateDir, templateDir,
        issueFileText: 'x', fixerDiff: '', fixerAccount: '', verdictPath: '/r/v.json',
      }),
    ).rejects.toThrow(/no "optimize\.criteria"/);
  });

  it('HALTS when the declared optimize.judge file is missing', async () => {
    const templateDir = await scratch();
    await writeNodeJson(templateDir, 'w0-classify', { judge: 'nope.md' });
    await expect(
      buildGatePrompt('w0-classify', {
        runDir: '/r', workspace: templateDir, templateDir,
        issueFileText: 'x', fixerDiff: '', fixerAccount: '', verdictPath: '/r/v.json',
      }),
    ).rejects.toThrow(/was not found/);
  });
});

// ── (2) parseGateVerdict — fail-closed ─────────────────────────────────────────────────────────────────────

describe('parseGateVerdict (fail-closed)', () => {
  it('accepts a valid ACCEPT verdict (no category/steer)', () => {
    const v = parseGateVerdict(JSON.stringify({ decision: 'accept', rationale: 'defect absent; no regression' }));
    expect(v.decision).toBe('accept');
    expect(v.category).toBeUndefined();
    expect(v.steer).toBeUndefined();
  });

  it('accepts a valid REJECT verdict with a category + steer', () => {
    const v = parseGateVerdict(JSON.stringify({
      decision: 'reject', rationale: 'the check was loosened, not the cause fixed',
      category: 'band-aid', steer: 'the root is in the prompt, not the schema',
    }));
    expect(v.decision).toBe('reject');
    expect(v.category).toBe('band-aid');
    expect(v.steer).toBe('the root is in the prompt, not the schema');
  });

  it('THROWS on a reject with no category (a drop-back has no signal without it)', () => {
    expect(() => parseGateVerdict(JSON.stringify({ decision: 'reject', rationale: 'nope' }))).toThrow(/category/);
  });

  it('THROWS on an invalid category', () => {
    expect(() => parseGateVerdict(JSON.stringify({ decision: 'reject', rationale: 'x', category: 'meh' }))).toThrow(/category/);
  });

  it('THROWS when an accept smuggles a category (mislabeled verdict)', () => {
    expect(() => parseGateVerdict(JSON.stringify({ decision: 'accept', rationale: 'x', category: 'band-aid' }))).toThrow(/omitted on an accept/);
  });

  it('THROWS on a bad decision, empty rationale, or non-JSON', () => {
    expect(() => parseGateVerdict(JSON.stringify({ decision: 'maybe', rationale: 'x' }))).toThrow(/decision/);
    expect(() => parseGateVerdict(JSON.stringify({ decision: 'accept', rationale: '' }))).toThrow(/rationale/);
    expect(() => parseGateVerdict(JSON.stringify({ decision: 'accept', rationale: '   ' }))).toThrow(/rationale/);
    expect(() => parseGateVerdict('not json at all')).toThrow(/valid JSON/);
  });
});

// ── (3) runSubstrateGate — wiring, with an injected runAgent seam (never a live spawn) ─────────────────────────

describe('runSubstrateGate', () => {
  /** A stub runAgent that records the spawn opts and WRITES a fake verdict.json into the agent's owned dir. */
  function stubAgent(verdict: object): {
    runAgent: (o: RunBaseAgentOpts) => Promise<RunBaseAgentResult>;
    seen: { last?: RunBaseAgentOpts };
  } {
    const seen: { last?: RunBaseAgentOpts } = {};
    const runAgent = async (o: RunBaseAgentOpts): Promise<RunBaseAgentResult> => {
      seen.last = o;
      const gateOutDir = o.owns[0];
      await fs.mkdir(gateOutDir, { recursive: true });
      await fs.writeFile(join(gateOutDir, 'verdict.json'), JSON.stringify(verdict));
      return { status: {} as RunBaseAgentResult['status'], text: 'done', runDir: undefined };
    };
    return { runAgent, seen };
  }

  async function fixture(): Promise<{ runDir: string; templateDir: string }> {
    const runDir = await scratch('piflow-gate-run-');
    const templateDir = await scratch('piflow-gate-tpl-');
    await writeNodeJson(templateDir, 'w0-classify', { judge: 'criteria.md' });
    await fs.writeFile(join(templateDir, 'criteria.md'), 'CRITERION: enumerate every named mechanic.');
    return { runDir, templateDir };
  }

  const baseOpts = (runDir: string, templateDir: string) => ({
    workspace: templateDir,
    templateDir,
    issueFileText: 'ISSUE: dropped ladder mechanic',
    fixerDiff: 'DIFF',
    fixerAccount: 'ACCOUNT',
  });

  it('spawns the gate with skill=piflow-gate, owns the gate dir, and reads back the parsed verdict', async () => {
    const { runDir, templateDir } = await fixture();
    const { runAgent, seen } = stubAgent({ decision: 'accept', rationale: 'defect absent' });

    const res = await runSubstrateGate(runDir, 'w0-classify', { ...baseOpts(runDir, templateDir), runAgent });

    expect(res.verdict?.decision).toBe('accept');
    expect(res.verdictPath).toBe(join(runDir, 'optimize', 'substrate', 'gate', 'verdict.json'));
    // wiring: the correct skill was staged, the run dir is granted read, and the gate owns its out dir.
    expect(seen.last?.skill).toBe(GATE_SKILL);
    expect(seen.last?.readScope).toContain(runDir);
    expect(seen.last?.owns).toEqual([join(runDir, 'optimize', 'substrate', 'gate')]);
  });

  it('grants read of candidateRef when provided', async () => {
    const { runDir, templateDir } = await fixture();
    const { runAgent, seen } = stubAgent({ decision: 'reject', rationale: 'band-aid', category: 'band-aid' });
    await runSubstrateGate(runDir, 'w0-classify', { ...baseOpts(runDir, templateDir), candidateRef: '/cand/x', runAgent });
    expect(seen.last?.readScope).toContain('/cand/x');
  });

  it('dry-run returns the composed plan and writes NO verdict', async () => {
    const { runDir, templateDir } = await fixture();
    const runAgent = async (o: RunBaseAgentOpts): Promise<RunBaseAgentResult> => ({ plan: { label: 'agent', prompt: o.prompt } as RunBaseAgentResult['plan'] });
    const res = await runSubstrateGate(runDir, 'w0-classify', { ...baseOpts(runDir, templateDir), dryRun: true, runAgent });
    expect(res.dryRun).toBeDefined();
    expect(res.verdict).toBeUndefined();
    // no verdict file was written on a dry-run
    await expect(fs.readFile(join(runDir, 'optimize', 'substrate', 'gate', 'verdict.json'), 'utf8')).rejects.toThrow();
  });

  it('THROWS (never silent-accepts) when the agent writes no verdict', async () => {
    const { runDir, templateDir } = await fixture();
    const runAgent = async (): Promise<RunBaseAgentResult> => ({ status: {} as RunBaseAgentResult['status'], text: 'i did nothing' });
    await expect(
      runSubstrateGate(runDir, 'w0-classify', { ...baseOpts(runDir, templateDir), runAgent }),
    ).rejects.toThrow(/wrote no verdict/);
  });
});
