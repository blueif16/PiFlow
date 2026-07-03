---
"@piflow/core": minor
---

The skill `requires` floor is now ENFORCED at run time (previously dormant).

A pre-pass at runner entry (`runFromTemplate` + `runFromConfig`, before tool resolution) locates
each node's bound skill, parses its manifest, and unions the deny-filtered `requires` list into
the node's effective `tools.allow`. Consequences:

- A skill that declares `requires: [..., mcp.<server>:<tool>]` no longer runs silently without
  that tool: if the MCP catalog doesn't provision it, the node ends **blocked** at the pre-spawn
  bind check (before pi spawns). Fix: `piflowctl catalog sync` / `catalog introspect <server>`.
- A manifest violating `requires ⊆ allowed` now fails the run at start with the parser's message.
- Nodes without a skill, and skills that don't resolve, are byte-identical to before (the
  runner's loud skill-missing issue remains the resolution failure path).
