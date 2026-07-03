---
"@piflow/core": minor
"@piflow/cli": minor
"@piflow/server": minor
---

Widen the skill marketplace to the live online indexes (online-first; local rings become the offload cache) and bridge MCP registry names to local bind names.

- **`searchRemote` moves to `@piflow/core`** (`workflow/ops/skill-remote.ts`) so the CLI verb and the control-plane server share one implementation. Five new live-probed remote indexes join ClaudSkills/SkillsMP: `topagentskills` (146 curated, quality-ranked), `agentskill` (274k rows, server-side search + per-row detail resolve), `claude-plugins` (50k, server-side `q`), `skills-re` (7.5k, POST search + resolve-install), and `skillregistry` (161k static lite index, opt-in). Defaults are quality-first (`topagentskills → agentskill → claude-plugins → claudskills`); rows dedup across sources by name+repo.
- **`piflowctl skill search <q> --remote --source <a,b>`** picks indexes explicitly.
- **`GET /__piflow/skill-search?q=&sources=&limit=`** (`@piflow/server`) exposes the same lane to the GUI marketplace panel, which gains an **online** ring: debounced live search over the remote indexes, cards copy their `piflowctl skill add <source>` command.
- **`piflowctl catalog introspect <server> --as <alias>`** writes a registry-named server's tools under the LOCAL alias specs select (`mcp.exa:*` instead of `mcp.ai.exa/exa:*`) and copies its config to `servers[<alias>]`, so registry-synced servers become bindable at run time.
