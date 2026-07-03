---
"@piflow/server": minor
"@piflow/cli": minor
---

Skill marketplace P2 — the browse/discover surface.

- **`@piflow/server`**: new `GET /__piflow/skills/<run>` — every resolvable skill across both local
  rings (workspace `.agents/skills` + `$PIFLOW_HOME/skills`), ring-tagged and shadow-flagged, each
  entry carrying `mcpRequires` + `provisioned` (cross-checked against the cached MCP catalog) so a
  UI can show "needs catalog sync" honestly. Never 500s on a missing workspace root.
- **`@piflow/cli`**: `skill search <q> --remote [--limit N] [--json]` — online discovery over
  pluggable indexes. ClaudSkills is the default (live-verified: the API has no server-side text
  search, so this is a bounded paginated scan + client-side filter, and its `url` is a catalog
  page rather than a clonable repo); SkillsMP is available programmatically (true server-side
  search; real repo roots derived from its GitHub tree links). Rows feed `skill add` verbatim.
