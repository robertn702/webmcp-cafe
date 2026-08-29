import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/packages/route";

const state = vi.hoisted(
  (): {
    calls: unknown[];
  } => ({ calls: [] }),
);

vi.mock("@/lib/packages-repo", () => ({
  listPackages: (opts: unknown) => {
    state.calls.push(opts);
    return Promise.resolve({ packages: [], total: 0 });
  },
}));

// This file exercises GET only. The route module also exports POST, whose
// imports otherwise initialize auth and database environment validation.
vi.mock("@/lib/api-auth", () => ({ getAuthUserId: () => Promise.resolve(null) }));
vi.mock("@/lib/mutations", () => ({ insertPackage: () => Promise.reject(new Error("unused")) }));

describe("GET /api/packages search", () => {
  beforeEach(() => {
    state.calls = [];
  });

  it("forwards a trimmed query with the existing browse filters", async () => {
    const response = await GET(
      new Request(
        "https://webmcp.today/api/packages?q=%20reddit%20&domain=reddit.com&page=2&pageSize=5",
      ),
    );

    expect(response.status).toBe(200);
    expect(state.calls).toEqual([{ q: "reddit", domain: "reddit.com", page: 2, pageSize: 5 }]);
  });

  it("rejects queries over the public 200-character bound", async () => {
    const response = await GET(
      new Request(`https://webmcp.today/api/packages?q=${"x".repeat(201)}`),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "q must be at most 200 characters" });
    expect(state.calls).toEqual([]);
  });
});
