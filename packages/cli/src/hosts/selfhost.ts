// The self-host adapter — run the SAME control plane on any always-on box (NO cloud account), fronted by a
// cloudflared quick-tunnel for a free stable HTTPS URL (design: docs/design/control-plane-hosting-uniform.md
// §4-selfhost). No image build, no cloud CLI — the runbook is: write a 0600 env file with the minted secrets →
// `piflowctl serve` under a supervisor (the always-on plane) → `cloudflared tunnel` for the public origin.
//
// URL: `urlIsHostDerived:false` — a quick-tunnel's URL is known only AFTER it starts, so the operator supplies
// it via `--public-url` (the two-phase flow: PLAN prints the runbook with the 127.0.0.1 placeholder; the
// operator brings up serve+tunnel, reads the printed `*.trycloudflare.com` URL, and re-runs with `--public-url`
// before `--execute`). `appUrl` just returns that publicUrl.
//
// SECRETS never leave the host: they resolve LOCALLY via mint and are WRITTEN to a `0600` `./piflow-control.env`
// the supervisor sources — no remote secrets API (mint-not-forward). REDACTION is load-bearing: the env-write
// heredoc and the `serve --token` argv carry the real bearer + creds in `command`, but their `display` shows
// `***` (the same contract as `secretsSetStep`/fly.ts). Nothing here spawns — pure `DeployStep[]` builders.
//
// The env-write can't use `envRunStep` (that factory shapes `-e NAME=VALUE` for `docker run`, not a heredoc env
// file), so it's built directly — but it stages the SAME pair set `secretsSetStep` does: every `ctx.secrets`
// var plus, when present, the NON-secret gateway `MODELS_JSON_ENV` (shown as a safe `<gateway:…>` label, never
// the blob). `downSteps` is empty → the plan prints a manual "stop the supervisor + tunnel" note.

import type { HostAdapter, HostPlanContext } from './adapter.js';
import { MODELS_JSON_ENV, type CloudSecret, type DeployStep } from '../cloud.js';

/** The 0600 env file the supervisor sources; the serve process + cloudflared read the secrets from it. */
const ENV_FILE = './piflow-control.env';

/**
 * The full staged pair set for the env file — every minted secret plus the NON-secret gateway config when a
 * custom `--provider` resolved (staged as `MODELS_JSON_ENV`, exactly as `secretsSetStep` does). `displayValue`
 * carries the safe label so the config path shows `<gateway:…>` instead of `***`; a real secret has none.
 */
function stagedPairs(ctx: HostPlanContext): CloudSecret[] {
  const pairs = [...ctx.secrets];
  if (ctx.modelsJson)
    pairs.push({ name: MODELS_JSON_ENV, value: ctx.modelsJson, displayValue: `<gateway:${ctx.provider ?? 'pi'}>` });
  return pairs;
}

/**
 * The env-write step: write `./piflow-control.env` at `umask 077` (→ 0600) via `sh -c` + a heredoc. `command`
 * inlines the REAL `NAME=VALUE` lines; `display` mirrors the shape with every value redacted to `***` (the
 * gateway config to its `<gateway:…>` label). THE redaction contract, same as `secretsSetStep`/fly.ts.
 */
function envWriteStep(ctx: HostPlanContext): DeployStep {
  const pairs = stagedPairs(ctx);
  const body = (redact: boolean): string =>
    pairs.map((p) => `${p.name}=${redact ? (p.displayValue ?? '***') : p.value}`).join('\n');
  const script = (redact: boolean): string => `umask 077; cat > ${ENV_FILE} <<'EOF'\n${body(redact)}\nEOF`;
  return {
    id: 'env-write',
    kind: 'host',
    command: ['sh', '-c', script(false)],
    display: `sh -c '${script(true)}'`,
    outward: true,
    note: `writes ${ENV_FILE} (0600) with PIFLOW_TOKEN + provider cred(s) + optional gateway config; the supervisor sources it (secrets never leave the host).`,
  };
}

export const selfhostAdapter: HostAdapter = {
  id: 'selfhost',
  label: 'selfhost',
  urlIsHostDerived: false,

  // The cloudflared HTTPS origin, supplied via --public-url; the 127.0.0.1 placeholder is only for PLAN mode.
  appUrl: (_app, { publicUrl, port }) => publicUrl ?? `http://127.0.0.1:${port}`,

  upSteps: (c) => [
    envWriteStep(c),
    {
      id: 'serve',
      kind: 'host',
      command: ['piflowctl', 'serve', '--host', '0.0.0.0', '--port', String(c.port), '--token', c.token],
      display: `piflowctl serve --host 0.0.0.0 --port ${c.port} --token ***`,
      outward: true,
      note: 'run under a supervisor (systemd/pm2/tmux) so it survives logout — this is the always-on plane.',
    },
    {
      id: 'tunnel',
      kind: 'host',
      command: ['cloudflared', 'tunnel', '--url', `http://localhost:${c.port}`],
      display: `cloudflared tunnel --url http://localhost:${c.port}`,
      outward: true,
      note: 'free stable HTTPS; copy the printed https URL into --public-url so the context baseUrl + smoke match.',
    },
  ],

  // Nothing remote to tear down; the plan prints "stop the supervisor + tunnel yourself".
  downSteps: () => [],
};
