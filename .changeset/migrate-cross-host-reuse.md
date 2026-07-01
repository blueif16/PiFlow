---
"@piflow/core": patch
---

Fix cross-host run migration reuse. A run resumed on a different host/path now REUSES its
already-completed nodes instead of re-running the whole done prefix. The resume identity hash
(`envelopeHashOf`) previously embedded the absolute `{{RUN}}`/`{{WORKSPACE}}` path, so any
migration to a new filesystem path flipped every completed node's envelope hash and invalidated
journal reuse — defeating the freeze→bundle→adopt contract ("done nodes reused, the tail runs").
The hash now keeps `{{RUN}}`/`{{WORKSPACE}}` as tokens; only `{{state}}`/`{{arg}}` (true identity)
resolve. Same-path resume is unaffected.
