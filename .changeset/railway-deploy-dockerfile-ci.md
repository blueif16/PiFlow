---
"@piflow/cli": patch
---

Fix `cloud up --host railway --execute` so the deploy actually builds our image and the smoke waits for it
(found live: the first railway go-live failed the smoke 0/7). Three railway-specific defects: (1) the Dockerfile
path was passed as a **local process env** on the deploy step, but Railway's build runs on its server-side
builder which never sees it → Railway fell back to Railpack (Node auto-detect) → "No start command detected".
It's now set as a **service variable** via a new `dockerfile-path` step (`railway variables --set
RAILWAY_DOCKERFILE_PATH=…`). (2) The deploy used bare `railway up`, which returns on upload in a non-TTY spawn
(before the server-side build) and swallows build failures → now `railway up --ci` (stream-then-exit: waits for
the build, exits non-zero on failure, parity with `fly deploy`). (3) Setting variables triggers a deploy by
default, so all `railway variables` calls now pass `--skip-deploys` (set config, deploy once explicitly). Also
hardened the smoke's readiness poll to wait for the control plane's own `200`/`401` rather than accepting a host
edge's `404`/`5xx` (Railway returns `404 "Application not found"` until a deployment is live).
