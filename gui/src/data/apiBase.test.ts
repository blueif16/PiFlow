import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getEndpoint, setEndpoint, api, apiFetch, apiUrl } from "./apiBase";

// The runtime endpoint store: baseUrl + bearer, repointable for the migrate switch. Every API fetch must
// carry Authorization: Bearer <token>; SSE/URL-only calls append ?token= (EventSource/<img> can't set headers).

describe("apiBase endpoint store", () => {
  beforeEach(() => setEndpoint({ baseUrl: "", token: "" }));

  it("setEndpoint updates getEndpoint and strips a trailing slash", () => {
    setEndpoint({ baseUrl: "https://x.fly.dev/", token: "tok" });
    expect(getEndpoint()).toEqual({ baseUrl: "https://x.fly.dev", token: "tok" });
  });

  it("api() prefixes the current baseUrl (same-origin when empty)", () => {
    expect(api("/x")).toBe("/x");
    setEndpoint({ baseUrl: "https://x.fly.dev" });
    expect(api("/x")).toBe("https://x.fly.dev/x");
  });

  it("apiUrl appends ?token= only when a token is set (and uses & when a query already exists)", () => {
    expect(apiUrl("/f?path=a")).toBe("/f?path=a"); // tokenless → unchanged
    setEndpoint({ baseUrl: "", token: "tok" });
    expect(apiUrl("/f")).toBe("/f?token=tok");
    expect(apiUrl("/f?path=a")).toBe("/f?path=a&token=tok");
  });
});

describe("apiFetch — carries the bearer", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    setEndpoint({ baseUrl: "", token: "" });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sets Authorization: Bearer when the endpoint carries a token", async () => {
    setEndpoint({ baseUrl: "https://x.fly.dev", token: "SECRET" });
    await apiFetch("/api/x", { method: "POST" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://x.fly.dev/api/x");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer SECRET");
    expect(init.method).toBe("POST"); // caller init preserved
  });

  it("sends NO Authorization header when the endpoint is tokenless (local same-origin)", async () => {
    await apiFetch("/api/x");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("Authorization")).toBeNull();
  });
});
