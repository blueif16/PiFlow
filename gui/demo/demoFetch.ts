/**
 * demoFetch — the static-demo data shim.
 *
 * The GUI talks to a Vite dev middleware over `/__piflow/*` endpoints (index, run-view,
 * stream, tree, agents, node-config, control, …). In the published static demo THERE IS
 * NO SERVER, so this module answers those calls from data bundled into the build at
 * `site-piflow/demo-data/**` — making the demo 100% static (zero network calls to `/__piflow/*`).
 *
 * It MUST be imported FIRST in `main.tsx` (before any React/component module), because it
 * patches the two browser primitives the data layer uses — `window.fetch` (runIndex,
 * runView, tree, agents, node-config, …) and `window.EventSource` (the live SSE feeds in
 * runStream + controlSession) — and those primitives are read at call time, so installing
 * the wrapper before the app mounts is sufficient (no component touches them at import).
 *
 * Bundled coverage:
 *   - GET /__piflow/index.json          → the trimmed global index (2 done runs).
 *   - GET /__piflow/run-view/<id>       → the distilled run-view for a bundled run.
 *   - GET /__piflow/tree/<id>           → the run's on-disk file tree (when bundled).
 *   - GET /__piflow/agents.json         → the agent-preset catalog (node icons).
 *   - any other /__piflow/...           → an INERT success (empty object / 200 ok / an
 *     immediately-idle SSE stream) so no UI path errors or hangs. Writes (node-edit,
 *     save-run, checkpoint, control/message) are no-ops that report success.
 *   - everything NOT /__piflow/...       → the real fetch (e.g. the asset/font requests).
 *
 * Refresh: re-capture from the live dev server and re-run `npm run build:demo`
 * (see site-piflow/demo-data/README).
 */

// Eagerly bundle every JSON under the site's demo-data/** — `eager` + `import: "default"`
// inlines the parsed objects into the build, so there is no runtime fetch to disk. The data
// LIVES IN THE SITE (`site-piflow/demo-data/`, it exists only to power the marketing demo);
// Vite bundles this cross-package import fine. Keys are paths relative to THIS file, e.g.
// "../../site-piflow/demo-data/run-view/demo-fusion.json".
const dataModules = import.meta.glob<unknown>("../../site-piflow/demo-data/**/*.json", { eager: true, import: "default" });

/** Look a bundled file up by its `demo-data`-relative path (e.g. "run-view/demo-fusion.json"). */
function bundled(rel: string): unknown | undefined {
  return dataModules[`../../site-piflow/demo-data/${rel}`];
}

/** A 200 JSON Response from a plain object (mirrors the dev middleware's `sendJson`). */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Parse the pathname out of any fetch input (string | URL | Request). Relative URLs are
 *  resolved against the current origin so `/__piflow/...` always matches. */
function pathOf(input: RequestInfo | URL): string {
  const raw =
    typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  try {
    return new URL(raw, window.location.origin).pathname;
  } catch {
    return raw;
  }
}

/**
 * Resolve a `/__piflow/*` request to a bundled Response, or `null` if this shim does not
 * own the path (the caller then falls through to the real fetch / a real EventSource).
 * The id segment is decoded so an encoded run id (the client `encodeURIComponent`s it) maps
 * back onto the bundled filename.
 */
function resolvePiflow(path: string): Response | null {
  if (!path.startsWith("/__piflow/")) return null;

  // GET /__piflow/index.json
  if (path === "/__piflow/index.json") {
    const ix = bundled("index.json");
    return ix ? jsonResponse(ix) : jsonResponse({ generatedAt: new Date().toISOString(), products: [] });
  }

  // GET /__piflow/agents.json
  if (path === "/__piflow/agents.json") {
    return jsonResponse(bundled("agents.json") ?? {});
  }

  // GET /__piflow/run-view/<id>
  let m = path.match(/^\/__piflow\/run-view\/([^/]+)/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const view = bundled(`run-view/${id}.json`);
    return view ? jsonResponse(view) : jsonResponse({ error: `no bundled run-view for "${id}"` }, 404);
  }

  // GET /__piflow/tree/<id>  (the run's on-disk file navigator)
  m = path.match(/^\/__piflow\/tree\/([^/]+)/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const tree = bundled(`tree/${id}.json`);
    // Absent ⇒ inert empty tree; the canvas falls back to the run-view's produced-files tree.
    return jsonResponse(tree ?? { tree: [], truncated: false });
  }

  // GET /__piflow/node-config/<id>?node=…  (Compose mode badge) — not bundled ⇒ inert null.
  // loadNodeConfig() treats a non-2xx / { node: null } as "no authored config" (badge shows
  // "drop a gate"), so the UI never errors.
  if (path.match(/^\/__piflow\/node-config\//)) {
    return jsonResponse({ node: null });
  }

  // Everything else under /__piflow/ — preview, save-run, node-edit, checkpoint, file,
  // control/<id>/{start,message,sessions,select,new} — is an INERT success. The demo is
  // read-only; writes report ok and reads of an unbundled file return an empty body, so no
  // code path throws or hangs. (The two SSE GETs — stream + control/stream — are handled by
  // the EventSource patch below, never here.)
  return jsonResponse({ ok: true }, 200);
}

/** Install the fetch wrapper: intercept `/__piflow/*`, pass everything else through. */
const realFetch = window.fetch.bind(window);
window.fetch = function demoFetchWrapper(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const hit = resolvePiflow(pathOf(input));
  if (hit) return Promise.resolve(hit);
  return realFetch(input, init);
};

/**
 * Stub EventSource for the SSE feeds (`/__piflow/stream/<run>` in runStream,
 * `/__piflow/control/<run>/stream` in controlSession). There is no server to stream from,
 * so a real EventSource would fire `onerror` in a tight reconnect loop. Instead we return an
 * inert source that "connects" (readyState OPEN) and emits nothing — never an error.
 *
 * Why this is safe for the canvas: the flowmap renders from the bundled run-view, NOT from
 * the live stream. runStream's `onerror` only surfaces a UI error when it never received a
 * model AND the run isn't done; a silent (non-erroring) stream avoids that entirely. The
 * Companion chat (the only consumer of the control stream) is closed on load.
 *
 * A non-/__piflow EventSource (none today, but future-proof) falls back to the real one.
 */
const RealEventSource = window.EventSource;
class DemoEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readonly url: string;
  readonly withCredentials = false;
  readyState = 1; // OPEN — never errors, never reconnects
  onopen: ((this: EventSource, ev: Event) => unknown) | null = null;
  onmessage: ((this: EventSource, ev: MessageEvent) => unknown) | null = null;
  onerror: ((this: EventSource, ev: Event) => unknown) | null = null;

  constructor(url: string | URL, _init?: EventSourceInit) {
    super();
    this.url = typeof url === "string" ? url : url.href;
    // Announce OPEN on the next tick so a listener attached right after construction still fires.
    queueMicrotask(() => {
      const ev = new Event("open");
      this.onopen?.call(this as unknown as EventSource, ev);
      this.dispatchEvent(ev);
    });
  }
  close(): void {
    this.readyState = 2;
  }
}

// Only override for the demo's own SSE paths; anything else uses the native EventSource.
const EventSourceProxy = new Proxy(RealEventSource ?? (DemoEventSource as unknown as typeof EventSource), {
  construct(target, args: [string | URL, EventSourceInit?]) {
    const url = typeof args[0] === "string" ? args[0] : (args[0] as URL).href;
    const path = pathOf(url);
    if (path.startsWith("/__piflow/")) {
      return new DemoEventSource(args[0], args[1]) as unknown as object;
    }
    return Reflect.construct(target, args) as object;
  },
});
window.EventSource = EventSourceProxy as unknown as typeof EventSource;
