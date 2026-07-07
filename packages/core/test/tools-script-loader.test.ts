// loadTemplate's script-tool DEFAULT-FILL (docs/design script-tools): a `tool:<name>` allow entry with NO
// `tools.defs` override resolves to the TEMPLATE's own tools root (`<templateDir>/tools/<name>/`) — the
// loader is the one place that KNOWS the template dir, so it bakes this default in at load time (an
// author-declared `defs` override is carried through verbatim, untouched).

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTemplate } from '../src/workflow/template/loader.js';
import { discoverScriptTools, preflightScriptTools } from '../src/tools/script-discover.js';
import type { ResolveCtx } from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TPL_DEFAULT = path.join(HERE, 'fixtures', 'template-script-tool-default');
const TPL_MIN = path.join(HERE, 'fixtures', 'template-min');

describe('loadTemplate — script-tool defs DEFAULT-FILL', () => {
  it('a `tool:<name>` allow entry with no defs override is filled with <templateDir>/tools/<name>/', async () => {
    const spec = await loadTemplate(TPL_DEFAULT);
    const probe = spec.nodes.find((n) => n.label === 'probe');
    expect(probe).toBeDefined();
    expect(probe!.tools.defs).toEqual({ 'tool:demo_probe': path.join(TPL_DEFAULT, 'tools', 'demo_probe') });
  });

  it('the default-filled defs entry actually DISCOVERS + resolves to a valid script ToolEntry', async () => {
    const spec = await loadTemplate(TPL_DEFAULT);
    const probe = spec.nodes.find((n) => n.label === 'probe')!;
    const ctx: ResolveCtx = { run: '/run', workspace: HERE, state: {}, args: {} };
    const { entries, issues } = discoverScriptTools(probe.tools, ctx);
    expect(issues).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0].piName).toBe('demo_probe');
  });

  it('preflightScriptTools PASSES (no throw) against the loaded, default-filled node', async () => {
    const spec = await loadTemplate(TPL_DEFAULT);
    const probe = spec.nodes.find((n) => n.label === 'probe')!;
    const ctx: ResolveCtx = { run: '/run', workspace: HERE, state: {}, args: {} };
    expect(() => preflightScriptTools(probe.tools, ctx)).not.toThrow();
  });

  it('a node with NO `tool:*` allow entries gets NO defs fill (byte-identical to before this feature)', async () => {
    const spec = await loadTemplate(TPL_MIN); // the pre-existing fixture — none of its nodes select a script tool
    for (const n of spec.nodes) expect(n.tools.defs).toBeUndefined();
  });
});
