import { describe, expect, it } from "vitest";
import { ENGINE_VERSION, type RevocationEntry } from "@webmcp-today/schema";
import { handleBridgeRequest, type BridgeDeps } from "../src/lib/install-bridge.js";
import { createInstallsStore, type ReadySchemaState } from "../src/lib/installs-store.js";
import { INDEX_KEY, REVOKED_KEY, pkgKey, type RevokedDoc } from "../src/lib/store-schema.js";
import { createFakeStorageArea, type FakeStorageArea } from "./fake-storage-area.js";

const ORIGIN = "https://webmcp.today";

const API_BLOCK = {
  baseUrl: "https://en.wikipedia.org",
  endpoints: { summary: { method: "GET", path: "/api/rest_v1/page/summary" } },
};

/** A registry-served body, as the versions endpoint returns it. */
function servedPackage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "pkg-wiki",
    versionId: "ver-1",
    version: 1,
    domain: "en.wikipedia.org",
    urlPatterns: ["*://en.wikipedia.org/wiki/*"],
    title: "Wikipedia article",
    description: "Fixture package",
    contributor: "robert",
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
    minEngine: 1,
    tools: [
      {
        name: "wiki_summary",
        description: "wiki_summary fixture tool",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
        execution: { mode: "api", endpoint: "summary" },
      },
    ],
    api: API_BLOCK,
    ...overrides,
  };
}

function revokedDoc(entries: RevocationEntry[] = []): RevokedDoc {
  return { cursor: 1, fetchedAt: "2026-07-27T00:00:00.000Z", entries };
}

function revocation(id: number, packageId: string, versionId: string | null): RevocationEntry {
  return {
    id,
    packageId,
    versionId,
    reason: `reason ${id}`,
    revokedAt: "2026-07-27T00:00:00.000Z",
  };
}

/** Prefix-routed fetch stub; "network-error" rejects, a number is a bare
 *  HTTP status, anything else is a 200 JSON body. */
function fetchRouter(routes: Record<string, unknown | "network-error" | number>): {
  calls: string[];
  fetchFn: (url: string) => Promise<Response>;
} {
  const calls: string[] = [];
  return {
    calls,
    fetchFn: async (url: string) => {
      calls.push(url);
      for (const [prefix, value] of Object.entries(routes)) {
        if (!url.startsWith(prefix)) continue;
        if (value === "network-error") throw new Error("network down");
        if (typeof value === "number") return new Response("nope", { status: value });
        return new Response(JSON.stringify(value), { status: 200 });
      }
      return new Response("unstubbed", { status: 500 });
    },
  };
}

function versionRoute(body: unknown | "network-error" | number = servedPackage()) {
  return { [`${ORIGIN}/api/packages/`]: body };
}

function makeDeps(opts: {
  area?: FakeStorageArea;
  routes?: Record<string, unknown | "network-error" | number>;
  schemaState?: ReadySchemaState;
}): {
  deps: BridgeDeps;
  area: FakeStorageArea;
  calls: string[];
} {
  const area = opts.area ?? createFakeStorageArea();
  const { calls, fetchFn } = fetchRouter(opts.routes ?? {});
  return {
    area,
    calls,
    deps: {
      store: createInstallsStore(area),
      area,
      fetchFn,
      extensionVersion: "0.0.1",
      ensureInitialized: () => Promise.resolve(opts.schemaState ?? "ok"),
    },
  };
}

function installMessage(overrides: Record<string, unknown> = {}) {
  return { v: 1, type: "install", packageId: "pkg-wiki", versionId: "ver-1", ...overrides };
}

describe("handleBridgeRequest", () => {
  describe("origin allowlist", () => {
    it("ignores messages from a non-allowlisted origin — no response, no fetch", async () => {
      const { deps, calls } = makeDeps({ routes: versionRoute() });

      const response = await handleBridgeRequest(installMessage(), "https://evil.com", deps);

      expect(response).toBeUndefined();
      expect(calls).toEqual([]);
    });

    it("ignores messages with no sender origin", async () => {
      const { deps, calls } = makeDeps({ routes: versionRoute() });

      const response = await handleBridgeRequest({ v: 1, type: "ping" }, undefined, deps);

      expect(response).toBeUndefined();
      expect(calls).toEqual([]);
    });
  });

  describe("message validation", () => {
    it.each([
      ["garbage", { nonsense: true }],
      ["the wrong protocol version", { v: 2, type: "ping" }],
      ["an unknown type", { v: 1, type: "explode" }],
      ["an install missing versionId", { v: 1, type: "install", packageId: "pkg-wiki" }],
    ])("refuses %s with bad-request", async (_label, message) => {
      const { deps, calls } = makeDeps({ routes: versionRoute() });

      const response = await handleBridgeRequest(message, ORIGIN, deps);

      expect(response).toEqual({ ok: false, reason: "bad-request" });
      expect(calls).toEqual([]);
    });
  });

  describe("ping", () => {
    it("reports protocol, engine, version and a readable store", async () => {
      const { deps } = makeDeps({});

      const response = await handleBridgeRequest({ v: 1, type: "ping" }, ORIGIN, deps);

      expect(response).toEqual({
        ok: true,
        protocol: 1,
        engine: ENGINE_VERSION,
        extensionVersion: "0.0.1",
        storageReadable: true,
      });
    });

    it("reports storageReadable: false when the schema version guard fails", async () => {
      const { deps } = makeDeps({ schemaState: "newer" });

      const response = await handleBridgeRequest({ v: 1, type: "ping" }, ORIGIN, deps);

      expect(response).toMatchObject({ ok: true, storageReadable: false });
    });
  });

  describe("install", () => {
    it("fetches the body from the SENDER's origin and stores it atomically", async () => {
      const area = createFakeStorageArea({ [REVOKED_KEY]: revokedDoc() });
      const { deps, calls } = makeDeps({ area, routes: versionRoute() });

      const response = await handleBridgeRequest(installMessage(), ORIGIN, deps);

      expect(response).toEqual({
        ok: true,
        packageId: "pkg-wiki",
        versionId: "ver-1",
        version: 1,
      });
      expect(calls).toEqual([`${ORIGIN}/api/packages/pkg-wiki/versions/ver-1`]);
      const snapshot = area.snapshot();
      expect(snapshot[pkgKey("pkg-wiki")]).toEqual(servedPackage());
      expect(snapshot[INDEX_KEY]).toMatchObject({
        "pkg-wiki": { packageId: "pkg-wiki", versionId: "ver-1", origin: ORIGIN },
      });
    });

    it("bootstraps the revocation list on first install when it is absent", async () => {
      const area = createFakeStorageArea();
      const { deps, calls } = makeDeps({
        area,
        routes: {
          [`${ORIGIN}/api/packages/`]: servedPackage(),
          [`${ORIGIN}/api/revocations`]: { cursor: 0, latest: 0, entries: [] },
        },
      });

      const response = await handleBridgeRequest(installMessage(), ORIGIN, deps);

      expect(response).toMatchObject({ ok: true });
      expect(calls[0]).toBe(`${ORIGIN}/api/packages/pkg-wiki/versions/ver-1`);
      expect(calls[1]).toBe(`${ORIGIN}/api/revocations?since=0`);
      expect(area.snapshot()[REVOKED_KEY]).toBeDefined();
    });

    it("refuses with revocation-unavailable when the bootstrap poll fails, writing nothing", async () => {
      const area = createFakeStorageArea();
      const { deps } = makeDeps({
        area,
        routes: {
          [`${ORIGIN}/api/packages/`]: servedPackage(),
          [`${ORIGIN}/api/revocations`]: "network-error",
        },
      });

      const response = await handleBridgeRequest(installMessage(), ORIGIN, deps);

      expect(response).toEqual({ ok: false, reason: "revocation-unavailable" });
      expect(area.snapshot()).toEqual({});
    });

    it("refuses a revoked package, writing nothing", async () => {
      const area = createFakeStorageArea({
        [REVOKED_KEY]: revokedDoc([revocation(1, "pkg-wiki", null)]),
      });
      const { deps } = makeDeps({ area, routes: versionRoute() });

      const response = await handleBridgeRequest(installMessage(), ORIGIN, deps);

      expect(response).toEqual({ ok: false, reason: "revoked" });
      expect(area.snapshot()[pkgKey("pkg-wiki")]).toBeUndefined();
    });

    it("refuses a revoked VERSION even when the package itself is not revoked", async () => {
      const area = createFakeStorageArea({
        [REVOKED_KEY]: revokedDoc([revocation(1, "pkg-wiki", "ver-1")]),
      });
      const { deps } = makeDeps({ area, routes: versionRoute() });

      const response = await handleBridgeRequest(installMessage(), ORIGIN, deps);

      expect(response).toEqual({ ok: false, reason: "revoked" });
    });

    it("maps a 404 to not-found and other HTTP failures to network", async () => {
      const area = createFakeStorageArea({ [REVOKED_KEY]: revokedDoc() });

      const notFound = makeDeps({ area, routes: versionRoute(404) });
      expect(await handleBridgeRequest(installMessage(), ORIGIN, notFound.deps)).toEqual({
        ok: false,
        reason: "not-found",
      });

      const broken = makeDeps({ area, routes: versionRoute(500) });
      expect(await handleBridgeRequest(installMessage(), ORIGIN, broken.deps)).toEqual({
        ok: false,
        reason: "network",
      });

      const down = makeDeps({ area, routes: versionRoute("network-error") });
      expect(await handleBridgeRequest(installMessage(), ORIGIN, down.deps)).toEqual({
        ok: false,
        reason: "network",
      });
      expect(area.snapshot()[pkgKey("pkg-wiki")]).toBeUndefined();
    });

    it("refuses a body that fails the package schema", async () => {
      const area = createFakeStorageArea({ [REVOKED_KEY]: revokedDoc() });
      const { deps } = makeDeps({ area, routes: versionRoute({ nonsense: true }) });

      const response = await handleBridgeRequest(installMessage(), ORIGIN, deps);

      expect(response).toEqual({ ok: false, reason: "invalid-body" });
      expect(area.snapshot()[pkgKey("pkg-wiki")]).toBeUndefined();
    });

    it("refuses when the served ids don't match the requested ids", async () => {
      const area = createFakeStorageArea({ [REVOKED_KEY]: revokedDoc() });
      const { deps } = makeDeps({
        area,
        routes: versionRoute(servedPackage({ id: "pkg-other" })),
      });

      const response = await handleBridgeRequest(installMessage(), ORIGIN, deps);

      expect(response).toEqual({ ok: false, reason: "id-mismatch" });
      expect(area.snapshot()).toEqual({ [REVOKED_KEY]: revokedDoc() });
    });

    it("upserts: reinstalling a newer version reports the replaced pin", async () => {
      const area = createFakeStorageArea({ [REVOKED_KEY]: revokedDoc() });
      const first = makeDeps({ area, routes: versionRoute() });
      await handleBridgeRequest(installMessage(), ORIGIN, first.deps);

      const second = makeDeps({
        area,
        routes: versionRoute(servedPackage({ versionId: "ver-2", version: 2 })),
      });
      const response = await handleBridgeRequest(
        installMessage({ versionId: "ver-2" }),
        ORIGIN,
        second.deps,
      );

      expect(response).toEqual({
        ok: true,
        packageId: "pkg-wiki",
        versionId: "ver-2",
        version: 2,
        replaced: { versionId: "ver-1", version: 1 },
      });
    });

    it("refuses with storage-unreadable before any fetch when the schema guard fails", async () => {
      const { deps, calls } = makeDeps({ routes: versionRoute(), schemaState: "newer" });

      const response = await handleBridgeRequest(installMessage(), ORIGIN, deps);

      expect(response).toEqual({ ok: false, reason: "storage-unreadable" });
      expect(calls).toEqual([]);
    });

    it("maps a failed storage write to quota, leaving nothing behind", async () => {
      const area = createFakeStorageArea({ [REVOKED_KEY]: revokedDoc() });
      area.failNextSet();
      const { deps } = makeDeps({ area, routes: versionRoute() });

      const response = await handleBridgeRequest(installMessage(), ORIGIN, deps);

      expect(response).toEqual({ ok: false, reason: "quota" });
      expect(area.snapshot()).toEqual({ [REVOKED_KEY]: revokedDoc() });
    });
  });

  describe("uninstall", () => {
    it("removes an installed package", async () => {
      const area = createFakeStorageArea({ [REVOKED_KEY]: revokedDoc() });
      const installed = makeDeps({ area, routes: versionRoute() });
      await handleBridgeRequest(installMessage(), ORIGIN, installed.deps);

      const { deps } = makeDeps({ area });
      const response = await handleBridgeRequest(
        { v: 1, type: "uninstall", packageId: "pkg-wiki" },
        ORIGIN,
        deps,
      );

      expect(response).toEqual({ ok: true });
      expect(area.snapshot()[pkgKey("pkg-wiki")]).toBeUndefined();
      expect(area.snapshot()[INDEX_KEY]).toEqual({});
    });

    it("reports not-installed for an unknown package", async () => {
      const { deps } = makeDeps({});

      const response = await handleBridgeRequest(
        { v: 1, type: "uninstall", packageId: "pkg-nope" },
        ORIGIN,
        deps,
      );

      expect(response).toEqual({ ok: false, reason: "not-installed" });
    });

    it("reports storage-unreadable when the schema guard fails", async () => {
      const { deps } = makeDeps({ schemaState: "newer" });

      const response = await handleBridgeRequest(
        { v: 1, type: "uninstall", packageId: "pkg-wiki" },
        ORIGIN,
        deps,
      );

      expect(response).toEqual({ ok: false, reason: "storage-unreadable" });
    });
  });

  describe("list-installs", () => {
    it("returns an empty list for a fresh store", async () => {
      const { deps } = makeDeps({});

      const response = await handleBridgeRequest({ v: 1, type: "list-installs" }, ORIGIN, deps);

      expect(response).toEqual({ ok: true, installs: [] });
    });

    it("lists installed packages with their state", async () => {
      const area = createFakeStorageArea({ [REVOKED_KEY]: revokedDoc() });
      const installed = makeDeps({ area, routes: versionRoute() });
      await handleBridgeRequest(installMessage(), ORIGIN, installed.deps);

      const { deps } = makeDeps({ area });
      const response = await handleBridgeRequest({ v: 1, type: "list-installs" }, ORIGIN, deps);

      expect(response).toMatchObject({
        ok: true,
        installs: [
          {
            packageId: "pkg-wiki",
            versionId: "ver-1",
            version: 1,
            title: "Wikipedia article",
            domain: "en.wikipedia.org",
            state: "ok",
          },
        ],
      });
    });

    it("marks a revoked install as revoked", async () => {
      const area = createFakeStorageArea({ [REVOKED_KEY]: revokedDoc() });
      const installed = makeDeps({ area, routes: versionRoute() });
      await handleBridgeRequest(installMessage(), ORIGIN, installed.deps);
      await area.set({
        [REVOKED_KEY]: revokedDoc([revocation(2, "pkg-wiki", null)]),
      });

      const { deps } = makeDeps({ area });
      const response = await handleBridgeRequest({ v: 1, type: "list-installs" }, ORIGIN, deps);

      expect(response).toMatchObject({ ok: true, installs: [{ state: "revoked" }] });
    });

    it("reads as empty when the schema guard fails", async () => {
      const { deps } = makeDeps({ schemaState: "newer" });

      const response = await handleBridgeRequest({ v: 1, type: "list-installs" }, ORIGIN, deps);

      expect(response).toEqual({ ok: true, installs: [] });
    });
  });
});
