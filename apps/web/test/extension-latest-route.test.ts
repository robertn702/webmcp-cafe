import { beforeEach, describe, expect, it, vi } from "vitest";
import { dynamic, GET } from "@/app/api/extension/latest/route";

const state = vi.hoisted((): { release: unknown; error: Error | undefined } => ({
  release: undefined,
  error: undefined,
}));

const counter = vi.hoisted(() => ({ increment: vi.fn() }));

vi.mock("@/lib/extension-release", () => ({
  getLatestExtensionRelease: () => {
    if (state.error !== undefined) return Promise.reject(state.error);
    return Promise.resolve(state.release);
  },
}));

vi.mock("@/lib/aggregate-counters", () => ({
  scheduleAggregateMetricIncrement: counter.increment,
}));

const release = {
  channel: "stable",
  version: "1.0.3",
  releaseUrl: "https://github.com/robertn702/webmcp-today/releases/tag/extension-v1.0.3",
  downloadUrl:
    "https://github.com/robertn702/webmcp-today/releases/download/extension-v1.0.3/webmcp-today-extension-1.0.3.zip",
  checksumsUrl:
    "https://github.com/robertn702/webmcp-today/releases/download/extension-v1.0.3/SHA256SUMS",
  publishedAt: "2026-08-05T12:00:00Z",
};

describe("GET /api/extension/latest", () => {
  beforeEach(() => {
    state.release = undefined;
    state.error = undefined;
    counter.increment.mockClear();
  });

  it("returns the validated release document with a shared cache policy", async () => {
    state.release = release;

    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    await expect(response.json()).resolves.toEqual(release);
    expect(counter.increment).toHaveBeenCalledWith("release_document_fetch");
  });

  it("uses the uncached Next 15 GET default so only requests reach counter scheduling", () => {
    expect(dynamic).toBe("auto");
  });

  it("does not manufacture a release when none is valid or GitHub is unavailable", async () => {
    await expect(GET()).resolves.toMatchObject({ status: 404 });

    state.error = new Error("GitHub unavailable");
    await expect(GET()).resolves.toMatchObject({ status: 503 });
    expect(counter.increment).not.toHaveBeenCalled();
  });
});
