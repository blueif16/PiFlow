// The Fly.io host adapter — a refactor of the ORIGINAL `buildFlyDeployPlan` body, with every argv lifted
// VERBATIM so fly behavior stays byte-identical (design: docs/design/control-plane-hosting-uniform.md §4-fly).
//
// It owns the four Fly-only leaks the MAP found: the `.fly.dev` URL shape (`appUrl`, was `flyAppUrl`), the argv
// of the three `kind:'host'` steps + `apps-destroy`, and its render tag (`id`/`label`). Everything else — the
// .dockerignore copy/rm, the secrets-set redaction, the smoke — comes from the SHARED step factories in
// `cloud.ts`, so redaction lives in exactly one place across all hosts.

import type { HostAdapter } from './adapter.js';
import { copyDockerignoreStep, rmDockerignoreStep, secretsSetStep } from '../cloud.js';

export const flyAdapter: HostAdapter = {
  id: 'fly',
  label: 'fly',
  urlIsHostDerived: true,

  // The old `flyAppUrl(app)` — Fly gives every app `https://<app>.fly.dev` automatically.
  appUrl: (app) => `https://${app}.fly.dev`,

  upSteps: (c) => [
    copyDockerignoreStep(),
    {
      id: 'apps-create',
      kind: 'host',
      command: ['fly', 'apps', 'create', c.app],
      display: `fly apps create ${c.app}`,
      outward: true,
      idempotent: true,
      note: 'first deploy only — skipped (reported, not failed) if the app already exists.',
    },
    secretsSetStep(c, (pairs) => ['fly', 'secrets', 'set', ...pairs, '-a', c.app]),
    {
      id: 'deploy',
      kind: 'host',
      command: ['fly', 'deploy', '--config', c.config, '--dockerfile', c.dockerfile, '-a', c.app, '.'],
      display: `fly deploy --config ${c.config} --dockerfile ${c.dockerfile} -a ${c.app} .`,
      outward: true,
      paid: true,
      note: 'the operator\'s paid step — builds + ships the control-VM image from the repo root.',
    },
    rmDockerignoreStep(),
  ],

  downSteps: ({ app }) => [
    {
      id: 'apps-destroy',
      kind: 'host',
      command: ['fly', 'apps', 'destroy', app, '--yes'],
      display: `fly apps destroy ${app} --yes`,
      outward: true,
      note: 'DESTRUCTIVE — removes the machine + kills any in-flight runs/streams.',
    },
  ],
};
