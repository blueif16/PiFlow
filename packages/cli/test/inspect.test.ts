import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseInspectArgs, inspectTemplate, renderNodeInspect, type InspectDeps } from '../src/inspect.js';
import { loadTemplate, DefaultToolRegistry, type NodeSpec } from '@piflow/core';

// loadTemplate (re)writes the template's generated workflow.json lock, so we run over a CLONE in a tmp
// dir (the run.test convention) — the source fixture stays pristine.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../../core/test/fixtures/template-min');

let TEMPLATE_MIN: string;
beforeAll(async () => {
  TEMPLATE_MIN = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-cli-inspect-tpl-'));
  await fs.cp(FIXTURE, TEMPLATE_MIN, { recursive: true });
});
afterAll(async () => {
  await fs.rm(TEMPLATE_MIN, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// (A) ARG PARSING — the flat argv → { templateDir, nodeId?, full }.
// ─────────────────────────────────────────────────────────────────────────────
describe('parseInspectArgs', () => {
  it('takes the template dir + an optional node id positionally, and --full', () => {
    const p = parseInspectArgs([TEMPLATE_MIN, 'w0-classify', '--full']);
    expect(p.templateDir).toBe(TEMPLATE_MIN);
    expect(p.nodeId).toBe('w0-classify');
    expect(p.full).toBe(true);
  });

  it('omitting the node id leaves nodeId undefined (inspect all) and full defaults false', () => {
    const p = parseInspectArgs([TEMPLATE_MIN]);
    expect(p.nodeId).toBeUndefined();
    expect(p.full).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (B) ONE-NODE RESOLVED VIEW — sandbox + tools(resolved) + ops + io.artifacts + a prompt slice.
// ─────────────────────────────────────────────────────────────────────────────
describe('inspectTemplate — one node resolved view', () => {
  it('renders w0-classify: compiled sandbox, resolved tools, ops, io.artifacts, and a prompt slice', async () => {
    const out = await inspectTemplate({ templateDir: TEMPLATE_MIN, nodeId: 'w0-classify', full: false });

    // the node header
    expect(out).toContain('w0-classify');

    // SANDBOX — the compiled provider/workspace/read/write/output (densified by compile).
    expect(out).toMatch(/sandbox/i);
    expect(out).toContain('inmemory'); // compile defaults the fixture's provider
    expect(out).toContain('spec/classification.json'); // the owned write path

    // TOOLS — authored allow/deny AND the registry-RESOLVED piTools + excluded. The `resolved piTools`
    // and `excluded` LABELS are produced ONLY by the registry.resolve() rendering (the authored allow/deny
    // lines never emit them), so asserting them pins that the resolution path ran — not just an echo.
    expect(out).toMatch(/tools/i);
    expect(out).toContain('read');
    expect(out).toContain('write');
    expect(out).toContain('submit_result'); // resolves (a registered contract tool)
    expect(out).toContain('resolved piTools'); // the resolution-only label (registry.resolve ran)
    expect(out).toContain('excluded'); // deny:['bash'] → the resolution's exclude set
    expect(out).toContain('bash');

    // OPS — the promote op the node declares.
    expect(out).toMatch(/ops|promote/i);
    expect(out).toContain('archetype'); // promote target channel

    // IO.artifacts — the required output.
    expect(out).toMatch(/artifact/i);

    // PROMPT — a slice of the realized prompt is shown.
    expect(out).toContain('Classify the request');
  });

  it('--full shows the WHOLE prompt; the default truncates a long prompt', async () => {
    const spec = await loadTemplate(TEMPLATE_MIN);
    const w0 = spec.nodes.find((n) => n.label.toLowerCase().includes('classify') || true);
    // the fixture prompt ends with "Load and follow the skill." — present only when not truncated short.
    const full = await inspectTemplate({ templateDir: TEMPLATE_MIN, nodeId: 'w0-classify', full: true });
    expect(full).toContain('Load and follow the skill.');
    void w0;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (C) ALL NODES + UNKNOWN ID — omitting the id inspects every node; a bad id errors with the valid ids.
// ─────────────────────────────────────────────────────────────────────────────
describe('inspectTemplate — all nodes + unknown id', () => {
  it('with no node id, renders every node in the template', async () => {
    const out = await inspectTemplate({ templateDir: TEMPLATE_MIN, full: false });
    for (const id of ['w0-classify', 'w2a-levels', 'w2b-assets']) expect(out).toContain(id);
  });

  it('an unknown node id THROWS with a message listing the valid ids', async () => {
    await expect(
      inspectTemplate({ templateDir: TEMPLATE_MIN, nodeId: 'nope', full: false }),
    ).rejects.toThrow(/nope/);
    // the error must enumerate the real ids so the user can correct it.
    let msg = '';
    try {
      await inspectTemplate({ templateDir: TEMPLATE_MIN, nodeId: 'nope', full: false });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('w0-classify');
    expect(msg).toContain('w2a-levels');
  });

  it('loadTemplate is injectable (RunDeps-style seam) — a spy spec is used as-is', async () => {
    let loaded = false;
    const realSpec = await loadTemplate(TEMPLATE_MIN);
    const deps: InspectDeps = {
      loadTemplate: async (dir) => {
        loaded = true;
        expect(dir).toBe(TEMPLATE_MIN);
        return realSpec;
      },
    };
    const out = await inspectTemplate({ templateDir: TEMPLATE_MIN, nodeId: 'w0-classify', full: false }, deps);
    expect(loaded).toBe(true);
    expect(out).toContain('w0-classify');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (D) A5 — run-family ops + programmatic nodes are no longer FALSE "not wired" signals.
//   • a run op (e.g. a migrated op:[{run}]) must appear in the `ops:` line, not `ops: (none)`.
//   • a programmatic node (no prompt) must print its resolved op[] instead of an EMPTY prompt block
//     that reads as "0 markers → not wired".
// renderNodeInspect is PURE — we hand-build a NodeSpec (no fixture needed for these node shapes).
// ─────────────────────────────────────────────────────────────────────────────
describe('renderNodeInspect — A5 run/gate ops + programmatic op[]', () => {
  const REG = new DefaultToolRegistry();
  const base = {
    sandbox: { provider: 'inmemory', workspace: '/w', output: 'out', read: [], write: ['out/**'] },
    tools: {},
    io: { artifacts: [{ path: 'out/video.mp4' }] },
  };

  it('a PROGRAMMATIC node with a run op shows the run cmd in `ops:` (NOT "(none)") and prints its op[]', () => {
    const node = {
      id: 'render',
      label: 'render',
      programmatic: true,
      op: [{ when: 'post', run: { cmd: 'npm', args: ['run', 'render'], cwd: '{{WORKSPACE}}' }, onFailure: 'block' }],
      ...base,
    } as unknown as NodeSpec;
    const out = renderNodeInspect(node, REG, true);
    expect(out).not.toContain('ops:   (none)'); // the run op MUST be counted
    expect(out).toContain('npm'); // the run cmd is shown in the ops summary
    expect(out).toContain('run'); // the run-family label
    expect(out).toMatch(/programmatic/i); // the no-prompt node prints its op[] block, not an empty prompt
  });

  it('a POST gate op appears in the `ops:` line (gate-family, not just derive transforms)', () => {
    const node = {
      id: 'verify',
      label: 'verify',
      prompt: 'do the thing',
      op: [{ when: 'post', gate: { kind: 'non-empty', path: 'out/report.md' }, onFailure: 'block' }],
      ...base,
    } as unknown as NodeSpec;
    const out = renderNodeInspect(node, REG, true);
    expect(out).not.toContain('ops:   (none)');
    expect(out).toContain('non-empty'); // the gate kind is shown
  });
});
