# Workspace switcher (design + plan)

Status: **proposed** — awaiting two decisions (see §5). Nothing built yet except the
prerequisite cleanup (redundant top-right Fit icon removed, `f3d6b14`).

## 1. Goal

Today the GUI is scoped to the **one folder** it was launched in. You can *see* other
folders' runs in the top-right `▾` menu, but you can't **enter** them — open their runs,
browse their templates, or point the pi chat at them. Add a first-class **"switch
workspace"** action: a corner icon that opens a launcher of all folders, and selecting one
re-scopes the console into it.

A **workspace = a folder/repo** (a `product` in index terms). Inside it live **templates**
(`namespaces`) and the **runs** each template produced (`threads`).

## 2. What already exists (reuse, don't rebuild)

| Piece | Where | Note |
|---|---|---|
| Global index of every folder | `src/data/runIndex.ts` (`GlobalIndex`, `loadIndex()`) | `products → namespaces → threads`; source `~/.piflow/index.json` via Vite middleware (`vite.config.ts:16`). Already loaded + polled every 4s in `WorkflowCanvas.tsx:156`. |
| The current switcher | `MenuBar.tsx` (`▾` popover → `DirectoryPanel` fed by `indexToTree`) | Run-centric: selecting a leaf sets `activeRun`. Root column already = workspaces flattened across all products. |
| Miller-column list | `DirectoryPanel.tsx` | Reusable; `reverse` for right-anchored. |
| Overlay/modal primitives | `GlassSurface` (`variant="window"`/`"soft"`), `NodeExpandOverlay`/`FileExpandOverlay` (scrim + `layoutId` morph), `StartRunPanel` (centered glass modal) | Match these; no command-palette primitive exists yet. |
| Runtime re-point seam | `apiBase.ts` `setEndpoint()` | Re-points the whole console local⇄cloud; the pattern to imitate for re-scope. |
| Chat session, keyed by run | `Companion.tsx:62` `useControlSession(activeRun)` | Re-points automatically when `activeRun` changes. |

## 3. The real blocker — `viewable:false`

`IndexThread.viewable` is `false` for runs that live under a folder **this serve wasn't
launched in** (`runIndex.ts:37`). The serve resolves scope from `PIFLOW_SCOPE_ROOTS` /
`loadScopedRegistry` (`scripts/lib/index-snapshot.mjs:57`) and only serves `run-view.json`
for its own folder. So the overlay UI is the easy half; **actually entering another folder
requires the serve to serve all registered folders** (from `~/.piflow/products.json`), which
flips those runs to `viewable`. This is the one piece of backend work.

## 4. Recommended shape (research-backed)

Because this switch has **global side-effects and re-points a live agent session**, treat it
like **VS Code's deliberate window re-scope**, not a lightweight in-place filter (Vercel).
Evidence + pattern taxonomy: the EXA brief (Basecamp Launchpad / Slack rail = corner-icon →
launcher of instances-you-enter; VS Code = re-scope replaces the window; design-system
consensus = confirm only when state is *dirty/live*, and *preserve* per-workspace state so
returning restores it).

- **Affordance:** corner icon → **full-screen overlay launcher** — grid of workspace cards,
  **recents/pinned first**, a **search** field, current workspace always labelled for
  orientation. (Recommended default; see §5-Q2.)
- **Effect on select:** re-scope templates + runs (+ chat + Start-run) to that folder;
  **confirm only when a run/chat is live** ("Switching will detach the live session in
  {current} — Stay / Switch"). Returning to a workspace restores its prior `activeRun`.

## 5. Two decisions that gate the build

**Q1 — switch effect** (recommended: **Full re-scope**)
- *Full re-scope:* entering repoints templates + runs + pi chat + Start-run; needs the §3
  serve-all-folders change. Matches "workspace determines which session we chat with."
- *View-only first:* open other folders' runs read-only; chat + Start-run stay on the
  launched folder. Smaller; defers the live re-point.

**Q2 — surface** (recommended: **Full-screen overlay launcher**)
- Overlay launcher (grid + recents + search) · Upgrade the top-right `▾` menu in place ·
  Command palette (⌘K).

## 6. Build plan (once Q1/Q2 land)

Assuming Full re-scope + overlay launcher:

1. **Serve all registered folders** (§3): widen the middleware's scope to
   `~/.piflow/products.json`; cross-folder runs become `viewable`. Guard: still default the
   *initial* focus to the launched folder.
2. **`activeWorkspace` state** in `CanvasInner` (currently only `activeRun` exists,
   `WorkflowCanvas.tsx:111`). Derive initial from `pickCurrentRun`'s product. Remember the
   last `activeRun` per workspace so re-entry restores it.
3. **`WorkspaceLauncher`** organism: portaled `GlassSurface variant="window"` + scrim, grid
   of workspace cards (name · #templates · #runs · live dot), recents/pinned + search, click-
   away/Esc (copy `MenuBar.tsx:38`). New `src/styles/launcher.css` using `--ds-*` tokens.
4. **Corner icon** to open it (top-left near the run-file navigator, or a dedicated chip);
   always show current workspace name.
5. **Confirm-on-live** re-scope: when the entered workspace ≠ current and a run is running or
   the companion is connected, route through a confirm (reuse the `ControlPlaneChip` dialog
   pattern, `ControlPlaneChip.tsx:91`) before switching `activeWorkspace`/`activeRun`.
6. Tests: `indexToTree`/re-scope selectors are pure — unit-test the workspace projection +
   the "restore last run per workspace" logic; Playwright for open→search→enter→confirm.

## 7. Open questions

- Does one piflow **folder** always map to one `product`, or can a folder hold several? (If
  several, the launcher lists products, and templates nest one level deeper.)
- Should Start-run's product/namespace pickers (`StartRunPanel.tsx`) collapse into "the
  current workspace" once workspace is first-class?
- Pin/recents persistence — memory-only (like `rememberedRemote`) or `localStorage`?
