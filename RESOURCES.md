# OpenClaw and Hermes Agent Resources

## Knowledge

- [OpenClaw README](vendor/openclaw/README.md)
  Product overview, installation path, supported channels, security model, and source-development loop. Use for first-pass orientation.
- [OpenClaw AGENTS.md](vendor/openclaw/AGENTS.md)
  Maintainer rules, architecture boundaries, commands, and review expectations. Use before interpreting why the repo is shaped around core/plugin separation.
- [OpenClaw package manifest](vendor/openclaw/package.json)
  CLI package metadata, published files, and command surface. Use for understanding how the source checkout becomes the `openclaw` package.
- [OpenClaw workspace config](vendor/openclaw/pnpm-workspace.yaml)
  Workspace membership and dependency policy. Use when tracing package, UI, and extension boundaries.
- [OpenClaw gateway architecture](vendor/openclaw/docs/concepts/architecture.md)
  Local concept doc for the Gateway, WebSocket control plane, clients, nodes, events, and gateway invariants.
- [OpenClaw agent runtime](vendor/openclaw/docs/concepts/agent.md)
  Local concept doc for the embedded runtime, agent workspace, bootstrap files, skills, tools, and session store.
- [OpenClaw session management](vendor/openclaw/docs/concepts/session.md)
  Local concept doc for how messages map to sessions, how isolation works, and where session state lives.
- [OpenClaw gateway runbook](vendor/openclaw/docs/gateway/index.md)
  Operational view of the Gateway process, port, auth boundary, OpenAI-compatible HTTP endpoints, and service lifecycle.
- [Hermes README](vendor/hermes-agent/README.md)
  Product overview, install path, CLI/gateway quick reference, documentation map, and OpenClaw migration path. Use after the OpenClaw orientation lesson.
- [Hermes AGENTS.md](vendor/hermes-agent/AGENTS.md)
  Design intent for prompt caching, narrow core surface, plugins, skills, and contribution review. Use before comparing Hermes to OpenClaw.
- [Hermes Python project metadata](vendor/hermes-agent/pyproject.toml)
  Runtime requirements, exact-pinned core dependencies, optional extras, and supply-chain policy. Use for the Hermes architecture lesson.
- [Hermes package manifest](vendor/hermes-agent/package.json)
  JavaScript workspace helpers for web, TUI, and desktop surfaces. Use when comparing polyglot packaging to OpenClaw's pnpm workspace.

## Wisdom (Communities)

- [OpenClaw Discord](https://discord.gg/clawd)
  Community linked from the OpenClaw README. Use for maintainer/operator context after source-level questions are clear.
- [Nous Research Discord](https://discord.gg/NousResearch)
  Community linked from the Hermes README. Use for Hermes operator and contributor context after local-source study.

## Gaps

- No Hermes lesson has been written yet. Finish the OpenClaw navigation track first, then create a Hermes entry-point lesson from `vendor/hermes-agent/README.md`, `vendor/hermes-agent/AGENTS.md`, and `vendor/hermes-agent/pyproject.toml`.
