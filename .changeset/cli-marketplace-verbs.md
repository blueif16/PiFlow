---
"@piflow/cli": minor
---

Marketplace P0 CLI surface — the init agent's enumeration + install verbs.

- `piflowctl agents list [--json]` — every base-agent preset in `~/.piflow/agents` (id, label,
  skills, tools; malformed presets surface as error notes).
- `piflowctl catalog sync [--base-url --max-pages] [--json]` / `catalog introspect <server> [--json]`
  — first-class verbs over the previously library-only MCP catalog federation.
- `piflowctl skill list [--json]` / `skill search <q> [--json]` — the two local rings
  (workspace `.agents/skills` + `$PIFLOW_HOME/skills`), ring-tagged and shadow-flagged, same
  ordering the runner stages by.
- `piflowctl skill add <source> [--skill <name>] [--force]` — install a bundle from a local dir,
  git URL, or `owner/repo` GitHub shorthand into `$PIFLOW_HOME/skills/<id>`: enforces the
  agentskills.io name=dir rule, validates the manifest via core's `parseSkillManifest`
  (a `requires ⊄ allowed` bundle is refused at install time), and records provenance in
  `.install.json` `{source, sha256, installedAt}` with a deterministic content hash.
