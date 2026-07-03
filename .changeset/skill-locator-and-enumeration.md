---
"@piflow/core": minor
"@piflow/server": patch
---

Unified skill locator + capability enumeration (skill-marketplace P0).

- **Bare skill ids now actually stage.** `node.prompt.skill: "<bare-id>"` previously resolved
  against the workspace root only and **silently** skipped staging when absent (the running pi
  never received `--skill`, live-proven on a shipped example run). New `locateSkillStage` searches
  the two local rings — `<workspace>/.agents/skills/<id>` then `$PIFLOW_HOME/skills/<id>`
  (SKILL.md-gated, workspace wins) — and a declared-but-unresolvable skill is now LOUD: a
  `skill missing` issue on the node's status record (visible in observe/GUI/TUI) plus a warning,
  while the node still proceeds. Path-like and `{{WORKSPACE}}`-token refs are byte-identical to
  before; `resolveSkillStage` is unchanged.
- **New enumeration seam** exported from `@piflow/core`: `skillSearchRoots(workspace, piflowHome?)`
  (the single source of truth for ring ordering), `listSkills({workspace, piflowHome})` (both
  rings, with `ring`/`shadowed` tags and manifest fields), `listAgentPresets(dir?)` (the
  `~/.piflow/agents` readdir loop the server previously inlined), `locateSkillStage`,
  `isBareSkillId`, and `parseSkillManifest`/`SkillManifest` (so installers can refuse a
  `requires ⊄ allowed` bundle at install time).
- **`@piflow/server`** rides the seam: `GET /__piflow/agents.json` enumerates via
  `listAgentPresets`; `GET /__piflow/skill` resolves bare ids from the same ordered roots the
  runtime stages from (display ≡ staging; the installed ring is now `PIFLOW_HOME`-aware instead
  of hardcoded `~/.piflow/skills`). Response shapes unchanged (pinned by characterization tests).
