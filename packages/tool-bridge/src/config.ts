// Config resolution. The bridge gets its server map from one of two paths, checked in order:
//   1. IN-PROCESS — a host (or a test) calls `configureBridge(config)`. Takes precedence.
//   2. ENV FILE — if not configured in-process, read a JSON file path from `PIFLOW_MCP_CONFIG`. This is
//      the path that works inside a freshly-spawned pi node: the runner writes the server map to a JSON
//      file and exports `PIFLOW_MCP_CONFIG=<path>` into the node's env, so the generated `-e` extension's
//      first `callTool` lazily picks it up. (A JSON file can only describe 'stdio'/'http' servers — the
//      'inMemory' variant carries a live Transport object and so is in-process-only.)

import { readFileSync } from 'node:fs';
import { BridgeError } from './errors.js';
import type { BridgeConfig } from './types.js';

/** Env var naming the JSON config file a spawned pi node reads its MCP server map from. */
export const CONFIG_ENV = 'PIFLOW_MCP_CONFIG';

let inProcessConfig: BridgeConfig | undefined;
/** Memoized env-file config (the file is read once per process, like a spawned node's lifetime). */
let envConfigLoaded = false;
let envConfig: BridgeConfig | undefined;

/** Set the server connection config in-process. Overrides any `PIFLOW_MCP_CONFIG` file for this process. */
export function configureBridge(config: BridgeConfig): void {
  inProcessConfig = config;
}

/** Clear in-process config AND the memoized env-file read (so tests start clean). Internal to teardown. */
export function resetConfig(): void {
  inProcessConfig = undefined;
  envConfigLoaded = false;
  envConfig = undefined;
}

function loadEnvConfig(): BridgeConfig | undefined {
  if (envConfigLoaded) return envConfig;
  envConfigLoaded = true;
  const path = process.env[CONFIG_ENV];
  if (!path) {
    envConfig = undefined;
    return undefined;
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new BridgeError('not-configured', `failed to read ${CONFIG_ENV} file at ${JSON.stringify(path)}`, { cause });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new BridgeError('not-configured', `${CONFIG_ENV} file at ${JSON.stringify(path)} is not valid JSON`, { cause });
  }
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as BridgeConfig).servers !== 'object') {
    throw new BridgeError('not-configured', `${CONFIG_ENV} file at ${JSON.stringify(path)} must be { "servers": { ... } }`);
  }
  envConfig = parsed as BridgeConfig;
  return envConfig;
}

/** Resolve the active config (in-process first, then the env file). Throws `not-configured` if neither. */
export function resolveConfig(): BridgeConfig {
  if (inProcessConfig) return inProcessConfig;
  const fromEnv = loadEnvConfig();
  if (fromEnv) return fromEnv;
  throw new BridgeError(
    'not-configured',
    `tool-bridge is not configured: call configureBridge(config) or set ${CONFIG_ENV} to a JSON config file`,
  );
}
