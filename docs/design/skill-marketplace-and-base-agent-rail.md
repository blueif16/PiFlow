# Skill marketplace + base-agent rail — mechanism map & design

*2026-07-03 · synthesized from a 5-lane parallel understanding pass (GUI compose surface · base-agent
presets · skill lifecycle · prior marketplace research · external prior art). Every code claim below was
subagent-mapped with file:line anchors; the load-bearing ones re-verified inline.*

**The ask.** (a) Press `B` → see every base agent with its icon on a rail, rendered like the gate rail
that opens with Compose, draggable onto the graph. (b) A skill marketplace available in the GUI *and* to
the `piflow-init` agent — search skills, drag one onto the canvas so it becomes an agent (or pairs with a
base agent), store our own skills and bundles. Robust, composable lego pieces.

---

## 1. What exists today (verified mechanisms)

### 1.1 The gate-compose pattern is a complete, cloneable template
- Rail: `RAIL_KINDS` (compile-time constant, `gui/src/data/gates.ts:33-52`) → `GateRail.tsx:23-37`
  renders draggable hexes; drag sets `CHIP_DND_MIME = "application/x-piflow-gate-chip"`
  (`ComposeContext.tsx:52`).
- Drop: `NodeGateChips.tsx:43-62` (rendered only when `mode === "compose"`,
  `WorkflowNode.tsx:333-337`) parses the payload and opens `GateDropCard` — **the drop performs no
  write**; the card's submit does.
- Write: both fast-path and agent-composed paths converge on `dropChip` → `POST
  /__piflow/node-edit/<run>` (`runView.ts:278-296`) → `piflowNodeWriteback`
  (`packages/server/src/handlers.ts:575-646`) → **two-tier**: `target:"run"` bakes into this run's
  `.pi/` state; `target:"template"` durably patches `template/nodes/<id>/node.json` via the
  schema-validated `gui/scripts/lib/node-writeback.mjs`. This satisfies the config-is-truth law
  (GUI is a projection; the write lands in config).
- Limitation: `chipToOps`/`applyEdit` (`node-writeback.mjs:61,127`) only know gate kinds
  (`execution/judge/human`) — **no chip kind exists for "set agentType" or "set skill"**, though both
  fields exist on `AuthoredNodeConfig` and in `node.schema.ts`.

### 1.2 Base agents are already enumerable — the GUI just doesn't show a rail
- **15 known ids**: 12 file presets seeded from
  `.claude/skills/piflow-init/references/agent-presets/*.md` and materialized into
  `~/.piflow/agents/<id>.md` (`explore plan author coder reviewer synthesizer general-purpose
  interview market-research paper-analyzer verify debugger`), + 3 built-in fusion presets
  (`packages/core/src/workflow/fusion/presets.ts:25-39`), + the bare `judge` label stamped by gate
  materialization (`judge/materialize.ts:82`) with **no catalog file**.
- **Enumeration endpoint EXISTS**: `GET /__piflow/agents.json` (`handlers.ts:501-542`) readdirs
  `~/.piflow/agents/`, returns `{id → {label,icon,color,prompt,skills,tools,model,tier}}` + a
  `drivers[]` axis. Already consumed by `loadAgentCatalog()` → `toFlowGraph()` for node chips,
  faces (`agentFaces.ts`, 6 face PNGs), and `AgentHoverCard`.
- **Gaps**: no SDK `listAgentPresets()` (server re-implements the readdir loop inline); no
  `piflowctl agents list` verb (the init agent can't enumerate presets); icon-glyph cases missing for
  `debugger`(`bug`) and `fusion-obligations`(`checklist`); docs claim 3/6 presets, reality is 12.
- **`b` is NOT free**: bound to the "Basis" view mode (`ViewModeContext.tsx:38`) — the passive
  base-agent inheritance strip. Same concept, read-only. (Resolution in §3.1.)

### 1.3 The skill lifecycle — built end-to-end EXCEPT the one hop that matters
- Anatomy: `parseSkillManifest` (`skill-manifest.ts:159`) reads `name/requires/allowed/display`,
  enforces `requires ⊆ allowed` at parse time. `requires` (dependency floor) is piflow-novel (D6).
- Bind: `node.prompt.skill` (single slot). Writers: hand-edit (the only path actually exercised),
  `add-node --skill` (built, **undocumented in piflow-init's SKILL.md**), preset fallback
  `skill = node.skill ?? preset.skills?.[0]` (`agent-preset.ts:77`) — but all 12 shipped presets carry
  `skills: []`, so the indirect path currently supplies nothing.
- Runtime (design D5, Option C stage+flag): `resolveSkillStage` (`ops/skill.ts:40-44`) → `fs.cp` to
  `<run>/.pi/skills/<name>/` + sandbox mirror (`node-lifecycle.ts:424-436`) → `pi --skill
  <in-sandbox-path>` (`command.ts:98`).
- **⚠️ P0 GAP (live-proven)**: `resolveSkillStage` resolves a bare id against the *workspace root
  only* — `"multi-source-research"` → `<workspace>/multi-source-research`, which doesn't exist, and
  the runner's stat-gate **silently skips** staging. Run `skillcase-01` recorded
  `config.skill: "multi-source-research"` yet executed pi with **no `--skill` flag and no `.pi/skills/`
  dir** (re-verified 2026-07-03). The GUI's `/__piflow/skill` display handler has its own *wider*
  search (run skills → workspace → `.agents/skills/` → `~/.piflow/skills` → `~/.claude/skills` →
  `~/.pi/agent/skills`, `handlers.ts:387-423`) — so the panel shows a skill the runtime never
  delivered. Display path and staging path must share one resolver.
- **Dormant machinery**: `compileNodeBase`/`resolveSkillLoadout`/`preflightSkills`
  (`agent-base.ts:175-309`) — the requires-floor auto-wire + preflight — is built and tested but has
  no caller on the main load path (only judge-materialize). A marketplace bind wants exactly this: a
  skill's `requires: [mcp.*]` auto-provisioning tools + failing fast when unprovisioned.
- MCP federation: `introspectMcpServer`/`syncMcpCatalog` library-complete, populate
  `~/.piflow/catalog/mcp.index.json`; registry hard-fails unknown `mcp.*` addresses. **No CLI verb** —
  today only a hand-written script can populate the catalog.
- Install surfaces: `piflowctl skills install` = Claude-**authoring** skills into `.claude/skills/`
  (different artifact, different consumer — do not conflate); `~/.piflow/skills/` = the planned
  node-skill install root (read-root only today, nothing writes it); repo `.agents/skills/` = the one
  real git-tracked precedent (`multi-source-research` lives there).

### 1.4 Prior decisions that bind this design (docs/research + docs/design, all still standing)
- **D14 — the marketplace atom is the layer *below* an agent**: a skill (procedure) or an MCP server
  (connectivity), never a full persona. Loadout ⟂ posture split validated across Anthropic /
  Salesforce / LangGraph.
- **D5 — stage+flag** is the settled skill delivery (no readScope widening, cloud-identical).
- **D6 — `requires` floor ≠ `allowed` ceiling**, `requires ⊆ allowed ⊆ catalog`.
- **D7 — integration order MCP → Skills → OpenClaw** (OpenClaw stays ingest-side, D10/D11).
- **D16 — registry-as-code**: git-tracked JSON catalog, keyword search first, no DB.
- **Security constraints**: provenance gate; introspect-in-sandbox before trust; pin by
  checksum, never floating tags; popularity is a tiebreaker never a trust proxy; enforcement external
  to the agent (D13 — structural isolation, the sandbox is the boundary).
- **Largest recorded open question** (now being answered here): *no user-facing marketplace verb,
  browse UI, or install flow was ever specified* — every prior doc covers FEDERATE/ingest mechanics only.

### 1.5 External prior art worth stealing (2026 survey, 13 registries; full brief in the lane report)
- **Anthropic Agent Skills spec**: `name` must equal dir name; `description ≤1024` chars is the
  always-resident trigger surface (progressive disclosure) — our palette entries should carry exactly that.
- **n8n**: *verified-badge gates palette visibility, not installability* — anyone can install with an
  explicit risk consent; only reviewed entries surface ambiently in the editor search. The cheapest
  credible trust tier.
- **Dify**: one generic Tool node + runtime-populated provider list; per-param `form: llm|form`
  (design-time human field vs run-time agent-inferred) — borrowable for skill config.
- **Claude Code marketplace.json**: "declare paths, client scans and merges" overlay — the leanest
  bundle contract; a piflow **skill bundle** (several skills + suggested base-agent pairings in one
  repo) can mirror it.
- **skills.sh / vercel-labs**: `npx skills add owner/repo` — GitHub-repo-as-registry, zero central
  index; right shape for our Ring-2 remote sources.
- **Cautionary**: ClawHavoc (≈20% of ClawHub packages malicious in one campaign) and Snyk ToxicSkills
  (13.4% critical) — scanning alone does not stop supply-chain attacks; default-deny + pinning + the
  sandbox boundary are the honest defenses (consistent with D13).

---

## 2. The composition model (the "lego" contract)

One sentence: **a node = base agent (loadout: prompt+tools+skills) × posture (model/tier/sandbox/gates),
and a skill is the atomic marketplace unit that can either JOIN an existing node or SEED a new one.**

Already-shipped semantics make "pair with a base agent or not" free:
`mergePreset` resolves `skill = node.skill ?? preset.skills?.[0]` — node wins, preset is fallback.
So: drag skill → onto an existing node = **pair** (set `node.prompt.skill`); drag skill → onto empty
canvas = **becomes an agent** (spawn a node from a default/suggested base agent with that skill bound).
Same write primitive both times.

---

## 3. Design

### 3.1 `B` — the base-agent rail (upgrade Basis mode, don't fight it)
`b` already means "base agent" (Basis mode). Keep the key, **promote the mode**: Basis becomes the
active picker — the left rail lists every *authorable* preset (exclude `fusion-*` and bare `judge`,
which are system-stamped) with face/glyph + label, exactly the `GateRail` rendering pattern; the
existing per-node inheritance strip stays as Basis mode's on-node projection.
- Data: reuse `GET /__piflow/agents.json` verbatim (already returns everything the rail needs).
- Drag: new MIME `application/x-piflow-agent-chip`, payload `{agentType}`; drop target on node cards
  (clone `NodeGateChips` gating on `mode === "basis"`); a small confirm card in the `GateDropCard`
  idiom (shows the preset's prompt/tools/skill delta) — then the standard two-tier write.
- Write: new chip kind `agent` in `node-writeback.mjs` `chipToOps`/`applyEdit` → sets
  `node.agentType`; rides the existing `POST /__piflow/node-edit` + run-bake/template-promote flow.
- SDK hygiene while we're here: extract `listAgentPresets()` into core (server drops its inline
  readdir), add `piflowctl agents list` (the init agent's enumeration surface), add glyph cases for
  `bug`/`checklist`, decide the `judge.md` seed.

### 3.2 The skill marketplace — three rings, one panel, one resolver
**Rings** (storage surfaces, all already read by the display handler — we make them canonical):
- **Ring 0 — ours**: repo `.agents/skills/<id>/` (git-tracked; where Hermes-edited, self-improved
  skills live; "store our own skills and bundles").
- **Ring 1 — installed**: `~/.piflow/skills/<id>/` (global install root; written by the new install
  verb; checksum-pinned + `install-manifest.json` per D16/security constraints).
- **Ring 2 — remote**: federated sources searched on demand — GitHub repos of SKILL.md folders
  (skills.sh-shape `owner/repo`), the curated skill aggregators, and the MCP registry for `requires`
  resolution. Registry-as-code: a git-tracked `catalog/skills.index.json` mirror, keyword+tag search.

**Panel** (`SkillMarketPanel`, sibling of `SkillPanel`): search box + ring filter; each card =
`display.icon + name + description (the ≤1024-char trigger surface) + requires/allowed tags +
needsMcp/provisioned badge + trust tier`. Clicking = existing `SkillPanel` detail. Ring-2 cards get an
**Install** action first (→ Ring 1); Ring-0/1 cards are draggable.
- New endpoint `GET /__piflow/skills` — enumerates Ring 0+1 (reuse `piflowSkill`'s root set and its
  realpath-confinement discipline); Ring-2 search proxied via the catalog module.
- `needsMcp` upgrades from a string heuristic to a real cross-check against
  `~/.piflow/catalog/mcp.index.json` → "provisioned / needs `piflowctl catalog sync`".

**Drag-out semantics** (new MIME `application/x-piflow-skill-chip`, payload `{skillId, ring}`):
- **Onto a node** → confirm card → chip kind `skill` sets `node.prompt.skill` (replace, v1 — the
  schema slot is singular; multi-skill is a schema change, deferred). Two-tier write as always.
- **Onto empty canvas** → **spawn**: pane-level `onDrop` on `<ReactFlow>` (no precedent yet — the one
  genuinely new GUI mechanic) → a spawn card (id, base agent defaulting to `general-purpose` or the
  skill's suggested pairing, deps) → new endpoint `POST /__piflow/node-add` wrapping the existing
  `buildNode`/scaffold path (template-only; a new node has no run state to bake).

**Trust posture** (from priors + external evidence): install = fetch → checksum-pin → static scan →
land in Ring 1 with `trust: verified|community`; community entries are installable with explicit
consent but **not ambient** in search results by default (n8n pattern); the *actual* boundary stays
the per-node sandbox + `--tools` allowlist (D13) — a skill's `allowed` is pre-approval metadata, never
enforcement.

### 3.3 Runtime correctness (P0 — before any marketplace UI)
1. **Bare-id resolution**: give `resolveSkillStage` (or a resolver just above it) the same ordered
   search the display handler uses — workspace `.agents/skills/<id>` → `~/.piflow/skills/<id>` —
   and make the runner's silent skip **loud** (a `skill_missing` trace event at minimum). One shared
   resolver, display and staging.
2. **Wire the dormant floor**: call `resolveSkillLoadout`/`preflightSkills` on the main load path so
   a bound skill's `requires` auto-wires `tools.allow` and unprovisioned `mcp.*` fails at dry-run,
   not silently at runtime. (SA-A was built for exactly this.)
3. **CLI verbs**: `piflowctl catalog sync|introspect` (library exists, verb doesn't) and
   `piflowctl skill add|list|search` (the init agent's surface — piflow-init's SKILL.md then documents
   `--skill` + `skill search`, closing the "only hand-edits ever exercised this" hole).

### 3.4 What the init agent gets
`piflow-init`'s COMPOSE branch gains one step: *search skills before authoring lanes* —
`piflowctl skill search <need>` → bind via `add-node --agent-type <base> --skill <id>`. Same catalog,
same resolver, same verbs as the GUI. (Self-describing CLI is the enablement path per the rollout
memory; the GUI and the agent must never have different pictures of the skill universe.)

---

## 4. Build order (each phase independently landable)

| Phase | Content | Nature |
|---|---|---|
| **P0** | Shared skill resolver + loud skip + staging fix; `catalog sync` + `skill list/search/add` verbs; `listAgentPresets()` extraction + `agents list` | SDK/CLI, no GUI |
| **P1** | `B` rail: AgentRail + agent chip kind in node-writeback + confirm card + two-tier write | GUI, clones compose |
| **P2** | `GET /__piflow/skills` + SkillMarketPanel (Ring 0+1) + skill chip drag-onto-node | GUI + server |
| **P3** | Canvas-pane drop + spawn card + `POST /__piflow/node-add`; skill-led node creation | the one new mechanic |
| **P4** | Ring 2: remote search/install, checksum pin, trust tiers, `requires` preflight wiring | federation |

**Open decisions** (defaults chosen above, flag if you disagree): (1) Basis-mode upgrade vs a new
key for the rail; (2) v1 skill drop = replace the single `prompt.skill` slot (multi-skill = schema
change, deferred); (3) spawn-from-skill default base = `general-purpose` vs a `suggests:` field in
skill frontmatter; (4) whether run-first baking applies to agentType/skill reassignment or those are
template-only (recommend: template-only for agentType — it's structural; run-first OK for skill).
