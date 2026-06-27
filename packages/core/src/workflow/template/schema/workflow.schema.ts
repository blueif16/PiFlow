// JSON Schema (draft 2020-12) for the GENERATED `workflow.json` lock (template-format.md §5).
// This file is NEVER hand-authored — the compile step (re)writes it from meta.json + every node.json
// (the package.json ⟷ package-lock.json analogy). The schema pins the generated lock SHAPE so the
// compile step's output (and a `piflowctl check` staleness gate) has an oracle:
//   { id, meta:{name,description}, stages: string[][], nodes: { <id>: { phase, deps } } }

/** The draft-2020-12 JSON Schema object for the generated `workflow.json`. Frozen; import to validate. */
export const workflowSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://piflow.dev/schema/template/workflow.json',
  title: 'piflow generated workflow.json (lock)',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'meta', 'stages', 'nodes'],
  properties: {
    id: { type: 'string', minLength: 1, description: 'Workflow id (mirrors meta.id).' },
    meta: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'description'],
      properties: {
        name: { type: 'string', minLength: 1 },
        description: { type: 'string' },
      },
    },
    stages: {
      // Resolved topology: each inner array is one stage (a parallel lane of node ids).
      type: 'array',
      description: 'Resolved stages — each inner array is a parallel lane of node ids (§5).',
      items: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        minItems: 1,
      },
    },
    nodes: {
      // A mirror of each node.json's routing fields, keyed by node id.
      type: 'object',
      description: 'Per-node routing mirror, keyed by id (§5).',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['phase', 'deps'],
        properties: {
          phase: { type: 'string', minLength: 1 },
          deps: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
        },
      },
    },
  },
} as const;
