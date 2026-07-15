---
"@piflow/core": patch
"@piflow/cli": patch
---

Fix the WRITE-path starvation behind session-only nodes, and recover `logs --summary` + `trace` from the native session.

Follow-ups to the observe read-path recovery, fixing the root cause and widening the recovery to the remaining surfaces (run 260715-02/plan):

- **Warm-resume addresses the session by PATH, not the bare id (root cause).** The L1 warm retry invoked `pi --session <nodeId>` under a per-run `--session-dir`. pi resolves a bare id by SCANNING that dir; finding the session in a foreign project dir it classifies it "different project" and prints an interactive `Fork this session? [y/N]` (or `No session found matching '<id>'`) — a prompt a headless `pi -p` cannot answer. The attempt no-ops and its fresh truncating recorder overwrites attempt-1's rich `events.jsonl` with just pi's stderr line. The runner now LOCATES the session file attempt-1 minted and passes its ABSOLUTE PATH to `--session`, which pi opens directly (no scan, no fork prompt); a bare id remains the best-effort fallback.
- **`logs --summary` / `trace` recover too.** `diagnoseRun` and the `trace` context-composition reducer read only `events.jsonl`, so a starved node showed a false `0w/0r/0t` and an empty element tree with every advertised artifact wrongly flagged a BLIND SPOT. Both now route through a shared reader that recovers the ordered stream from the native session when the archive is starved (one copy of the locate + transcode logic in `runner/pi-session`). No-op passthrough for a normally-captured archive.

Live on run 260715-02/plan: `logs plan --summary` `0w/0r/0t` → `2w/18r/31t`; `trace plan` `readFiles=0` → the real 18 reads + grep/list/bash elements.
