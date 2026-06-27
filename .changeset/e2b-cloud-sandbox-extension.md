---
"@piflow/e2b": minor
"@piflow/cli": patch
---

Add `@piflow/e2b` — the E2B open-egress cloud-sandbox backend, packaged as a choose-to-install extension (`npm i @piflow/e2b`; the CLI loads it dynamically on `--sandbox e2b`). One long-lived E2B sandbox per run (per-node workdir subtrees, killed once) behind `@piflow/core`'s existing sandbox seam; egress is open by default — the unblock for heterogeneous/remote MCP that Daytona's tier-gated egress can't serve. Establishes the providers-are-extensions pattern (Daytona stays in core for now).
