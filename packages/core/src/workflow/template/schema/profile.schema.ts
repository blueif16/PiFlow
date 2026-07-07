// JSON Schema (draft 2020-12) for a PROFILE OVERLAY file — `template/profiles/<name>.json`
// (docs/design/gate-list-and-additive-profiles.md §b). A profile is a SPARSE ADDITIVE overlay: it names
// only the nodes it modifies and lists the gate ADDITIONS (typically `agentic`/`hitl`) to APPEND to each.
// It can only ADD gates — never elide a node (the deprecated `elidePhases` model), never toggle one off.
//
// `additionalProperties:false` at the object boundary makes a typo'd top-level key fail closed, exactly
// like a malformed node.json. Each `nodes` value is an array of `GateEntry` (the shared fragment). An
// unknown NODE ID is NOT a schema concern (the schema can't know the template's ids) — the loader's
// referential merge (`mergeProfileOverlay`) raises that LOUD, listing the known ids.

import { gateEntrySchema } from './gate-entry.schema.js';

/** The draft-2020-12 JSON Schema object for a profile overlay file. Frozen; import to validate. */
export const profileSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://piflow.dev/schema/template/profile.json',
  title: 'piflow template profile overlay',
  type: 'object',
  additionalProperties: false,
  required: ['nodes'],
  properties: {
    description: { type: 'string', description: 'OPTIONAL human note — what this profile adds and why.' },
    nodes: {
      // A map <nodeId> → the gate additions APPENDED to that node's `gates[]`. A node named here that the
      // template does not declare is a LOUD load-time error (mergeProfileOverlay), never a silent no-op.
      type: 'object',
      description: 'Per-node gate ADDITIONS — a map of nodeId → GateEntry[] appended to that node.',
      additionalProperties: {
        type: 'array',
        items: { $ref: '#/$defs/gateEntry' },
      },
    },
  },
  $defs: { gateEntry: gateEntrySchema },
} as const;
