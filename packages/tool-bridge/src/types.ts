// Public types for @piflow/tool-bridge. The bridge is the MCP transport RUNTIME the generated pi `-e`
// extension imports: `callTool(address, params, opts)`. Its return MUST be a valid pi tool-execute
// result, so `PiToolResult` mirrors pi's `execute` return contract (content[] + optional details).
//
// pi execute return (verified — pi-tools-extensions brief §1 + pi docs `tool_result`/`tool_execution_end`):
//   { content: [{ type: "text", text }] | [{ type: "image", data, mimeType }], details?, isError?, terminate? }
// The MCP `tools/call` result (verified — @modelcontextprotocol/sdk@1.29.0 CallToolResultSchema):
//   { content: ContentBlock[], structuredContent?: object, isError?: boolean }
// They share the `content[]` block shape, so the bridge passes content through and folds MCP's
// `structuredContent`/`isError` onto pi's `details`/`isError`.

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/** A pi/MCP content block. Both contracts use the same discriminated shape (text · image · audio). */
export type PiContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  // MCP may emit other block kinds (resource links etc.); keep them passable without losing data.
  | { type: string; [k: string]: unknown };

/**
 * What a pi tool `execute` must return. The generated extension's `async execute(...)` returns the
 * Promise from `callTool`, so this shape is what pi consumes.
 */
export interface PiToolResult {
  /** Content blocks shown to the model — passed through verbatim from the MCP result. */
  content: PiContentBlock[];
  /** Structured side-channel reaching a `-p` driver on `tool_execution_end`. Carries MCP `structuredContent`. */
  details?: unknown;
  /** True when the underlying tool reported a failure (MCP `isError`) — pi surfaces it as an error result. */
  isError?: boolean;
}

/** Connection config for ONE MCP server. Mirrors pi-mcp-adapter's per-server keys (command/args/env · url/headers). */
export type McpServerConfig =
  /** Local, process-spawned server over stdio. */
  | { transport: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  /** Remote server over Streamable HTTP. */
  | { transport: 'http'; url: string; headers?: Record<string, string> }
  /**
   * A pre-built Transport instance (the SDK's InMemoryTransport pair, or any custom Transport). This is
   * the seam tests use to attach a real in-process MCP server WITHOUT spawning a process — the call still
   * traverses the real client → transport → server path; only the wire is in-memory.
   */
  | { transport: 'inMemory'; transportInstance: Transport };

/** The bridge's whole config: a map of server name → connection config. */
export interface BridgeConfig {
  servers: Record<string, McpServerConfig>;
}

/**
 * One row of an MCP server's `tools/list` result, as `listServerTools` maps it. Mirrors core's
 * `McpToolListing` (tools/ingest.ts) field-for-field — DUPLICATED on purpose so the bridge stays
 * product-agnostic and NEVER imports core (core depends on the bridge, not the reverse).
 */
export interface McpToolListing {
  name: string;
  description?: string;
  /** JSON Schema (MCP standard `inputSchema`) — passed through verbatim. */
  inputSchema?: unknown;
}
