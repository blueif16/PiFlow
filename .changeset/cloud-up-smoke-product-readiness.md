---
"@piflow/cli": patch
---

Fix the `cloud up --execute` smoke gate so the paid go-live can actually pass (any host).
Two defects blocked it: (1) the smoke targeted the wrong id — the control-VM bakes the demo to
`/home/piflow/demo`, so its PRODUCT id is `demo`, but the smoke defaulted `PIFLOW_PRODUCT=greet`
(the WORKFLOW inside it), which `POST /api/runs/start` rejected as "no product in scope" (400) —
so the gate failed at check B on every host. `smokeStep` now passes `PIFLOW_PRODUCT` = the baked
demo product id (`CONTROL_VM_DEMO_PRODUCT`), and the smoke's own default is `demo`. (2) The execute
loop fired the smoke immediately after `railway up --detach`, which returns before the ~minutes-long
server-side build finishes → the smoke hit a not-yet-live service. The railway deploy step drops
`--detach` (blocks until the deploy is live, and exits non-zero on a build failure — parity with
`fly deploy`), and the smoke now polls the origin for reachability (`READY_TIMEOUT_MS`, default 90s)
before the ordered A→E checks so brief edge/domain propagation lag can't false-red the gate.
