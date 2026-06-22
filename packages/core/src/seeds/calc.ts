// The @piflow/core reference SEED for the OpenClaw `sdk` tool lane — a minimal, PURE OpenClaw plugin.
//
// Shape matches `definePluginEntry`'s default export ({ id, name, description, register(api) }), so the
// capture-shim (tools/openclaw-shim.ts) drives `register(api)` to obtain the tool def + its NATIVE
// execute, and the generated `-e` binds that execute directly (no MCP bridge). PURE: `execute` reads
// only its params (never `api.*` / the gateway), so it is portable into a headless `pi -e` — the
// portability class the OpenClaw sourcing brief calls "feasible". Proven end-to-end in real pi 0.79.0
// (tool_execution_end → "sum": 5). Params are a plain JSON-Schema object (no typebox dependency); pi's
// registerTool reads `.properties`/`.required` directly, so a raw object schema is accepted.

/** The minimal capture-`api` surface this seed touches (registerTool only — it is pure). */
interface SeedApi {
  registerTool(def: unknown, opts?: unknown): void;
}

/** A pi tool-execute result; `details` carries the structured outcome a `-p` driver reads off the event. */
interface CalcResult {
  content: { type: 'text'; text: string }[];
  details: { a: number; b: number; sum: number };
}

const entry = {
  id: 'calc',
  name: 'Calc',
  description: 'Arithmetic reference tools (the @piflow/core OpenClaw sdk seed).',
  register(api: SeedApi): void {
    api.registerTool({
      name: 'add',
      label: 'Add two numbers',
      description: 'Add two numbers and return their sum.',
      parameters: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
      execute(_toolCallId: string, params: { a: number; b: number }): CalcResult {
        const sum = params.a + params.b;
        return { content: [{ type: 'text', text: String(sum) }], details: { a: params.a, b: params.b, sum } };
      },
    });
  },
};

export default entry;
