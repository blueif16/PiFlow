// Template-format JSON Schemas (draft 2020-12) — the on-disk AUTHORING contract for a piflow
// template (template-format.md §3/§5). A future `loadTemplate`/compile step imports these to
// fail-closed at author time (the workflow's `tsc`); the validation test (test/template-schema.test.ts)
// is the oracle they're built on.

export { nodeSchema } from './node.schema.js';
export { metaSchema } from './meta.schema.js';
export { workflowSchema } from './workflow.schema.js';
export { profileSchema } from './profile.schema.js';
export { gateEntrySchema } from './gate-entry.schema.js';
