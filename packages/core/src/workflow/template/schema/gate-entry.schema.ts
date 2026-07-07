// JSON Schema (draft 2020-12) fragment for ONE `GateEntry` — the typed, additive gate the owner decided a
// node's gating is a LIST of (docs/design/gate-list-and-additive-profiles.md §a). It is SHARED verbatim by
// two parents: `node.schema.ts` (the authored `gates[]` on a node.json) and `profile.schema.ts` (the gate
// additions a profile overlay lists per node). Both embed it under their own `$defs.gateEntry`, so the
// `#/$defs/gateEntry` `$ref` resolves inside whichever schema is being validated — the fragment carries no
// cross-schema `$ref` of its own (the policy shape is inlined) so it stays self-contained + embeddable.
//
// Discrimination is a top-level `oneOf` over the three owner types (`execution`/`agentic`/`hitl`), each a
// `type` const + `additionalProperties:false` — a typo'd key or a wrong-type field FAILS closed (the whole
// point of the strict node.json gate). An `execution` entry is deterministic and carries EXACTLY ONE of a
// `check` predicate (schema-style) or a `cmd` script (the inner `oneOf`).

/** The on-fail policy an entry may carry (the existing `GatePolicy` vocabulary). Inlined (no `$ref`). */
const gatePolicy = {
  type: 'object',
  additionalProperties: false,
  properties: {
    onFail: { enum: ['block', 'warn', 'stop', 'retry', 'escalate'], description: "On-fail action. Default 'block'." },
    retryMax: { type: 'integer', minimum: 0, description: 'Extra attempts after the first (retry only).' },
    retryScope: { enum: ['feedback', 'fix'], description: "Correction scope for retries (default 'feedback')." },
  },
} as const;

/** One typed additive gate entry. Discriminated on `type`; embed under a parent schema's `$defs.gateEntry`. */
export const gateEntrySchema = {
  type: 'object',
  oneOf: [
    {
      // EXECUTION — deterministic ("normally always holds true"): a `check` predicate OR a `cmd` script.
      additionalProperties: false,
      required: ['type'],
      properties: {
        type: { const: 'execution' },
        check: { type: 'string', minLength: 1, description: 'A Check predicate kind (non-empty, json-parses, …) — the schema/floor lane.' },
        path: { type: 'string', minLength: 1, description: 'Artifact path the check reads (run-relative).' },
        param: { description: 'Kind-specific check parameter. Any type.' },
        advisory: { type: 'boolean', description: 'true ⇒ non-blocking (warn). Default false.' },
        cmd: { type: 'string', minLength: 1, description: 'A shell command (test/build/lint) — the script lane.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Arguments to `cmd`.' },
        cwd: { type: 'string', minLength: 1, description: 'Working dir for `cmd` (token-resolvable).' },
        policy: gatePolicy,
      },
      // Deterministic gate = EXACTLY ONE of a predicate (`check`) or a script (`cmd`).
      oneOf: [{ required: ['check'] }, { required: ['cmd'] }],
    },
    {
      // AGENTIC — a judge on a DIFFERENT model evaluates the producer against a rubric.
      additionalProperties: false,
      required: ['type', 'judgeTier', 'rubric'],
      properties: {
        type: { const: 'agentic' },
        judgeTier: { type: 'string', minLength: 1, description: 'Tier alias the judge resolves through. MUST differ from the producer tier.' },
        rubric: { type: 'string', minLength: 1, description: "The rubric the judge evaluates the producer's output against." },
        threshold: { type: 'string', minLength: 1, description: "Pass/fail bar (default 'pass')." },
        policy: gatePolicy,
      },
    },
    {
      // HITL — a human approves/rejects (the G5 checkpoint surface).
      additionalProperties: false,
      required: ['type', 'question'],
      properties: {
        type: { const: 'hitl' },
        question: { type: 'string', minLength: 1, description: 'The question shown to the human reviewer.' },
        checkpointKind: { enum: ['confirm', 'input', 'select'], description: 'confirm (default) | input | select.' },
        choices: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'For a select checkpoint.' },
        policy: gatePolicy,
      },
    },
  ],
} as const;
