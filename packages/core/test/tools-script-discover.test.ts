// DISCOVER/RESOLVE + PREFLIGHT for the `script` tool source (docs/design script-tools): a `tool:<name>`
// address in a node's `tools.allow` resolves against a DEFINE-path `tool.json` manifest sitting in the
// declared tool dir (`tools.defs["tool:<name>"]`, token-resolved). `discoverScriptTools` is the pure(-ish,
// host-fs-reading) resolution step; `preflightScriptTools` is the loud aggregate-all-then-throw gate that
// wraps it (the `preflightSkills` pattern) — wired at the node-lifecycle seam BEFORE pi ever spawns.
//
// No "archetype"/product vocabulary — fixtures use neutral names (variantA-style) per the SDK's
// product-agnostic boundary.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  discoverScriptTools,
  preflightScriptTools,
  isScriptToolAddress,
  scriptToolName,
  TOOL_ADDRESS_PREFIX,
  DEFAULT_SCRIPT_TIMEOUT_MS,
} from '../src/tools/script-discover.js';
import type { ToolSelection } from '../src/index.js';
import type { ResolveCtx } from '../src/index.js';

let dir: string;
const ctx: ResolveCtx = { run: '/run', workspace: '', state: {}, args: {} };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'piflow-script-tool-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a valid `tool.json` + a real executable-shaped script into `toolDir` (creating the dir). */
function writeGoodTool(toolDir: string, overrides: Record<string, unknown> = {}): void {
  mkdirSync(toolDir, { recursive: true });
  const manifest = {
    name: 'demo_probe',
    description: 'Echo the given message back.',
    parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
    exec: { cmd: 'node', argv: ['{{toolDir}}/probe.mjs'], input: 'flags', timeoutMs: 5000 },
    ...overrides,
  };
  writeFileSync(path.join(toolDir, 'tool.json'), JSON.stringify(manifest));
  const script = path.join(toolDir, 'probe.mjs');
  writeFileSync(script, '#!/usr/bin/env node\nconsole.log(JSON.stringify({ ok: true }));\n');
  chmodSync(script, 0o755);
}

// ── address helpers ──────────────────────────────────────────────────────────────────────────────

describe('isScriptToolAddress / scriptToolName', () => {
  it('recognizes the `tool:` prefix and strips it to the allow tail', () => {
    expect(TOOL_ADDRESS_PREFIX).toBe('tool:');
    expect(isScriptToolAddress('tool:demo_probe')).toBe(true);
    expect(isScriptToolAddress('fs:read')).toBe(false);
    expect(isScriptToolAddress('mcp.github:create_issue')).toBe(false);
    expect(scriptToolName('tool:demo_probe')).toBe('demo_probe');
  });
});

// ── discoverScriptTools — the happy path ─────────────────────────────────────────────────────────

describe('discoverScriptTools — a valid tool.json resolves to a script ToolEntry', () => {
  it('resolves the dir via `tools.defs`, reads the manifest, and builds a source:"script" entry', () => {
    const toolDir = path.join(dir, 'demo_probe');
    writeGoodTool(toolDir);
    const sel: ToolSelection = { allow: ['read', 'tool:demo_probe'], defs: { 'tool:demo_probe': toolDir } };

    const { entries, issues } = discoverScriptTools(sel, ctx);

    expect(issues).toEqual([]);
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.address).toBe('tool:demo_probe');
    expect(e.source).toBe('script');
    expect(e.piName).toBe('demo_probe');
    expect(e.description).toBe('Echo the given message back.');
    expect(e.parameters).toEqual({ type: 'object', properties: { message: { type: 'string' } }, required: ['message'] });
    // {{toolDir}} in argv is substituted with the ABSOLUTE resolved tool dir.
    expect(e.exec).toEqual({ cmd: 'node', argv: [path.join(toolDir, 'probe.mjs')], timeoutMs: 5000 });
  });

  it('defaults exec.timeoutMs when the manifest omits it', () => {
    const toolDir = path.join(dir, 'demo_probe');
    mkdirSync(toolDir, { recursive: true });
    writeFileSync(
      path.join(toolDir, 'tool.json'),
      JSON.stringify({
        name: 'demo_probe',
        description: 'x',
        parameters: { type: 'object', properties: {} },
        exec: { cmd: 'node', argv: ['{{toolDir}}/probe.mjs'] },
      }),
    );
    writeFileSync(path.join(toolDir, 'probe.mjs'), 'console.log("{}");');

    const sel: ToolSelection = { allow: ['tool:demo_probe'], defs: { 'tool:demo_probe': toolDir } };
    const { entries, issues } = discoverScriptTools(sel, ctx);
    expect(issues).toEqual([]);
    expect(entries[0].exec?.timeoutMs).toBe(DEFAULT_SCRIPT_TIMEOUT_MS);
  });

  it('token-resolves a `defs` path (e.g. {{WORKSPACE}}) before treating it as a tool dir', () => {
    const toolDir = path.join(dir, 'shared-tools', 'demo_probe');
    writeGoodTool(toolDir);
    const wsCtx: ResolveCtx = { ...ctx, workspace: dir };
    const sel: ToolSelection = { allow: ['tool:demo_probe'], defs: { 'tool:demo_probe': '{{WORKSPACE}}/shared-tools/demo_probe' } };

    const { entries, issues } = discoverScriptTools(sel, wsCtx);
    expect(issues).toEqual([]);
    expect(entries[0].exec?.argv).toEqual([path.join(toolDir, 'probe.mjs')]);
  });

  it('ignores non-`tool:` allow entries entirely (fs:/mcp./contract: addresses are not discovered)', () => {
    const sel: ToolSelection = { allow: ['read', 'write', 'submit_result', 'mcp.github:create_issue'] };
    const { entries, issues } = discoverScriptTools(sel, ctx);
    expect(entries).toEqual([]);
    expect(issues).toEqual([]);
  });
});

// ── discoverScriptTools — every violation, aggregated ────────────────────────────────────────────

describe('discoverScriptTools — violations aggregate (never just the first)', () => {
  it('no `defs` entry and no template default resolved ⇒ an issue naming the address', () => {
    const sel: ToolSelection = { allow: ['tool:demo_probe'] }; // no defs at all
    const { entries, issues } = discoverScriptTools(sel, ctx);
    expect(entries).toEqual([]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/tool:demo_probe/);
    expect(issues[0]).toMatch(/defs/);
  });

  it('a tool dir that does not exist ⇒ an issue naming the resolved path', () => {
    const missingDir = path.join(dir, 'nope');
    const sel: ToolSelection = { allow: ['tool:demo_probe'], defs: { 'tool:demo_probe': missingDir } };
    const { entries, issues } = discoverScriptTools(sel, ctx);
    expect(entries).toEqual([]);
    expect(issues[0]).toMatch(/tool:demo_probe/);
    expect(issues[0]).toMatch(/tool dir not found/);
    expect(issues[0]).toContain(missingDir);
  });

  it('a defs path whose token CANNOT resolve (e.g. {{arg.missing}}) ⇒ a per-tool issue, NEVER a throw', () => {
    const sel: ToolSelection = { allow: ['tool:demo_probe'], defs: { 'tool:demo_probe': '{{arg.missing}}/demo_probe' } };
    let result: ReturnType<typeof discoverScriptTools> | undefined;
    expect(() => {
      result = discoverScriptTools(sel, ctx); // ctx carries no `missing` arg ⇒ resolveTokens throws MissingArgError
    }).not.toThrow();
    expect(result!.entries).toEqual([]);
    expect(result!.issues).toHaveLength(1);
    expect(result!.issues[0]).toMatch(/tool:demo_probe/);
    expect(result!.issues[0]).toMatch(/missing/);
  });

  it('a missing tool.json ⇒ an issue naming the manifest path', () => {
    const toolDir = path.join(dir, 'demo_probe');
    mkdirSync(toolDir, { recursive: true }); // dir exists, but no tool.json
    const sel: ToolSelection = { allow: ['tool:demo_probe'], defs: { 'tool:demo_probe': toolDir } };
    const { entries, issues } = discoverScriptTools(sel, ctx);
    expect(entries).toEqual([]);
    expect(issues[0]).toMatch(/tool\.json/);
  });

  it('an invalid-JSON tool.json ⇒ an issue naming the parse failure', () => {
    const toolDir = path.join(dir, 'demo_probe');
    mkdirSync(toolDir, { recursive: true });
    writeFileSync(path.join(toolDir, 'tool.json'), '{ not valid json ');
    const sel: ToolSelection = { allow: ['tool:demo_probe'], defs: { 'tool:demo_probe': toolDir } };
    const { entries, issues } = discoverScriptTools(sel, ctx);
    expect(entries).toEqual([]);
    expect(issues[0]).toMatch(/tool\.json/);
  });

  it('a structurally invalid manifest (missing exec.argv) ⇒ an issue naming the missing field', () => {
    const toolDir = path.join(dir, 'demo_probe');
    mkdirSync(toolDir, { recursive: true });
    writeFileSync(
      path.join(toolDir, 'tool.json'),
      JSON.stringify({ name: 'demo_probe', description: 'x', parameters: {}, exec: { cmd: 'node' } }),
    );
    const sel: ToolSelection = { allow: ['tool:demo_probe'], defs: { 'tool:demo_probe': toolDir } };
    const { entries, issues } = discoverScriptTools(sel, ctx);
    expect(entries).toEqual([]);
    expect(issues[0]).toMatch(/argv/);
  });

  it('manifest.name not matching the allow tail ⇒ an issue naming the mismatch', () => {
    const toolDir = path.join(dir, 'demo_probe');
    writeGoodTool(toolDir, { name: 'wrong_name' });
    const sel: ToolSelection = { allow: ['tool:demo_probe'], defs: { 'tool:demo_probe': toolDir } };
    const { entries, issues } = discoverScriptTools(sel, ctx);
    expect(entries).toEqual([]);
    expect(issues[0]).toMatch(/wrong_name/);
    expect(issues[0]).toMatch(/demo_probe/);
  });

  it('an unsupported exec.input value ⇒ an issue naming it (v1 supports ONLY "flags")', () => {
    const toolDir = path.join(dir, 'demo_probe');
    mkdirSync(toolDir, { recursive: true });
    writeFileSync(
      path.join(toolDir, 'tool.json'),
      JSON.stringify({
        name: 'demo_probe',
        description: 'x',
        parameters: {},
        exec: { cmd: 'node', argv: ['{{toolDir}}/probe.mjs'], input: 'stdin' },
      }),
    );
    writeFileSync(path.join(toolDir, 'probe.mjs'), '');
    const sel: ToolSelection = { allow: ['tool:demo_probe'], defs: { 'tool:demo_probe': toolDir } };
    const { entries, issues } = discoverScriptTools(sel, ctx);
    expect(entries).toEqual([]);
    expect(issues[0]).toMatch(/stdin/);
    expect(issues[0]).toMatch(/flags/);
  });

  it('the {{toolDir}}-resolved exec script missing on disk ⇒ an issue naming the missing script path', () => {
    const toolDir = path.join(dir, 'demo_probe');
    mkdirSync(toolDir, { recursive: true });
    writeFileSync(
      path.join(toolDir, 'tool.json'),
      JSON.stringify({
        name: 'demo_probe',
        description: 'x',
        parameters: {},
        exec: { cmd: 'node', argv: ['{{toolDir}}/missing.mjs'] },
      }),
    );
    // note: probe.mjs / missing.mjs is never written — the script itself is absent.
    const sel: ToolSelection = { allow: ['tool:demo_probe'], defs: { 'tool:demo_probe': toolDir } };
    const { entries, issues } = discoverScriptTools(sel, ctx);
    expect(entries).toEqual([]);
    expect(issues[0]).toMatch(/missing\.mjs/);
    expect(issues[0]).toMatch(/exec script not found/);
  });

  it('AGGREGATES violations across MULTIPLE declared tools (never just the first)', () => {
    const goodDir = path.join(dir, 'good');
    writeGoodTool(goodDir);
    const brokenDir = path.join(dir, 'broken');
    mkdirSync(brokenDir, { recursive: true }); // no tool.json at all
    const sel: ToolSelection = {
      allow: ['tool:demo_probe', 'tool:broken_one'],
      defs: { 'tool:demo_probe': goodDir, 'tool:broken_one': brokenDir },
    };
    const { entries, issues } = discoverScriptTools(sel, ctx);
    expect(entries).toHaveLength(1); // the good one still resolves
    expect(entries[0].piName).toBe('demo_probe');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/tool:broken_one/);
  });
});

// ── preflightScriptTools — the loud aggregate-then-throw wrapper ────────────────────────────────

describe('preflightScriptTools — aggregate-all-violations-then-throw (the preflightSkills pattern)', () => {
  it('returns the discovered entries WITHOUT throwing when every declared tool is valid', () => {
    const toolDir = path.join(dir, 'demo_probe');
    writeGoodTool(toolDir);
    const sel: ToolSelection = { allow: ['read', 'tool:demo_probe'], defs: { 'tool:demo_probe': toolDir } };
    const entries = preflightScriptTools(sel, ctx);
    expect(entries).toHaveLength(1);
    expect(entries[0].piName).toBe('demo_probe');
  });

  it('never throws when the node declares no `tool:*` address at all', () => {
    const sel: ToolSelection = { allow: ['read', 'write', 'submit_result'] };
    expect(() => preflightScriptTools(sel, ctx)).not.toThrow();
    expect(preflightScriptTools(sel, ctx)).toEqual([]);
  });

  it('throws ONE aggregate error listing EVERY violation across every declared tool', () => {
    const brokenA = path.join(dir, 'broken-a');
    mkdirSync(brokenA, { recursive: true }); // no tool.json
    const brokenB = path.join(dir, 'broken-b');
    // brokenB dir does not even exist
    const sel: ToolSelection = {
      allow: ['tool:demo_a', 'tool:demo_b'],
      defs: { 'tool:demo_a': brokenA, 'tool:demo_b': brokenB },
    };
    let thrown: Error | undefined;
    try {
      preflightScriptTools(sel, ctx);
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toMatch(/tool:demo_a/);
    expect(thrown!.message).toMatch(/tool:demo_b/);
  });
});

// ── OPTIONAL defs entries — presence-based tool offering ─────────────────────────────────────────
// A defs value may be `{ path, optional: true }`: if the resolved dir exists the tool behaves EXACTLY
// like a required one (full validation — presence activates the whole contract); if it does not exist,
// the tool is skipped with a NOTE (not an error, not an entry). Optional forgives ABSENCE only.

describe('discoverScriptTools — optional defs entries (presence-based offering)', () => {
  it('optional + ABSENT dir ⇒ no entry, no issue, ONE note ("optional, not present for this run")', () => {
    const sel: ToolSelection = {
      allow: ['tool:demo_probe'],
      defs: { 'tool:demo_probe': { path: path.join(dir, 'not-installed'), optional: true } },
    };
    const { entries, issues, notes } = discoverScriptTools(sel, ctx);
    expect(entries).toEqual([]);
    expect(issues).toEqual([]);
    expect(notes).toEqual(['tool:demo_probe — optional, not present for this run']);
  });

  it('optional + PRESENT dir ⇒ identical to a required entry (full resolve, no note)', () => {
    const toolDir = path.join(dir, 'demo_probe');
    writeGoodTool(toolDir);
    const sel: ToolSelection = {
      allow: ['tool:demo_probe'],
      defs: { 'tool:demo_probe': { path: toolDir, optional: true } },
    };
    const { entries, issues, notes } = discoverScriptTools(sel, ctx);
    expect(issues).toEqual([]);
    expect(notes).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0].piName).toBe('demo_probe');
    expect(entries[0].exec).toEqual({ cmd: 'node', argv: [path.join(toolDir, 'probe.mjs')], timeoutMs: 5000 });
  });

  it('optional + PRESENT-but-BROKEN ⇒ a loud aggregate issue (presence activates the full contract)', () => {
    const toolDir = path.join(dir, 'demo_probe');
    mkdirSync(toolDir, { recursive: true });
    writeFileSync(
      path.join(toolDir, 'tool.json'),
      JSON.stringify({
        name: 'demo_probe',
        description: 'x',
        parameters: {},
        exec: { cmd: 'node', argv: ['{{toolDir}}/missing.mjs'] }, // the exec script is never written
      }),
    );
    const sel: ToolSelection = {
      allow: ['tool:demo_probe'],
      defs: { 'tool:demo_probe': { path: toolDir, optional: true } },
    };
    const { entries, issues, notes } = discoverScriptTools(sel, ctx);
    expect(entries).toEqual([]);
    expect(notes).toEqual([]); // optional forgives ABSENCE, never a present-but-broken manifest
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/exec script not found/);
  });

  it('object-form WITHOUT optional (required) + ABSENT dir ⇒ still an issue (unchanged semantics)', () => {
    const missingDir = path.join(dir, 'nope');
    const sel: ToolSelection = { allow: ['tool:demo_probe'], defs: { 'tool:demo_probe': { path: missingDir } } };
    const { entries, issues, notes } = discoverScriptTools(sel, ctx);
    expect(entries).toEqual([]);
    expect(notes).toEqual([]);
    expect(issues[0]).toMatch(/tool dir not found/);
  });

  it('a malformed object defs entry (no `path`) ⇒ an issue naming the address', () => {
    const sel: ToolSelection = {
      allow: ['tool:demo_probe'],
      defs: { 'tool:demo_probe': { optional: true } as unknown as { path: string } },
    };
    const { entries, issues } = discoverScriptTools(sel, ctx);
    expect(entries).toEqual([]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/tool:demo_probe/);
    expect(issues[0]).toMatch(/path/);
  });

  it('preflight: optional + ABSENT ⇒ NO throw, no entry, and the note is surfaced via console.warn', () => {
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      warns.push(a.map(String).join(' '));
    });
    try {
      const sel: ToolSelection = {
        allow: ['read', 'tool:demo_probe'],
        defs: { 'tool:demo_probe': { path: path.join(dir, 'not-installed'), optional: true } },
      };
      const entries = preflightScriptTools(sel, ctx);
      expect(entries).toEqual([]);
      expect(warns.join(' ')).toContain('tool:demo_probe — optional, not present for this run');
    } finally {
      spy.mockRestore();
    }
  });
});
