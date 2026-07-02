---
"@piflow/cli": minor
---

`piflowctl context` is now a two-axis switch — WHERE the control plane runs (`host`) and WHERE
nodes run (`worker`) — that unifies the previously-separate `--sandbox` setting. A context's
`worker` IS the sandbox (`WorkerKind ⊂ SandboxChoice`), so there is ONE setting: `--sandbox`
becomes the LEGACY per-run override of the persistent `context worker` (precedence
flag > context-worker > `inmemory` default; the plain local context keeps `inmemory` for
back-compat).

- `context use <name>` switches the whole bundle and prints the cascaded worker; a CLOUD control
  plane can't reach a laptop-local sandbox, so switching to a cloud context auto-promotes the
  worker to the top set-up cloud sandbox (`e2b > daytona`).
- `context host use <kind>` / `context worker use <kind>` are escape hatches to set one axis;
  `worker use` rejects an incompatible local-under-cloud pick.
- SETUP-ON-MISS: switching to a not-yet-provisioned host or an unconfigured cloud worker prints
  the exact setup command instead of a bare error — including `selfhost` = the free
  `piflowctl serve` + Cloudflare quick-tunnel path.
- `docker` is deferred from the worker cascade (ambiguous local-vs-cloud); `--sandbox docker`
  still works as a per-run override.
