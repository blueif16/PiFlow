---
"@piflow/core": patch
"@piflow/cli": patch
---

Observe read-path resilience: recover a starved node's telemetry from pi's native session, and parse `logs` positionals correctly.

Two already-merged read-path fixes for a pi node whose stdout tee (`events.jsonl`) carried no model turns even though pi persisted a full native session (run 260715-02/plan: a 688KB session read back as 0 calls / 0 tokens):

- **Session-recovery backfill (telemetry).** When the event replay yields no usage AND the executor left no authoritative usage rollup (pi never sets one), `buildRunView` locates the node's `<ISO-ts>_<sessionId>.jsonl` by suffix and transcodes its `message`/content vocabulary through the same reducer a live run uses, so recovered tokens/calls are byte-identical. Read-only — the audit ledger stays true to `events.jsonl`.
- **`logs` positional parsing.** `piflowctl logs <rundir> [nodeId]` now binds its positionals the same way `status`/`telemetry`/`trace` do (the last positional no longer clobbers the run dir), and `--help` is honored.
