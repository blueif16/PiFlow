# Run-Layout Migration — everything self-contained under `.piflow/`

Branch: `fix/run-layout-self-contained`. Source of truth for this migration (audited via the
`migration-blast-audit` workflow, 2026-07-02).

## Goal (two invariants)
1. **Nothing at the workspace root.** Every write a run produces is anchored under
   `.piflow/<wf>/runs/<id>/`, from ANY cwd — never `process.cwd()`.
2. **One self-contained run folder.** A run dir = your output + a single `.pi/` (record +
   staged inputs + sessions). No sibling `_pi/` / `.pi-sessions/`.

## Target layout
```
<product>/                         ← pure project (packages, templates, .agents, apps…) + .piflow/
  .piflow/<wf>/
    template/
    runs/<id>/
      spec/ + built project        ← YOUR output
      .pi/                         ← the ONE machinery dir
        run.json workflow.json state.json journal.json   (observe SSOT — unchanged)
        nodes/<id>/                (record — unchanged)
        staged/<id>/               ← was _pi/<id>/  (prompt.md, tools.ts, mcp.json)
        sessions/                  ← was .pi-sessions/
        skills/ checkpoints/       (unchanged)
```

## Part A — root auto-derivation (invariant 1)
New helper in `packages/core/src/observe/scope.ts` (beside `findProductRoot`):
`templateLayout(templateDir) -> { productRoot, runsHome } | null` — walk up from a
`.piflow/<wf>/template` path; `null` when off-path → caller falls back to `findProductRoot`
then **warns** (never a silent cwd). Route these sites through it:

| site | today | change |
|---|---|---|
| `cli/run.ts:491` | `workspace = parsed.workspace ?? process.cwd()` | `?? templateLayout(tdir)?.productRoot ?? findProductRoot(tdir) ?? cwd(+warn)` |
| `cli/run.ts:497` | inline `basename==='template'` runsHome | `templateLayout(tdir)?.runsHome` |
| `cli/run.ts ~710` (runFromTemplate call) | **no `repoRoot` passed** | add `repoRoot: workspace` — **highest-value fix** (jail anchored at cwd every run today) |
| `core/entry.ts:152` | `workspace = opts.workspace ?? opts.repoRoot ?? cwd` | add `templateLayout(templateDir)?.productRoot` before cwd |
| `core/runner.ts:361` | `repoRoot = opts.repoRoot ?? cwd` | keep as low-level fallback (propagates once run.ts passes it) |
| `server/start-run.ts:72` | `runsHomeFor` duplicate | thin-wrap `templateLayout().runsHome` |
| `server/start-run.ts:130` | `tpl.productRoot ?? cwd` | `?? templateLayout(templateDir).productRoot` |
| `server/migrate.ts:94/113` | redundant runsHome + cwd fallback | via `templateLayout` |
| `cli/migrate.ts:245/247` | inline runsHome + spawnResume cwd | via `templateLayout` |

**Do NOT fold** (orthogonal, different mechanism): `gui.ts`/`tui.ts`/`serve-cli.ts`
`resolveScope(cwd)` (discovery scope); `cli/node.ts:179 resolveNodeRunDir` (reverse id→dir search).

## Part B — run-folder consolidation (invariant 2)
Two anchor edits — everything downstream (incl. the pi command builder, which reads only the
opaque `ctx.promptFile`/`ctx.extensionFile`) auto-propagates:

| edit | today | change |
|---|---|---|
| `core/runner/node-lifecycle.ts:135` | `nodeStage = path.posix.join('_pi', node.id)` | `path.posix.join('.pi','staged', node.id)` |
| `core/runner/layout.ts:37` | `piSessionsDir = path.join(run,'.pi-sessions')` | `path.join(piDir(run),'sessions')` |
| `core/tools/compile.ts:332` (cosmetic) | esbuild virtual sourcefile `'_pi/tools.ts'` | `.pi/staged/tools.ts` |
| `cli/run.ts:315` (cosmetic) | `dryRunPlan` default `promptDir ?? '_pi'` | `.pi/staged` |

No collision (`.pi/staged`, `.pi/sessions` are fresh siblings). Sandbox jail unaffected (grants
whole workdir). Migrate bundle unaffected (walks the whole tree).

## Observe interface: ZERO edits (confirmed)
Observe reads only `.pi/…`; `_pi`/`.pi-sessions` never appear in `packages/core/src/observe/*`.
GUI/TUI/server read through the same `.pi/` contract. (Follow-up, out of scope: several observe
files hardcode `.pi/…` instead of layout helpers — a hygiene pass if we ever rename `.pi` itself.)

## Tests
- **NEW (test-first):** `test/scope.test.ts` — `templateLayout` derivation; a run resolves
  `workspace` + `repoRoot` to `productRoot` from a **foreign cwd** (the anti-footgun); staged
  lands under `.pi/staged`, sessions under `.pi/sessions`.
- **UPDATE (intentional contract change — not weakening):** `warm-resume-l1.test.ts:122` (invert
  the "sessions never inside `.pi`" invariant), `cli/node.test.ts:101` (`piSessionsDir` literal),
  `runner.test.ts` (~20 `_pi/` assertions), `execcwd-staging.test.ts:74`. Introduce ONE shared
  test helper for the staged path so the literal isn't hand-duplicated again.
- Run from repo root: `pnpm test` (= `vitest run --project default`); scope one file:
  `npx vitest run --project default packages/core/test/<f>.test.ts`.

## Data-compat decision
Pre-migration runs keep `_pi/`/`.pi-sessions/` on disk; after the fold, resuming/warm-sessioning
an OLD run silently cold-starts (no crash — observe views stay correct). **DECISION: accept** —
pre-1.0, runs are disposable, no shim. (Alternative if ever needed: `piSessionsDir` checks both
locations.)

## Verification (phase 4 workflow)
typecheck + `pnpm test` green; then a demo run from a **foreign cwd** proving: run lands under
`.piflow/<wf>/runs/<id>`, run dir = `spec/` + one `.pi/` (no `_pi`/`.pi-sessions`), `{{WORKSPACE}}`
+ read-jail = product root, and the observe run-view still renders.

## Changeset
`@piflow/core` (minor: layout + templateLayout), `@piflow/cli`, `@piflow/server`.
