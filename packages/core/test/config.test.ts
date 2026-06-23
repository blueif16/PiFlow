import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/runner/index.js';

describe('loadConfig — resolve PI_RUNNER_* env + args → the run-opts subset runFromConfig consumes (U8)', () => {
  it('maps every PI_RUNNER_* env var onto its RunOptions field (timeouts seconds→ms)', () => {
    const cfg = loadConfig({
      args: { run: 'g1' },
      env: {
        PI_RUNNER_PROVIDER: 'mmgw',
        PI_RUNNER_MODEL: 'MiniMax-M3',
        PI_RUNNER_THINKING: 'high',
        PI_RUNNER_NODE_TIMEOUT: '600', // seconds
        PI_RUNNER_STALL_TIMEOUT: '120', // seconds
        PI_RUNNER_FROM: 'w2',
        PI_RUNNER_UNTIL: 'verify',
      },
    });
    expect(cfg.run).toBe('g1');
    expect(cfg.providerName).toBe('mmgw');
    expect(cfg.model).toBe('MiniMax-M3');
    expect(cfg.thinking).toBe('high');
    expect(cfg.nodeTimeoutMs).toBe(600_000); // 600 s → ms
    expect(cfg.stallMs).toBe(120_000); // 120 s → ms
    expect(cfg.from).toBe('w2');
    expect(cfg.until).toBe('verify');
  });

  it('args OVERRIDE env (the CLI flag beats the env default)', () => {
    const cfg = loadConfig({
      args: { run: 'g2', providerName: 'cp', model: 'm-cli', from: 'harden' },
      env: { PI_RUNNER_PROVIDER: 'mmgw', PI_RUNNER_MODEL: 'm-env', PI_RUNNER_FROM: 'w0' },
    });
    expect(cfg.providerName).toBe('cp'); // arg wins
    expect(cfg.model).toBe('m-cli'); // arg wins
    expect(cfg.from).toBe('harden'); // arg wins
  });

  it('provider defaults to "cp" when neither arg nor env sets it', () => {
    const cfg = loadConfig({ args: { run: 'g3' }, env: {} });
    expect(cfg.providerName).toBe('cp');
    // unset optional knobs are absent (not garbage) → runWorkflow falls back to ITS defaults.
    expect(cfg.model).toBeUndefined();
    expect(cfg.nodeTimeoutMs).toBeUndefined();
    expect(cfg.from).toBeUndefined();
  });

  it('a MISSING required field (run) throws a CLEAR error', () => {
    expect(() => loadConfig({ args: {}, env: {} })).toThrow(/run/i);
  });
});
