import { describe, it, expect, vi, afterEach } from 'vitest';
import { nodeSchema } from '@piflow/core';
import { runSchemaCli, CLI_TOPICS, renderAddNodeHelp } from '../src/schema.js';

// `piflowctl schema <topic>` is a TOPIC-SEGMENTED, concise CLI-syntax reference for the add-node
// authoring flags: an agent pulls only the slice it needs, instead of a front-loaded raw dump. The
// load-bearing guarantee is ANTI-DRIFT BY SINGLE SOURCE: `CLI_TOPICS` is the ONE data structure rendered
// into BOTH `piflowctl schema` AND the add-node `--help`, so the two can never diverge. The `--json`
// escape hatch keeps the formal @piflow/core schema re-export (anti-drift by construction).

/** Run `runSchemaCli(argv)`, capturing whatever it writes to stdout/stderr (and the exit code). */
function capture(argv: string[]): { stdout: string; stderr: string; exitCode: number } {
  let stdout = '';
  let stderr = '';
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
  process.exitCode = 0;
  try {
    runSchemaCli(argv);
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return { stdout, stderr, exitCode };
}

// Every add-node authoring flag the reference MUST cover (the canonical list from the spec). The
// coverage test asserts each appears in EXACTLY ONE topic's lines — so the reference can't silently drop
// (or duplicate) a flag.
const CANONICAL_FLAGS = [
  // node (the spine)
  '--id', '--phase', '--dep', '--artifact', '--owns', '--read', '--return-mode', '--programmatic', '--prompt-file',
  // tools
  '--tool', '--deny', '--inject', '--mcp',
  // agent
  '--agent-type', '--skill', '--executor',
  // routing
  '--model', '--provider', '--tier', '--timeout', '--retries',
  // derive
  '--seed', '--project', '--merge-run', '--promote', '--registry-project',
  // checks (+ gate)
  '--check', '--check-pre', '--on-fail', '--on-warn', '--gate-run',
  // control
  '--escalate', '--reroute',
  // judge
  '--judge', '--judge-on-fail', '--judge-retry-max', '--judge-retry-scope',
  // hitl
  '--checkpoint', '--checkpoint-choice', '--checkpoint-default', '--checkpoint-headless', '--checkpoint-timeout',
  // topology
  '--fusion', '--fusion-n', '--fusion-panel', '--fusion-judge', '--fusion-obligations', '--fusion-no-verify', '--subworkflow',
  // contract
  '--full-access', '--fill-sentinel', '--schema',
] as const;

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe('piflowctl schema — topic-segmented CLI-syntax reference', () => {
  it('the bare INDEX lists every topic key and prints NO flags (no front-loading)', () => {
    const { stdout, exitCode } = capture([]);
    expect(exitCode).toBe(0);
    // Every topic key appears in the index…
    for (const key of Object.keys(CLI_TOPICS)) {
      expect(stdout).toContain(key);
    }
    // …but the index must not front-load any flag syntax.
    expect(stdout).not.toMatch(/--[a-z]/);
    // and it points the agent at the next call.
    expect(stdout).toContain('piflowctl schema <topic>');
  });

  it('`schema judge` prints the judge flags AND the judge.md + tier-must-differ gotcha', () => {
    const { stdout, exitCode } = capture(['judge']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('--judge');
    expect(stdout).toContain('--judge-on-fail');
    expect(stdout).toContain('--judge-retry-scope');
    // The two load-bearing gotchas for judge authoring:
    expect(stdout).toContain('judge.md');
    expect(stdout.toLowerCase()).toMatch(/judgetier.*differ|differ.*--tier/);
    // A topic page is the slice ONLY — it must NOT dump an unrelated topic's flag.
    expect(stdout).not.toContain('--fusion');
  });

  it('an unknown topic exits non-zero and lists the valid topics on stderr', () => {
    const { stdout, stderr, exitCode } = capture(['bogus']);
    expect(exitCode).not.toBe(0);
    expect(stdout).toBe('');
    // Lists the real topics so the agent can self-correct.
    for (const key of Object.keys(CLI_TOPICS)) {
      expect(stderr).toContain(key);
    }
  });

  it('SINGLE SOURCE: the lines `schema <topic>` prints are the SAME content the add-node --help renders', () => {
    const help = renderAddNodeHelp();
    // Prove (for two independent topics) that the help body literally contains the topic page's lines —
    // i.e. both surfaces render from the one CLI_TOPICS structure, so they cannot diverge.
    for (const topic of ['judge', 'derive'] as const) {
      for (const line of CLI_TOPICS[topic].lines) {
        expect(help).toContain(line);
      }
    }
  });

  it('COVERAGE: every add-node flag appears in EXACTLY ONE topic page', () => {
    for (const flag of CANONICAL_FLAGS) {
      // Count topics whose lines mention this flag as a standalone token (boundary on the flag, so
      // `--check` does not match `--check-pre`).
      const owners = Object.entries(CLI_TOPICS).filter(([, t]) =>
        t.lines.some((l) =>
          new RegExp(`(^|[^-\\w])${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^-\\w]|$)`).test(l),
        ),
      );
      expect(
        owners.length,
        `${flag} must be covered by exactly one topic (found: ${owners.map(([k]) => k).join(',') || 'none'})`,
      ).toBe(1);
    }
  });

  it('`schema --json node` still DEEP-EQUALS the imported @piflow/core nodeSchema (anti-drift escape hatch)', () => {
    const { stdout, exitCode } = capture(['--json', 'node']);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual(nodeSchema);
  });

  it('`schema --json` defaults to the node schema', () => {
    const { stdout, exitCode } = capture(['--json']);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual(nodeSchema);
  });
});
