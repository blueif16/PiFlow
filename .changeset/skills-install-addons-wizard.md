---
"@piflow/cli": minor
---

`piflowctl skills install` gains opt-in add-ons, an interactive wizard, and a per-project manifest.

The workflow-authoring trio still installs by default. On top of it you can now add optional skill packs —
the first is `okf` (the `okf-slices` code-understanding skill):

- `--with <id>` (repeatable) / `--all` — add specific add-ons / every add-on.
- `--wizard` — interactively choose which add-ons to install.
- The chosen set is recorded in `<targetDir>/.piflow/skills.json` (`{ "addons": [...] }`); a later bare
  `skills install` replays it. No flag + no manifest = the trio only (unchanged default).

Add-on skills are bundled into the npm tarball alongside the trio. This ships the add-on SKILL only (a pure
`.claude/skills/` byte-copy, preserving the anti-drift invariant); seeding a repo's OKF generator /
`.agents/okf/` is a separate future step.
