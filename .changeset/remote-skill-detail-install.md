---
"@piflow/core": minor
"@piflow/server": minor
"@piflow/cli": patch
---

Online skill marketplace: clickable detail page + one-click Install.

A web-searched (online-ring) skill result can now be inspected and installed from the GUI, not just copied
as a command. New shared surface:

- **`@piflow/core`** — `parseSkillDoc(raw, fallbackId?)` (the manifest widened with the frontmatter
  `description` + the markdown `body` — one pure parser for both the local and remote detail views), and the
  install pipeline hoisted out of the CLI as `installSkill(source, opts)` / `classifySkillSource` /
  `SkillInstallError` so the control-plane server can install a skill without shelling the CLI (the same move
  made for `searchRemote`). `piflowctl skill add` is now a thin renderer over `installSkill`; behavior is
  unchanged (the git-fixture install test still passes).
- **`@piflow/server`** — `POST /__piflow/skill-install` `{ source, skill?, force? }`: installs a remote skill
  into `~/.piflow/skills` and returns the `InstalledSkill` record, so it re-appears in the installed ring as a
  bindable, draggable local card. Any install failure is a clean 502 one-line message (mirrors `skill-search`).
