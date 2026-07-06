---
"@piflow/core": minor
"@piflow/server": minor
---

M8 — expose the optimize-substrate's lineage + issue ledger through the ONE observe surface (no new logic; every view is a projection).

- **Lineage rides the index.** `RunModel`/`ThreadRow` now carry `parent`/`spawnedBy` verbatim off the
  already-parsed `RunStatus` (M1's child-run fields were read and dropped before reaching a view) — zero new
  I/O. A new pure `groupByParent(threads)` nests child runs under their parent (orphans promoted to
  top-level, deterministic order), letting the GUI run switcher render lineage with `spawnedBy.issue`
  attribution.
- **New `nodeIssuesProjection(templateDir, nodeId)`** (`@piflow/core/observe`, re-exported at the package
  root) — a thin wrapper over the optimize-substrate ledger's `listIssues` (no reimplementation). Backs a new
  `@piflow/server` route, `GET /__piflow/issues/<run>?node=<id>`, mirroring the existing run-digest route's
  shape (resolve → project → send; 404 on an unresolved run/template).

Additive throughout: every new field is optional, every new export/route is new surface — no existing
behavior changes.
