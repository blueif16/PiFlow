// One typed error class for every bridge failure the caller might branch on. A single named class
// (with a machine-readable `code`) keeps the generated extension's error handling simple while letting
// tests assert on the specific failure mode.

export type BridgeErrorCode =
  /** Address was neither `mcp.<server>:<tool>` nor `oc.<plugin>:<tool>` (e.g. `web:search`, `builtin:read`) — out of this bridge's scope. */
  | 'unsupported-address'
  /** An `mcp.<server>:<tool>` / `oc.<plugin>:<tool>` address could not be parsed into a server + tool. */
  | 'malformed-address'
  /** No config exists for the server named in the address. */
  | 'unknown-server'
  /** The bridge has not been configured (no in-process config and `PIFLOW_MCP_CONFIG` unset/invalid). */
  | 'not-configured'
  /**
   * A `$VAR`/`${VAR}` reference in the config resolved to no env var. Distinct from `not-configured`
   * (config IS present, just unexpandable) and `connect-failed` — we fail HERE so a literal `$VAR`
   * never reaches a server as a bogus credential.
   */
  | 'missing-env'
  /** Connecting the MCP client to its server transport failed. */
  | 'connect-failed';

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  constructor(code: BridgeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BridgeError';
    this.code = code;
  }
}
