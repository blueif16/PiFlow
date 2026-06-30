# Mastra teardown — Tools, MCP & integrations

> Per-aspect source brief for [`../competitive-analysis-vs-mastra.md`](../competitive-analysis-vs-mastra.md)
> (§1d, §2, §3 M5). Evidence cited `file:line` relative to `vendor/mastra/`. Produced 2026-06-29 from a
> focused read of `packages/core/src/{tools,tool-provider,integration}/`, `packages/mcp/`,
> `packages/mcp-docs-server/`, `packages/mcp-registry-registry/`, `integrations/` at HEAD `12af22b`.
> Honest by construction.

## Tool definition — createTool shape

`createTool(opts)` returns a `Tool` instance (`packages/core/src/tools/tool.ts:575`, class at `:78`). The
shape is `id` (`:91`), `description` (`:94`), optional `inputSchema`/`outputSchema` (`:97`,`:100`), plus
`suspendSchema`/`resumeSchema` (`:103`,`:106`) for human-in-the-loop, `requestContextSchema` (`:112`), and
`execute?` (`:120`). The full authored interface is `ToolAction` (`types.ts:578`); `execute` signature is
`(inputData, context) => Promise<TSchemaOut | ValidationError | void>` (`types.ts:629`). Schemas are
normalized to a Standard-Schema wrapper via `toStandardSchema` (`tool.ts:280`), so Zod and JSON-Schema both
work. The constructor wraps `execute` to validate input/requestContext/resume/output (`tool.ts:303-466`).

The `context` (`ToolExecutionContext`, `types.ts:518`) carries `mastra` (`:524`), `requestContext`
(`:525`), `abortSignal` (`:526`), `workspace` (`:537`), `browser` (`:545`), `writer` (`:549`), `observe`
(`:575`), and nested `agent`/`workflow`/`mcp` sub-contexts (`:554-560`). When an agent/AI-SDK drives the
tool, the adapter `CoreToolBuilder` assembles this context: `abortSignal` at `tool-builder/builder.ts:608`,
`mastra` (`:587`), `requestContext` merged from build+exec time (`:590`), `workspace` (`:594`). There is no
separately-named "runtimeContext"; the run-scoped store is `RequestContext`.

Vercel-AI-SDK compat is first-class. `CoreTool`/`InternalCoreTool` (`types.ts:407,465`) mirror the AI-SDK
`Tool` (uses `parameters`, `execute(params, options)`). `isVercelTool` (`toolchecks.ts:19`) and
`isProviderDefinedTool` (`:49`) detect AI-SDK and provider-defined tools (e.g. `google.google_search`);
`CoreToolBuilder` accepts `ToolToConvert = VercelTool | ToolAction | VercelToolV5 | ProviderDefinedTool`
(`builder.ts:85`) and handles both v4 `parameters` and v5 `inputSchema` (`:335-340`). Composition:
`providerOptions` (`:175`), `toModelOutput` (`:181`), `transform` (`:186`), `requireApproval` (`:138`),
`background` (`:260`). A "code-mode" factory `createCodeMode` exposes `execute_typescript` that runs
model-written TS in a `WorkspaceSandbox` and bridges `external_*` calls back to real tools
(`code-mode/code-mode.ts:1-7`, stdio worker transport `transport.ts:1-8`).

## MCP client

Public class `MCPClient` (`packages/mcp/src/client/configuration.ts:71`) wraps per-server
`InternalMastraMCPClient` (`client/client.ts:189`). Transports auto-detect from config: stdio via
`command`/`args`/`env`/`cwd`/`stderr` → `StdioClientTransport` (`client.ts:377`); HTTP via `url` tries
`StreamableHTTPClientTransport` first, falling back to deprecated `SSEClientTransport` on status
400/404/405 (`client.ts:395-463`, fallback codes `:81`). Server defs are typed `StdioServerDefinition |
HttpServerDefinition` (`client/types.ts:285,326,425`), with custom `fetch` for dynamic auth (`:368`),
`requireToolApproval` (`:229`), and filesystem `roots` (`:277`, `setRoots` at `client.ts:355`).

Tool retrieval: `listTools()` returns all servers' tools namespaced `serverName_toolName`
(`configuration.ts:773,808`) — meant for an Agent definition. `listToolsets()` returns tools grouped by
server without prefixing, for per-call dynamic injection into `stream()`/`generate()` (`:854`). Both have
`...WithErrors` variants that skip-and-report failed servers (`:796,876`). The legacy `getTools`/`getToolsets`
names are absent (uncertain whether removed or renamed; only `listTools`/`listToolsets` exist in current
source). Resources: `mcp.resources.list/templates/read/subscribe/unsubscribe/onUpdated/onListChanged`
(`actions/resource.ts:46,90,130,149,167,189,209`). Prompts: `mcp.prompts.list/get/onListChanged`
(`actions/prompt.ts:45,98` + configuration `:547`). Elicitation: `mcp.elicitation.onRequest(handler)`
registers a callback for server-initiated structured input (`actions/elicitation.ts:67`; configuration
`:212`). Also: `progress` tracking (`:168`), `getServerInstructions()` (`:742`), OAuth provider
(`client/oauth-provider.ts`).

## MCP server

Yes — Mastra is also an MCP **server**. `MCPServer` (`server/server.ts:92`, extends abstract
`MCPServerBase` at `core/src/mcp/index.ts:29`) exposes Mastra `tools`, `agents`, and `workflows` to any MCP
client. Agents become tools named `ask_<agentKey>` (`server.ts:1043`, built via `createTool` wrapping
`agent.generate`), workflows become `run_<workflowKey>` (`:1131`, wrapping `workflow.createRun`).
Transports: `startStdio` (`:1301`), `startSSE` (`:1357`), `startHonoSSE` (`:1434`), `startHTTP`
(Streamable HTTP, `:1546`) — using `StdioServerTransport`/`SSEServerTransport`/`StreamableHTTPServerTransport`
(`:24-26`). It serves `tools/list`+`tools/call` (`:605`), `resources` (`:853`, configurable
`getResourceContent`), `prompts` (`:949`, `server.prompts` actions `:137`), and server-side `elicitation`
to call back to clients (`:157,402`). Tool annotations (`readOnlyHint` etc.) are advertised
(`types.ts:338`). OAuth middleware exists (`server/oauth-middleware.ts`).

**Verdict: Mastra is BOTH a full MCP client (`MCPClient`, `client/configuration.ts:71`) and a full MCP
server (`MCPServer`, `server/server.ts:92`).**

## Integrations & registry

`integrations/` holds hand/codegen'd typed tool packages, each exporting a `createXTools()` factory of
`createTool` tools, not generic OpenAPI clients: `@mastra/tavily` (search/extract/crawl/map,
`integrations/tavily/src/`), `@mastra/perplexity`, `@mastra/brightdata`, `opencode`. The core `Integration`
base (`integration.ts:4`) and `OpenAPIToolset` (`openapi-toolset.ts:6`, auto-wraps an API client's methods
into tools via `_generateIntegrationTools` `:30`) are the abstractions, but `listTools`/`getApiClient` are
unimplemented stubs in the base (`integration.ts:44-50`). A richer `tool-provider/` layer
(`BaseToolProvider`, `tool-provider/base.ts`) adds connection/auth-flow/health for hosted multi-tenant
providers. `mcp-docs-server` is a standalone MCP **server** serving Mastra's own docs/API to IDEs (tools
`mastraDocs`, `getMastraExports`, etc.). `mcp-registry-registry` is a meta-registry MCP server — a registry
*of* MCP registries for server discovery (tools `registryList`, `registryServers`).

## Edges & limits

**Capabilities:** (1) Symmetric MCP — one library is both client and server, so a Mastra node can consume
external servers and re-expose its agents/workflows as MCP tools. (2) `listToolsets()` enables true
*dynamic, per-call* tool injection grouped by server (`configuration.ts:854`) — different tools per turn
without rebuilding the agent. (3) Per-server `requireToolApproval`, `roots`, custom `fetch`, and OAuth give
per-connection isolation/auth (`types.ts:229,277,368`). (4) Code-mode runs tools-as-code in a
`WorkspaceSandbox` with host bridging (`code-mode.ts`). (5) Full MCP surface: resources, prompts,
elicitation, progress, annotations.

**Limits for per-node heterogeneous fleets:** (1) MCP servers are connected *per-MCPClient-instance within
one process* — there's no built-in "each node is its own OS process with its own mounted MCP set"; that
orchestration is the caller's job. (2) `listTools()` namespacing is flat `serverName_toolName` (`:808`) —
no nested/per-node scoping primitive. (3) The generic `Integration`/`OpenAPIToolset` base methods are stubs
(`integration.ts:44`), so non-MCP typed integrations are per-vendor handwritten, not a uniform plug. (4)
Process-level sandboxing applies only to the code-mode tool's sandbox, not to MCP tool execution generally
(uncertain how far `WorkspaceSandbox` extends to MCP stdio children). (5) No evidence of a per-node
*resource/CPU* isolation contract — isolation is connection/auth-scoped, not process-fleet-scoped.
