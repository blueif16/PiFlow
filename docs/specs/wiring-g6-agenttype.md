# Wiring design — G6: agentType presets (author-time expansion + branding)

> Status: DESIGN ONLY (no source edited). Created 2026-06-25. Companion to
> `docs/specs/competitive-gaps-vs-pi-dynamic-workflows.md` §G6. Every existing-code claim cites a
> `file:line` read while writing this. Where the §G6 brief differed from reality it is recorded under
> **⚠️ Discrepancies**.
>
> **Design decisions (locked with the owner 2026-06-25):**
> 1. **Author-time expansion**, NOT a runtime resolver. `piflow-init` expands a preset INTO the node's
>    concrete `tools`/`prompt` while authoring the template; `agentType` stays on the node as a *label*.
>    Core grows ~no execution logic.
> 2. A preset is a **thin, optional starting point + branding** — a few canonical skills + a base tool set
>    + a canonical role-prompt + a `display` (icon/label/color). It is NOT a capability gate: per-node
>    customization always wins, and most real tool/model wiring is authored per node at init.
> 3. **Presets DO NOT carry `model`/`tier`.** The format keeps the slots (uniform schema) but the seeds
>    leave them empty and expansion never sources a model from a preset — model/tier are per-node/run.
> 4. **Additive merge:** node `tools.allow` ADDS to the preset's base, `tools.deny` REMOVES; the node's
>    task prompt is APPENDED to the preset's canonical role-prompt (preset = the role + standard, node =
>    the specific task).
> 5. **The icon is the headline.** A preset's most visible value is the pre-customized icon/label that makes
>    a node feel purpose-built. It is pure display data — surfaced by `observe` → GUI, IGNORED by the runner.

---

## 1. Objective

Ship **a small, curated set of ready-to-use agent presets** (`market-research`, `paper-analyzer`,
`interview`) that an author can drop onto a node as a named, pre-sorted starting point — canonical
skills + a base tool set + a canonical role-prompt + a branded icon — while keeping the workflow
**fully flexible**: a node can start from a preset and customize above it, or skip presets entirely and
have the init agent wire tools/model/prompt by hand. The mechanism is **author-time expansion**: at init
the preset is flattened into the node's concrete fields and the `agentType` label is retained for
branding. Honest framing baked into the product: presets are conveniences, not exclusive powers — they
carry the same kind of tools any node can, just pre-sorted and wearing a nice icon.

---

## 2. Current state (each with file:line)

- **`agentType` is carried but unconsumed.** `NodeSpec.agentType?: string`
  (`packages/core/src/types.ts:31`) and the authored subset `NodeIntent`
  (`types.ts:560`). The ONLY readers are: the journal envelope hash, which hashes the raw string and
  marks a G1/G6 fold-in TODO (`runner/journal.ts:90-104`), and the imperative `extract` path
  (`workflow/extract.ts:32-33,152`). It NEVER reaches `resolve()` or `buildCommand()`.
- **⚠️ The TEMPLATE format has no `agentType` field at all.** `TemplateNode` carries
  `prompt: { file: string; skill?: string }` (`workflow/template/types.ts:19`) — so a skill lives under
  `prompt.skill`, and there is **no** `agentType` key in the node schema (`template/schema/node.schema.ts`
  has `skill` at `:42`, no `agentType`). The loader sets `skill: n.def.prompt.skill` (`loader.ts:116`)
  and never sets `agentType` (it stays `undefined` on the template path). So the PRIMARY authoring path
  (templates) cannot even declare `agentType` today — it is reachable only via the imperative `extract`
  path. (This amplifies the §G6 claim "field exists, no binding": on templates the field doesn't exist.)
- **No agentType / preset definition loader anywhere.** There is no `.pi/agents/<name>.md` equivalent in
  `packages/core/src` (confirmed by grep: zero resolver). PDW has one; we have none.
- **Per-node tool wiring already works (the strength G6 sits on top of).** A node's
  `tools: ToolSelection { allow?, deny? }` (`types.ts:162`) resolves through `DefaultToolRegistry.resolve`
  (`tools/registry.ts:69`) → a generated, bundled pi `-e` extension binding exactly that node's sdk/mcp
  tools (`tools/compile.ts:241`, staged at `runner.ts:872-875`). MCP/community tools route through
  `@piflow/tool-bridge` by address (`tool-bridge/index.ts:62`), incl. the reserved `openclaw` gateway
  (`tool-bridge/address.ts:41`). **This is additive + per-node + tested** — the thing PDW's in-process
  agentType structurally can't match (its `mcp`/`skills` frontmatter is parsed-but-ignored —
  `vendor/.../agent-registry.ts:14-17`).
- **Per-node model routing exists (G1).** `resolveNodeModel` owns the precedence
  (`runner/model-routing.ts:66`), consumed at `runner.ts:896-905`. A node already routes its own
  model/tier — so a preset has NO reason to also set one (decision #3).
- **observe is the single data path; it does NOT surface `agentType`.** `RunViewNode`
  (`observe/runView.ts:30`) carries `id/label/phase/status` (pushed at `runView.ts:274`) but no
  `agentType`; `NodeView` (`observe/types.ts:39-41`) likewise. The GUI/TUI/CLI all read this one reader
  (memory `[[observe-single-data-path]]`), so the icon must ride here to render per node.
- **SDK/data boundary (CLAUDE.md + `[[sdk-data-boundaries]]`).** Product-specific data (a catalog of named
  agent types + their icons) MUST NOT live in `packages/*`. Global mapping/index lives in `~/.piflow/`
  (parallels `model-tiers.json`, read read-only by `model-routing.ts:93-100`). The GUI is a static viewer
  that reads the global index from `~/.piflow/`.

---

## 3. Reference (competitor) — PDW agentType, with file:line

PDW resolves `agentType` to a `.pi/agents/<name>.md` definition binding **tools (name allow/deny) + model
+ role prompt**, applied per `agent()` call (`vendor/pi-dynamic-workflows/src/agent-registry.ts`; applied
`src/workflow.ts:371-375`). Its frontmatter `mcp`/`skills`/`background`/`isolation` are
**parsed-but-ignored** (`agent-registry.ts:14-17`), and `opts.tools` injection is whole-workflow, never
per node (§1a of the gap doc).

**ADOPT** (the idea, re-cast): a named, reusable bundle of {canonical skills + base tools + role prompt +
display} a node can start from.

**REJECT / DIVERGE** (mechanism — does not fit a declarative, multi-process fleet):
- **Runtime resolution in the engine.** PDW resolves at `agent()`-call time inside one process. We choose
  **author-time expansion** (decision #1): the init agent flattens the preset into the template node, so
  the runner/journal see only concrete fields and need no agentType-aware code. Lighter, boundary-clean,
  and matches "most tool use is defined at init."
- **model in the preset.** PDW's agentType can pin a model; we deliberately DON'T (decision #3) — G1 owns
  per-node model.
- **ignored mcp/skills.** Their structural limit is our differentiator: our presets bind **real MCP/
  community tools** because the per-node tool pipeline (§2) is additive — the "uniquely ours" line in §G6.

---

## 4. End-to-end design — the author-time-expansion walk

The flow has four actors: the **preset catalog** (product data), the **`mergePreset` utility** (pure
logic, core), **`piflow-init`** (the authoring agent that calls it), and the **GUI** (renders the icon
via observe). The runner is untouched except for carrying the label through observe.

### 4.1 The preset format — `~/.piflow/agents/<id>.md` (markdown + frontmatter)

Mirrors PDW's `.pi/agents/<name>.md` and the Claude-Code subagent shape (frontmatter = metadata, body =
the canonical role-prompt). Lives in the global dir (boundary-clean), not in `packages/*`.

```markdown
---
id: market-research
display:                      # the headline — pure branding, runner-ignored
  label: Market Research
  icon: chart-trend           # an icon KEY the GUI maps to a bundled asset (never a path into the SDK)
  color: "#2563eb"
skills: [multi-source-research]          # canonical skills (folded into the role-prompt + node.skill)
tools:                                    # the BASE tool set (a starting allow-list; node adds/removes)
  allow: [fs:read, fs:write, oc.firecrawl:firecrawl_search, oc.tavily:tavily_search]
model:                                    # PRESENT in the format, EMPTY in every seed (decision #3)
tier:                                     # PRESENT in the format, EMPTY in every seed (decision #3)
---
<the canonical role-prompt body — see 4.5>
```

`AgentPreset` (the parsed shape, a pure type in core — logic, not data):
```ts
interface AgentPreset {
  id: string;
  display?: { label?: string; icon?: string; color?: string };
  skills?: string[];
  tools?: { allow?: string[]; deny?: string[] };
  model?: string;   // forward-compat slot; seeds leave empty; see merge rule 4.3
  tier?: string;    // forward-compat slot; seeds leave empty
  prompt: string;   // the role-prompt body
}
```

### 4.2 Where the catalog lives (boundary-clean) + where seeds come from

- **Home:** `~/.piflow/agents/*.md` — the single, user-extensible catalog. Parallels
  `~/.piflow/model-tiers.json`. The GUI reads icon/label from here (via the global index).
- **Seeds:** the 3 starter presets ship as **`piflow-init` skill references** (authoring tooling, version-
  controlled with the skill — NOT in `packages/*`). On init, `piflow-init` materializes any missing seed
  into `~/.piflow/agents/` (idempotent copy) so the catalog is populated and the GUI can resolve icons.
- **Custom presets:** a user/author drops a new `<id>.md` into `~/.piflow/agents/`; it's available
  immediately, same as a seed. The taxonomy is open, not fixed.

### 4.3 `mergePreset` — the pure expansion utility (core logic, testable)

A pure function in core (`packages/core/src/workflow/agent-preset.ts`), called by `piflow-init` at author
time. It is LOGIC only (no product data, no I/O) so it honors the boundary and is exhaustively unit-
testable. Precedence is the contract:

```
mergePreset(preset, node) -> node':
  tools.allow := unique( preset.tools.allow ∪ node.tools.allow )           # ADDITIVE
  tools.deny  := unique( preset.tools.deny  ∪ node.tools.deny  )           # node can still subtract
                 then drop any allow address that appears in deny          # deny wins over allow
  prompt      := preset.prompt + "\n\n" + node.prompt                      # role first, task appended
  skill       := node.skill ?? preset.skills?.[0]                          # node wins; preset is fallback
  agentType   := preset.id                                                 # the retained label
  model/tier  := node.model / node.tier ONLY                               # NEVER sourced from preset
                 (if a future preset sets model/tier, treat as LOWEST-precedence fallback below run —
                  seeds leave them empty so in practice model/tier is always node/run; decision #3)
  display     := preset.display                                            # carried for the GUI (see 4.6)
```

This makes "customize above an agent type" literal: a node naming `market-research` plus its own
`tools.allow: [mcp.github:create_issue]` ends up with the preset's web tools PLUS GitHub; a node adding
`tools.deny: [oc.tavily:tavily_search]` drops one preset tool. Same for the prompt (role + task).

### 4.4 `piflow-init` — the author-time expansion contract (agent-facing)

`piflow-init` (the workflow-authoring skill) gains a step: when an author assigns a node an `agentType`,
it expands the preset rather than treating the name as magic. This is agent-facing prose — the contract
the init agent follows:

> **When a node declares `agentType: <id>`:** (1) read `~/.piflow/agents/<id>.md`; if absent, HALT and
> tell the author the preset is unknown — never invent one. (2) Call `mergePreset(preset, node)` (4.3) and
> WRITE THE RESULT into the template `node.json`: the merged `tools` and the role-prepended `prompt` become
> the node's CONCRETE fields, so the template on disk is self-contained. (3) KEEP `agentType: <id>` on the
> node as the branding label (so the GUI shows the icon) — do not strip it. (4) Decide the node's
> `model`/`tier` yourself per the run's needs; the preset contributes NONE. (5) Tell the author, in one
> line, exactly what the preset contributed (base tools + role-prompt + icon) and that everything is now
> editable per node — presets are a starting point, not a lock-in.
>
> **The author may always skip presets entirely** and wire `tools`/`prompt`/`model` by hand; that is the
> common path. Presets exist to save retyping a canonical bundle and to brand a node.

### 4.5 The canonical role-prompts (the preset bodies — agent-facing)

Each preset body is a REUSABLE role + standard the node's task is appended to. Authored to raise the floor
(role · observable required sections · no-fabrication MUST-NOT · a self-check), and deliberately task-
agnostic so the appended node prompt supplies the specifics.

**`market-research`:**
> You are a senior market-research analyst. You produce decision-grade market briefs — never a list of
> links or a thin summary. Your brief MUST cover, at minimum: (1) market sizing — TAM/SAM/SOM with the
> assumptions shown; (2) the competitive landscape — a named-competitor matrix (positioning · pricing ·
> differentiation); (3) demand signals & trends, each with a DATED source; (4) target segments & the
> buyer; (5) risks/unknowns. Cite every non-obvious claim with a dated source. MUST NOT fabricate a number
> or a source — mark anything you could not verify as UNKNOWN. Before returning, audit the brief against
> each required section; fill any that is thin or missing, then return.

**`paper-analyzer`:**
> You are a rigorous research-paper analyst. You produce a faithful, structured analysis — never a generic
> abstract paraphrase. Your analysis MUST cover: (1) the problem & the contribution claim; (2) the method,
> in enough detail that a peer could critique it; (3) key results with the ACTUAL numbers/metrics; (4) the
> experimental setup & datasets; (5) limitations the paper states AND ones you infer; (6) threats to
> validity; (7) relation to prior work. Ground every claim in a specific section/figure/quote. MUST NOT
> invent a result or a citation; flag any claim the paper asserts without evidence. Before returning, check
> every required section is present and grounded in the paper, then return.

**`interview`:**
> You are a skilled qualitative interviewer and analyst, operating in one of two modes the task names.
> CONDUCT mode → produce a focused interview guide: objective, warm-up, core questions grouped by theme,
> probes/follow-ups per question, and a wrap — covering every stated objective. SYNTHESIZE mode → from the
> transcript(s) produce: themes (each backed by verbatim quotes), saliency/frequency, contradictions, and
> actionable findings. Ground every theme in specific quotes. MUST NOT fabricate a quote or a participant.
> Before returning, verify each theme is quote-backed (synthesize) or each objective is covered (conduct),
> then return.

Seed tool lists are conservative + REAL (builtins + the existing community web tools `oc.firecrawl`/
`oc.tavily` for `market-research`; builtins for `paper-analyzer`/`interview`). The honest note: the
community/MCP tools are gateway-coupled — the actual executable wiring (an MCP server / the `openclaw`
gateway) is configured at init/run, consistent with "most tool use defined at init." A preset's tool list
is a *suggestion the author edits*, never a guarantee the gateway is up.

### 4.6 The icon path — observe surfaces the label, GUI renders the asset

Because expansion keeps `agentType` on the node, the icon needs only the label to reach the GUI through
the single data path:

1. **Template carries it.** Add `agentType?` (+ optional `display?` passthrough) to `TemplateNode`
   (`template/types.ts`) + `node.schema.ts` + `loader.ts` (mirror how `skill` is carried at
   `loader.ts:116`). This is the small real change that lets the template authoring path declare the label
   at all (§2 ⚠️). ~12 lines.
2. **observe surfaces it.** Add `agentType?: string` to `RunViewNode` (`observe/runView.ts:30`, pushed at
   `:274`) and `NodeView` (`observe/types.ts:39`) — a verbatim passthrough from the node record. ~5 lines.
   (Decision: carry only the `agentType` STRING, not the resolved display — keep the node/run-view lean;
   the GUI maps `agentType → {icon,color,label}` from `~/.piflow/agents/`.)
3. **GUI renders.** The GUI reads the preset catalog's display metadata from `~/.piflow/agents/` (via the
   global index, the same dev mechanism it already uses for the index) and renders the icon on the node
   chip / NodeHud keyed off `RunViewNode.agentType`. Pure viewer; no collected data committed.

The runner NEVER reads `display`/icon — it's inert for execution (verified-not-trusted in spirit: the
icon is cosmetic; the node's real tools/prompt are the concrete merged fields).

---

## 5. SDK / data-boundary justification (the explicit check)

- **Logic in core, data outside.** The pure `mergePreset` + the `AgentPreset` type are product-agnostic
  LOGIC (`packages/core`). The CATALOG (named types, icons, tool picks, role-prompts) is product data in
  `~/.piflow/agents/` (+ seeds bundled with the `piflow-init` skill). Nothing product-specific enters
  `packages/*` — mirrors `model-routing.ts` (logic in core) ⊥ `model-tiers.json` (data in `~/.piflow`).
- **GUI stays a static viewer.** It reads icon/label from `~/.piflow/agents/` through the global index;
  no preset data is committed into `gui/` (no `gui/public/*` catalog), per CLAUDE.md.
- **Runner stays agnostic.** Author-time expansion means the runner sees only concrete `tools`/`prompt`;
  it carries `agentType` as an opaque label and never resolves a preset. Zero new runtime coupling.

---

## 6. Reconciliation with §G6 + the journal extension point

- §G6 proposed "resolve agentType at instantiate time and merge its tools/model/prompt into the node
  envelope." We **adopt** the merge, **at author/instantiate time** (init), and **drop model** from it
  (G1 owns model). So §G6's "go further than PDW: bind real MCP/community per agentType" is satisfied —
  the merged node's `tools.allow` can include `mcp.*`/`oc.*`, compiled by the existing pipeline (§2).
- **The journal G1/G6 fold-in (`journal.ts:90-104`) becomes mostly moot.** Because expansion bakes the
  preset into concrete `tools`/`prompt` BEFORE the runner, the envelope hash already flips when those
  change (it hashes the resolved tools + realized prompt at `journal.ts`/`runner.ts:1213-1227`). The raw
  `agentType` string is still hashed (`journal.ts:104`) so renaming the label alone re-keys the node; we
  can keep that or drop it (a cosmetic label change arguably should NOT force a re-run — see open decisions).

---

## 7. Edge cases & failure modes

- **Unknown `agentType`** → `piflow-init` HALTS at author time and reports the missing preset; never
  silently no-ops or invents a bundle (4.4). The runner never sees an unresolved label because expansion
  already ran.
- **Preset + node tool conflict** (preset allows X, node denies X) → deny wins (4.3 rule); the merged node
  drops X. Deterministic, testable.
- **Preset sets model/tier** (a non-seed/custom preset) → ignored as a model source in v1 (lowest-
  precedence fallback only); seeds never trip this. Honors decision #3 without breaking the format.
- **`agentType` on a checkpoint node** (G5, no `pi` spawn) → expansion still sets the label + icon; the
  merged tools/prompt are inert (a checkpoint spawns no model), but the GUI still brands the node. Harmless.
- **GUI catalog missing an icon key** → the GUI falls back to a default node chip (no crash); the icon is
  cosmetic, so a missing asset never blocks a run or a view.
- **Author skips presets** → nothing happens; `agentType` is undefined, observe carries nothing, the node
  renders with the default chip. The common path stays zero-cost.
- **Re-init / re-expand** → expansion is idempotent if the init agent expands from the ORIGINAL authored
  intent, not a previously-expanded node (else the role-prompt would double-prepend). Contract note in 4.4:
  expand once from the author's `agentType` + raw task prompt; re-runs start from the same intent.

---

## 8. Test plan — tests that FAIL when the design is wrong

Split by artifact type (per `test-discipline`: pure logic → unit; agent prose → eval; schema → validation).

**Core unit (pure `mergePreset` — the load-bearing logic):**
1. **Additive tools**: preset allow `[fs:read, oc.firecrawl:firecrawl_search]`, node allow
   `[mcp.github:create_issue]` → merged allow is the UNION (all three), order-stable, deduped. FAILS if a
   node replaces (loses the preset's) or a preset replaces (loses the node's).
2. **Deny wins**: preset allow `[oc.tavily:tavily_search]`, node deny `[oc.tavily:tavily_search]` → merged
   allow does NOT contain it; merged deny does. FAILS if deny is dropped or allow leaks the denied tool.
3. **Prompt is role-then-task**: merged prompt === preset.prompt + sep + node.prompt (role FIRST). FAILS if
   reversed or either side is lost.
4. **model/tier never sourced from preset**: preset with `model: "x"`, node with no model → merged
   `model` is undefined (NOT "x"). FAILS if the preset's model leaks onto the node (violates decision #3).
5. **agentType label retained**: merged node carries `agentType === preset.id`. FAILS if the label is
   stripped (the GUI would lose the icon).
6. **skill fallback**: node.skill set → kept; node.skill unset + preset.skills `[a,b]` → merged
   `skill === a`. FAILS if the node's skill is overwritten.

**Core unit (template + observe passthrough):**
7. **Template carries agentType**: a `node.json` with `agentType` loads into a `NodeSpec.agentType`
   (`loader.ts`). FAILS if the loader drops it (today it would — §2 ⚠️ — so this test guards the new wiring).
8. **observe surfaces agentType**: build a run-view over a node record with `agentType` → `RunViewNode
   .agentType` (and `NodeView.agentType`) present. FAILS if absent (the GUI could never render the icon).

**Eval (agent-facing prose — NOT unit tests):**
9. **Init expansion contract** (eval over `piflow-init`): given a node with `agentType: market-research`
   and a task prompt, the authored `node.json` has the merged tools, the role-prepended prompt, a kept
   `agentType` label, and a model chosen by init (not the preset). And: unknown agentType → HALT.
10. **Canonical role-prompts hit their bar** (eval per preset): a node expanded from each seed, run on a
    representative task, produces output covering the preset's required sections (market sizing/competitor
    matrix/…; method/results-with-numbers/…; quote-backed themes/…) with no fabricated source/result/quote.

**Schema validation:**
11. A seed `<id>.md` frontmatter validates against the `AgentPreset` schema; `model`/`tier` empty is valid;
    an unknown tool address in `tools.allow` is caught by the existing bind-check at run time
    (`runner.ts:765`), not silently bound.

---

## 9. Files to touch — checklist (change · rough size)

**packages/core (LOGIC only — small):**
- `src/workflow/agent-preset.ts` — NEW: `AgentPreset` type + pure `mergePreset(preset, node)` + a markdown-
  frontmatter parser for `~/.piflow/agents/<id>.md` (READ-ONLY adapter, mirrors `loadModelTiers`,
  `model-routing.ts:103`). ~70 lines.
- `src/workflow/template/types.ts` — `TemplateNode.agentType?` (+ optional `display?` passthrough). ~4 lines.
- `src/workflow/template/schema/node.schema.ts` — `agentType` string + optional `display` object;
  `additionalProperties:false` kept. ~10 lines.
- `src/workflow/template/loader.ts` — carry `agentType` into the spec (mirror `skill` at `:116`). ~3 lines.
- `src/observe/runView.ts` — `RunViewNode.agentType?` passthrough (push at `:274`). ~3 lines.
- `src/observe/types.ts` — `NodeView.agentType?`. ~2 lines.
- (Optional) `src/index.ts` — export `AgentPreset` / `mergePreset` for the init tooling. ~2 lines.

**product data (NOT in packages):**
- `~/.claude/skills/piflow-init/references/agent-presets/{market-research,paper-analyzer,interview}.md` —
  the 3 seed presets (frontmatter + role-prompt bodies from §4.5). bundled with the authoring skill.
- (materialized at init into) `~/.piflow/agents/*.md` — the global, user-extensible catalog.

**piflow-init skill:**
- the §4.4 expansion contract + the seed-materialize step + the icon-key convention. (skill edit; eval-gated)

**gui:**
- read `~/.piflow/agents/` display metadata (via the global index dev mechanism) + render the icon on the
  node chip / NodeHud keyed off `RunViewNode.agentType`; default chip when absent. ~40 lines.
- a small bundled icon set keyed by the `icon` strings the seeds use (`chart-trend`, etc.). assets only.

---

## 10. Open decisions

1. **`mergePreset` in core vs expansion purely in the init agent's head.** Recommended: the **pure utility
   in core** (testable, reusable, leaves a clean seam for a future runtime fallback) — the init agent calls
   it. Alternative: no core function; the init agent merges by hand (zero core code, but the additive rule
   is then untested prose). Recommend the utility.
2. **Hash the `agentType` label?** Today `journal.ts:104` hashes the raw string. Since expansion bakes the
   substance in, a label rename is cosmetic. Recommended: **drop the label from the envelope hash** (a
   rename shouldn't re-run a node); keep only the resolved tools/prompt in the hash. Open.
3. **Carry resolved `display` on the node vs GUI resolves from `~/.piflow/agents/`.** Recommended: **GUI
   resolves** (lean node/run-view; display is pure product data). Alternative: bake `display` onto the node
   at author time (simpler GUI, heavier node). Recommend GUI-resolves.
4. **Seed home: skill references vs `~/.piflow/agents/` only.** Recommended: **both** — ship seeds with the
   `piflow-init` skill (version-controlled) and materialize into `~/.piflow/agents/` on init (so the GUI +
   user edits have one home). Open: whether to overwrite a user-edited seed on re-init (recommend: never
   overwrite — only create-if-absent).
5. **Icon delivery.** Recommended: an `icon` KEY in the preset that the GUI maps to a bundled asset (never
   a filesystem path into the SDK or a committed binary in the repo). Open: the starter icon set.

---

## ⚠️ Discrepancies (referenced claim ≠ reality)

- **§G6 "field exists, no binding (`types.ts:31`)" is understated for templates.** `NodeSpec.agentType`
  exists (`types.ts:31`) but the TEMPLATE format has **no** `agentType` field — `TemplateNode` only has
  `prompt.skill` (`template/types.ts:19`; `node.schema.ts:42`; `loader.ts:116`). So on the primary
  (template) authoring path the field doesn't exist at all; it's reachable only via `extract.ts:152`. The
  design adds the template field (§4.6, §9).
- **§G6 / sequencing "fold agentType into G4's envelope hash."** With author-time expansion this is mostly
  moot (§6): the resolved tools/prompt already drive the hash (`runner.ts:1213-1227`); only the raw label
  is separately hashed (`journal.ts:104`), which open-decision #2 may drop.
- **observe field count.** `RunViewNode` (`observe/runView.ts:30`) and `NodeView` (`observe/types.ts:39`)
  confirmed to carry NO `agentType` today; the design adds it.

---

## Self-check (Required bar — PASS/FAIL + evidence)

1. **Every existing-code claim cites a file:line read** — **PASS**. types.ts:31/162/560,
   runner/journal.ts:90-104, workflow/extract.ts:32-152, template/types.ts:19, node.schema.ts:42,
   loader.ts:116, tools/{registry.ts:69,compile.ts:241}, runner.ts:{765,872-875,896-905,1213-1227},
   model-routing.ts:{66,93-103}, tool-bridge/{index.ts:62,address.ts:41}, observe/{runView.ts:30,274,
   types.ts:39}, vendor/.../agent-registry.ts:14-17 — all read this session; mismatches in ⚠️.
2. **Honors the locked decisions (author-time · thin · no model/tier · additive · icon-headline)** —
   **PASS**. §4.3 merge rule (additive tools, role-then-task prompt, model/tier never from preset), §4.1
   format (empty model/tier slots), §4.6 icon via observe, §4.4 expansion-at-init.
3. **SDK/data boundary explicitly satisfied** — **PASS**. §5: logic (mergePreset) in core, catalog/icons in
   `~/.piflow/agents/` + skill, GUI a viewer, runner agnostic; parallels model-routing ⊥ model-tiers.
4. **Agent-facing prose meets the prompt-design bar** — **PASS**. §4.4 init contract (read-this→write-that,
   HALT-on-unknown failure path, scope fence "presets are a starting point"), §4.5 role-prompts (role +
   observable required sections + no-fabrication MUST-NOT + self-check), per `agentic-prompt-design`.
5. **Test plan names seams that FAIL on a specific break** — **PASS**. §8: unit (additive/deny-wins/role-
   order/no-model-leak/label-kept/skill-fallback/loader/observe), eval (init expansion + role-prompt bars),
   schema validation — each fails on a named wrong behavior.
6. **Reconciled honestly with §G6 (incl. what becomes moot)** — **PASS**. §3 + §6 + ⚠️: adopt merge,
   diverge to author-time, drop model, journal fold-in mostly moot.

**Must-NOT audit**: no source edited (this doc is the only Write); no invented line numbers (every cited
line verified, mismatches recorded in ⚠️); no product data placed in `packages/*` (catalog/icons live in
`~/.piflow/agents/` + the init skill; only pure logic lands in core).
