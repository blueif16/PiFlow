// JSON Schema (draft 2020-12) for a template `meta.json` — the tiny AUTHORED header
// (template-format.md §5/§11): `{ id, name, description }` + an OPTIONAL phase DISPLAY order.
// `phase` order is decorative (it never drives the DAG — deps + owns do), so it is optional and
// loosely typed (a list of phase labels). `additionalProperties: false` keeps a typo'd key from
// passing.

import { nodeSchema } from './node.schema.js';

/** The draft-2020-12 JSON Schema object for a template `meta.json`. Frozen; import to validate. */
export const metaSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://piflow.dev/schema/template/meta.json',
  title: 'piflow template meta.json',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'description'],
  properties: {
    id: { type: 'string', minLength: 1, description: 'Workflow id.' },
    name: { type: 'string', minLength: 1, description: 'Human-readable workflow name.' },
    description: { type: 'string', description: 'One-line workflow description.' },
    phases: {
      // OPTIONAL phase DISPLAY order (§5) — decorative; never an ordering source beside deps.
      type: 'array',
      description: 'Optional phase DISPLAY order — decorative only (deps + owns drive the DAG).',
      items: { type: 'string', minLength: 1 },
      uniqueItems: true,
    },
    profiles: {
      // OPTIONAL product-declared run modes (§5) — a map name → a GENERIC elision predicate. The names
      // are the PRODUCT's vocabulary (data); the SDK only applies the predicate. `{}` elides nothing.
      type: 'object',
      description: 'Optional named run profiles — generic node-elision predicates (DATA).',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        properties: {
          elidePhases: {
            type: 'array',
            description: 'Elide every node whose `phase` is in this list (deps rewired transitively).',
            items: { type: 'string', minLength: 1 },
            uniqueItems: true,
          },
        },
      },
    },
    defaultProfile: {
      // OPTIONAL — the profile applied when a run names none. Absent ⇒ no elision (the full DAG).
      type: 'string',
      minLength: 1,
      description: 'Profile applied when a run names none. Absent ⇒ the full DAG.',
    },
    optimize: {
      // (docs/design/optimize-blame.md WS-B0) The RUN-LEVEL twin of the node-level `optimize` block
      // (node.schema.ts:385) — exact per-node symmetry, same shape, same gate. Never read by
      // `toNodeIntent`/the compiled WorkflowSpec; the out-of-band `optimize blame` verb reads it
      // straight off `<templateDir>/meta.json`, same precedent as the node-level block. Still
      // validates through the SAME schema gate: a typo'd key here fails the whole template load.
      //
      // The weight flips at this level (§2): HARD (`measure`) is expected-sparse — most templates
      // leave it empty, since a run-level deterministic check is usually too general to surface
      // anything real (author one only for a genuine end-to-end invariant over the run's final
      // artifact). SOFT (`criteria`) is load-bearing — the final-artifact bar the run-level judge
      // attributes against. No `judge` alias (no back-compat exists at meta level) and no
      // `verifyDefault` (a per-issue verify tier is meaningless above the node grain).
      type: 'object',
      additionalProperties: false,
      description: 'Run-level optimizer-facing measurement + criteria block, read via fs by the out-of-band blame verb — never loaded onto the runtime WorkflowSpec. Omitted ⇒ no run-level measurement.',
      properties: {
        measure: {
          type: 'array',
          description: 'Post-run measurement ops over the run\'s FINAL artifact — reuses $defs/op byte-for-byte. Expected-sparse: the run\'s mechanical floor already comes from every node\'s own hard report; author this only for a real end-to-end invariant.',
          items: { $ref: '#/$defs/op' },
        },
        criteria: {
          type: 'string',
          minLength: 1,
          description: 'Token-resolved path to the template-root soft-criteria file (the run-level judge\'s final-artifact bar).',
        },
      },
    },
  },
  // Carries the WHOLE node-level $defs object (not just `op`) so an in-document `#/$defs/op` sibling
  // $ref inside the op def itself keeps resolving — nodeSchema is the single source of truth for the
  // op/check grammar; meta-level measure ops reuse it byte-for-byte rather than forking a second copy.
  $defs: nodeSchema.$defs,
} as const;
