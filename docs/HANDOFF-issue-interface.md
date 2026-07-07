# Handoff — Issue interface (M8 issues surfaces)

_Session 2026-07-06. Branch `feat/gui-issues-surface` (off `main` @ `6498b10`)._

## Status: feature code LANDED, live visual render UNVERIFIED
Four commits on the branch, each typecheck-green + modules transform 200. The only thing not yet
done is *looking at it in a browser* (blocked by a dev-server hiccup, not a code bug — see below).

```
b0e276d run-level issues card (I key) — grouped by node, filter, jump-to-node
b298b58 node-level in-HUD issues browser (transform in place)
601919f shared issue UI — GitHub status icons, count cluster, row, content
dfa3583 server: issues route serves the all-nodes aggregate when ?node omitted
f2ce4a1 issue status helpers — isClosed/issueCounts/groupByNode (tested + mutation-checked)
```

## The model (locked, run-AGNOSTIC)
Issues live at `<templateDir>/nodes/<node>/issues/<name>.md` — **node-TYPE-scoped, persistent, reflect
CURRENT STATUS**. Same set regardless of selected run; `<run>` in the URL only picks which template to
read. GitHub semantics: **closed = `resolved`**; everything else (open/active/fix-landed/verifying/**regressed**)
= **open**. "this run" is a subtle badge (`isCurrentRun`), never a filter that hides.

## What's built
- **Backend** `GET /__piflow/issues/<run>[?node=]`: `?node` present → that node (fail-closed);
  omitted → `allIssuesProjection` = **viewer-tolerant** all-nodes aggregate (one unreadable legacy
  ledger can't blank the card). `packages/core/src/observe/issues.ts`, `handlers.ts`. Tests green.
- **Shared UI** `gui/src/components/IssueBits.tsx` + `styles/issues.css`: `IssueStatusIcon`
  (green open / violet resolved / amber reopened octicons), `IssueCountCluster`, `IssueRow`, `IssueContent`
  (parsed issue = facts + fix-attempts + markdown body via `MarkdownReader`).
- **Node-level (in-HUD)** `NodeHud.tsx`: identity row shows the `◎ open · ✓ closed` cluster (only when
  the node has issues); click → issues-mode: LEFT = issue list (replaces input files), CENTER = selected
  issue content. Remounts per node (`key=id`). `focusIssue` prop = jump target.
- **Run-level** `RunIssuesPanel.tsx` (bottom-bar **I** key): grouped by node, filter-by-node chips,
  per-node counts; clicking an issue **jumps to that node's HUD** with the issue open. Retired the old
  node-scoped `IssuesPanel`/`IssuesContext` (deleted).
- **Data helpers** `gui/src/data/nodeIssues.ts`: `isClosed`, `issueCounts`, `groupByNode`, `loadAllIssues`
  (test-first + mutation-verified in `nodeIssues.test.ts`).

## NEXT (start here)
1. **Verify live** (Task #6). Launch from the **fresh local dist** (global `piflowctl` 0.1.0 is stale):
   `node packages/cli/dist/cli.js gui` (serves :5174). Switch workspace → **game-omni** → pick a run →
   click the **gameplay** node → the `◎2 · ✓1` cluster → issues-mode. Then bottom-bar **I** → run card.
   - **Dev-server gotcha:** clearing `gui/node_modules/.vite` forces a cold dep-optimization that makes
     Vite hold ALL `/__piflow/*` requests for ~20–40s (looks like a hang; it isn't). Don't clear the
     cache unless needed; if you do, wait it out. All 3 seeded issues + tolerance were confirmed working
     server-side (`[observe] allIssuesProjection: skipping … w1-design`).
2. **Better issue interface (the design ask).** Principle: it just **records/presents the CURRENT STATUS**
   of issues, GitHub-style. Open questions to explore next session:
   - status grouping/tabs (Open | Closed) vs the current flat severity-sorted list;
   - what the node-level in-HUD transform should hide (keep meta/right/bottom regions, or go full
     two-pane?); empty-state polish; the "this run" badge's exact `verifiedByRun` matching
     (real values are `<run>.<node>`, e.g. `gm4d.gameplay` — `isCurrentRun` currently exact-matches, so
     it hits via `firstSeen`/`lastSeen` but not `verifiedByRun`; consider prefix-match).
   - severity ↔ status color harmony; attempt/regression timeline rendering.

## Facts / gotchas
- **Seeded test data** (in the *game-omni* repo, uncommitted): 3 M2-format fixtures on the **gameplay**
  node — `spawn-rate-unbounded-on-restart` (open/high), `player-hitbox-oversized` (resolved/medium),
  `double-jump-locks-input` (regressed/critical). Written via the real `writeIssueFile`. Re-seed with the
  same inline node script if lost.
- **`w1-design/issues/m5-teach-solo-band-grain.md`** is game-omni's **bespoke pre-M2 format** (`recurrence-4`
  severity etc.) → the fail-closed parser rejects it (per-node route 500s; aggregate tolerates+skips it).
  Decide later: migrate it to M2, or leave it (viewer already degrades gracefully).
- **OKF full sync** parked on `chore/okf-full-sync` (`c948a87`, 16 slices, `--check` exit 0) — NOT merged
  (main was checked out in a background worktree). Land it to main when convenient.
- Branch `feat/gui-issues-surface` = `main`'s code (FF'd from the stale merged `feat/gui-unified-side-card`).
  A background worktree holds `main`, so this branch's label ≠ `main` but the tree matches main's tip.
