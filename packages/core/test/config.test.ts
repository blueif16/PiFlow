import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
        PI_RUNNER_IDLE_TIMEOUT: '480', // seconds — the request-level liveness window
        PI_RUNNER_IDLE_RETRIES: '3', // in-place re-execs before killed:'idle'
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
    expect(cfg.idleRequestMs).toBe(480_000); // 480 s → ms
    expect(cfg.idleRequestRetries).toBe(3);
    expect(cfg.from).toBe('w2');
    expect(cfg.until).toBe('verify');
  });

  it('PI_RUNNER_IDLE_TIMEOUT=0 resolves to idleRequestMs:0 — the documented DISABLE is honored, never pruned to undefined', () => {
    // The 0-doesn't-disable regression (run 260714-02): `0` must survive as a real value all the way to the
    // runner's `idleRequestMs ?? default` (where 0 disarms) — never coerced to undefined (which would let the
    // default win). secondsToMs('0')===0, and pruneUndefined keeps 0 (0 !== undefined).
    const cfg = loadConfig({ args: { run: 'g0' }, env: { PI_RUNNER_IDLE_TIMEOUT: '0' } });
    expect(cfg.idleRequestMs).toBe(0);
    expect('idleRequestMs' in cfg).toBe(true); // present, not pruned away — this is the value the CLI threads
  });

  it('args OVERRIDE env (the CLI flag beats the env default)', () => {
    const cfg = loadConfig({
      args: { run: 'g2', providerName: 'openrouter', model: 'm-cli', from: 'harden' },
      env: { PI_RUNNER_PROVIDER: 'mmgw', PI_RUNNER_MODEL: 'm-env', PI_RUNNER_FROM: 'w0' },
    });
    expect(cfg.providerName).toBe('openrouter'); // arg wins
    expect(cfg.model).toBe('m-cli'); // arg wins
    expect(cfg.from).toBe('harden'); // arg wins
  });

  // The terminal fallback of the additive cascade is the SINGLE system default — pi's settings.json — NOT a
  // hardcoded provider/model name. A model swap is a settings.json edit; loadConfig carries whatever it holds.
  it('provider+model fall back to the system default (pi settings.json) when neither arg nor env sets them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'piflow-cfg-'));
    const settingsFile = join(dir, 'settings.json');
    writeFileSync(settingsFile, JSON.stringify({ defaultProvider: 'mmgw', defaultModel: 'MiniMax-M3' }));
    const cfg = loadConfig({ args: { run: 'g3' }, env: {}, settingsFile });
    expect(cfg.providerName).toBe('mmgw'); // the system default — no hardcoded name in code
    expect(cfg.model).toBe('MiniMax-M3');
    rmSync(dir, { recursive: true, force: true });
  });

  it('provider+model are UNDEFINED when nothing sets them and no settings.json exists (pi self-resolves)', () => {
    const cfg = loadConfig({ args: { run: 'g3b' }, env: {}, settingsFile: '/nonexistent/piflow-no-settings.json' });
    expect(cfg.providerName).toBeUndefined(); // no `cp`, no invented default
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
