// descriptor.schema.ts — the JSON Schema (draft 2020-12) for `AgentDriverDescriptor` (types.ts) — the
// static "what this driver brings" card (docs/design/agent-driver-registry.md §2.5). This is the
// machine-readable contract the `piflowctl schema --json agent` escape hatch emits, so discovery tooling
// (and the server's driver-catalog surface) can validate/introspect the descriptor shape.
//
// It sits WITH `AgentDriverDescriptor` (the source of truth is types.ts, this file) and mirrors the
// nodeSchema/metaSchema/workflowSchema pattern (frozen schema OBJECT, re-exported through core's barrel so
// the CLI never copies it).
//
// P4 STUB: a placeholder empty-object schema — it does NOT yet describe the descriptor's fields (no id /
// telemetry / sandbox / model / tools properties). The failing test pins the real schema; the real object
// replaces this stub.

/** The draft-2020-12 JSON Schema object for an `AgentDriverDescriptor`. Frozen; import to validate. */
export const agentDriverDescriptorSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://piflow.dev/schema/driver/agent-descriptor.json',
  title: 'piflow AgentDriverDescriptor',
  type: 'object',
  // STUB — no properties declared yet. The real schema enumerates id/label/version/runtime/binary/
  // model/tools/sandbox/telemetry/costModel.
  properties: {},
} as const;
