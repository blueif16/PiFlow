// The Docker host adapter — a generic `docker run` of the SAME control-vm image ANYWHERE (any box with
// docker); the operator brings the public origin (their reverse proxy / TLS) via `--public-url`
// (design: docs/design/control-plane-hosting-uniform.md §4-docker).
//
// It is the free/offline sibling of the fly pathway: same `deploy/control-vm/Dockerfile`, same minted
// secrets, same smoke — only the build/run/rm argvs differ, and the origin is user-supplied rather than
// host-derived (`urlIsHostDerived: false`). The `-e NAME=VALUE` secret args are composed via the SHARED
// `envRunStep` factory from `cloud.ts`, so redaction (real value in `command`, `***` in `display`) lives in
// exactly one place across all hosts and can never be hand-inlined into a raw step's display.

import type { HostAdapter } from './adapter.js';
import { envRunStep } from '../cloud.js';

export const dockerAdapter: HostAdapter = {
  id: 'docker',
  label: 'docker',
  // The operator fronts the container with TLS/routing and passes the resulting origin as `--public-url`;
  // docker can't manufacture a stable HTTPS URL, so `--execute` without one fails fast (cloud.ts guard).
  urlIsHostDerived: false,

  // The operator brings the public origin; PLAN mode without it uses a localhost:<port> placeholder.
  appUrl: (_app, { publicUrl, port }) => publicUrl ?? `http://127.0.0.1:${port}`,

  upSteps: (c) => [
    {
      id: 'build',
      kind: 'host',
      command: ['docker', 'build', '-f', c.dockerfile, '-t', `${c.app}:latest`, '.'],
      display: `docker build -f ${c.dockerfile} -t ${c.app}:latest .`,
      // building locally spends nothing + hits no provider — unlike fly/railway deploy it is not outward.
      outward: false,
      note: 'builds the SAME control-vm image locally (no provider, no spend).',
    },
    // Secrets ride `docker run -e NAME=VALUE`: REAL values in `command`, `***` in `display`, via the shared
    // helper so redaction is centralized. `-p <port>:8080` publishes the image's 8080 on the host port the
    // operator proxies; `--name <app>` makes teardown (`docker rm -f <app>`) idempotent by name.
    envRunStep(
      'run',
      c,
      (envArgs) => ['docker', 'run', '-d', '--name', c.app, ...envArgs, '-p', `${c.port}:8080`, `${c.app}:latest`],
      {
        outward: true,
        note: 'runs the image; the operator fronts it with TLS + passes the origin as --public-url.',
      },
    ),
  ],

  downSteps: ({ app }) => [
    {
      id: 'docker-rm',
      kind: 'host',
      command: ['docker', 'rm', '-f', app],
      display: `docker rm -f ${app}`,
      outward: true,
      // `docker rm -f` on an absent/stopped container is tolerable — execute-mode continues (already gone).
      idempotent: true,
      note: 'stops + removes the container (idempotent — a no-op if already gone).',
    },
  ],
};
