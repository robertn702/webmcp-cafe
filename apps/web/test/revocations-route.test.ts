import { revocationsResponseSchema } from "@webmcp-today/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/revocations/route";

// The kill list is the only lever the registry keeps once package bodies live on
// the client's disk, and the client drives it entirely through the cursor — so
// cursor handling is the contract worth pinning. No test database: the repo
// layer is mocked and records the cursor it was called with.
const state = vi.hoisted(
  (): {
    rows: {
      id: number;
      packageId: string;
      versionId: string | null;
      reason: string;
      revokedAt: Date;
    }[];
    cursors: number[];
  } => ({ rows: [], cursors: [] }),
);

const counter = vi.hoisted(() => ({ increment: vi.fn() }));

vi.mock("@/lib/revocations-repo", () => ({
  listRevocationsSince: (cursor: number) => {
    state.cursors.push(cursor);
    return Promise.resolve(state.rows.filter((row) => row.id > cursor));
  },
  getLatestRevocationId: () => {
    const max = state.rows.reduce((acc, row) => Math.max(acc, row.id), 0);
    // pg returns max(bigserial) as a raw string; the route must coerce, and the
    // toEqual/wire-schema assertions below fail if it ever stops.
    return Promise.resolve(String(max));
  },
}));

vi.mock("@/lib/aggregate-counters", () => ({
  scheduleAggregateMetricIncrement: counter.increment,
}));

function revoked(id: number, versionId: string | null): (typeof state.rows)[number] {
  return {
    id,
    packageId: "pkg-" + id,
    versionId,
    reason: "Exfiltrated form values",
    revokedAt: new Date("2026-07-0" + id + "T00:00:00.000Z"),
  };
}

function get(query: string): Promise<Response> {
  return GET(new Request("https://webmcp.today/api/revocations" + query));
}

describe("GET /api/revocations", () => {
  beforeEach(() => {
    state.rows = [revoked(1, null), revoked(2, "ver-2"), revoked(3, null)];
    state.cursors = [];
    counter.increment.mockClear();
  });

  it("starts from 0 when since is absent", async () => {
    const response = await get("");
    expect(response.status).toBe(200);
    expect(state.cursors).toEqual([0]);
    expect(counter.increment).toHaveBeenCalledWith("revocation_list_fetch");
    const body = await response.json();
    expect(body.entries.map((e: { id: number }) => e.id)).toEqual([1, 2, 3]);
  });

  it("serves entries after the cursor and hands back the new one", async () => {
    const response = await get("?since=2");
    const body = await response.json();
    expect(state.cursors).toEqual([2]);
    expect(body).toEqual({
      cursor: 3,
      latest: 3,
      entries: [
        {
          id: 3,
          packageId: "pkg-3",
          versionId: null,
          reason: "Exfiltrated form values",
          revokedAt: "2026-07-03T00:00:00.000Z",
        },
      ],
    });
  });

  it("echoes the cursor it was given when there is nothing new", async () => {
    const response = await get("?since=3");
    await expect(response.json()).resolves.toEqual({ cursor: 3, latest: 3, entries: [] });
  });

  it("returns latest 0 on an empty page (empty table)", async () => {
    state.rows = [];
    const response = await get("");
    await expect(response.json()).resolves.toEqual({ cursor: 0, latest: 0, entries: [] });
  });

  it("reports a latest below a since that is ahead of the server, so a client can detect a cursor reset is needed (e.g. after a DB wipe restarts the bigserial)", async () => {
    const response = await get("?since=999");
    const body = await response.json();
    expect(body.latest).toBe(3);
    expect(body.latest).toBeLessThan(999);
    expect(body.entries).toEqual([]);
  });

  it("starts from 0 on a since it cannot parse", async () => {
    await get("?since=lol");
    await get("?since=");
    await get("?since=-4");
    await get("?since=1.5e400");
    expect(state.cursors).toEqual([0, 0, 0, 0]);
  });

  it("serves a null versionId for a whole-package revocation", async () => {
    const response = await get("?since=1");
    const body = await response.json();
    expect(body.entries[0].versionId).toBe("ver-2");
    expect(body.entries[1].versionId).toBeNull();
  });

  it("serves the shape the published wire schema describes", async () => {
    const response = await get("");
    const parsed = revocationsResponseSchema.safeParse(await response.json());
    expect(parsed.success).toBe(true);
  });
});
