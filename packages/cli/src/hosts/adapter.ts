// The HostAdapter seam — a hosting pathway = a URL shaper + the provider-CLI steps. This is the ONLY new
// interface the uniform-hosting refactor introduces (design: docs/design/control-plane-hosting-uniform.md §3.3).
//
// Every adapter method is PURE — it returns data (DeployStep[] / string), never spawns. Adapters plug into the
// EXISTING plan → render → PLAN-vs-`--execute` gate → runStep pipeline with zero new execution path, so the
// fake-step-runner test seam is preserved: unit tests assert argv/redaction with no I/O.
//
// `cloud.ts` owns the shared core (mint, the DeployPlan/DeployStep model, redaction, renderPlan, the step
// factories); an adapter owns ONLY the four provider-specific leaks (URL shape, provider-CLI argvs, the render
// tag, the defaults). Adding a 5th host = one adapter object + one registry row.

import type { CloudSecret, DeployStep } from '../cloud.js';

/** Everything a plan needs from the caller: mint output + resolved config paths + the computed origin. */
export interface HostPlanContext {
  /** Logical app/service/container name (`--app`). */
  app: string;
  /** The public HTTPS origin (adapter-shaped OR user-supplied via `--public-url`). */
  appUrl: string;
  /** fly.toml path (`''` for railway/docker/selfhost). */
  config: string;
  /** control-vm Dockerfile (`''` for selfhost-via-serve). */
  dockerfile: string;
  /** Host port to publish (docker/selfhost); 8080 default. */
  port: number;
  /** From `mintCloudSecrets` — PIFLOW_TOKEN first, real values. */
  secrets: CloudSecret[];
  /** The minted bearer (for the smoke env + serve `--token`). */
  token: string;
  /** Secret-free gateway config, staged as MODELS_JSON_ENV (when a custom `--provider` resolved). */
  modelsJson?: string;
  /** Gateway name, for the display label. */
  provider?: string;
}

/**
 * A hosting pathway = a URL shaper + the provider-CLI steps. All methods are PURE — they return data
 * (DeployStep[] / string), never spawn. They plug into the existing plan/render/gate/runStep pipeline
 * with zero new execution path.
 */
export interface HostAdapter {
  /** Registry key + value of `--host` + render tag: 'fly' | 'railway' | 'selfhost' | 'docker'. */
  readonly id: string;
  /** Human label for the paid render tag (replaces the hardcoded 'fly·$$'). Usually === id. */
  readonly label: string;
  /**
   * True when the origin is host-derived (fly/railway); false when the operator must supply `--public-url`
   * (docker/selfhost) — used to fail `--execute` fast if the URL is missing.
   */
  readonly urlIsHostDerived: boolean;

  /** The stable public HTTPS origin for an app. fly → `https://<app>.fly.dev`; selfhost/docker → publicUrl. */
  appUrl(app: string, opts: { publicUrl?: string; port: number }): string;

  /**
   * The FULL ordered `up` runbook for this host (including any .dockerignore copy/rm it needs).
   * buildDeployPlan appends ONLY the invariant smoke after these.
   */
  upSteps(ctx: HostPlanContext): DeployStep[];

  /** The teardown step(s) for `down` (may be empty for selfhost → the plan prints a manual note). */
  downSteps(opts: { app: string; port: number }): DeployStep[];
}
