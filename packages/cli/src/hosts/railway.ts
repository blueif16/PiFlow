// The Railway host adapter — the SAME control-VM image on Railway's builder (design:
// docs/design/control-plane-hosting-uniform.md §4-railway). `railway up --ci` builds the identical
// `deploy/control-vm/Dockerfile` server-side (streaming until the deploy finishes); the host only supplies
// secrets (as service variables) + a public domain, exactly like fly. It owns the same leaks the MAP found:
// the `.up.railway.app` URL shape (`appUrl`), the argv of its provider-CLI steps, and its render tag.
//
// Everything else — the .dockerignore copy/rm dance (railway's builder reads a repo-root Dockerfile +
// .dockerignore, same as fly) and the secrets-set redaction — comes from the SHARED step factories in
// `cloud.ts`, so redaction lives in exactly one place across all hosts. `secretsSetStep` builds the
// `NAME=VALUE` pairs (secrets `***`-redacted in the display, the labeled non-secret gateway config shown as
// `<gateway:…>`) and hands them to a railway-shaped argv (`railway variables --set K=V …`).
//
// Dockerfile targeting (LEARNED THE HARD WAY): `railway up` has no `--dockerfile` flag, and the build runs on
// Railway's SERVER-SIDE Metal builder — a local process env is invisible to it. So the Dockerfile path must be
// a persisted SERVICE variable (`RAILWAY_DOCKERFILE_PATH`, the `dockerfile-path` step) set BEFORE `railway up`.
// Without it Railway ignores our non-root monorepo Dockerfile and falls back to Railpack (Node auto-detect),
// which fails with "No start command detected." And the deploy uses `--ci` so it WAITS for the build and exits
// non-zero on failure (bare `railway up` returns on upload in a non-TTY spawn; `--detach` never waits).

import type { HostAdapter } from './adapter.js';
import { copyDockerignoreStep, rmDockerignoreStep, secretsSetStep } from '../cloud.js';

export const railwayAdapter: HostAdapter = {
  id: 'railway',
  label: 'railway',
  urlIsHostDerived: true,

  // Railway's default public origin is `https://<service>.up.railway.app` — a deterministic guess the
  // `railway domain` step confirms; an operator who already has a custom domain passes it as `--public-url`.
  appUrl: (app, { publicUrl }) => publicUrl ?? `https://${app}.up.railway.app`,

  upSteps: (c) => [
    // railway's builder reads ONLY a context-root Dockerfile + .dockerignore (same as fly) — stage then clean.
    copyDockerignoreStep(),
    // `railway variables --skip-deploys --set K=V …` stages each secret as a service variable — the SAME
    // {name,value} shape fly's `fly secrets set` takes, redacted identically via the shared factory.
    // `--skip-deploys`: setting a variable triggers a deploy by DEFAULT — we suppress it so no premature
    // (Railpack) build fires before RAILWAY_DOCKERFILE_PATH is set; the explicit `railway up --ci` deploys once.
    secretsSetStep(c, (pairs) => ['railway', 'variables', '--skip-deploys', ...pairs.flatMap((p) => ['--set', p])]),
    {
      id: 'dockerfile-path',
      kind: 'host',
      // Point Railway's SERVER-SIDE builder at the control-VM Dockerfile via a SERVICE variable. This MUST be a
      // persisted variable, not a local process env: the build runs on Railway's Metal builder, which never sees
      // the CLI's env. Without it Railway ignores our monorepo Dockerfile (it isn't at the context root) and
      // falls back to Railpack (Node auto-detect) → "No start command detected" → build fails. Not secret.
      // `--skip-deploys` for the same reason as above: set the config, don't trigger a build until `railway up`.
      command: ['railway', 'variables', '--skip-deploys', '--set', `RAILWAY_DOCKERFILE_PATH=${c.dockerfile}`],
      display: `railway variables --skip-deploys --set RAILWAY_DOCKERFILE_PATH=${c.dockerfile}`,
      outward: true,
      note: 'point Railway\'s builder at deploy/control-vm/Dockerfile (a service variable — a local env never reaches it).',
    },
    {
      id: 'deploy',
      kind: 'host',
      // `--ci`: stream the build logs then exit with the build's status. This makes `railway up` WAIT for the
      // deploy and exit NON-ZERO on a build failure (so cloud.ts's execute loop halts before the smoke). Bare
      // `railway up` returns on upload in a non-TTY spawn, and `--detach` never waits — either fires the smoke
      // at a not-yet-live service and swallows build failures. Parity with `fly deploy`'s synchronous build.
      command: ['railway', 'up', '--ci', '--service', c.app],
      display: `railway up --ci --service ${c.app}`,
      outward: true,
      paid: true,
      note: 'the operator\'s paid step — builds deploy/control-vm/Dockerfile on Railway + deploys, streaming until done (--ci).',
    },
    {
      id: 'domain',
      kind: 'host',
      command: ['railway', 'domain'],
      display: 'railway domain',
      outward: true,
      idempotent: true,
      note: 'ensures a public https domain; copy it into --public-url if the smoke URL was a guess.',
    },
    rmDockerignoreStep(),
  ],

  downSteps: () => [
    {
      id: 'railway-down',
      kind: 'host',
      command: ['railway', 'down', '--yes'],
      display: 'railway down --yes',
      outward: true,
      note: 'DESTRUCTIVE — removes the service deployment.',
    },
  ],
};
