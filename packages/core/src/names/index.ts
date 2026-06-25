// Docker-style run-name generation: `<bake-adjective>-<pie>` (e.g. "flaky-pecan"). The CLI calls
// `generateRunName` when `--run/--id` is omitted; the slug rule + word lists back the data file.
export { generateRunName, ADJECTIVES, PIES, type Rng } from './generator.js';
export { pieSlug, pieSlugList } from './slugify.js';
