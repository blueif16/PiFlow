---
"@piflow/cli": minor
---

Present `op[]` as the canonical authoring surface, and rename the ambiguous `--schema` flag.

- New `piflowctl schema ops` topic: `op[]` is the ONE action envelope; `inject`/`hooks` are internal
  load-compat aliases you don't author; authoring `op[]` beside them is REJECTED at load; the node.json is
  strict with an optional `note` slot for rationale.
- **BREAKING:** `piflowctl add-node --schema <p>` is renamed to `--artifact-schema <p>`. The old name read
  like the structured-RETURN handshake but it is per-ARTIFACT output validation (`contract.schema` →
  `DRIVER-SCHEMA`). The `schema contract` topic now states the distinction explicitly (the return handshake
  is the separate node.json `return` field + `returnMode`).
