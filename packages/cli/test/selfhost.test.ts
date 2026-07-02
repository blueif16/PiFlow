// The selfhost adapter — run the SAME control plane on any always-on box (no cloud account) fronted by a
// cloudflared quick-tunnel for a free stable HTTPS URL (design: docs/design/control-plane-hosting-uniform.md
// §4-selfhost). These are PURE builder tests: assert the env-write/serve/tunnel argvs + `***` redaction +
// urlIsHostDerived:false + the operator-supplied publicUrl + the empty downSteps, with zero I/O.
//
// REDACTION is the load-bearing property here: the env-write step + the serve --token step carry the bearer +
// provider creds; their `display` MUST show `***`, only `command` holds the real values. The redaction tests
// pass the §4 "test-the-test" bar — a mutation that leaks a secret into `display` MUST turn one of them red.
//
// NOTE ON TEST LOCATION: this lives in packages/cli/test/ (not src/hosts/) because vitest.config.ts collects
// `packages/*/test/**/*.test.ts` — a file under src/hosts/ would NOT run. This mirrors cloud.test.ts, which
// already tests the fly adapter from here.

import { describe, it, expect } from 'vitest';
import { selfhostAdapter } from '../src/hosts/selfhost.js';
import { MODELS_JSON_ENV } from '../src/cloud.js';
import type { HostPlanContext } from '../src/hosts/adapter.js';

// A fixed context — real secret values so redaction is observable, and a models.json so the non-secret gateway
// config path is exercised too. `BEARER`/`NK`/`OAUTH` are the values that must NEVER appear in any `display`.
const ctx = (over: Partial<HostPlanContext> = {}): HostPlanContext => ({
  app: 'the-app',
  appUrl: 'https://my-tunnel.trycloudflare.com',
  config: '',
  dockerfile: '',
  port: 8080,
  token: 'BEARER-secret',
  secrets: [
    { name: 'PIFLOW_TOKEN', value: 'BEARER-secret' },
    { name: 'NEBIUS_API_KEY', value: 'NK-secret' },
    // Value deliberately NOT a substring of any var name (e.g. 'OAUTH' lives inside CLAUDE_CODE_OAUTH_TOKEN),
    // so a "does not contain <value>" leak check can't false-positive on the redacted name itself.
    { name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'oauth-cred-value' },
  ],
  ...over,
});

// All secret VALUES that must never leak into a printable `display` (across every step).
const SECRET_VALUES = ['BEARER-secret', 'NK-secret', 'oauth-cred-value'];

describe('selfhostAdapter — identity', () => {
  it('has id/label "selfhost"', () => {
    expect(selfhostAdapter.id).toBe('selfhost');
    expect(selfhostAdapter.label).toBe('selfhost');
  });

  it('is NOT host-derived (the operator must supply --public-url)', () => {
    expect(selfhostAdapter.urlIsHostDerived).toBe(false);
  });
});

describe('selfhostAdapter.appUrl', () => {
  it('returns the operator-supplied publicUrl (the printed cloudflared origin)', () => {
    expect(selfhostAdapter.appUrl('the-app', { publicUrl: 'https://my-tunnel.trycloudflare.com', port: 8080 })).toBe(
      'https://my-tunnel.trycloudflare.com',
    );
  });

  it('falls back to the 127.0.0.1 placeholder when no publicUrl is given (PLAN-mode placeholder)', () => {
    expect(selfhostAdapter.appUrl('the-app', { port: 9000 })).toBe('http://127.0.0.1:9000');
  });
});

describe('selfhostAdapter.upSteps — the runbook shape', () => {
  it('emits env-write → serve → tunnel, in that order (no build, no dockerignore, no smoke)', () => {
    const ids = selfhostAdapter.upSteps(ctx()).map((s) => s.id);
    expect(ids).toEqual(['env-write', 'serve', 'tunnel']);
  });
});

describe('selfhostAdapter.upSteps — env-write step (the 0600 secret file)', () => {
  it('writes ./piflow-control.env at umask 077 via sh -c (0600 mechanism)', () => {
    const write = selfhostAdapter.upSteps(ctx()).find((s) => s.id === 'env-write')!;
    expect(write.command[0]).toBe('sh');
    expect(write.command[1]).toBe('-c');
    const script = write.command[2];
    expect(script).toContain('umask 077'); // creates the file 0600
    expect(script).toContain('./piflow-control.env'); // the exact env-file path
  });

  it('inlines the REAL secret values in command but redacts EVERY value to *** in display', () => {
    const write = selfhostAdapter.upSteps(ctx()).find((s) => s.id === 'env-write')!;
    const script = write.command[2];
    // command carries the real env-file lines
    expect(script).toContain('PIFLOW_TOKEN=BEARER-secret');
    expect(script).toContain('NEBIUS_API_KEY=NK-secret');
    expect(script).toContain('CLAUDE_CODE_OAUTH_TOKEN=oauth-cred-value');
    // display redacts each value — and leaks NONE of the real ones
    expect(write.display).toContain('PIFLOW_TOKEN=***');
    expect(write.display).toContain('NEBIUS_API_KEY=***');
    expect(write.display).toContain('CLAUDE_CODE_OAUTH_TOKEN=***');
    for (const v of SECRET_VALUES) expect(write.display).not.toContain(v);
  });

  it('stages a present models.json as the NON-secret MODELS_JSON_ENV (labeled in display, real in command)', () => {
    const write = selfhostAdapter
      .upSteps(ctx({ modelsJson: '{"providers":{"mmgw":{"apiKey":"$MMGW_KEY"}}}', provider: 'mmgw' }))
      .find((s) => s.id === 'env-write')!;
    expect(write.command[2]).toContain(`${MODELS_JSON_ENV}={"providers":{"mmgw":{"apiKey":"$MMGW_KEY"}}}`);
    expect(write.display).toContain(`${MODELS_JSON_ENV}=<gateway:mmgw>`); // labeled, not the blob
    expect(write.display).not.toContain('$MMGW_KEY');
  });

  it('omits MODELS_JSON_ENV entirely when there is no models.json (plain-key path)', () => {
    const write = selfhostAdapter.upSteps(ctx()).find((s) => s.id === 'env-write')!;
    expect(write.command[2]).not.toContain(MODELS_JSON_ENV);
    expect(write.display).not.toContain(MODELS_JSON_ENV);
  });
});

describe('selfhostAdapter.upSteps — serve step', () => {
  it('runs piflowctl serve --host 0.0.0.0 --port <port> --token <real> with the token *** in display', () => {
    const serve = selfhostAdapter.upSteps(ctx({ port: 9000 })).find((s) => s.id === 'serve')!;
    expect(serve.command).toEqual(['piflowctl', 'serve', '--host', '0.0.0.0', '--port', '9000', '--token', 'BEARER-secret']);
    expect(serve.display).toContain('--token ***'); // the bearer is redacted in the printable runbook
    expect(serve.display).not.toContain('BEARER-secret'); // and never leaks
  });

  it('is outward (an agent must not auto-run the always-on plane)', () => {
    const serve = selfhostAdapter.upSteps(ctx()).find((s) => s.id === 'serve')!;
    expect(serve.outward).toBe(true);
  });
});

describe('selfhostAdapter.upSteps — tunnel step', () => {
  it('runs cloudflared tunnel --url http://localhost:<port>', () => {
    const tunnel = selfhostAdapter.upSteps(ctx({ port: 9000 })).find((s) => s.id === 'tunnel')!;
    expect(tunnel.command).toEqual(['cloudflared', 'tunnel', '--url', 'http://localhost:9000']);
    expect(tunnel.display).toBe('cloudflared tunnel --url http://localhost:9000');
  });

  it('carries no secret (nothing to redact)', () => {
    const tunnel = selfhostAdapter.upSteps(ctx()).find((s) => s.id === 'tunnel')!;
    for (const v of SECRET_VALUES) expect(tunnel.display).not.toContain(v);
  });
});

describe('selfhostAdapter — no step across the whole up runbook leaks a secret value', () => {
  it('every display is redacted (the runbook is safe to print/scrollback)', () => {
    const steps = selfhostAdapter.upSteps(ctx({ modelsJson: '{"k":"$V"}', provider: 'mmgw' }));
    for (const s of steps) for (const v of SECRET_VALUES) expect(s.display).not.toContain(v);
  });
});

describe('selfhostAdapter.downSteps', () => {
  it('is EMPTY — the plan prints a manual "stop the supervisor + tunnel" note instead', () => {
    expect(selfhostAdapter.downSteps({ app: 'the-app', port: 8080 })).toEqual([]);
  });
});
