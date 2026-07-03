# okf-slices/assets — the vendored engine the skill seeds into a repo

These files are **mirrors, not the source of truth.** The canonical, dogfooded engine lives in piflow at
`.agents/okf/topics/{_generate.mjs, _rank.mjs}`; these copies exist so the *globally-installed* skill is
self-contained and can seed `.agents/okf/` into any repo (its SETUP mode) without piflow present.

- **Do NOT hand-edit these** — edit the canonical engine, then re-copy. A parity gate
  (`packages/cli/test/skill-assets-parity.test.ts`) fails until `assets/*.mjs` are byte-identical to the
  canonical engine, so this copy can never silently rot (code-as-truth).
- `_generate.mjs` — the gate/maintenance/`--find` engine (zero-dep, `node` only).
- `_rank.mjs` — the one pure ranker `--find` uses.
- `okf.config.template.json` — the config SETUP writes to `<repo>/.agents/okf/okf.config.json`.
