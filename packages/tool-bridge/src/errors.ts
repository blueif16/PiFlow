// One typed error class for every bridge failure the caller might branch on. A single named class
// (with a machine-readable `code`) keeps the generated extension's error handling simple while letting
// tests assert on the specific failure mode.

export type BridgeErrorCode =
  /** Address was not `mcp.<server>:<tool>` (e.g. `web:search`, an `sdk` tool) — out of this bridge's scope. */
  | 'unsupported-address'
  /** The `mcp.<server>:<tool>` address could not be parsed into a server + tool. */
  | 'malformed-address'
  /** No config exists for the server named in the address. */
  | 'unknown-server'
  /** The bridge has not been configured (no in-process config and `PIFLOW_MCP_CONFIG` unset/invalid). */
  | 'not-configured'
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
