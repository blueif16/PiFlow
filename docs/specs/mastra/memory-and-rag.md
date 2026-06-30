# Mastra teardown — Memory & RAG

> Per-aspect source brief for [`../competitive-analysis-vs-mastra.md`](../competitive-analysis-vs-mastra.md)
> (§1e–1f, §3 M1/M2, §5). Evidence cited `file:line` relative to `vendor/mastra/`. Produced 2026-06-29
> from a focused read of `packages/memory/`, `packages/rag/`, `packages/core/src/{memory,vector,relevance}/`
> at HEAD `12af22b`. piflow has **no** memory or RAG subsystem, so this is largely "what Mastra enables
> that piflow cannot do today." Honest by construction.

## Memory — kinds, thread/resource model, attachment

Mastra's memory abstraction is `MastraMemory` (`packages/core/src/memory/memory.ts:114`), implemented
concretely as `Memory` (`packages/memory/src/index.ts:227`). It exposes **four distinct memory kinds**,
all combined into one context window:

1. **Conversation/thread history** — recent N messages from the current thread, `lastMessages` default 10 (`memory.ts:83`); attached as a `MessageHistory` input/output processor (`memory.ts:780-786`).
2. **Semantic recall** — RAG retrieval of relevant *past* messages by vector similarity (`SemanticRecall` processor, `memory.ts:826-835`; type doc `memory/types.ts:312-411`), with `topK`, `messageRange` (surrounding-context window), `threshold`, and MongoDB-style `filter` (`types.ts:331,344,388,399`). Default `topK=4`, `messageRange=1` (`processors/memory/semantic-recall.ts:14-15`).
3. **Working memory** — a persistent structured record (Markdown template or JSON schema) the agent rewrites via an `updateWorkingMemory` tool (`processors/memory/working-memory.ts:47`; tool at `packages/memory/src/tools/working-memory.ts:95`). Default template at `memory.ts:88-100`.
4. **Observational memory** — a three-tier Observer→Reflector pipeline that extracts and compresses long-term observations (`memory/types.ts:741-871`), with token-triggered observation (`messageTokens` default 30000) and reflection (`observationTokens` default 40000), async buffering, and an optional `recall` retrieval tool.

**Working memory vs semantic recall (from code):** working memory is *agent-authored state* — the
`WorkingMemory` **input** processor reads a stored blob and *prepends it as a system instruction* every
turn (`working-memory.ts:36-46`); the agent mutates it by calling the `updateWorkingMemory` tool,
persisted via `Memory.updateWorkingMemory` (`memory/src/index.ts:722`) under a mutex (`:802`). Semantic
recall is *retrieval* — it embeds the query, vector-searches prior messages, and injects the top-K matches
plus their `messageRange` neighbors (`semantic-recall.ts`); it requires a vector store + embedder
(enforced at `memory.ts:170-186, 799-813`), while working memory needs only a storage adapter
(`memory.ts:723-730`).

**Thread/resource model:** `StorageThreadType` (`memory/types.ts:39`) keys every thread by `id` +
`resourceId` (the user/owner). Both working memory and semantic recall take a `scope: 'thread' |
'resource'` (`types.ts:184,357`) — `resource` shares state across all of a user's threads; `thread`
isolates it. `listThreads` filters by `resourceId` + metadata with pagination (`memory.ts:438`).

**Message storage:** messages are `MastraDBMessage`/`MastraMessageV1` (`memory/types.ts:21`) persisted via
`saveMessages` (`memory.ts:458`, impl `memory/src/index.ts:1077`). Threads support `cloneThread`
(`memory.ts:963`), `deleteMessages` (`:953`), and **thread-title generation** (`generateTitle`,
`memory/types.ts:1012`).

**Attachment to an agent:** `Memory` is passed to `new Agent({ memory })`; it self-registers as a
processor provider via `getInputProcessors`/`getOutputProcessors` (`memory.ts:700, 856`), which
conditionally emit the MessageHistory/WorkingMemory/SemanticRecall processors based on config.

**Working-memory templates/schemas:** either a Markdown `template` string or a Zod/JSON `schema`
(`memory/types.ts:201-224`). `getWorkingMemoryTemplate` converts a schema to a JSON-Schema-draft-07
template (`memory/src/index.ts:1367-1381`), else returns the markdown template.

**Memory processors:** abstract `MemoryProcessor` (`memory.ts:71`); the built-ins are `MessageHistory`,
`WorkingMemory`, `SemanticRecall`, plus `globalEmbeddingCache`
(`packages/core/src/processors/memory/index.ts:1-10`). The old `processors` config is removed in favor of
agent input/output processors (`memory.ts:137-163`).

## Memory storage backends

Memory persists through a `MastraCompositeStore` (`SharedMemoryConfig.storage`, `memory/types.ts:1134`).
**17 storage classes across 16 store dirs** persist threads/messages/working memory (evidence =
`saveMessages` in each store's `domains/memory/index.ts`): **libsql** (`stores/libsql/src/storage/index.ts:159`),
**pg** `PostgresStore` (`stores/pg/src/storage/index.ts:187`), **upstash** (`:96`), **mysql**, **mssql**,
**mongodb**, **dynamodb**, **redis**, **clickhouse**, **convex**, **dsql**, **duckdb**, **lance**,
**spanner**, **cloudflare** (KV + DO, two classes), and **cloudflare-d1**. Snapshots/messages/working-memory
live in each adapter's memory domain (e.g. `stores/libsql/src/storage/domains/memory/index.ts:631`).

## RAG — ingestion, chunking, embedding, retrieval, rerank, graph-RAG, filters

**Ingestion:** `MDocument` (`packages/rag/src/document/document.ts:38`) with
`fromText/fromHTML/fromMarkdown/fromJSON` (`:104-150`).

**Chunking — 9 strategies** (`document.ts:171-181`): `recursive`, `character`, `token` (tiktoken, `:289`),
`markdown` (+header-aware, `:299`), `semantic-markdown` (`:335`), `html` (header/section, `:218`), `json`
(`:264`), `latex` (`:283`), `sentence` (`:312`). Recursive supports 27 code languages
(`document/types.ts:10-37`). Optional metadata extractors run during `chunk()`:
Title/Summary/QuestionsAnswered/Keyword/Schema (`document.ts:49-99`).

**Embedding:** version-multiplexed AI-SDK `embed` aliases `embedV1/V2/V3`
(`packages/core/src/vector/embed.ts:1-3`); a first-party **VoyageAI** embedder ships V2/V3 models + reranker
(`embedders/voyageai/src/text-embedding.ts:66,147`).

**Retrieval:** `createVectorQueryTool` (`packages/rag/src/tools/vector-query.ts:22`) embeds the query,
searches, optionally reranks; options include `indexName`, `model`, `enableFilter`, `reranker`,
`vectorStoreName` or `vectorStore` (`tools/types.ts:127-174`).

**Reranking:** `rerank()` (`packages/rag/src/rerank/index.ts:197`) blends `DEFAULT_WEIGHTS =
{semantic:0.4, vector:0.4, position:0.2}` (`:10-14`). Relevance scorers: `MastraAgentRelevanceScorer`
(`packages/core/src/relevance/mastra-agent/index.ts:7`), `CohereRelevanceScorer`
(`rerank/relevance/cohere/index.ts:20`), `ZeroEntropyRelevanceScorer` (re-exported
`rerank/relevance/index.ts:3`), plus Voyage reranker (`embedders/voyageai/src/reranker.ts`).

**Graph-RAG:** `GraphRAG` (`packages/rag/src/graph-rag/index.ts:39`, ctor `dimension=1536,
threshold=0.7`) builds `'semantic'` edges between chunks above a cosine threshold (`:169-184`) and
re-ranks via random-walk-with-restart (`query()` `:261`, walk `:208`); exposed as `createGraphRAGTool`
(`tools/graph-rag.ts:21`).

**Metadata filtering:** `VectorFilter` (`packages/core/src/vector/filter/base.ts:84`) +
`BaseFilterTranslator` (`:154`) support MongoDB operators: `$eq,$ne` / `$gt,$gte,$lt,$lte` /
`$in,$nin,$all,$elemMatch` / `$and,$or,$not,$nor` / `$exists` / `$regex,$options` (`base.ts:164-169`).

## Vector store abstraction

`MastraVector` (`packages/core/src/vector/vector.ts:72`) is the common interface: `query`, `upsert`,
`createIndex`, `listIndexes`, `describeIndex`, `deleteIndex`, `updateVector`, `deleteVector`,
`deleteVectors` (`:94-146`), with dimension/metric validation (`:148`). **18 vector backends** implement
it: astra, chroma, convex (`ConvexVector` + `ConvexNativeVector`), couchbase, duckdb, elasticsearch,
lance, libsql, mongodb, opensearch, pg (`PgVector`), pinecone, qdrant, s3vectors, turbopuffer, upstash,
vectorize (`CloudflareVector`) — e.g. `stores/pg/src/vector/index.ts:105`,
`stores/pinecone/src/vector/index.ts:107`. **7 stores do both** storage + vector: convex, duckdb, lance,
libsql, mongodb, pg, upstash. PG additionally supports HNSW/IVFFlat index tuning (`memory/types.ts:235-310`).
Metadata filters are per-store via `BaseFilterTranslator` subclasses.

## Edges & limits

What Mastra enables that a stateless multi-process DAG runner lacks:

1. **Cross-session continuity per user** — `resource`-scoped working memory + semantic recall mean an agent remembers a user across separate threads/processes; a stateless runner restarts blank each invocation.
2. **Automatic context compression** — observational memory's Observer/Reflector tiers keep long histories within a token budget without app code (`memory/types.ts:741-871`).
3. **Turnkey RAG** — ingest→9-way chunk→embed→vector-search→rerank→graph-walk, as agent-callable tools (`createVectorQueryTool`, `createGraphRAGTool`), with one filter dialect across 18 vector DBs.
4. **Pluggable persistence** — swap among 16+ storage and 18 vector backends behind unchanging interfaces.
5. **Structured agent-authored state** — schema/template working memory the model self-maintains via a tool.

**Limits / honest notes:** `embed.ts` re-exports only `embed`, **not** `embedMany` (bulk embedding happens
in `rag/src/utils`, not opened here). Graph-RAG implements only `'semantic'` edges (sequential/hierarchical/
citation are TODO, `graph-rag/index.ts:8`). `version: 'vnext'` working memory and `useStateSignals` are
flagged experimental (`memory.ts:680`, `types.ts:196`). PG-specific HNSW/IVFFlat index config is ignored by
other vector stores (`types.ts:230-233`). FastEmbed is referenced in a docstring (`types.ts:1157`) but no
first-party embedder package exists under `embedders/` besides VoyageAI (uncertain whether bundled
elsewhere).
