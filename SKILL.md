---
name: piflow
description: >-
  Pi Flow — author, enhance, and run structured filesystem-coordinated workflows (a DAG of producer/verify
  nodes) as a fleet of efficient pi agents driven by non-Claude coding-plan models, with Claude Code as the
  single console. This is the plugin OVERVIEW/router; the work lives in three skills — piflow-init (create),
  piflow-enhance (improve), piflow-start (run). Source of truth is a structured workflow TEMPLATE; the
  `@piflow/core` SDK loads it and runs one `pi` per node.
---

# Pi Flow — the plugin overview (router)

**One-line model:** a **structured workflow template** (`.piflow/<wf>/template/`) is the single source of
truth; the **`@piflow/core` SDK** loads it into a `WorkflowSpec` and runs it one efficient `pi` per node, while
Claude Code owns the graph and monitors. A Claude `.js` is an optional one-time INGEST seed, discarded after.

This repo IS the `@piflow/core` product repo AND the **piflow** plugin. The agent-facing work is split into
three skills (each invokable on its own):

| Skill | Role | Status |
|---|---|---|
| **piflow-init** | CREATE a workflow: triage the source (PORT a `.js` / IMPORT n8n / COMPOSE) → build the `template/` → stand up the per-repo runner. **The bulk — start here.** | full |
| **piflow-enhance** | IMPROVE a running workflow: the `hermes-skill-system` capture→route→edit→verify→approve loop, the criteria fixture, Companion Mode. | stub (scope declared) |
| **piflow-start** | RUN & monitor a workflow on the pi fleet: dry-run → live → `piflowctl logs`. | stub (scope declared) |

→ The skills live at `.claude/skills/{piflow-init,piflow-enhance,piflow-start}/` and are symlinked into
`~/.claude/skills/` for global availability. **For anything substantive, load `piflow-init`** — it carries the
model, the standing-up steps, the laws, Companion Mode, and the node-I/O design craft.

## Product repo map (paths relative to this repo root, `~/Desktop/piflow`)
- `packages/core` — **`@piflow/core`**, the engine (installed, not copied): `runWorkflow`/`compile`, the
  contract codec, `runHooks`, the sandbox providers, the tool registry, the `piflow` bin + observability.
- `reference/` — the deep specs (sdk-consumer · observability · cli · architecture · artifact-contract ·
  escalation · orchestration · worktree-isolation · read-scope-sandbox · provider-and-headless).
- `docs/` — the design canon (`docs/INDEX.md`); the keystone is `docs/design/template-format.md` (D8) +
  `docs/design/sdk-canonical-build-plan.md` (D1–D9 + the U-unit table).
- `templates/` — `pi-runner/` (the SDK consumer to copy into a repo), `models.json.example`,
  `workflow-snippets/`, `legacy/` (the archived pre-SDK monolith — do not build on it).
- `.tasks/` — session-continuation handoffs (the latest carries the current build state).
