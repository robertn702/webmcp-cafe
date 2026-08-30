import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSiteTools,
  getSiteModelContext,
  registerSiteTools,
  type ModelContextLike,
  type SiteTool,
} from "@/lib/site-tools";

function packageBody(id: string, toolNames: string[]) {
  const endpoints = Object.fromEntries(
    toolNames.map((name) => [name, { method: "GET", path: `/${name}` }]),
  );
  return {
    id,
    versionId: `${id}-version`,
    version: 1,
    domain: "reddit.com",
    urlPatterns: ["*://reddit.com/*"],
    title: `${id} package`,
    description: `Description for ${id}.`,
    contributor: "Ada",
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    tools: toolNames.map((name) => ({
      name,
      description: `${name} description`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execution: { mode: "api", endpoint: name },
    })),
    api: { baseUrl: "https://reddit.com", endpoints },
    minEngine: 1,
  };
}

function tool(name: string): SiteTool {
  const found = createSiteTools().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("site-native WebMCP tools", () => {
  it("registers from the pre-hydration client entrypoint before Sentry", async () => {
    const source = await readFile(new URL("../instrumentation-client.ts", import.meta.url), "utf8");

    expect(source.indexOf("registerSiteTools();")).toBeGreaterThan(-1);
    expect(source.indexOf("registerSiteTools();")).toBeLessThan(source.indexOf("Sentry.init("));
  });

  it("defines four read-only descriptors with bounded schemas", () => {
    const tools = createSiteTools();
    expect(tools.map((item) => item.name)).toEqual([
      "search_packages",
      "get_package",
      "compare_packages",
      "verify_site_tools",
    ]);
    for (const item of tools) {
      expect(item.annotations).toEqual({ readOnlyHint: true, untrustedContentHint: true });
      expect(item.description.length).toBeLessThanOrEqual(500);
    }
    expect(tool("search_packages").inputSchema).toMatchObject({
      properties: { query: { maxLength: 200 }, limit: { minimum: 1, maximum: 20 } },
    });
  });

  it("searches the same-origin list API and returns concise summaries", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        Response.json({
          packages: [packageBody("pkg-1", ["read"])],
          total: 1,
          page: 1,
          pageSize: 3,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await tool("search_packages").execute({
      query: "read",
      domain: "reddit.com",
      limit: 3,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/packages?q=read&page=1&pageSize=3&domain=reddit.com",
    );
    expect(result).toEqual({
      total: 1,
      packages: [
        {
          id: "pkg-1",
          title: "pkg-1 package",
          description: "Description for pkg-1.",
          domain: "reddit.com",
          contributor: "Ada",
          toolNames: ["read"],
        },
      ],
    });
  });

  it("gets packages, compares their common and unique tools, and verifies URL matches", async () => {
    const alpha = packageBody("alpha", ["shared", "alpha_only"]);
    const beta = packageBody("beta", ["shared", "beta_only"]);
    const fetchMock = vi.fn((path: string) => {
      if (path === "/api/packages/alpha") return Promise.resolve(Response.json(alpha));
      if (path === "/api/packages/beta") return Promise.resolve(Response.json(beta));
      return Promise.resolve(Response.json({ packages: [alpha] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const getResult = await tool("get_package").execute({ id: "alpha" });
    expect(getResult).toEqual(
      expect.objectContaining({
        id: "alpha",
        tools: expect.arrayContaining([expect.objectContaining({ name: "shared" })]),
      }),
    );

    const comparison = await tool("compare_packages").execute({ ids: ["alpha", "beta"] });
    expect(comparison).toEqual({
      packages: [
        expect.objectContaining({ id: "alpha", toolNames: ["shared", "alpha_only"] }),
        expect.objectContaining({ id: "beta", toolNames: ["shared", "beta_only"] }),
      ],
      commonToolNames: ["shared"],
      uniqueToolNames: [
        { id: "alpha", toolNames: ["alpha_only"] },
        { id: "beta", toolNames: ["beta_only"] },
      ],
    });

    const verified = await tool("verify_site_tools").execute({
      url: "https://reddit.com/page?token=secret#private",
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/packages/lookup?url=https%3A%2F%2Freddit.com%2Fpage",
    );
    expect(verified).toEqual(
      expect.objectContaining({
        url: "https://reddit.com/page",
        packages: expect.arrayContaining([
          expect.objectContaining({
            id: "alpha",
            tools: expect.arrayContaining([
              expect.objectContaining({ name: "shared", description: "shared description" }),
            ]),
          }),
        ]),
      }),
    );
  });

  it("returns plain JSON errors for invalid inputs and HTTP failures", async () => {
    const invalid = await tool("search_packages").execute({ query: "" });
    expect(invalid).toEqual({ error: expect.any(String) });

    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 500 }))),
    );
    const failed = await tool("get_package").execute({ id: "missing" });
    expect(failed).toEqual({ error: "Registry request failed (500)" });

    const badUrl = await tool("verify_site_tools").execute({ url: "ftp://reddit.com" });
    expect(badUrl).toEqual({ error: expect.any(String) });

    const malformedUrl = await tool("verify_site_tools").execute({ url: "not-a-url" });
    expect(malformedUrl).toEqual({ error: expect.any(String) });

    const credentialedUrl = await tool("verify_site_tools").execute({
      url: "https://user:password@reddit.com/page",
    });
    expect(credentialedUrl).toEqual({ error: expect.any(String) });
  });

  it("prefers document, no-ops without WebMCP, and continues after rejection", async () => {
    const documentCalls: SiteTool[] = [];
    const navigatorCalls: SiteTool[] = [];
    const documentContext: ModelContextLike = {
      registerTool(item) {
        documentCalls.push(item);
        return Promise.resolve(undefined);
      },
    };
    const navigatorContext: ModelContextLike = {
      registerTool(item) {
        navigatorCalls.push(item);
        return Promise.resolve(undefined);
      },
    };
    vi.stubGlobal("document", { modelContext: documentContext });
    vi.stubGlobal("navigator", { modelContext: navigatorContext });
    expect(getSiteModelContext()).toBe(documentContext);

    const calls: SiteTool[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const registerTool = vi.fn((item: SiteTool) => {
      calls.push(item);
      return item.name === "get_package"
        ? Promise.reject(new Error("duplicate"))
        : Promise.resolve(undefined);
    });
    const rejectingContext: ModelContextLike = {
      registerTool,
    };
    const registration = registerSiteTools(rejectingContext);
    await registration.ready;
    expect(calls).toHaveLength(4);
    expect(registerTool.mock.calls.every((args) => args.length === 1)).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      '[webmcp-today] Failed to register site tool "get_package":',
      expect.any(Error),
    );

    vi.stubGlobal("document", {});
    vi.stubGlobal("navigator", {});
    const unsupported = registerSiteTools();
    await expect(unsupported.ready).resolves.toBeUndefined();
    expect(documentCalls).toEqual([]);
    expect(navigatorCalls).toEqual([]);
  });
});
