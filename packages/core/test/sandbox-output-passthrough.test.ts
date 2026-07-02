// Target 3 (N-breach) — LOADER PASSTHROUGH, RED-first.
//
// The N-breach fix needs a REAL @piflow/core `sandbox.output` passthrough: a template node whose
// `contract.output` is authored to `"."` (identity, no downloadDir flatten) must COMPILE to
// `node.sandbox.output === "."`. Today it cannot:
//   • the `contract` schema is `additionalProperties:false` (node.schema.ts:135) with NO `output` key
//     (properties end at `fillSentinel`) → an authored `contract.output` is REJECTED by the schema, OR
//   • even if accepted, the loader/render hardcodes `output: \`out/${def.id}\`` (render.ts:110), so the
//     authored value is DROPPED and the compiled node carries `out/<id>`, never `"."`.
//
// This test authors `contract.output: "."` on a fixture node, drives the REAL loadTemplate→compile path
// (mirroring the `contract.fullAccess` passthrough test in load-template.test.ts:376-404), and asserts
// the compiled `sandbox.output === "."`. Against the CURRENT (unfixed) tree it REDS — the capability is
// absent (schema rejects OR loader ignores). The implementer greens it by adding the schema key + the
// TemplateNode type field + the loader thread + the render override (Target 3 FIX SPEC edits 1-4).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTemplate, compile } from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'template-min');

/** Copy the pristine fixture into a fresh tmp dir so a test can mutate it without touching the source. */
async function cloneFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-outpass-'));
  await fs.cp(FIXTURE, dir, { recursive: true });
  return dir;
}

const readJson = async (p: string): Promise<any> => JSON.parse(await fs.readFile(p, 'utf8'));
const writeJson = async (p: string, v: unknown): Promise<void> =>
  fs.writeFile(p, JSON.stringify(v, null, 2) + '\n');
const nodeJson = (dir: string, id: string): string => path.join(dir, 'nodes', id, 'node.json');

// Hermetic agents catalog (mirror load-template.test.ts:34-49): seed the in-repo presets into a temp
// PIFLOW_HOME so any agentType-label resolution works without the dev's real ~/.piflow (absent in CI).
const AGENT_SEEDS = path.join(HERE, '../../..', '.claude/skills/piflow-init/references/agent-presets');
let PIFLOW_HOME_DIR: string;
let SAVED_PIFLOW_HOME: string | undefined;
beforeEach(async () => {
  PIFLOW_HOME_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-home-'));
  await fs.cp(AGENT_SEEDS, path.join(PIFLOW_HOME_DIR, 'agents'), { recursive: true });
  SAVED_PIFLOW_HOME = process.env.PIFLOW_HOME;
  process.env.PIFLOW_HOME = PIFLOW_HOME_DIR;
});
afterEach(async () => {
  if (SAVED_PIFLOW_HOME === undefined) delete process.env.PIFLOW_HOME;
  else process.env.PIFLOW_HOME = SAVED_PIFLOW_HOME;
  await fs.rm(PIFLOW_HOME_DIR, { recursive: true, force: true });
});

let dir: string;
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

describe('loadTemplate — per-node contract.output (the N-breach identity-collection passthrough)', () => {
  // RED-first: the capability is absent today. The observable is the COMPILED node's sandbox.output —
  // a fresh read of the loaded+compiled WorkflowSpec, not a config/template substring.
  it('ACCEPTS contract.output:"." and threads it onto the compiled node.sandbox.output', async () => {
    dir = await cloneFixture();
    const n = await readJson(nodeJson(dir, 'w0-classify'));
    n.contract.output = '.'; // identity collection — no downloadDir flatten (the only cross-kind-parity config)
    await writeJson(nodeJson(dir, 'w0-classify'), n);

    // Must NOT throw: the schema must ACCEPT the new key (today additionalProperties:false REJECTS it).
    const wf = compile(await loadTemplate(dir));

    // And the authored value must RIDE loader→compile onto the dense NodeSpec's sandbox.output (today the
    // render hardcodes `out/<id>`, so this is `out/w0-classify`, NOT `.`).
    expect(wf.nodes['w0-classify'].sandbox.output).toBe('.');
  });

  it('a node that declares no contract.output keeps the compile default out/<id> (additive — no regression)', async () => {
    // The no-regression control: an un-authored node stays byte-identical to today (`out/<id>`). This
    // passes NOW and MUST keep passing after the fix (the passthrough defaults to `out/${def.id}`).
    dir = await cloneFixture();
    const wf = compile(await loadTemplate(dir));
    expect(wf.nodes['w2a-levels'].sandbox.output).toBe('out/w2a-levels');
  });
});
