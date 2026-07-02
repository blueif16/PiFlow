// descriptor.schema.ts — the JSON Schema (draft 2020-12) for `AgentDriverDescriptor` (types.ts) — the
// static "what this driver brings" card (docs/design/agent-driver-registry.md §2.5). This is the
// machine-readable contract the `piflowctl schema --json agent` escape hatch emits, so discovery tooling
// (and the server's driver-catalog surface) can validate/introspect the descriptor shape.
//
// It sits WITH `AgentDriverDescriptor` (the source of truth is types.ts, this file mirrors it) and follows
// the nodeSchema/metaSchema/workflowSchema pattern (a frozen schema OBJECT, re-exported through core's
// barrel so the CLI never copies it). The property set MUST track the `AgentDriverDescriptor` interface —
// the one card the drivers' `describe()` returns.

/** The draft-2020-12 JSON Schema object for an `AgentDriverDescriptor`. Frozen; import to validate. */
export const agentDriverDescriptorSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://piflow.dev/schema/driver/agent-descriptor.json',
  title: 'piflow AgentDriverDescriptor',
  description:
    'The static, product-agnostic capability card one AgentDriver.describe() returns (design §2.5).',
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'label',
    'version',
    'runtime',
    'binary',
    'model',
    'tools',
    'sandbox',
    'telemetry',
    'costModel',
  ],
  properties: {
    id: { type: 'string', description: 'The driver id (the open executor key, e.g. "pi", "claude-code").' },
    label: { type: 'string', description: 'Human-facing name.' },
    version: { type: 'integer', description: 'Bumped when buildCommand/eventAccumulator output shape changes.' },
    runtime: { type: 'string', enum: ['cli', 'sdk'], description: 'How the executor is invoked.' },
    binary: { type: 'string', description: 'The executable name (e.g. "pi", "claude").' },
    model: {
      type: 'object',
      description: 'Model-resolution capabilities.',
      additionalProperties: false,
      required: ['tierAware', 'providerRouting', 'resolvesThrows'],
      properties: {
        tierAware: { type: 'boolean', description: 'false ⇒ the driver pins its own model and ignores a node tier.' },
        providerRouting: { type: 'boolean', description: 'true ⇒ routes through a provider gateway (pi --provider).' },
        aliases: { type: 'array', items: { type: 'string' } },
        resolvesThrows: { type: 'boolean', description: 'true ⇒ an unresolvable tier throws (vs degrading to a default).' },
      },
    },
    tools: {
      type: 'object',
      description: 'Tool grammar + capabilities.',
      additionalProperties: false,
      required: ['grammar', 'supportsCustom', 'supportsMcp', 'supportsSkills', 'builtinMap'],
      properties: {
        grammar: { type: 'string', description: '"pi-bare" | "claude-builtin" | a custom grammar id.' },
        supportsCustom: { type: 'boolean' },
        supportsMcp: { type: 'boolean' },
        supportsSkills: { type: 'boolean' },
        builtinMap: {
          description: 'A GETTER over the one tool-name map — a function at runtime, not serializable data.',
        },
        dropped: { type: 'array', items: { type: 'string' } },
      },
    },
    sandbox: {
      type: 'object',
      description: 'The sandbox providers the executor runs on + its credential coupling.',
      additionalProperties: false,
      required: ['providers'],
      properties: {
        providers: { type: 'array', items: { type: 'string' }, description: 'The sandbox providers this executor supports.' },
        authInjectEnv: { type: 'array', items: { type: 'string' } },
        stripEnv: { type: 'array', items: { type: 'string' } },
        configDir: { type: 'string' },
      },
    },
    telemetry: {
      type: 'object',
      description: 'The telemetry-parity surface (§4).',
      additionalProperties: false,
      required: ['usageRollup', 'perToolTimeline', 'loopSignal', 'costReported'],
      properties: {
        usageRollup: { type: 'boolean', description: 'true ⇒ parseResult writes a NodeUsage spine; false ⇒ the event fold owns it.' },
        perToolTimeline: { type: 'string', enum: ['full', 'count-only', 'none'] },
        loopSignal: { type: 'boolean' },
        costReported: { type: 'boolean' },
      },
    },
    costModel: { type: 'string', enum: ['per-token', 'subscription-flat', 'unknown'] },
  },
} as const;
