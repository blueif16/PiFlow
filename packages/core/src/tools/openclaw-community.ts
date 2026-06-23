// The OpenClaw COMMUNITY catalog — a curated handful of REAL tool-bearing plugins from the OpenClaw
// ecosystem, persisted as registry-as-code so a design agent / a node can DISCOVER them by `oc.<id>:<tool>`.
//
// PROVENANCE (verified, not fabricated). Enumerated 2026-06-22 by a sparse blobless clone of
// github.com/openclaw/openclaw @ commit c57fee8 (branch `main`, pinned npm `openclaw@2026.6.9`), reading
// every `extensions/*/openclaw.plugin.json`: 139 extensions, of which 19 declare `contracts.tools`. The
// rows below are a CURATED subset (memory / web / files / sub-LLM / workflow) — tool NAMES + the plugin's
// own manifest `description` are verbatim from those manifests. Re-ingest on a version bump by repeating
// the crawl (sparse clone → parse `contracts.tools`) and bumping {@link OPENCLAW_PIN}.
//
// HONEST LIMITS — these are SKELETON, GATEWAY-COUPLED entries (tagged `gateway-coupled`), NOT the
// standalone-executable seed `oc.calc:add` is (catalog.ts):
//   - NO per-tool `parameters` and NO per-tool `description`: a shipped `openclaw.plugin.json` is
//     names-only (its `contracts.tools` is a bare `string[]`; `toolMetadata` carries flags, not schema).
//     The per-tool schema lives only in the plugin's `register()` body. We therefore DO NOT invent one —
//     `parameters` is omitted and the entry `description` is the PLUGIN-level manifest description ('' when
//     the manifest has none), never a fabricated per-tool blurb.
//   - NOT portable to bare `pi -e`: every shipped OpenClaw agent tool closes over the gateway `api`
//     (LLM gateway / a store / a channel / network+key), so its `execute` throws off the no-op capture
//     shim. The `origin.ref` is a GIT-SOURCE pin (`openclaw@<ver>#extensions/<dir>`), which compile.ts
//     deliberately treats as NON-importable — so resolving one never tries to bundle the whole gateway.
//   - They are here for DISCOVERY (search / list / provenance), the registry's core value, exactly as the
//     OpenClaw sourcing brief found: "discoverable, not standalone-executable."

import type { ToolEntry } from '../types.js';
import { openClawPluginToEntries } from './ingest.js';

/** The npm/source pin every community entry's `origin.ref` records (commit c57fee8 on `main`). */
export const OPENCLAW_PIN = 'openclaw@2026.6.9';

/** One crawled plugin: the manifest facts we persist (all verbatim from its `openclaw.plugin.json`). */
interface CrawledPlugin {
  /** The `extensions/<dir>` segment — the git-source pin path + the manifest location. */
  dir: string;
  /** Manifest `id` — the address namespace + the piName prefix. */
  id: string;
  /** Manifest plugin-level `description` ('' when the manifest declares none). NOT a per-tool description. */
  description: string;
  /** Verbatim `contracts.tools` — the bare tool names this plugin owns. */
  tools: string[];
  /** Factual category tags (derived from the tool names / plugin purpose) for search. */
  tags: string[];
  /** `setup` present in the manifest → the plugin needs provider credentials (tagged `needs-setup`). */
  needsSetup?: boolean;
  /** Tool names the manifest flags `toolMetadata.<tool>.optional` (unloaded until allowlisted). */
  optional?: string[];
}

/** The curated crawl rows (verbatim manifest data — see the PROVENANCE note above). */
const PLUGINS: CrawledPlugin[] = [
  {
    dir: 'memory-core',
    id: 'memory-core',
    description: '',
    tools: ['memory_get', 'memory_search'],
    tags: ['memory'],
  },
  {
    dir: 'memory-lancedb',
    id: 'memory-lancedb',
    description: 'OpenClaw LanceDB-backed long-term memory plugin with auto-recall, auto-capture, and vector search.',
    tools: ['memory_forget', 'memory_recall', 'memory_store'],
    tags: ['memory', 'vector-search'],
  },
  {
    dir: 'firecrawl',
    id: 'firecrawl',
    description: '',
    tools: ['firecrawl_search', 'firecrawl_scrape'],
    tags: ['web', 'search', 'scrape'],
    needsSetup: true,
  },
  {
    dir: 'tavily',
    id: 'tavily',
    description: '',
    tools: ['tavily_search', 'tavily_extract'],
    tags: ['web', 'search', 'extract'],
    needsSetup: true,
  },
  {
    dir: 'file-transfer',
    id: 'file-transfer',
    description:
      'Fetch, list, and write files on paired nodes via dedicated node commands. Bypasses bash stdout truncation by using base64 over node.invoke for binaries up to 16 MB.',
    tools: ['file_fetch', 'dir_list', 'dir_fetch', 'file_write'],
    tags: ['files'],
  },
  {
    dir: 'llm-task',
    id: 'llm-task',
    description: 'Generic JSON-only LLM tool for structured tasks callable from workflows.',
    tools: ['llm-task'],
    tags: ['llm', 'workflow'],
    optional: ['llm-task'],
  },
  {
    dir: 'lobster',
    id: 'lobster',
    description: 'Lobster workflow tool plugin for typed pipelines and resumable approvals.',
    tools: ['lobster'],
    tags: ['workflow', 'pipeline'],
    optional: ['lobster'],
  },
];

/**
 * Build the community `ToolEntry[]` from the crawl rows. The address/piName/origin mapping is delegated to
 * {@link openClawPluginToEntries} (ONE source of truth for the sdk skeleton shape); this enriches each row
 * with the plugin-level manifest `description` (real static data — never a fabricated per-tool blurb) and
 * the discovery tags. Every entry carries a fresh `tags` array so a mutating consumer can't corrupt a sibling.
 */
function buildCommunityCatalog(): ToolEntry[] {
  const out: ToolEntry[] = [];
  for (const p of PLUGINS) {
    const ref = `${OPENCLAW_PIN}#extensions/${p.dir}`; // git-source pin → non-importable (compile.ts)
    const baseTags = ['openclaw', 'sdk', 'gateway-coupled', p.id, ...p.tags, ...(p.needsSetup ? ['needs-setup'] : [])];
    for (const entry of openClawPluginToEntries({ id: p.id, contracts: { tools: p.tools } }, { ref })) {
      const rawName = entry.address.slice(entry.address.indexOf(':') + 1);
      const tags = [...baseTags, ...(p.optional?.includes(rawName) ? ['optional'] : [])];
      out.push({ ...entry, description: p.description, tags });
    }
  }
  return out;
}

/** The persisted community catalog (curated OpenClaw tool plugins — discoverable, gateway-coupled). */
export const OPENCLAW_COMMUNITY_CATALOG: ToolEntry[] = buildCommunityCatalog();
