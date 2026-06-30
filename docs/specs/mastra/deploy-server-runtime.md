# Mastra teardown — Deployment, server, runtime & dev experience

> Per-aspect source brief for [`../competitive-analysis-vs-mastra.md`](../competitive-analysis-vs-mastra.md)
> (§1h, §3 M4/M6, §4). Evidence cited `file:line` relative to `vendor/mastra/`. Produced 2026-06-29 from a
> focused read of `packages/{deployer,server,cli,create-mastra,playground,client-sdks}/` and `deployers/`
> at HEAD `12af22b`. Honest by construction.

## The Mastra runtime/server

Mastra is unambiguously a **long-running HTTP service you deploy**, not a process you spawn and watch. `new
Mastra({...})` takes a `Config` (`packages/core/src/mastra/index.ts:228`) whose fields are the registry of
the running service: `agents` (`:250`), `storage` (`:256`), `vectors` (`:262`), `workflows` (`:274`),
`observability` (`:326`), `deployer` (`:339`), `server` (`:344`), `mcpServers` (`:381`), `bundler`
(`:386`), `scorers` (`:409`), `tools` (`:414`), and `memory` (`:425`). The constructor (`:1080`) wires
these into a DI hub and auto-creates background workers (an `OrchestrationWorker`, optional
`BackgroundTaskWorker`) plus a default in-memory store (`:1206`) — i.e. it expects to stay resident and
coordinate state, not exit per task.

The HTTP layer is **Hono** (`import { Hono } from 'hono'`,
`packages/server/src/server/server-adapter/index.ts:9`). All built-in routes live in `SERVER_ROUTES`
(`packages/server/src/server/server-adapter/routes/index.ts:164`), aggregating agents, workflows, memory,
tools, vectors, A2A, MCP, observability, scores, and more, all mounted under an `/api` prefix (client
default `apiPrefix='/api'`). Concrete surface, verified in `packages/server/src/server/handlers/`:

- **Agents:** `GET /agents` (`agents.ts:1007`), `GET /agents/:agentId` (`:1142`), `POST /agents/:agentId/generate` (`:1222`), `POST /agents/:agentId/stream` (`:1595`), `/observe`, `/approve-tool-call`, `/send-tool-approval`.
- **Workflows:** `GET /workflows` (`workflows.ts:96`), `POST /workflows/:workflowId/create-run` (`:339`), `/stream` (`:379`), `/start` / `/start-async` (`:522`/`:486`), `/resume`, `/resume-stream`, `/time-travel`.
- **Memory:** `/memory/threads`, `/memory/threads/:threadId/messages`, `/memory/search` (`memory.ts:1805`), `/memory/working-memory`.

Auth/RBAC is enforced per-route via `coreAuthMiddleware` with a dev-playground bypass. There is also an
**A2A** protocol surface and **MCP** server routes.

## CLI & dev experience

The `mastra` CLI (`packages/cli/src/index.ts`) registers `create`, `init`, `lint`, `dev` (`:159`), `build`
(`:183`), `start` (`:242`), `studio` (`:253`, manages Mastra Studio/Cloud deploys), `worker`, `migrate`,
`scorers`, `auth`. `mastra dev` (`packages/cli/src/commands/dev/dev.ts`) bundles the project to
`.mastra/output/index.mjs`, spawns it as a child Node process with `MASTRA_DEV='true'` (`dev.ts:138-143`),
and hot-reloads on file changes by re-bundling and POSTing `/__refresh` (`:219`). Default port is **4111**
(`dev.ts:479`, `deployer/src/server/index.ts:451`), with auto-port-scan 4111–4131. The local
**playground/studio** (`@internal/playground`, a Vite + React SPA — `packages/playground/package.json`) is
served by the built server via `@hono/node-server`'s `serveStatic` under a studio base path
(`deployer/src/server/index.ts:6,44,398`). It lets a developer chat with agents, run/resume workflows, and
inspect traces/observability against the live `/api` routes. `mastra start` (`start.ts`) just `spawn`s the
prebuilt `index.mjs` from `.mastra/output`.

## Bundling & deployers

`mastra build` (`packages/cli/src/commands/build/build.ts`) bundles with **Rollup + esbuild**
(`deployer/src/build/bundler.ts:8,114`). It is deployer-aware: it calls `getDeployer(entryFile,
outputDir)` (`build.ts:37`); if a deployer is configured it runs that deployer's `bundle()`, otherwise it
falls back to a `BuildBundler` producing a standalone Node server `index.mjs` (`build.ts:40-62`).

The deployer contract: `MastraDeployer extends MastraBundler` with one abstract method
`deploy(outputDirectory)` (`packages/core/src/deployer/index.ts:8-13`); the deployer-package base adds
`getEnvFiles()` reading `.env.production/.env.local/.env` (`deployer/src/deploy/base.ts:16`). The **full
target list is exactly four** (`deployers/`):

1. **`cloudflare`** — `CloudflareDeployer` (`deployers/cloudflare/src/index.ts:46`), emits `wrangler.json` for Workers (`:191`), aliases Node builtins to worker stubs.
2. **`vercel`** — `VercelDeployer` (`vercel/src/index.ts:12`), outputs `.vercel/output/functions/index.func` serverless functions using `hono/vercel` (`:70`).
3. **`netlify`** — `NetlifyDeployer` (`netlify/src/index.ts:66`) with `target: 'serverless' | 'edge'` (`:63`); edge runs on Deno with no hard timeout (`:59`).
4. **`cloud`** — `CloudDeployer` (`cloud/src/index.ts:13`), the managed Mastra Cloud target (`deploy()` is a no-op handed off to the platform, `:39`).

## Client SDK

External apps use `@mastra/client-js` (`client-sdks/client-js/`). `BaseResource` builds every request as
`${baseUrl}${apiPrefix}${path}`, with `apiPrefix` defaulting to `/api`
(`client-sdks/client-js/src/resources/base.ts:11,35,39`). `agent.generate()` POSTs `/agents/:id/generate`,
`agent.stream()` POSTs `/agents/:id/stream`; workflows go through `createRun()` →
`/workflows/:id/create-run`, then `/start`, `/resume`, `/stream`, `/observe` (all `?runId=`). **Streaming
is HTTP SSE over a `ReadableStream`**: `processMastraStream` reads `response.body.getReader()`, splits on
`\n\n`, strips the `data: ` prefix, and stops on `[DONE]`
(`client-sdks/client-js/src/utils/process-mastra-stream.ts:8,12,33,36`).

## Edges & limits

**Enabled by deploy-as-a-service (that a local CLI fleet runner lacks):**
1. A stable network endpoint — any external app/browser calls agents/workflows over HTTP via `client-js`; no co-located process.
2. **Serverless/edge fan-out** — one build deploys to Workers/Vercel/Netlify-edge/Cloud, with stateless MCP mode for connectionless runtimes (`server-adapter/index.ts:74-87`).
3. **Per-route auth/RBAC + A2A/MCP protocol surfaces** — multi-tenant, permission-gated access.
4. **Live dev playground** — chat, run workflows, view traces against the running service (`packages/playground`).
5. **Resume/observe/time-travel of long-running workflows** via persistent storage and background workers.

**Limits vs a multi-process-per-node sandboxed fleet:**
1. **One server process** is the unit — agents/workflows are in-process handlers, not isolated OS processes; no per-node process boundary.
2. **No per-node OS sandbox** (no seatbelt/daytona-style jailing) — there is auth, but isolation is logical, not kernel-level.
3. **Edge-runtime constraints** — Cloudflare/Vercel-edge force Node builtins to be stubbed/aliased (`cloudflare/src/index.ts:22`, netlify edge stub `:34-56`); native binaries, the full FS, and arbitrary subprocess spawning are off-limits.
4. **Serverless execution caps** — short-lived function invocations are ill-suited to long autonomous headless runs (Netlify edge is the no-timeout exception, `netlify/src/index.ts:59`).
5. **Shared blast radius / heterogeneity** — a single bundle and runtime per deployment; no first-class per-node model/tool/sandbox heterogeneity the way a process-per-node fleet provides.

*(Honest gaps: the deployer's request-context propagation and the `mastra worker` runtime were not opened
in depth; the playground's exact trace UI was inferred from package wiring (Vite/React SPA served as static
assets) rather than from reading its React components — though the `/api/observability` and workflow
`/observe` routes it consumes are confirmed.)*
