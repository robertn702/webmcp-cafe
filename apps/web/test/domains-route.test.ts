import { domainsResponseSchema } from "@webmcp-today/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/domains/route";

// The extension trusts this list to decide when to badge/register locally, so
// the shape and cache-busting contract are what's worth pinning. No test
// database: the repo layer is mocked.
const state = vi.hoisted((): { domains: string[]; version: number } => ({
  domains: [],
  version: 0,
}));

const counter = vi.hoisted(() => ({ increment: vi.fn() }));

vi.mock("@/lib/domains-repo", () => ({
  listDistinctDomains: () => Promise.resolve(state.domains),
  getDomainsVersion: () => Promise.resolve(state.version),
}));

vi.mock("@/lib/aggregate-counters", () => ({
  scheduleAggregateMetricIncrement: counter.increment,
}));

function get(headers?: HeadersInit): Promise<Response> {
  return GET(new Request("https://webmcp.today/api/domains", { headers }));
}

describe("GET /api/domains", () => {
  beforeEach(() => {
    state.domains = [];
    state.version = 0;
    counter.increment.mockClear();
  });

  it("returns an empty domain list and version 0 for an empty registry", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      version: 0,
      generatedAt: expect.any(String),
      domains: [],
    });
  });

  it("returns the distinct domains and version for a populated registry", async () => {
    state.domains = ["github.com", "reddit.com"];
    state.version = 1_700_000_000_000;

    const response = await get();
    const body = await response.json();
    expect(body.version).toBe(1_700_000_000_000);
    expect(body.domains).toEqual(["github.com", "reddit.com"]);
  });

  it("serves the shape the published wire schema describes", async () => {
    state.domains = ["github.com", "reddit.com"];
    state.version = 1_700_000_000_000;

    const response = await get();
    const parsed = domainsResponseSchema.safeParse(await response.json());
    expect(parsed.success).toBe(true);
  });

  it("sets an ETag derived from the version and domain count", async () => {
    state.domains = ["github.com", "reddit.com"];
    state.version = 1_700_000_000_000;

    const response = await get();
    expect(response.headers.get("etag")).toBe('W/"1700000000000-2"');
  });

  it("returns 304 with no body when If-None-Match matches the current ETag", async () => {
    state.domains = ["github.com", "reddit.com"];
    state.version = 1_700_000_000_000;

    const response = await get({ "if-none-match": 'W/"1700000000000-2"' });
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
    expect(counter.increment).toHaveBeenCalledWith("known_domains_fetch");
  });

  it("returns 200 when If-None-Match is stale", async () => {
    state.domains = ["github.com", "reddit.com"];
    state.version = 1_700_000_000_000;

    const response = await get({ "if-none-match": 'W/"1600000000000-2"' });
    expect(response.status).toBe(200);
    expect(counter.increment).toHaveBeenCalledWith("known_domains_fetch");
  });
});
