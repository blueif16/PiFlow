// A FIXTURE OpenClaw plugin — a `definePluginEntry`-shaped default export with ONE pure tool.
// "Pure" = execute reads only its params (no `api.*`, no network/store), so it is portable to bare
// `pi -e`. Stands in for a real pinned, imported plugin module in the sdk-branch compile test. This is
// a TEST FIXTURE — finding a real shipped pure OpenClaw tool is the main thread's job, not the compiler's.

export default {
  id: 'fixture-pure',
  name: 'Fixture Pure Plugin',
  description: 'A pure example plugin used to test the sdk compile branch.',
  register(api: {
    registerTool(def: unknown, opts?: unknown): void;
    registerProvider(...a: unknown[]): void;
    on(...a: unknown[]): void;
  }) {
    api.registerTool(
      {
        name: 'fixture_echo',
        description: 'Echo a message back (pure compute, no gateway).',
        parameters: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
        async execute(_toolCallId: string, params: { msg: string }) {
          // NATIVE execute: pure, reads only params. NOT a callTool bridge route.
          return { content: [{ type: 'text', text: `ECHO:${params.msg}` }] };
        },
      },
      { optional: true },
    );
    // a non-tool registration to prove the shim no-ops it during capture
    api.registerProvider({ id: 'fixture-noop-provider' });
  },
};
