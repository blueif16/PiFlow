import { describe, it, expect } from "vitest";
import { pushTemplate, deriveTemplateIdentity } from "../src/template-push.js";
import type { ContextEntry } from "../src/context-store.js";

// `cloud push` packs a LOCAL template dir and POSTs it to a cloud plane's /__piflow/templates. The teeth: the
// EXACT request (url + product/workflow query + gzip body + bearer) and graceful degradation on a non-202 (so a
// bake-only plane that 501s doesn't crash the run — the caller falls back to sending the local path).

const CLOUD = { baseUrl: "https://plane.example.com", token: "sekret" } as ContextEntry;

function fakeFetch(status: number, json: unknown) {
  const calls: { url: string; init: any }[] = [];
  const impl = (async (url: unknown, init: any) => {
    calls.push({ url: String(url), init });
    return { status, json: async () => json, text: async () => JSON.stringify(json) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("deriveTemplateIdentity", () => {
  it("derives workflow=<wf> from a .piflow/<wf>/template dir; product defaults to it", () => {
    expect(deriveTemplateIdentity("/repo/.piflow/example-academy/template")).toEqual({
      product: "example-academy",
      workflow: "example-academy",
    });
  });

  it("honors explicit product/workflow overrides", () => {
    expect(deriveTemplateIdentity("/repo/.piflow/wf/template", { product: "prod", workflow: "flow" })).toEqual({
      product: "prod",
      workflow: "flow",
    });
  });
});

describe("pushTemplate", () => {
  it("packs the template and POSTs it to /__piflow/templates with the product/workflow query + bearer", async () => {
    const { impl, calls } = fakeFetch(202, {
      installed: true,
      templateDir: "/home/piflow/uploads/example-academy/.piflow/example-academy/template",
      product: "example-academy",
      workflow: "example-academy",
    });
    const packDir = async () => Buffer.from("BUNDLE");
    const r = await pushTemplate(CLOUD, "/repo/.piflow/example-academy/template", {}, { fetchImpl: impl, packDir });

    expect(r.ok).toBe(true);
    expect(r.status).toBe(202);
    expect(r.templateDir).toBe("/home/piflow/uploads/example-academy/.piflow/example-academy/template");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://plane.example.com/__piflow/templates?product=example-academy&workflow=example-academy");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers["Content-Type"]).toBe("application/gzip");
    expect(calls[0].init.headers.Authorization).toBe("Bearer sekret");
    expect((calls[0].init.body as Buffer).toString()).toBe("BUNDLE");
  });

  it("returns ok:false on a non-202 (501 push disabled) so the caller can degrade gracefully", async () => {
    const { impl } = fakeFetch(501, { error: "template push not enabled" });
    const r = await pushTemplate(CLOUD, "/repo/.piflow/wf/template", {}, { fetchImpl: impl, packDir: async () => Buffer.from("x") });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(501);
  });

  it("sends NO Authorization header for a tokenless (local) entry", async () => {
    const { impl, calls } = fakeFetch(202, { installed: true, templateDir: "/x", product: "wf", workflow: "wf" });
    await pushTemplate({ baseUrl: "http://127.0.0.1:5273" } as ContextEntry, "/repo/.piflow/wf/template", {}, { fetchImpl: impl, packDir: async () => Buffer.from("x") });
    expect(calls[0].init.headers.Authorization).toBeUndefined();
  });
});
