// The INJECT renderer for the `script` tool source — `renderScriptTool` (modeled on `renderContractTool`):
// an inline `pi.registerTool` whose `execute` spawns the resolved cmd/argv via `child_process.execFile`
// (no shell), maps model-supplied params to CLI flags (the v1 `input:"flags"` exec contract), and turns
// stdout/stderr into a pi ToolResult. Tested with the SAME "instantiate the generated source" harness
// `tools-compile.test.ts` uses for the sdk/bridge branches — this proves the GENERATED CODE actually
// spawns + maps flags correctly, not just that a string contains some substrings.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderScriptTool, type ScriptRenderable } from '../src/tools/script-tool.js';

/**
 * Instantiate a generated script-tool block the way pi would: strip the `import { execFile } from
 * "node:child_process"` line and inject the REAL `execFile` (imported above) as a Function arg, then run
 * the default-exported factory against a fake `pi` that records every registerTool. The tool's `execute`
 * then genuinely spawns a real child process — no stub, no mock of our own code.
 */
function instantiate(source: string) {
  const body = source
    .replace(/^\s*import[^\n]*\n/gm, '')
    .replace(/export\s+default\s+function/m, 'return function');
  const TypeStub = { Unsafe: (s: unknown) => s, Object: (s: unknown) => s };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const make = new Function('Type', 'execFile', body);
  const factory = make(TypeStub, execFile) as (pi: unknown) => void;
  const registered: Array<Record<string, any>> = [];
  factory({ registerTool: (def: Record<string, any>) => registered.push(def), on: () => undefined });
  return registered;
}

/** Wrap a rendered `pi.registerTool({...})` BLOCK (renderScriptTool's return) in the extension shell
 *  `compile.ts`'s `renderExtension` would produce, so `instantiate` can eval it as a whole module. */
function wrap(block: string): string {
  return [
    'import { Type } from "typebox";',
    'import { execFile } from "node:child_process";',
    '',
    'export default function (pi) {',
    block,
    '}',
    '',
  ].join('\n');
}

let dir: string;

function tmpScript(contents: string): string {
  dir = mkdtempSync(path.join(tmpdir(), 'piflow-script-render-'));
  const p = path.join(dir, 'probe.mjs');
  writeFileSync(p, contents);
  chmodSync(p, 0o755);
  return p;
}

function cleanup(): void {
  if (dir) rmSync(dir, { recursive: true, force: true });
}

// ── shape ─────────────────────────────────────────────────────────────────────────────────────────

describe('renderScriptTool — the registered tool shape', () => {
  it('emits name/label/description/parameters exactly as given', () => {
    const scriptPath = tmpScript('console.log("{}")');
    const t: ScriptRenderable = {
      piName: 'demo_probe',
      label: 'tool: demo_probe',
      description: 'Echo a message back.',
      parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
      exec: { cmd: 'node', argv: [scriptPath], timeoutMs: 5000 },
    };
    const registered = instantiate(wrap(renderScriptTool(t)));
    expect(registered).toHaveLength(1);
    expect(registered[0].name).toBe('demo_probe');
    expect(registered[0].label).toBe('tool: demo_probe');
    expect(registered[0].description).toBe('Echo a message back.');
    expect(registered[0].parameters).toEqual(t.parameters);
    cleanup();
  });

  it('is ROBUST to quotes/newlines/backticks in the description (JSON.stringify escaped, never concatenated)', () => {
    const scriptPath = tmpScript('console.log("{}")');
    const nasty = 'has "double" and \'single\' quotes,\nnewlines, a ${injection}, and `backticks`.';
    const t: ScriptRenderable = {
      piName: 'demo_probe',
      label: 'demo_probe',
      description: nasty,
      parameters: { type: 'object', properties: {} },
      exec: { cmd: 'node', argv: [scriptPath], timeoutMs: 5000 },
    };
    const registered = instantiate(wrap(renderScriptTool(t)));
    expect(registered[0].description).toBe(nasty);
    cleanup();
  });
});

// ── real execution: flags mapping + spawn + output ──────────────────────────────────────────────

describe('renderScriptTool — execute() REALLY spawns argv (flags mapping, no shell)', () => {
  it('maps EVERY non-subcommand param to `--<key> <value>` (primitives pass through as strings)', async () => {
    const scriptPath = tmpScript(
      '#!/usr/bin/env node\nconsole.log(JSON.stringify({ argv: process.argv.slice(2) }));\n',
    );
    const t: ScriptRenderable = {
      piName: 'demo_probe',
      label: 'demo_probe',
      description: 'echoes its argv',
      parameters: { type: 'object', properties: { message: { type: 'string' }, count: { type: 'number' } } },
      exec: { cmd: 'node', argv: [scriptPath], timeoutMs: 5000 },
    };
    const registered = instantiate(wrap(renderScriptTool(t)));
    const result = await registered[0].execute('tc-1', { message: 'hi', count: 3 });
    expect(result.details.argv).toEqual(['--message', 'hi', '--count', '3']);
    cleanup();
  });

  it('JSON-stringifies a non-primitive param value', async () => {
    const scriptPath = tmpScript(
      '#!/usr/bin/env node\nconsole.log(JSON.stringify({ argv: process.argv.slice(2) }));\n',
    );
    const t: ScriptRenderable = {
      piName: 'demo_probe',
      label: 'demo_probe',
      description: 'echoes its argv',
      parameters: { type: 'object', properties: { tags: { type: 'array' } } },
      exec: { cmd: 'node', argv: [scriptPath], timeoutMs: 5000 },
    };
    const registered = instantiate(wrap(renderScriptTool(t)));
    const result = await registered[0].execute('tc-1', { tags: ['a', 'b'] });
    expect(result.details.argv).toEqual(['--tags', '["a","b"]']);
    cleanup();
  });

  it('a `subcommand` property (when the schema declares one) becomes the FIRST positional, not a flag', async () => {
    const scriptPath = tmpScript(
      '#!/usr/bin/env node\nconsole.log(JSON.stringify({ argv: process.argv.slice(2) }));\n',
    );
    const t: ScriptRenderable = {
      piName: 'demo_probe',
      label: 'demo_probe',
      description: 'echoes its argv',
      parameters: { type: 'object', properties: { subcommand: { type: 'string' }, message: { type: 'string' } } },
      exec: { cmd: 'node', argv: [scriptPath], timeoutMs: 5000 },
    };
    const registered = instantiate(wrap(renderScriptTool(t)));
    const result = await registered[0].execute('tc-1', { subcommand: 'add', message: 'hi' });
    expect(result.details.argv).toEqual(['add', '--message', 'hi']);
    cleanup();
  });

  it('WITHOUT a `subcommand` schema property, a param literally named "subcommand" is just another flag', async () => {
    const scriptPath = tmpScript(
      '#!/usr/bin/env node\nconsole.log(JSON.stringify({ argv: process.argv.slice(2) }));\n',
    );
    const t: ScriptRenderable = {
      piName: 'demo_probe',
      label: 'demo_probe',
      description: 'echoes its argv',
      parameters: { type: 'object', properties: { message: { type: 'string' } } }, // no `subcommand` in schema
      exec: { cmd: 'node', argv: [scriptPath], timeoutMs: 5000 },
    };
    const registered = instantiate(wrap(renderScriptTool(t)));
    const result = await registered[0].execute('tc-1', { message: 'hi' });
    expect(result.details.argv).toEqual(['--message', 'hi']);
    cleanup();
  });

  it('stdout that parses as JSON is attached as `details`; the raw stdout is always the text', async () => {
    const scriptPath = tmpScript('#!/usr/bin/env node\nconsole.log(JSON.stringify({ sum: 5 }));\n');
    const t: ScriptRenderable = {
      piName: 'demo_probe',
      label: 'demo_probe',
      description: 'x',
      parameters: { type: 'object', properties: {} },
      exec: { cmd: 'node', argv: [scriptPath], timeoutMs: 5000 },
    };
    const registered = instantiate(wrap(renderScriptTool(t)));
    const result = await registered[0].execute('tc-1', {});
    expect(result.details).toEqual({ sum: 5 });
    expect(result.content[0].text.trim()).toBe(JSON.stringify({ sum: 5 }));
    cleanup();
  });

  it('non-JSON stdout ⇒ no `details`, but the text still carries the raw stdout', async () => {
    const scriptPath = tmpScript('#!/usr/bin/env node\nconsole.log("plain text output");\n');
    const t: ScriptRenderable = {
      piName: 'demo_probe',
      label: 'demo_probe',
      description: 'x',
      parameters: { type: 'object', properties: {} },
      exec: { cmd: 'node', argv: [scriptPath], timeoutMs: 5000 },
    };
    const registered = instantiate(wrap(renderScriptTool(t)));
    const result = await registered[0].execute('tc-1', {});
    expect(result.details).toBeUndefined();
    expect(result.content[0].text.trim()).toBe('plain text output');
    cleanup();
  });

  it('a non-zero exit is a tool error carrying the stderr TAIL', async () => {
    const scriptPath = tmpScript(
      '#!/usr/bin/env node\nprocess.stderr.write("boom: something broke");\nprocess.exit(1);\n',
    );
    const t: ScriptRenderable = {
      piName: 'demo_probe',
      label: 'demo_probe',
      description: 'x',
      parameters: { type: 'object', properties: {} },
      exec: { cmd: 'node', argv: [scriptPath], timeoutMs: 5000 },
    };
    const registered = instantiate(wrap(renderScriptTool(t)));
    const result = await registered[0].execute('tc-1', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/boom: something broke/);
    cleanup();
  });

  it('a timeout is a tool error too (bounded by exec.timeoutMs)', async () => {
    const scriptPath = tmpScript('#!/usr/bin/env node\nsetTimeout(() => {}, 5000);\n'); // hangs past the timeout
    const t: ScriptRenderable = {
      piName: 'demo_probe',
      label: 'demo_probe',
      description: 'x',
      parameters: { type: 'object', properties: {} },
      exec: { cmd: 'node', argv: [scriptPath], timeoutMs: 200 },
    };
    const registered = instantiate(wrap(renderScriptTool(t)));
    const result = await registered[0].execute('tc-1', {});
    expect(result.isError).toBe(true);
    cleanup();
  }, 10_000);

  it('spawns with NO shell (a `$(...)`-shaped param value is passed literally, never interpreted)', async () => {
    const scriptPath = tmpScript(
      '#!/usr/bin/env node\nconsole.log(JSON.stringify({ argv: process.argv.slice(2) }));\n',
    );
    const t: ScriptRenderable = {
      piName: 'demo_probe',
      label: 'demo_probe',
      description: 'x',
      parameters: { type: 'object', properties: { message: { type: 'string' } } },
      exec: { cmd: 'node', argv: [scriptPath], timeoutMs: 5000 },
    };
    const registered = instantiate(wrap(renderScriptTool(t)));
    const injection = '$(touch /tmp/piflow-shell-injection-witness) && echo pwned';
    const result = await registered[0].execute('tc-1', { message: injection });
    // the literal string arrives unchanged — no shell ever expanded `$(...)`.
    expect(result.details.argv).toEqual(['--message', injection]);
    cleanup();
  });
});
