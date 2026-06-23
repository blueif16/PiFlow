import { describe, it, expect } from 'vitest';
import { captureOpenClawTools, makeCaptureApi } from '../src/tools/openclaw-shim.js';

// ── fixtures: minimal OpenClaw `definePluginEntry` default exports ─────────────────────────────────
// An OpenClaw plugin entry is `{ id, name, description, register(api) }` where `register` calls
// `api.registerTool(def, opts?)`. The shim hands `register` a FAKE api that captures the defs and
// no-ops everything else. These fixtures stand in for a pinned, imported plugin module.

/** A PURE plugin: execute reads only its params, never touches `api`. Portable to bare `pi -e`. */
const PURE_ENTRY = {
  id: 'stock-quote',
  name: 'Stock Quote',
  description: 'A pure example plugin.',
  register(api: any) {
    api.registerTool(
      {
        name: 'stock_quote',
        description: 'Return a (fake) quote for a ticker.',
        parameters: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
        async execute(_id: string, params: { symbol: string }) {
          return { content: [{ type: 'text', text: `QUOTE ${params.symbol.toUpperCase()}` }] };
        },
      },
      { optional: true },
    );
    // also exercises a non-tool registration that MUST be a harmless no-op
    api.registerProvider({ id: 'noop-provider' });
    api.on('startup', () => {});
  },
};

/** A GATEWAY-COUPLED plugin: execute closes over `api` and calls `api.logger` — non-portable. */
const COUPLED_ENTRY = {
  id: 'llm-task',
  name: 'LLM Task',
  description: 'A gateway-coupled example plugin.',
  register(api: any) {
    api.registerTool({
      name: 'llm_task',
      description: 'Runs against the gateway.',
      parameters: { type: 'object', properties: {} },
      async execute(_id: string, _params: unknown) {
        // touches the gateway api — under the shim, api.logger is a no-op shim, but a real coupled
        // tool reaches api.runtime / the inference gateway, which the no-op api does NOT provide.
        return api.runtime.inference.complete('hi'); // api.runtime is undefined under the shim → throws
      },
    });
  },
};

// ── capture ───────────────────────────────────────────────────────────────────────────────────────

describe('captureOpenClawTools — the def-captor / purity gate', () => {
  it('captures each registerTool def (name/description/parameters/execute) verbatim', () => {
    const captured = captureOpenClawTools(PURE_ENTRY);
    expect(captured.map((c) => c.def.name)).toEqual(['stock_quote']);
    const def = captured[0].def;
    expect(def.description).toBe('Return a (fake) quote for a ticker.');
    expect(def.parameters).toEqual({
      type: 'object',
      properties: { symbol: { type: 'string' } },
      required: ['symbol'],
    });
    expect(typeof def.execute).toBe('function');
  });

  it('captures the registerTool OPTS (e.g. { optional: true })', () => {
    const [c] = captureOpenClawTools(PURE_ENTRY);
    expect(c.opts).toEqual({ optional: true });
  });

  it('preserves the NATIVE execute: it runs without any callTool/bridge, reading only params', async () => {
    const [c] = captureOpenClawTools(PURE_ENTRY);
    // the captured execute is the plugin's OWN function — calling it computes locally, no bridge.
    const result = await c.def.execute('tc-1', { symbol: 'acme' });
    expect(result).toEqual({ content: [{ type: 'text', text: 'QUOTE ACME' }] });
  });

  it('no-ops every non-registerTool api method (register*/on) so a pure register() completes', () => {
    // PURE_ENTRY.register also calls registerProvider + on — if those were not no-ops it would throw.
    expect(() => captureOpenClawTools(PURE_ENTRY)).not.toThrow();
  });

  it('accepts an entry whose default export is nested under `.default` (ESM interop)', () => {
    const captured = captureOpenClawTools({ default: PURE_ENTRY });
    expect(captured.map((c) => c.def.name)).toEqual(['stock_quote']);
  });

  it('PURITY GATE: a gateway-coupled execute (touches api.runtime) throws when invoked under the shim', async () => {
    const [c] = captureOpenClawTools(COUPLED_ENTRY);
    // capture itself succeeds (register only calls registerTool); the coupling shows up at EXECUTE time.
    await expect(c.def.execute('tc-1', {})).rejects.toThrow();
  });
});

// ── the fake api surface (reusable by the generated -e) ────────────────────────────────────────────

describe('makeCaptureApi — the fake api used at both call sites', () => {
  it('exposes a captured[] that registerTool pushes into, and no-op register*/on/logger', () => {
    const { api, captured } = makeCaptureApi();
    expect(captured).toEqual([]);
    api.registerTool({ name: 't', description: '', parameters: {}, async execute() {} }, { optional: false });
    expect(captured).toHaveLength(1);
    expect(captured[0].def.name).toBe('t');
    // the no-op surface exists and is callable without throwing
    expect(() => {
      api.registerProvider({});
      api.registerChannel({});
      api.registerEmbeddingProvider({});
      api.on('hook', () => {});
      api.logger.info('x');
    }).not.toThrow();
  });
});
