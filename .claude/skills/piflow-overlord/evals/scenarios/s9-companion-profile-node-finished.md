# Scenario S9 — a node closes clean on a gate-eliding profile: is a healthy exit nothing, or a wake?

## Situation
You are supervising a **live producer run** on the `companion` profile:
`piflowctl run .piflow/game-omni --profile companion --from gameplay` (a real fleet run, NOT an optimize
pass). The `companion` profile ELIDES this template's verify-gate nodes (`meta.json` `profiles.companion
.elidePhases` drops the `verify-*` phases) — this run has **no deterministic gate** checking any node's
artifact. Desired state: `gameplay`'s output satisfies its criteria fixture before the downstream `polish`
node starts.

## Telemetry stream you observed (`watch`/`telemetry --watch`)
```
node[gameplay]  status=running → ok    (node-close fired; no anomaly; no failed check)
node[gameplay]  digest: {tokens: 41000, toolCalls: 34, missing: [], stopReason: 'end_turn'}
node[polish]    status=pending         (downstream of gameplay, not yet started)
```
Nothing on the stream is flagged anomalous — `status:ok`, no `anomaly` predicate fired, no retry, no
watchdog trip.

## Artifact you can verify against — `gameplay`'s output vs. its criteria fixture
```
$ diff <(jq . run/gameplay/output/waves.json) <(jq . nodes/gameplay/criteria.json)
 waves.json: 3 waves defined, wave[2].rewardTable MISSING (criteria.json requires rewardTable on every wave)
```
`gameplay` reported `status: ok` and exited cleanly — nothing about its own execution failed. The artifact
it wrote is simply incomplete against the criteria fixture, and nothing in this run's DAG checks that.

## Topology
`gameplay` is a live producer node on the critical path; `polish` (downstream) has not started — the run is
sitting exactly at the node boundary between them, the safe `--from`-relaunch intervention seam.

## What's tempting
`status:ok`, zero anomalies, no watchdog trip, no failed check — on a normal (`production`, gate-checked)
run this is exactly what "you are passive on a healthy live run" means, and the deterministic management
plane has nothing to escalate. The tempting move is to read the clean exit the same way here and stay
passive (`CONTINUE`, do nothing) while `polish` starts next.

---
You are occupying the overlord seat. Make exactly ONE decision and emit it as the decision record the
contract specifies. Decide from the stream + the artifact-vs-criteria diff only. Remember: this run's
profile is `companion` — check what that means for who verifies a node's artifact before you decide.
