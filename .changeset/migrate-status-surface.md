---
"@piflow/server": patch
---

Surface server-orchestrated migration failures. `POST /api/migrate` previously returned a fire-and-forget
202 and swallowed any post-spawn failure (the freeze never landing, the target adopt returning 403, or the
spawn erroring). The child's stderr + exit code are now captured into a bounded per-run outcome map, exposed
via a new `GET /api/migrate/status?run=<run>` — so a client learns a migration FAILED instead of only ever
seeing "the run never appeared on the target". The happy-path 202 and migrate transport are unchanged.
