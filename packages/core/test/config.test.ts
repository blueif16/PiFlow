import { describe, it, expect } from 'vitest';
import { loadConfig, parseArgFlags } from '../src/runner/index.js';

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

  // S5 — the --arg k=v channel: parseArgFlags builds the map; loadConfig carries it onto ResolvedRunOpts.args.
  it('carries the parsed --arg map onto ResolvedRunOpts.args (no env fallback)', () => {
    const cfg = loadConfig({ args: { run: 'g4', args: { prompt: 'make a platformer', mode: 'companion' } }, env: {} });
    expect(cfg.args).toEqual({ prompt: 'make a platformer', mode: 'companion' });
  });

  it('an empty/absent --arg map prunes away (cfg.args is undefined, not {})', () => {
    expect(loadConfig({ args: { run: 'g5', args: {} }, env: {} }).args).toBeUndefined();
    expect(loadConfig({ args: { run: 'g6' }, env: {} }).args).toBeUndefined();
  });
});

describe('parseArgFlags — repeated --arg k=v → the {{arg.*}} map', () => {
  it('parses the `--arg k=v` flag form (repeats accumulate)', () => {
    expect(parseArgFlags(['--arg', 'prompt=hi there', '--arg', 'mode=companion'])).toEqual({
      prompt: 'hi there',
      mode: 'companion',
    });
  });

  it('parses bare `k=v` tokens too, and a value may contain `=` (only the FIRST splits)', () => {
    expect(parseArgFlags(['k=v', 'url=https://x?a=1&b=2'])).toEqual({ k: 'v', url: 'https://x?a=1&b=2' });
  });

  it('ignores a token with no `=` or an empty key (no crash, no phantom entry)', () => {
    expect(parseArgFlags(['noequals', '=novalue', '--arg', 'good=1'])).toEqual({ good: '1' });
  });
});
