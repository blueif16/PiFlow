// The control-server ENDPOINT the GUI talks to — a runtime-mutable { baseUrl, token }, not a build-time
// const. It is repointable at runtime so the one-click migrate can switch the whole console from one serve
// to another (local ⇄ cloud) without a reload: `setEndpoint(...)` notifies subscribers, and the data hooks
// (useRunStream / useControlSession / the canvas loaders) re-subscribe to the new origin.
//
// AUTH: a cloud serve bearer-gates EVERY request (API, SSE, and the static GUI itself). The browser reaches
// the gated GUI via `?token=<t>` (EventSource can't set headers, so the serve accepts the query form) — so we
// SEED the token from the page's `?token=` param on load, and thereafter carry it on every call: `apiFetch`
// sets `Authorization: Bearer`, while `sse()` / `fileUrl` append `?token=` (EventSource and <img> can't send
// headers). A same-origin local serve is tokenless → no header/param is added and nothing changes.

import { useSyncExternalStore } from "react";

/** One control-server endpoint: where a serve lives + the bearer it (optionally) requires. */
export interface Endpoint {
  baseUrl: string;
  token: string;
}

/** Seed from the build-time default (VITE_PIFLOW_API) + the page's `?token=` (how a gated GUI is opened). */
function seedEndpoint(): Endpoint {
  const baseUrl = (import.meta.env.VITE_PIFLOW_API ?? "").replace(/\/$/, "");
  let token = "";
  try {
    token = new URLSearchParams(window.location.search).get("token") ?? "";
  } catch {
    /* no window (SSR / tests) — tokenless */
  }
  return { baseUrl, token };
}

let endpoint: Endpoint = seedEndpoint();
const listeners = new Set<() => void>();

/** The current endpoint (read at call time, so `api`/`sse`/`apiFetch` always use the live value). */
export function getEndpoint(): Endpoint {
  return endpoint;
}

/**
 * Re-point the console to a different serve (the migrate switch). Replaces the endpoint object (so
 * useSyncExternalStore detects the change) and notifies subscribers → the data hooks reconnect.
 */
export function setEndpoint(next: { baseUrl: string; token?: string }): void {
  endpoint = { baseUrl: next.baseUrl.replace(/\/$/, ""), token: next.token ?? "" };
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** React hook: the current endpoint. Components re-render (and endpoint-keyed effects re-run) on `setEndpoint`. */
export function useEndpoint(): Endpoint {
  return useSyncExternalStore(subscribe, getEndpoint, getEndpoint);
}

/** Absolute URL for a control-server path against the current baseUrl (`""` = same-origin). */
export const api = (p: string) => `${endpoint.baseUrl}${p}`;

/** Append `?token=` to a URL when the current endpoint carries a bearer (for EventSource / <img> / URL-only fetch). */
function withToken(url: string): string {
  if (!endpoint.token) return url;
  return url + (url.includes("?") ? "&" : "?") + `token=${encodeURIComponent(endpoint.token)}`;
}

/** `fetch` a control-server path against the current endpoint, carrying the bearer as an Authorization header. */
export function apiFetch(p: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (endpoint.token) headers.set("Authorization", `Bearer ${endpoint.token}`);
  return fetch(api(p), { ...init, headers });
}

/** Open an SSE stream for a control-server path (bearer rides `?token=` since EventSource can't set headers). */
export const sse = (p: string) => new EventSource(withToken(api(p)));

/** A direct, token-carrying URL for a control-server path (used where a raw URL is needed: <img>, URL-only fetch). */
export const apiUrl = (p: string) => withToken(api(p));
