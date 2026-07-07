---
"@piflow/core": minor
"@piflow/cli": patch
"@piflow/server": patch
---

Make a run's layout self-contained under `.piflow/`, and anchor it at the product rather than `process.cwd()`.

Two invariants, audited across the runner/CLI/server:

- **Nothing at the workspace root; anchor at the product, not cwd.** A run now resolves `{{WORKSPACE}}` and
  the sandbox read-jail (`repoRoot`) to the product the template belongs to — DERIVED from the template's own
  `.piflow/<wf>/template/` placement via the new `templateLayout(templateDir)` helper — so a run kicked off
  from ANY foreign directory resolves identically. Precedence: explicit `--workspace` → template layout →
  nearest enclosing product → cwd with a LOUD warning (never a silent cwd footgun). The highest-value fix:
  `piflowctl run` now threads `repoRoot` into the runner, so the read-scope jail anchors at the product
  instead of wherever the run was invoked (previously it was never passed and defaulted to cwd on every run).

- **One self-contained run folder.** Per-node staged inputs move from a sibling `_pi/<id>/` to
  `.pi/staged/<id>/`, and per-run pi sessions from `<run>/.pi-sessions/` to `<run>/.pi/sessions/`. A run dir
  is now your output plus the ONE `.pi/` machinery dir — no stray `_pi/`/`.pi-sessions/` siblings. Observe
  reads only the named `.pi/` files, so the new `.pi/staged`/`.pi/sessions` subdirs are invisible to it.

New export: `templateLayout(templateDir) -> { productRoot, runsHome } | null`.

Data compatibility: pre-migration runs keep their old `_pi/`/`.pi-sessions/` on disk; resuming or
warm-sessioning such a run cold-starts (no crash — observe views stay correct). No data migration (pre-1.0,
runs are disposable).
