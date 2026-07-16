---
"@piflow/core": patch
---

fix(optimize): substrate fixer hardening — a 0-edit/oracle-touched discard no longer strands an issue at `active`, and the fixer's playbook skill is staged INSIDE the candidate worktree (not the live workspace)

Two live-evidenced defects in the optimize-substrate fix path:

- **Stranded issues.** `fixIssue`'s walk-back to `open` on a discard only fired for the
  proven-reject shape (`childId !== null`) — a fixer that applied zero edits, or whose commit
  touched an oracle path, left the issue at `active` forever (no self-loop in the status
  machine), so the NEXT `optimize fix` attempt crashed with "invalid issue status transition:
  active -> active". The walk-back now covers ANY discard on the hard (non-soft-gated) path.
- **Invisible playbook.** The fixer's `skill:` field pointed at `<workspace>/.claude/skills/
  piflow-fixer` — the LIVE product repo — while the fixer's own cwd/readScope/owns are all the
  isolated candidate git worktree (which never has `.claude/`, untracked in the product repo).
  Claude Code discovers a project skill relative to its OWN cwd (there is no `--skill <path>`
  flag for `claude -p`), so the fixer had no way to find its playbook and burned its turn
  hunting the filesystem, landing 0 edits. The resolved skill source is now copied into the
  candidate worktree itself (`<worktreeDir>/.claude/skills/<name>`), and the composed spawn's
  `skill`/`readScope` point at that in-jail copy. Audited the gate/triage/blame spawns — they
  run with `cwd: workspace` directly (no worktree isolation) and do not share this flaw.
