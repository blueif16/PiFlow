---
"@piflow/core": minor
"@piflow/cli": minor
---

Make `--sandbox local` actually enforce the Linux jail, and refuse rather than degrade.

Two reproduced bugs (verified live on an E2B Debian microVM) are fixed and the posture is now fail-closed:

- **Probe false-negative on merged-usr Linux (Debian/Fedora).** The bwrap capability probe bound only `/usr`,
  so `true` couldn't find its ELF loader (`/lib64` + the `/lib` symlink chain) and the probe exited 1 — a
  false negative that silently dropped `--sandbox local` to UNSANDBOXED even though the jail works. The probe
  now binds the whole root read-only (`--ro-bind / /`), a distro-agnostic capability check.
- **Private `/tmp` shadowed a `/tmp`-nested write lane.** `buildBwrapArgs` emitted `--tmpfs /tmp` after the rw
  binds and also bound the bare host `/tmp`, so a write lane under `/tmp` was overmounted by the tmpfs
  (`Can't chdir …`). The tmpfs is now laid down first (an under-`/tmp` lane overlays it and survives) and the
  bare host `/tmp` is no longer bound (the tmpfs is the private writable `/tmp`).
- **Fail-closed (BREAKING).** When read-scope enforcement is requested but no kernel jail backend is available
  (unsupported OS, or Linux without a usable bubblewrap), `LocalSandbox.exec` now REFUSES — it returns a
  failure result without running the command, instead of silently running it unsandboxed. The only way to run
  unsandboxed is the explicit `--sandbox danger-full-access`. A `--sandbox local` run on a host with no usable
  jail backend now fails loudly; install bubblewrap + allow unprivileged user namespaces, or opt out with
  `--sandbox danger-full-access`.
