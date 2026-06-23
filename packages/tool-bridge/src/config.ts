// Config resolution. The bridge gets its server map from one of two paths, checked in order:
//   1. IN-PROCESS — a host (or a test) calls `configureBridge(config)`. Takes precedence.
//   2. ENV FILE — if not configured in-process, read a JSON file path from `PIFLOW_MCP_CONFIG`. This is
//      the path that works inside a freshly-spawned pi node: the runner writes the server map to a JSON
//      file and exports `PIFLOW_MCP_CONFIG=<path>` into the node's env, so the generated `-e` extension's
//      first `callTool` lazily picks it up. (A JSON file can only describe 'stdio'/'http' servers — the
//      'inMemory' variant carries a live Transport object and so is in-process-only.)

import { readFileSync } from 'node:fs';
import { BridgeError } from './errors.js';
import type { BridgeConfig, McpServerConfig } from './types.js';

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

// ── $VAR / ${VAR} expansion ────────────────────────────────────────────────────────────────────────
// Secrets live as env vars in the spawned pi child, NOT as literals in `_pi/mcp.json`: the config carries
// only `$VAR`/`${VAR}` REFERENCES, which we expand against `process.env` right after JSON.parse so a
// literal `$VAR` never reaches a transport. Grammar mirrors dotenv-expand (`$BASIC` and `${BASIC}`,
// name = [A-Za-z_][A-Za-z0-9_]*). An UNRESOLVED reference (the var is undefined in process.env) is a loud
// `missing-env` failure — a defined-but-empty var resolves to '' (defined ⇒ present, not missing).

/** Match a `${VAR}` or `$VAR` reference. The braced alt comes first so `${VAR}` isn't read as `$VAR` + `}`. */
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** Expand every `$VAR`/`${VAR}` in `value` from `process.env`; throw `missing-env` on an unresolved ref. */
function expandString(value: string, where: string): string {
  return value.replace(ENV_REF, (_match, braced: string | undefined, bare: string | undefined) => {
    const name = braced ?? bare!;
    const resolved = process.env[name];
    if (resolved === undefined) {
      throw new BridgeError(
        'missing-env',
        `unresolved env reference $${name} in ${where}: set ${name} in the node's environment (the config carries a reference, the secret rides as an env var)`,
      );
    }
    return resolved;
  });
}

/** Expand `$VAR`/`${VAR}` in the string fields of one server config (env/headers values, url, args). */
function expandServer(name: string, cfg: McpServerConfig): McpServerConfig {
  const at = `server ${JSON.stringify(name)}`;
  switch (cfg.transport) {
    case 'stdio':
      return {
        ...cfg,
        args: cfg.args?.map((a) => expandString(a, `${at} args`)),
        env: cfg.env
          ? Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, expandString(v, `${at} env.${k}`)]))
          : cfg.env,
      };
    case 'http':
      return {
        ...cfg,
        url: expandString(cfg.url, `${at} url`),
        headers: cfg.headers
          ? Object.fromEntries(Object.entries(cfg.headers).map(([k, v]) => [k, expandString(v, `${at} headers.${k}`)]))
          : cfg.headers,
      };
    default:
      // 'inMemory' carries a live Transport (no string secrets) and never comes from a JSON file anyway.
      return cfg;
  }
}

/** Expand references across the whole server map (env-file configs only — in-process configs are verbatim). */
function expandConfig(config: BridgeConfig): BridgeConfig {
  return {
    ...config,
    servers: Object.fromEntries(Object.entries(config.servers).map(([name, cfg]) => [name, expandServer(name, cfg)])),
  };
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
  // Expand `$VAR`/`${VAR}` references in the secret-bearing string fields against `process.env` BEFORE
  // any consumer (makeTransport) sees the values — a literal `$VAR` must never reach a server.
  envConfig = expandConfig(parsed as BridgeConfig);
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
