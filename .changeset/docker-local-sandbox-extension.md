---
"@piflow/docker": minor
"@piflow/cli": patch
---

Add `@piflow/docker` — the LOCAL Docker-container sandbox backend, packaged as a choose-to-install extension (`npm i @piflow/docker`; the CLI loads it dynamically on `--sandbox docker`). One local Docker container per run (per-node workdir subtrees, removed once) behind `@piflow/core`'s existing sandbox seam, booting the SAME pi node-runtime image the cloud backends use (from the shared `deploy/pi-runtime` spec). It is the OFFLINE, FREE mirror of the Daytona/E2B path — same image, same credential injection (a container is a `CLOUD_KIND`: no host env, creds cross via the declared allowlist, `~/.pi/agent/models.json` staged in), same tool binding — NOT a stronger isolation tier than `--sandbox local` seatbelt.

Zero setup: `--sandbox docker` is a single line — the pi node-runtime image is AUTO-BUILT on first use from an embedded Dockerfile (generated from the shared spec, drift-gated), `docker build -t <tag> -` with an empty context. Talks to the `docker` CLI only (no daemon-client dependency); the provider is dependency-free, unit-tested against a fake SDK, and proven end-to-end against a real daemon (`deploy/docker/smoke-live.mjs`).
