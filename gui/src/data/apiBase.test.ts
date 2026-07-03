import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getEndpoint, setEndpoint, api, apiFetch, apiUrl, endpointKind, planEndpointSwitch, getRememberedRemote } from "./apiBase";

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

// The endpoint-switcher logic: which side the console points at (local vs cloud) and how a one-click
// toggle resolves — the SAME `baseUrl`-is-the-only-remote-predicate law, reused as the switch target.
describe("endpointKind — baseUrl is the one remote-ness predicate", () => {
  it("maps an empty baseUrl to local and any URL to cloud", () => {
    expect(endpointKind("")).toBe("local");
    expect(endpointKind("https://x.fly.dev")).toBe("cloud");
    expect(endpointKind("http://127.0.0.1:5273")).toBe("cloud");
  });
});

describe("planEndpointSwitch — resolves the one-click toggle target", () => {
  it("cloud → local is always ready and repoints to same-origin (tokenless)", () => {
    const plan = planEndpointSwitch({ baseUrl: "https://x.fly.dev", token: "t" }, null);
    expect(plan).toEqual({ from: "cloud", to: "local", ready: true, endpoint: { baseUrl: "", token: "" } });
  });

  it("local → cloud reuses a remembered remote when one is known (one click)", () => {
    const remembered = { baseUrl: "https://x.fly.dev", token: "t" };
    const plan = planEndpointSwitch({ baseUrl: "", token: "" }, remembered);
    expect(plan).toEqual({ from: "local", to: "cloud", ready: true, endpoint: remembered });
  });

  it("local → cloud degrades to needs-input when NO remote has ever been known (never fabricates a URL)", () => {
    const plan = planEndpointSwitch({ baseUrl: "", token: "" }, null);
    expect(plan).toEqual({ from: "local", to: "cloud", ready: false });
    // a remembered entry that is itself local must not count as a cloud target
    const localRemembered = planEndpointSwitch({ baseUrl: "", token: "" }, { baseUrl: "", token: "" });
    expect(localRemembered).toEqual({ from: "local", to: "cloud", ready: false });
  });
});

describe("remembered remote — the switch confirm reuses setEndpoint, and a cloud endpoint is remembered", () => {
  beforeEach(() => setEndpoint({ baseUrl: "", token: "" }));

  it("records the last cloud endpoint on setEndpoint, and local does not overwrite it", () => {
    setEndpoint({ baseUrl: "https://x.fly.dev/", token: "tok" });
    expect(getRememberedRemote()).toEqual({ baseUrl: "https://x.fly.dev", token: "tok" });
    setEndpoint({ baseUrl: "", token: "" }); // switch to local
    expect(getRememberedRemote()).toEqual({ baseUrl: "https://x.fly.dev", token: "tok" }); // still remembered
  });

  it("applying a ready plan via setEndpoint (the repoint fn) flips the live state", () => {
    setEndpoint({ baseUrl: "https://x.fly.dev", token: "tok" }); // start on cloud
    const plan = planEndpointSwitch(getEndpoint(), getRememberedRemote());
    expect(plan.ready).toBe(true);
    if (plan.ready) setEndpoint(plan.endpoint); // exactly what the popover Confirm does
    expect(endpointKind(getEndpoint().baseUrl)).toBe("local");
    expect(getEndpoint()).toEqual({ baseUrl: "", token: "" });
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
