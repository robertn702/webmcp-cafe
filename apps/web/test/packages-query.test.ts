import type { WebMcpPackage } from "@webmcp-today/schema";
import { describe, expect, it } from "vitest";
import { filterPackagesByQuery, packagePageByQuery } from "@/lib/package-query";

const pkg: WebMcpPackage = {
  id: "pkg-1",
  versionId: "ver-1",
  version: 1,
  domain: "reddit.com",
  urlPatterns: ["*://reddit.com/articles/*"],
  title: "Example Reader",
  description: "Read articles from Example.",
  contributor: "Ada Lovelace",
  createdAt: "2026-08-29T00:00:00.000Z",
  updatedAt: "2026-08-29T00:00:00.000Z",
  tools: [
    {
      name: "article_search",
      description: "Search published articles.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execution: { mode: "api", endpoint: "search" },
    },
  ],
  api: { baseUrl: "https://reddit.com", endpoints: { search: { method: "GET", path: "/api" } } },
  minEngine: 1,
};

describe("registry package text search", () => {
  it("matches every searchable served field case-insensitively before callers paginate", () => {
    const nonMatching: WebMcpPackage = {
      ...pkg,
      id: "pkg-2",
      domain: "github.com",
      urlPatterns: ["*://github.com/*"],
      title: "Other",
      description: "Unrelated",
      contributor: "Grace Hopper",
      tools: [
        {
          name: "other_tool",
          description: "Do something else.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          execution: { mode: "api", endpoint: "other" },
        },
      ],
      api: {
        baseUrl: "https://github.com",
        endpoints: { other: { method: "GET", path: "/api" } },
      },
    };
    for (const query of [
      "reader",
      "articles",
      "REDDIT.COM",
      "ada",
      "articles/*",
      "ARTICLE_SEARCH",
    ]) {
      expect(filterPackagesByQuery([nonMatching, pkg], query).slice(0, 1)).toEqual([pkg]);
    }
    expect(filterPackagesByQuery([nonMatching, pkg], "missing")).toEqual([]);

    expect(packagePageByQuery([nonMatching, pkg], "reader", 1, 1)).toEqual({
      packages: [pkg],
      total: 1,
    });
  });
});
