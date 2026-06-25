# Agent-type presets — the author-time expansion contract (G6)

A **preset** is a thin, optional, branded starting point an author can drop onto a node: a few canonical
skills + a base tool set + a canonical role-prompt + a `display` (icon/label/color). It is **not** a
capability gate — per-node customization always wins, and most real tool/model wiring is still authored per
node. Presets exist to save retyping a canonical bundle and to brand a node with a purpose-built icon.

Design source of truth: `docs/specs/wiring-g6-agenttype.md`. The merge logic is the pure `mergePreset` in
`@piflow/core` (`packages/core/src/workflow/agent-preset.ts`); this file is the **contract `piflow-init`
follows** when an author assigns a node an `agentType`.

## Where presets live (boundary-clean)

- **Catalog (the one home):** `~/.piflow/agents/<id>.md` — global, user-extensible (parallels
  `~/.piflow/model-tiers.json`). The GUI reads each preset's `display` (icon/label/color) from here.
- **Seeds (bundled with this skill):** `references/agent-presets/{market-research,paper-analyzer,interview}.md`.
  On init, **materialize any missing seed into `~/.piflow/agents/` (create-if-absent only — NEVER overwrite a
  user-edited preset)** so the catalog is populated and the GUI can resolve icons.
- A user authors a new preset by dropping a `<id>.md` into `~/.piflow/agents/`; it is available immediately,
  same as a seed. The taxonomy is open, not fixed. Nothing preset-specific goes into `packages/*` or the GUI.

## The contract — when a node declares `agentType: <id>`

1. **Read** `~/.piflow/agents/<id>.md`. **If it is absent: HALT and tell the author the preset is unknown —
   never invent one** (and never silently drop the `agentType`).
2. **Expand it with `mergePreset(preset, node)`** and WRITE THE RESULT into the template `node.json`, so the
   template on disk is self-contained:
   - `tools.allow` = the preset's base **UNION** the node's `allow` (ADDITIVE); `tools.deny` = the union of
     both denies, and any denied address is removed from `allow` (**deny wins**).
   - `prompt` = the preset's role-prompt body, then `\n\n`, then the node's task prompt (**role first, task
     appended**).
   - `skill` = the node's own skill if it set one, else the preset's first canonical skill.
3. **KEEP `agentType: <id>` on the node** as the branding label — do NOT strip it. The loader carries it
   through `observe` so the GUI renders the preset's icon on the node.
4. **Decide the node's `model` / `tier` yourself** per the run's needs. **The preset contributes NONE** — G1
   owns per-node model/provider/tier (`runner/model-routing.ts`). `mergePreset` never sources a model from a
   preset, even if a custom preset sets one.
5. **Tell the author, in one line,** exactly what the preset contributed (its base tools + role-prompt + icon)
   and that everything is now editable per node — a preset is a starting point, not a lock-in.

**The author may always skip presets entirely** and wire `tools` / `prompt` / `model` by hand; that is the
common path. Do not push an `agentType` onto a node that did not ask for one.

## Idempotence (re-init / re-expand)

Expand **once, from the author's original `agentType` + raw task prompt** — never re-expand an
already-expanded node (the role-prompt would double-prepend). On a re-init, start from the same authored
intent, not the previously merged `node.json`.

## The icon-key convention

`display.icon` is an icon **KEY** (e.g. `chart-trend`, `file-search`, `messages`), never a filesystem path
into the SDK and never a committed binary. The GUI maps the key to a bundled asset and falls back to the
default node chip when a key is unknown — the icon is cosmetic and never blocks a run or a view. When you add
a new preset, pick an icon key the GUI's bundled set already provides, or add the asset on the GUI side.

## Authoring a new preset (the format)

Frontmatter + a role-prompt body. Keep the frontmatter within this subset (the core parser is intentionally
small): top-level `key: value`, one nested level under `display:`/`tools:`, inline arrays `[a, b]`, and
quoted/bare scalars. Leave `model:` / `tier:` empty — presets never set them.

```markdown
---
id: <kebab-id>
display:
  label: <Human Label>
  icon: <icon-key>
  color: "#rrggbb"
skills: [<canonical-skill>]
tools:
  allow: [fs:read, fs:write, oc.firecrawl:firecrawl_search]
model:
tier:
---
<the canonical role-prompt body: role + standard + enumerable required sections + a no-fabrication MUST-NOT
+ a mandatory self-check against each required section — see the three seeds for the bar>
```

The role-prompt is **reusable and task-AGNOSTIC** — it sets the role and the bar; the node's specific task is
appended below it at expansion. A preset's tool list is a *suggestion the author edits*, not a guarantee the
gateway (an MCP server / the `openclaw` gateway) is up — an unbound address is caught at run time by the
existing bind-check, never silently bound.
