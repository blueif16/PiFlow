import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  hostOpenClawTool,
  type OpenClawSecretRoute,
} from '../src/tools/openclaw-host.js';
import type { SecretResolver } from '../src/types.js';

// ── S2 INTEGRATION TEST — route a SecretResolver-resolved key into the REAL tavily tool's read-location ─
//
// This is NOT a unit test of a mock, and it does NOT fabricate a provider response. It imports the ACTUAL
// installed `tavily` plugin entry (`node_modules/openclaw/dist/extensions/tavily/index.js`), runs its real
// `register(api)` on our host, captures the LAZY `tavily_search` factory, and drives the plugin's OWN
// `execute(...)`. The host's job under test: take a key from our `SecretResolver` seam (same type as
// types.ts:319) and land it where the tool reads it.
//
// THE KEY-READ PATH (forensically verified in the installed dist — re-verify on a version bump):
//   - `extensions/tavily/index.js:101` — `runTavilySearch({ cfg: resolveTavilyToolConfig(api, ctx), ... })`.
//   - `tavily-client-B74kqFH_.js:23-24` — `resolveTavilyApiKey(cfg)` reads
//       `cfg.plugins.entries.tavily.config.webSearch.apiKey` (or `process.env.TAVILY_API_KEY`).
//   - `tavily-client-B74kqFH_.js:69-70` — if no key, THROWS "needs a Tavily API key" BEFORE any network.
//   - `web-search-provider-common-B6jzKxnn.js` `postTrustedWebToolsJson` — builds the request with header
//       `Authorization: Bearer ${apiKey}` and calls the guarded fetch, which dispatches `globalThis.fetch`.
//
// HOW WE OBSERVE THE SENTINEL WITHOUT NETWORK OR A REAL KEY: we replace `globalThis.fetch` with a Vitest
// `vi.fn()`. OpenClaw's SSRF guard recognizes a vitest-mocked fetch (`runtime-fetch-*.js` `isMockedFetch`:
// `typeof fetchImpl.mock === 'object'`) and SKIPS its DNS-pinning, calling our fn directly with the real
// `init` — whose `Authorization` header is `Bearer <whatever resolveTavilyApiKey returned>`. Our fn CAPTURES
// that header and then THROWS (it does NOT return a fabricated provider body). So the assertion is on the
// value the tool WOULD SEND as auth, captured strictly BEFORE the network boundary — exactly the resolver's
// sentinel iff the host routed it. Remove the host's secret routing and the header carries no sentinel (the
// tool hits its "needs a key" gate first) → the deterministic case goes RED.

const TAVILY_ENTRY = '../../../node_modules/openclaw/dist/extensions/tavily/index.js';

const SECRET_ROUTE: OpenClawSecretRoute = {
  pluginId: 'tavily',
  varName: 'TAVILY_API_KEY',
  configPath: 'webSearch.apiKey',
};

/** A SecretResolver that returns `value` ONLY for TAVILY_API_KEY — so the asserted key is NOT host-sourced. */
function fakeResolver(value: string): SecretResolver {
  return (name) => (name === 'TAVILY_API_KEY' ? value : undefined);
}

/**
 * Replace `globalThis.fetch` with a vitest-mocked fn that captures the outgoing `Authorization` header and
 * then throws a unique abort — so the request is OBSERVED (its auth header) but NEVER completed and NEVER
 * answered with a fabricated body. Returns a getter for the captured header.
 */
function interceptFetchAuthHeader(): { getAuth: () => string | undefined; calls: () => number } {
  let captured: string | undefined;
  let count = 0;
  const fn = vi.fn(async (_url: unknown, init?: { headers?: HeadersInit }) => {
    count += 1;
    captured = new Headers(init?.headers).get('authorization') ?? undefined;
    // Refuse the call — do NOT manufacture a provider response. The test asserts on `captured` only.
    throw new Error('OC_S2_FETCH_INTERCEPTED');
  });
  globalThis.fetch = fn as unknown as typeof globalThis.fetch;
  return { getAuth: () => captured, calls: () => count };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('hostOpenClawTool — S2: SecretResolver-resolved key reaches the tavily tool read-location', () => {
  it('DETERMINISTIC: a fake resolver sentinel arrives as the tool\'s `Authorization: Bearer <sentinel>`', async () => {
    const realFetch = globalThis.fetch;
    const SENTINEL = 'tvly-S2-SENTINEL-7c3e-deterministic';
    const probe = interceptFetchAuthHeader();
    try {
      const mod = await import(TAVILY_ENTRY);

      // The tool's own execute will reject at our intercept; we assert on what it SENT, not on a result.
      await expect(
        hostOpenClawTool({
          mod,
          toolName: 'tavily_search',
          workspaceDir: '/tmp/oc-s2-tavily',
          params: { query: 'pi flow substrate adoption' },
          secrets: [SECRET_ROUTE],
          secretResolver: fakeResolver(SENTINEL),
        }),
      ).rejects.toThrow('OC_S2_FETCH_INTERCEPTED');

      // The tool got far enough to build and send the request (the key gate passed) ...
      expect(probe.calls(), 'tool should have reached the network boundary').toBe(1);
      // ... and the auth it WOULD send is exactly the resolver's sentinel — the proof the host routed it.
      expect(probe.getAuth()).toBe(`Bearer ${SENTINEL}`);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('NEGATIVE (source-of-truth): a DIFFERENT resolver value changes the auth the tool sends', async () => {
    const realFetch = globalThis.fetch;
    const OTHER = 'tvly-S2-SENTINEL-DIFFERENT-9a11';
    const probe = interceptFetchAuthHeader();
    try {
      const mod = await import(TAVILY_ENTRY);
      await expect(
        hostOpenClawTool({
          mod,
          toolName: 'tavily_search',
          workspaceDir: '/tmp/oc-s2-tavily',
          params: { query: 'pi flow substrate adoption' },
          secrets: [SECRET_ROUTE],
          secretResolver: fakeResolver(OTHER),
        }),
      ).rejects.toThrow('OC_S2_FETCH_INTERCEPTED');

      // The header tracks the resolver — proving the value is SOURCED from the resolver, not hardcoded.
      expect(probe.getAuth()).toBe(`Bearer ${OTHER}`);
      expect(probe.getAuth()).not.toContain('SENTINEL-7c3e');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('BOUNDARY: resolver returning undefined ⇒ tool hits its own "needs a key" gate, no network', async () => {
    const realFetch = globalThis.fetch;
    const probe = interceptFetchAuthHeader();
    try {
      const mod = await import(TAVILY_ENTRY);
      // No key resolved ⇒ no value written to cfg ⇒ the REAL tool throws its own pre-network key gate.
      await expect(
        hostOpenClawTool({
          mod,
          toolName: 'tavily_search',
          workspaceDir: '/tmp/oc-s2-tavily',
          params: { query: 'pi flow substrate adoption' },
          secrets: [SECRET_ROUTE],
          secretResolver: () => undefined,
        }),
      ).rejects.toThrow(/Tavily API key/);

      // The tool never reached the network boundary — confirms the value is real-gated, not fabricated.
      expect(probe.calls(), 'no key ⇒ no fetch').toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  // ── GATED LIVE CASE — runs ONLY when a real TAVILY_API_KEY is present; never faked, never mocked. ────
  // With a real key, the default env-reading resolver routes it and the tool makes a REAL Tavily call. We
  // assert the real provider response SHAPE (provider id + a results array). No key here ⇒ this SKIPS.
  it.skipIf(!process.env.TAVILY_API_KEY)(
    'GATED LIVE: real key → real tavily_search → real provider response shape',
    async () => {
      const mod = await import(TAVILY_ENTRY);
      const result = (await hostOpenClawTool({
        mod,
        toolName: 'tavily_search',
        workspaceDir: '/tmp/oc-s2-tavily-live',
        params: { query: 'OpenClaw plugin substrate', max_results: 3 },
        secrets: [SECRET_ROUTE],
        // No secretResolver ⇒ default env-reading resolver pulls the REAL TAVILY_API_KEY from process.env.
      })) as { content?: Array<{ text?: string }> };

      // tavily's tool returns a pi `jsonResult` — the JSON payload is in content[0].text.
      const text = result.content?.[0]?.text ?? '';
      const payload = JSON.parse(text) as { provider?: string; results?: unknown };
      expect(payload.provider).toBe('tavily');
      expect(Array.isArray(payload.results)).toBe(true);
    },
  );
});
