# `legacy/` — the pre-SDK monolith stack (archived reference)

> These files are the **pre-`@piflow/core` harness**: one self-contained `run.mjs` engine plus its
> bespoke monitors, sandbox profile, and provider extension. They are kept as a **parity bridge +
> reference snapshot** while the SDK consumer (`templates/pi-runner/sdk/` over `@piflow/core`) proves
> byte-for-byte parity, and are scheduled for removal once it does. **Do not build on these.** New
> projects copy `templates/pi-runner/`.

## Why they moved here

The generic engine that used to be a 153 KB `run.mjs` copied into every repo now lives once in the
**`@piflow/core`** package, consumed by the thin `templates/pi-runner/sdk/` runner. Each file below has a
named successor in the SDK world:

| Archived file | Was | Successor (SDK world) |
|---|---|---|
| `run.mjs` (153 KB) | the whole engine: extract→compile→DAG→spawn→hooks→contract→status | `@piflow/core` `runWorkflow`/`compile` + `templates/pi-runner/sdk/run.mjs` (the ~10 KB consumer) |
| `status.mjs` | one-shot / live run-status dashboard | `piflowctl logs <run> --summary` (post-run diagnosis) |
| `watch.mjs` | wake-on-event sentinel for a backgrounded run | `piflowctl logs <run> -f` (live follow); a silent-sentinel verb is a `@piflow/core` follow-up |
| `viz-model.mjs` + `tui/` | the `pi-tui` cross-project console (data layer + Ink UI) | `piflowctl logs` today; the box-and-arrow `piflowctl viz <run>` renderer over `buildModel()` is the planned successor (ROADMAP) |
| `sandbox/read-scope.sb` | the macOS Seatbelt read-scope profile run.mjs wrapped a node in | `@piflow/core` `SeatbeltSandboxProvider` / `buildSeatbeltProfile` |
| `providers/coding-plan.ts` | a custom `-e` provider impl (OAuth / non-OpenAI-compatible API) | the native `~/.pi/agent/models.json` path (canonical); a custom provider stays an opt-in `-e` |

## Caveat

`run.mjs`'s relative imports (`./hooks/`, `./extensions/`, `./viz-model.mjs`, …) point at siblings that
now live under `templates/pi-runner/` or `@piflow/core`. This is an **archived snapshot for reading, not
an executable copy** — run the SDK consumer (`node pi-runner/sdk/run.mjs`) instead.
