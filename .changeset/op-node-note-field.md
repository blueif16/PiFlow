---
"@piflow/core": minor
---

Add an optional `note` affordance to `op[]` entries and the node top-level.

`node.json` objects are strict (`additionalProperties:false`), so authoring rationale — WHY a gate runs a
particular script, a KNOWN-GAP marker — had no schema-blessed home and had to live outside the file. `note`
is an optional string on each `op[]` entry and on the node top-level; it validates, rides through the loader
verbatim, and is ignored at run time (never rendered). It is the one comment slot on an otherwise strict
node.json.
