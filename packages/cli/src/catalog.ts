// `piflowctl catalog sync|introspect` — THIN wrappers over @piflow/core's FEDERATE catalog pair
// (`syncMcpCatalog` mirrors the MCP Official Registry's server directory into `~/.piflow/catalog/
// mcp.index.json`; `introspectMcpServer` fetches ONE server's `tools/list` into its per-tool `entries`).
// The CLI layer is dispatch + flag-mapping + formatting ONLY — every network byte moves inside the core
// functions, so the verb is tested against injected fakes (the run-docker.test.ts dispatch pattern) with
// zero net. `--json` emits the core result verbatim (the machine mode the init agent consumes).

import {
  syncMcpCatalog,
  introspectMcpServer,
  type SyncMcpCatalogOpts,
  type SyncResult,
  type IntrospectMcpServerOpts,
  type IntrospectResult,
} from '@piflow/core';

/** Injectable sinks + the two core seams so the verb is testable with zero network. */
export interface CatalogDeps {
  out?: (s: string) => void;
  err?: (s: string) => void;
  sync?: (opts?: SyncMcpCatalogOpts) => Promise<SyncResult>;
  introspect?: (opts: IntrospectMcpServerOpts) => Promise<IntrospectResult>;
}

const USAGE =
  `usage: piflowctl catalog sync [--base-url <url>] [--max-pages <n>] [--json]\n` +
  `       piflowctl catalog introspect <server> [--as <alias>] [--json]\n`;

/** `--name <value>` lookup (the blueprint.ts flag convention). */
function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * `piflowctl catalog <sync|introspect <server>> [--json]`.
 *   • sync                → incremental registry pull (`--base-url` mirror, `--max-pages` backstop); prints
 *                           the run summary (pages · upserted · removed · cursor).
 *   • introspect <server> → capture that server's real per-tool schemas; prints the addresses written.
 * A core failure surfaces as a one-line message + exit 1 (never an unhandled rejection). Returns the exit code.
 */
export async function runCatalogCli(argv: string[], deps: CatalogDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => void process.stdout.write(s));
  const err = deps.err ?? ((s: string) => void process.stderr.write(s));
  const sync = deps.sync ?? syncMcpCatalog;
  const introspect = deps.introspect ?? introspectMcpServer;
  const [sub, ...rest] = argv;
  const json = argv.includes('--json');

  switch (sub) {
    case 'sync': {
      const opts: SyncMcpCatalogOpts = {};
      const baseUrl = flag(rest, 'base-url');
      if (baseUrl) opts.baseUrl = baseUrl;
      const maxPagesRaw = flag(rest, 'max-pages');
      if (maxPagesRaw !== undefined) {
        const n = Number(maxPagesRaw);
        if (!Number.isInteger(n) || n <= 0) {
          err(`piflowctl catalog sync: --max-pages must be a positive integer (got '${maxPagesRaw}').\n`);
          return 1;
        }
        opts.maxPages = n;
      }
      let result: SyncResult;
      try {
        result = await sync(opts);
      } catch (e) {
        err(`piflowctl catalog sync: ${(e as Error).message}\n`);
        return 1;
      }
      if (json) out(JSON.stringify(result, null, 2) + '\n');
      else {
        out(
          `synced: ${result.pages} page(s) · ${result.upserted} server(s) upserted · ` +
            `${result.removed} removed · cursor ${result.lastUpdatedSince}\n`,
        );
      }
      return 0;
    }

    case 'introspect': {
      // `--as <alias>` — write under the LOCAL name specs select (registry names never match short names).
      const asIdx = rest.indexOf('--as');
      const as = asIdx >= 0 ? rest[asIdx + 1] : undefined;
      if (asIdx >= 0 && (!as || as.startsWith('-'))) {
        err(`piflowctl catalog introspect: --as requires an alias value.\n${USAGE}`);
        return 1;
      }
      // The positional server = the first non-flag arg that is NOT the --as value.
      const server = rest.find((a, i) => !a.startsWith('-') && (asIdx < 0 || i !== asIdx + 1));
      if (!server) {
        err(`piflowctl catalog introspect <server> — a server name is required.\n${USAGE}`);
        return 1;
      }
      let result: IntrospectResult;
      try {
        result = await introspect({ server, ...(as ? { as } : {}) });
      } catch (e) {
        err(`piflowctl catalog introspect: ${(e as Error).message}\n`);
        return 1;
      }
      if (json) out(JSON.stringify(result, null, 2) + '\n');
      else {
        out(`${result.server}: ${result.toolCount} tool(s)\n`);
        for (const a of result.addresses) out(`  ${a}\n`);
      }
      return 0;
    }

    default:
      err(`piflowctl catalog: unknown subcommand '${sub ?? ''}'.\n${USAGE}`);
      return 1;
  }
}
