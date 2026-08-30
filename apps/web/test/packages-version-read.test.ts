import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getVersion } from "@/app/api/packages/[id]/versions/[versionId]/route";
import { GET as getVersionList } from "@/app/api/packages/[id]/versions/route";

// A local install pins by possession, so it fetches one exact version rather
// than "latest" — these two reads are the only version-addressed surface in the
// API. There is no test database here: the repo layer is mocked so the routes'
// own behaviour (404 on unknown, list shape, order pass-through) is what gets
// exercised.
const state = vi.hoisted(
  (): {
    packages: Record<string, unknown>;
    versions: { versionId: string; version: number; changelog: string | null; createdAt: Date }[];
  } => ({ packages: {}, versions: [] }),
);

const counter = vi.hoisted(() => ({ increment: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: {} }));

vi.mock("@/lib/api-auth", () => ({ getAuthUserId: () => Promise.resolve(null) }));

vi.mock("@/lib/mutations", () => ({
  publishVersion: () => Promise.resolve({ versionId: "ver-1", version: 1 }),
}));

// Mocked wholesale, so every export the two route modules import lives here.
vi.mock("@/lib/packages-repo", () => ({
  getPackageAtVersion: (id: string, versionId: string) =>
    Promise.resolve(state.packages[id + "/" + versionId] ?? null),
  listVersions: () => Promise.resolve(state.versions),
}));

vi.mock("@/lib/aggregate-counters", () => ({
  scheduleAggregateMetricIncrement: counter.increment,
}));

const packageAtV1 = {
  id: "pkg-1",
  versionId: "ver-1",
  version: 1,
  domain: "reddit.com",
  urlPatterns: ["*://*.reddit.com/*"],
  title: "Reddit",
  description: "Read and search Reddit",
  tools: [],
  contributor: "robert",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

function readVersion(id: string, versionId: string): Promise<Response> {
  return getVersion(new Request("https://webmcp.today/api/packages/x/versions/y"), {
    params: Promise.resolve({ id, versionId }),
  });
}

function readVersionList(id: string): Promise<Response> {
  return getVersionList(new Request("https://webmcp.today/api/packages/x/versions"), {
    params: Promise.resolve({ id }),
  });
}

describe("GET /api/packages/:id/versions/:versionId", () => {
  beforeEach(() => {
    state.packages = { "pkg-1/ver-1": packageAtV1 };
    counter.increment.mockClear();
  });

  it("serves the package document at that exact version", async () => {
    const response = await readVersion("pkg-1", "ver-1");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(packageAtV1);
    expect(counter.increment).toHaveBeenCalledWith("package_definition_get");
  });

  it("404s on a version that does not belong to this package", async () => {
    const response = await readVersion("pkg-1", "ver-9");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Package version not found" });
    expect(counter.increment).not.toHaveBeenCalled();
  });

  it("404s on an unknown package", async () => {
    const response = await readVersion("pkg-nope", "ver-1");
    expect(response.status).toBe(404);
  });
});

describe("GET /api/packages/:id/versions", () => {
  beforeEach(() => {
    state.versions = [
      {
        versionId: "ver-3",
        version: 3,
        changelog: "Fix the search tool",
        createdAt: new Date("2026-07-03T00:00:00.000Z"),
      },
      {
        versionId: "ver-2",
        version: 2,
        changelog: null,
        createdAt: new Date("2026-07-02T00:00:00.000Z"),
      },
      {
        versionId: "ver-1",
        version: 1,
        changelog: null,
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    ];
  });

  it("lists versions newest first", async () => {
    const response = await readVersionList("pkg-1");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.versions.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]);
  });

  it("serves versionId, version, changelog and createdAt", async () => {
    const response = await readVersionList("pkg-1");
    const body = await response.json();
    expect(body.versions[0]).toEqual({
      versionId: "ver-3",
      version: 3,
      changelog: "Fix the search tool",
      createdAt: "2026-07-03T00:00:00.000Z",
    });
  });

  it("404s when the package has no versions, which means it does not exist", async () => {
    state.versions = [];
    const response = await readVersionList("pkg-nope");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Package not found" });
  });
});
