// FULL END-TO-END integration for the `script` tool source (docs/design script-tools): DECLARE (node.json
// tools.allow/defs) → DEFINE (tool.json manifest + a real tiny script) → DISCOVER/RESOLVE (node start) →
// INJECT (the generated `-e` extension) → PREFLIGHT (loud, before pi spawns) — all wired through the
// REAL `runFromTemplate` → `runWorkflow` → `runNode` pipeline (the `runner-live-tool-e2e.test.ts` pattern:
// an offline stub `buildCommand` isolates the BIND/DISCOVER/PREFLIGHT concern from real pi execution).
//
// A companion DIRECT test (no runNode) proves the two literal integration claims: the compiled extension
// source contains the registered tool, and the registry's resolved `--tools` (piTools) list contains it.

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFromTemplate } from '../src/runner/index.js';
import { loadTemplate } from '../src/workflow/template/loader.js';
import { preflightScriptTools } from '../src/tools/script-discover.js';
import { compileToolExtension, DefaultToolRegistry } from '../src/index.js';
import type { ResolveCtx } from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const TPL_GOOD = path.join(FIXTURES, 'template-script-tool');
const TPL_BROKEN = path.join(FIXTURES, 'template-script-tool-broken');

async function tmpRunDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'piflow-script-tool-run-'));
}

/** THE OFFLINE STUB BUILDER (`runner-live-tool-e2e.test.ts` pattern): writes each declared artifact + a
 *  fenced return block instead of spawning `pi` — isolates BIND/DISCOVER/PREFLIGHT from real execution. */
function stubBuilder() {
  return (node: { id: string; io: { artifacts: { path: string }[] }; sandbox: { output: string } }): string => {
    const writes = node.io.artifacts
      .map((a) => {
        const dest = `${node.sandbox.output}/${a.path}`;
        const dir = dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : '.';
        return `mkdir -p ${dir} && printf '%s' '{}' > ${dest}`;
      })
      .join(' && ');
    const ret = `printf '%s' '\`\`\`json\\n{"status":"ok","summary":"${node.id} done"}\\n\`\`\`'`;
    return writes ? `${writes} && ${ret}` : ret;
  };
}

// ── DIRECT proof: the compiled extension + the resolved --tools list ────────────────────────────────

describe('script tool — compiled extension source + planned --tools list (direct, no runNode)', () => {
  it('the compiled extension contains a registered tool for demo_probe, and resolve() lists its piName', async () => {
    const spec = await loadTemplate(TPL_GOOD);
    const probe = spec.nodes.find((n) => n.label === 'probe')!;
    const ctx: ResolveCtx = { run: '/run', workspace: FIXTURES, state: {}, args: {} };

    // PREFLIGHT passes and hands back the discovered entry.
    const entries = preflightScriptTools(probe.tools, ctx);
    expect(entries).toHaveLength(1);

    // INJECT: the compiled extension source registers the tool.
    const compiled = compileToolExtension(entries);
    expect(compiled.source).toContain('pi.registerTool({');
    expect(compiled.source).toContain('"demo_probe"');
    expect(compiled.registered).toEqual(['demo_probe']);

    // The planned --tools list (registry.resolve) carries the bare piName.
    const registry = new DefaultToolRegistry();
    for (const e of entries) registry.register(e);
    const resolved = registry.resolve(probe.tools);
    expect(resolved.piTools).toContain('demo_probe');
    expect(resolved.extension).toBeDefined();
  });
});

// ── FULL pipeline proof: runFromTemplate (bind→discover→preflight→stage→exec-stub→collect→verify) ───

describe('script tool — runFromTemplate end-to-end (offline stub, no real pi)', () => {
  it('a node selecting tool:demo_probe (valid manifest + real script) BINDS and reaches ok', async () => {
    const runDir = await tmpRunDir();
    const result = await runFromTemplate(TPL_GOOD, {
      run: 'script-tool-good',
      runDir,
      workspace: FIXTURES, // {{WORKSPACE}} in defs resolves to fixtures/, reaching shared-tools/demo_probe
      buildCommand: stubBuilder(),
    });

    expect(result.status.nodes.probe.status).toBe('ok');
    await fs.rm(runDir, { recursive: true, force: true });
  });

  it('a node selecting tool:demo_probe whose exec script is MISSING is `blocked`, naming the tool + the problem', async () => {
    const runDir = await tmpRunDir();
    const result = await runFromTemplate(TPL_BROKEN, {
      run: 'script-tool-broken',
      runDir,
      workspace: FIXTURES,
      buildCommand: stubBuilder(),
    });

    expect(result.status.nodes.probe.status).toBe('blocked');
    const issues = (result.status.nodes.probe.issues ?? []).join(' ');
    expect(issues).toMatch(/tool:demo_probe/);
    expect(issues).toMatch(/exec script not found|missing\.mjs/);
    await fs.rm(runDir, { recursive: true, force: true });
  });
});
