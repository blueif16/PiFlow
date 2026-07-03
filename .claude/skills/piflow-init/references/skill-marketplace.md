# The skill marketplace — SEARCH for a skill, then BIND it (COMPOSE step)

When you COMPOSE a node (Step 0), a node's CRAFT lives in a skill, never in its prompt body (the
"workflow orchestrates; the SKILL carries the craft" law). So before you author a lane's prose, **run the
ladder below to find a skill that already carries that craft and bind it** — reach for an existing bundle
before you hand-write craft into `prompt.md`. This is the marketplace surface: two LOCAL rings plus a REMOTE
lane, an installer, and the one-flag bind.

**The rings (the resolution order everything uses).** A bound skill is a BARE id that resolves at RUN time by
searching, in order: **Ring 0** `<workspace>/.agents/skills/<id>` (the project's own bundles) → **Ring 1**
`<piflowHome>/skills/<id>` (the installed catalog; `piflowHome` = `$PIFLOW_HOME ?? ~/.piflow`). First hit
wins; a workspace bundle SHADOWS an installed one with the same id. `piflowctl skill add` installs into Ring 1
— which is exactly why *install-then-bind-by-id* works: `add` lands the bundle in Ring 1, and a bare `--skill
<id>` finds it there at run time.

## The decision ladder — run it top to bottom, stop at the first hit

### 1. Search the LOCAL rings first
```bash
piflowctl skill list --json            # every resolvable bundle across BOTH rings
piflowctl skill search <query> --json  # the same rows, filtered on id + description (case-insensitive)
```
Each row is a `SkillListEntry`. **Read these fields:**
- `id` — the RESOLVABLE token (the bundle dir name); this is the exact string you pass to `--skill`.
- `ring` — `"workspace"` (Ring 0) or `"installed"` (Ring 1).
- `description` — the frontmatter one-liner; judge relevance against the node's job here.
- `requires` / `allowed` — the manifest FLOOR / CEILING (see *requires / allowed* below). A non-empty
  `requires` with an `mcp.*` entry means "catalog-sync before you bind."
- `shadowed` — `true` on an installed entry HIDDEN by a same-id workspace bundle (the workspace one wins).
- `error` — a manifest parse error string. **An entry with `error` set is NOT safely bindable — skip it.**

A hit whose `description` matches the node's craft → go to step 4 (bind it). No local hit → step 2.

### 2. Search the REMOTE lane
`--remote` bolts an ONLINE lane onto the SAME `skill search` verb (core's `searchRemote` —
`packages/core/src/workflow/ops/skill-remote.ts`). It is RANKED and STAGED: the bundled quality index
(`https://piflow.sh/skills-index.json` — ~6k curated/scored skills, BM25 + popularity/quality ranking,
sub-second) answers FIRST; only when it can't fill the limit does the live fan-out fire (topagentskills →
agentskill → claude-plugins → claudskills, concurrent, a few seconds). The pinned shape — do NOT improvise
another:
```bash
piflowctl skill search <query> --remote [--source <a,b>] [--limit <n>] [--json]
```
- `--limit <n>` caps the row count (default 20).
- `--source <a,b>` pins specific indexes (ids: `index`, `topagentskills`, `agentskill`, `claude-plugins`,
  `claudskills`, `skillsmp`, `skills-re`, `skillregistry`). Default order is already quality-first — only
  override when hunting the long tail.
- `--json` emits `RemoteSkillRow[]`; **read these fields:** `slug` (the remote id), `name`, `description`
  (judge relevance here), `source` (the string you hand to `skill add` in step 3 — a repo URL or `owner/repo`),
  `author?`, `index` (which registry the row came from), and when present `quality` (0-100 curated/audit
  score) and `pop` (stars+installs). **Picking the best fit:** rows arrive ranked — prefer the top row whose
  `description` matches the node's craft; break ties by `quality`, then `pop`.
> Caveat baked into the source: a ClaudSkills row's `source` is a catalog DETAIL PAGE, not a verified git
> remote, so `skill add` against it may fail cleanly (a clone error) — open the page for the real repo. All
> other indexes' rows carry a real `github.com/<owner>/<repo>` root and install directly.

A remote hit gives you a `source` (an `owner/repo`, a git URL, or a local dir). → step 3 (install it).

### 3. INSTALL the chosen bundle into Ring 1
```bash
piflowctl skill add <source> [--skill <name>] [--force]
```
- `<source>` = a **local dir** (used as-is), a **git URL** (`https://…`, `git@…`, `…​.git`, shallow-cloned),
  or the **`owner/repo`** GitHub shorthand (expands to `https://github.com/owner/repo.git`).
- Installs to `<piflowHome>/skills/<id>/` and writes `.install.json` provenance (`{ source, sha256,
  installedAt }`). Success prints `installed <id> → <dest>`.
- `--skill <name>` — REQUIRED when the source holds more than one SKILL.md (a root `SKILL.md`, else every
  `*/SKILL.md` and `skills/*/SKILL.md`); pick ONE candidate by its id. `add` lists the candidates when you
  omit it.
- `--force` — replace an id that is already installed (otherwise `add` refuses and tells you it exists).
- **`add` validates the bundle before copying** (see the failure paths for the two rejections you must relay).

The installed `id` is now resolvable in Ring 1. → step 4.

### 4. BIND the skill onto the node
Author the lane with the scaffold loop and pass the bare id:
```bash
piflowctl add-node <templateDir> --id <nodeId> [--dep …] [--tool …] --skill <bare-id>
```
`--skill <bare-id>` writes the pointer into `node.json`:
```json
"prompt": { "file": "prompt.md", "skill": "<bare-id>" }
```
That bare id resolves through the rings at run time (§ *The rings* above). Then `Write` only the node's TASK
into `prompt.md` — the skill body is the craft, loaded at runtime, never restated in the prompt. Run
`piflowctl extract <templateDir>` to confirm the DAG still compiles.

## Bind a skill vs. rely on the PRESET's built-in skill

Binding an agent PRESET (`--agent-type <id>`) ALSO contributes a skill: `mergePreset` sets the node's skill to
`node.skill ?? preset.skills[0]` — i.e. **the preset's first canonical skill is the fallback, and an explicit
`--skill` always wins.** Decide with `piflowctl agents list --json` (read `presets[].skills` — the `[0]` entry
is what a node inherits):

- **Rely on the preset's built-in skill** when the node's job matches the preset's purpose AND that preset's
  `skills[0]` is the craft you want. Then `--agent-type <id>` alone gives you the skill for free, plus the
  preset's tools and branding icon — do NOT also pass `--skill`.
- **Bind an explicit `--skill <id>`** when: (a) no preset fits the node, so it is a plain node that still needs
  a craft skill; or (b) a preset fits for its tools/branding but you want a DIFFERENT skill than its
  `skills[0]` — pass BOTH `--agent-type <id>` and `--skill <id>`, and the explicit one overrides the fallback.

Unknown `--agent-type <id>` ⇒ the scaffolder HALTS (never invents a preset) — see `references/agent-presets/README.md`.

## `requires` / `allowed` semantics + the "needs catalog sync" case

A skill's `SKILL.md` manifest may declare two lists:
- **`requires`** — the dependency FLOOR: tool / MCP / capability ids that MUST be bound for the skill to
  function (e.g. `mcp.linear:create_issue`).
- **`allowed`** — the permission CEILING: what the running agent MAY touch (the Anthropic `allowed-tools`
  convention).

Invariants the engine holds: compile-time **`requires ⊆ allowed`**; run-time **`requires ⊆ bound ⊆ allowed ⊆
catalog`**. `piflowctl skill add` REFUSES a bundle whose `requires ⊄ allowed` (a manifest authoring error) — so
any *installed* skill's floor is already within its ceiling; you never have to check that yourself.

**The "needs catalog sync" case.** The `⊆ catalog` half of the run-time invariant is on YOU. If a skill's
`requires` (read it from `skill list --json`) names an **`mcp.<server>:<tool>`** address, that address must be
present in the local MCP catalog when the node runs — otherwise the tool-binding pre-check (`verifyToolBinding`,
which runs LOUD and EARLY, before `pi` spawns) marks the node `blocked`. So **before you bind a skill that
requires an `mcp.*` tool, sync the catalog:**
```bash
piflowctl catalog sync                    # mirror the MCP registry directory → ~/.piflow/catalog/mcp.index.json
piflowctl catalog introspect <server>     # capture ONE server's real per-tool schemas (its mcp.<server>:<tool> addresses)
```
`catalog sync --json` returns `{ pages, upserted, removed, lastUpdatedSince }`; `catalog introspect <server>
--json` returns `{ server, toolCount, addresses[], … }` — check the skill's required address appears in
`addresses`. A skill that requires only `fs:*` / `sh:*` / pure `oc.*` builtins needs NO sync. (Per-node MCP
creds are still declared as `$VAR` env references in `node.json`; see the tool-address law in SKILL.md.)

## Worked example — end to end (search → add → bind → node.json)

Composing a "file a triage ticket" node; no local skill carries Linear craft.
```bash
# 1. LOCAL rings — no hit
piflowctl skill search linear --json
# → []

# 2. REMOTE lane — one hit
piflowctl skill search linear --remote --json
# → [{ "slug": "linear-triage", "name": "linear-triage", "description": "File + groom Linear issues …",
#      "source": "acme/linear-skill", "index": "skillsmp" }]

# 3. INSTALL it into Ring 1
piflowctl skill add acme/linear-skill
# → installed linear-triage → /Users/me/.piflow/skills/linear-triage
#      source acme/linear-skill
#      sha256 3f9c…

# 3b. its manifest requires an mcp.* tool → sync the catalog first
piflowctl skill list --json | jq '.[] | select(.id=="linear-triage") | .requires'
# → ["mcp.linear:create_issue"]
piflowctl catalog sync
piflowctl catalog introspect linear      # confirm mcp.linear:create_issue is in .addresses

# 4. BIND onto the node
piflowctl add-node .piflow/triage/template --id file-ticket --dep classify --skill linear-triage
```
The emitted `node.json` for `file-ticket` now carries:
```json
{
  "id": "file-ticket",
  "deps": ["classify"],
  "prompt": { "file": "prompt.md", "skill": "linear-triage" }
}
```
`Write` the node's TASK into `nodes/file-ticket/prompt.md`, then `piflowctl extract .piflow/triage/template`
to confirm the DAG compiles.

## Failure paths (do NOT guess your way past these)

- **No match anywhere (local rings empty AND remote empty / `--remote` not yet live).** COMPOSE the node
  WITHOUT a skill: inline the craft directly in `prompt.md` (an inline-prompt node with no backing skill is
  exempt from the craft-in-skill law — there the body IS the only home). **NEVER invent a skill id and bind
  it** — a bare `--skill <id>` that resolves in NO ring makes the runner report a LOUD staging miss (the node
  can't stage the skill). Only bind an id you have confirmed resolves.
- **`skill add` rejects: frontmatter `name` ≠ dir name.** The message is
  `frontmatter name '<x>' does not match the dir name '<y>' (the agentskills.io rule)`. Tell the user: the
  source's `SKILL.md` `name:` must equal its bundle DIRECTORY name — rename ONE so they agree, then re-run
  `skill add`. Do NOT hand-copy the bundle into `~/.piflow/skills/` to dodge it: the id you'd bind wouldn't
  match the manifest and resolution stays broken.
- **`skill add` rejects: `requires ⊄ allowed` / unparseable frontmatter.** The bundle's own manifest is
  invalid (`manifest is invalid — …`). This is an authoring bug in the SOURCE skill, not something to force
  past — report the exact message and pick a different skill (or the source's author must fix the manifest).
- **`skill add` reports multiple candidates.** The source holds more than one SKILL.md; it lists the
  candidate ids — re-run with `--skill <name>` naming the one you want.
- **`skill add` says an id is already installed.** Re-run with `--force` only if you intend to replace the
  installed copy; otherwise the existing Ring-1 bundle is already bindable as-is.
