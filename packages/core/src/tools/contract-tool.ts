// ─────────────────────────────────────────────────────────────────────────────
// submit_result — the FIRST-PARTY CONTRACT tool (ported from game-omni pi-runner/extensions/
// node-contract.ts). A TYPED, terminating return tool: the node ENDS by CALLING it; pi validates the
// args against the schema, so a non-Claude model can't botch a ```json fence (the single most-patched
// surface in run.mjs). The structured `details` reach the driver on the `tool_execution_end` json event;
// `terminate:true` saves the extra follow-up LLM turn. The driver's fenced-JSON parser stays as a fallback
// (lastJsonBlock), so this is strictly NON-breaking.
//
// Unlike mcp/sdk tools (execute routes to the bridge / an imported plugin), this is a first-party tool
// with its OWN inline execute. It is bound by bare name like a builtin, but it is NOT pi-native — so it
// ships in the generated `-e` extension with its execute baked in (NO bridge, NO external plugin import).
// The owned-paths block + write-first gate from node-contract.ts are DEFERRED (env-driven hooks); the
// must here is the typed, registered, callable tool itself.
// ─────────────────────────────────────────────────────────────────────────────

import type { ToolEntry } from '../types.js';
import { renderParamsExpr } from './params.js';

/** The SDK-facing address for the first-party contract tool. */
export const SUBMIT_RESULT_ADDRESS = 'contract:submit_result';

/**
 * The `submit_result` parameter JSON-Schema (draft-07-shaped object). The compiler wraps it in TypeBox
 * `Type.Unsafe(...)`, so pi advertises this exact shape to the model. Mirrors node-contract.ts's
 * `Type.Object({...})`: node label · status enum · the artifacts written · summary · issues · findings.
 */
export const SUBMIT_RESULT_PARAMETERS = {
  type: 'object',
  properties: {
    node: { type: 'string', description: "this node's label" },
    status: {
      type: 'string',
      enum: ['ok', 'gap', 'blocked'],
      description: 'node outcome — ok only if every required artifact is on disk',
    },
    outputArtifacts: {
      type: 'array',
      items: { type: 'string' },
      description: 'repo-relative paths you wrote',
      default: [],
    },
    summary: { type: 'string', description: '1-2 sentence outcome' },
    issues: { type: 'array', items: { type: 'string' }, description: 'problems encountered', default: [] },
    pipelineFindings: {
      type: 'array',
      items: { type: 'string' },
      description: 'workflow-improvement findings',
      default: [],
    },
  },
  required: ['node', 'status', 'summary'],
} as const;

const DESCRIPTION =
  "Return this node's FINAL structured result. Call this as your LAST action, after writing every " +
  'required output file. Do not emit another message after calling it.';

/** The catalog entry registered in every DefaultToolRegistry by default (so a node can select it). */
export const SUBMIT_RESULT_TOOL: ToolEntry = {
  address: SUBMIT_RESULT_ADDRESS,
  source: 'contract',
  piName: 'submit_result',
  description: DESCRIPTION,
  parameters: SUBMIT_RESULT_PARAMETERS,
  origin: { kind: 'native' },
  tags: ['contract', 'return', 'terminating'],
};

/** The minimal shape `renderContractTool` reads — a `ToolEntry` and a compiler `PlannedTool` both satisfy it. */
export interface ContractRenderable {
  piName: string;
  description: string;
  parameters?: unknown;
}

/**
 * Render the `pi.registerTool({...})` block for the FIRST-PARTY contract tool — its REAL inline execute
 * (returns the structured `details` + `terminate:true`), NOT a bridge route. `parameters` is wrapped in
 * `Type.Unsafe(...)` (the same path the generated mcp/sdk tools use), so pi accepts it as a real schema.
 * Pure string render (the compiler is plan→render); every interpolation is JSON.stringify'd.
 */
export function renderContractTool(t: ContractRenderable): string {
  const params = t.parameters ?? { type: 'object', properties: {} };
  const snippet =
    'End the node by calling submit_result with the structured outcome (do not also print a JSON block). ' +
    'The moment your outputs exist and your checks pass, submit_result is your ONLY remaining action.';
  const guidelines = [
    'Call submit_result exactly once, as the final action, after all output files exist on disk.',
    "status='ok' ONLY if every required artifact was written; otherwise 'gap' or 'blocked' with the reason in summary.",
    'outputArtifacts = the repo-relative paths you actually wrote.',
    'TERMINAL CONDITION: the moment every required output file exists on disk AND your declared checks pass, calling submit_result is your ONLY remaining action — do nothing else first.',
    'Re-reading a file you already wrote, or re-running a check or command that already passed, is NOT diligence: it wastes turns and risks the node being killed by the timeout. Verify once, then submit.',
  ];
  return [
    '  pi.registerTool({',
    `    name: ${JSON.stringify(t.piName)},`,
    `    label: ${JSON.stringify('Submit node result')},`,
    `    description: ${JSON.stringify(t.description)},`,
    `    promptSnippet: ${JSON.stringify(snippet)},`,
    `    promptGuidelines: ${JSON.stringify(guidelines)},`,
    // #21: the `status` enum renders via the Gemini-safe `StringEnum` helper (renderParamsExpr); a
    // no-enum schema stays the byte-identical `Type.Unsafe(<json>)` form.
    `    parameters: ${renderParamsExpr(params)},`,
    '    async execute(toolCallId, params) {',
    '      return {',
    '        content: [{ type: "text", text: `submitted: ${params.node} \\u2192 ${params.status}` }],',
    '        details: params,',
    '        terminate: true,',
    '      };',
    '    },',
    '  });',
  ].join('\n');
}
