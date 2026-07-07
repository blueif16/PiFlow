// ─────────────────────────────────────────────────────────────────────────────
// The `script` tool source — the INJECT stage (docs/design script-tools): render an inline
// `pi.registerTool` block whose `execute` spawns a PRODUCT-DEFINED script (the DISCOVER stage's
// resolved `exec` contract — `tools/script-discover.ts`) via `child_process.execFile` (no shell, no
// bridge, no external plugin). Modeled closely on `renderContractTool` (contract-tool.ts): a first-party
// tool with its OWN inline execute, bound by bare name like a builtin/contract tool.
//
// v1 exec contract ("input":"flags", the ONLY mode implemented): a `subcommand` property — when the
// tool's PARAMETER SCHEMA declares one — becomes the first positional arg after `argv`; every OTHER
// param becomes `--<key> <value>` (JSON-stringified unless the value is a primitive). stdout is the
// result text; a stdout that parses as JSON is ALSO attached as `details`. A non-zero exit or a timeout
// is a tool error carrying the stderr tail (last 2000 chars).
// ─────────────────────────────────────────────────────────────────────────────

import { renderParamsExpr } from './params.js';

/** The minimal shape `renderScriptTool` reads — a `ToolEntry`/`PlannedTool` (source:'script') satisfies it. */
export interface ScriptRenderable {
  piName: string;
  label: string;
  description: string;
  parameters?: unknown;
  /** The DISCOVER-resolved exec contract — `argv` already has `{{toolDir}}` substituted to an absolute path. */
  exec: { cmd: string; argv: string[]; timeoutMs: number };
}

/** Does the tool's JSON-Schema declare a top-level `subcommand` property? (Render-time, not runtime.) */
function hasSubcommandProp(params: unknown): boolean {
  if (!params || typeof params !== 'object') return false;
  const props = (params as { properties?: unknown }).properties;
  return Boolean(props && typeof props === 'object' && Object.hasOwn(props, 'subcommand'));
}

/**
 * Render the `pi.registerTool({...})` block for a SCRIPT tool — its own inline execute (spawns the
 * resolved `cmd`/`argv` via `execFile`, no shell), NOT a bridge/native-sdk route. Every interpolation is
 * JSON.stringify'd (injection-safe), mirroring `renderContractTool`/`compile.ts`'s discipline.
 */
export function renderScriptTool(t: ScriptRenderable): string {
  const params = t.parameters ?? { type: 'object', properties: {} };
  const hasSubcommand = hasSubcommandProp(params);
  const snippet = `Use ${t.piName} — ${t.description}`;
  const guidelines = [`Call ${t.piName} when the task needs: ${t.description}`];
  return [
    '  pi.registerTool({',
    `    name: ${JSON.stringify(t.piName)},`,
    `    label: ${JSON.stringify(t.label)},`,
    `    description: ${JSON.stringify(t.description)},`,
    `    promptSnippet: ${JSON.stringify(snippet)},`,
    `    promptGuidelines: ${JSON.stringify(guidelines)},`,
    `    parameters: ${renderParamsExpr(params)},`,
    '    async execute(toolCallId, params) {',
    `      const cmd = ${JSON.stringify(t.exec.cmd)};`,
    `      const baseArgs = ${JSON.stringify(t.exec.argv)};`,
    `      const timeoutMs = ${JSON.stringify(t.exec.timeoutMs)};`,
    `      const hasSubcommand = ${JSON.stringify(hasSubcommand)};`,
    '      const p = params ?? {};',
    '      const args = [...baseArgs];',
    '      if (hasSubcommand && p.subcommand !== undefined) args.push(String(p.subcommand));',
    '      for (const [k, v] of Object.entries(p)) {',
    '        if (hasSubcommand && k === "subcommand") continue;',
    '        if (v === undefined) continue;',
    '        args.push("--" + k);',
    '        args.push(typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v));',
    '      }',
    '      return new Promise((resolve) => {',
    '        execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {',
    '          if (err) {',
    '            const tail = String(stderr || err.message || "").slice(-2000);',
    '            resolve({ content: [{ type: "text", text: "script tool \\"" + cmd + "\\" failed: " + tail }], isError: true });',
    '            return;',
    '          }',
    '          let details;',
    '          try { details = JSON.parse(stdout); } catch {}',
    '          resolve({ content: [{ type: "text", text: stdout }], details });',
    '        });',
    '      });',
    '    },',
    '  });',
  ].join('\n');
}
