// Docker-style run-name generation: `<bake-adjective>-<pie>` (e.g. "flaky-pecan"). Exported for a caller
// that wants it; the CLI's DEFAULT auto-mint is now `generateDateSeqName` (M1) — see date-seq.ts.
export { generateRunName, ADJECTIVES, PIES, type Rng } from './generator.js';
export { pieSlug, pieSlugList } from './slugify.js';
// M1 — scalable run identity: `YYMMDD-NN` (the CLI's default auto-mint) + child-run lineage naming.
export { generateDateSeqName } from './date-seq.js';
export { childRunName } from './child.js';
