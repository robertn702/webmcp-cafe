import type { RevocationEntry } from "@webmcp-today/schema";
import { NextResponse } from "next/server";
import { getLatestRevocationId, listRevocationsSince } from "@/lib/revocations-repo";
import { scheduleAggregateMetricIncrement } from "@/lib/aggregate-counters";

/**
 * GET /api/revocations?since=<cursor> — the kill list after that cursor, oldest
 * first, plus the cursor to send next time.
 *
 * Public and unauthenticated by design: the request carries a cursor and
 * nothing else, so polling it reveals no identity and no URL. Once package
 * bodies live on the client's disk this feed is the registry's only remaining
 * lever, so every client has to be able to read it — one shipped without it can
 * never be reached later.
 *
 * There is no write path in v1: revocations are hand-run SQL inserts.
 *
 * An absent or unparseable `since` starts from 0, and an empty page echoes the
 * cursor it was given rather than rewinding the caller.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  // Number, not parseInt: a cursor that isn't wholly a positive safe integer is
  // garbage, and parseInt would silently truncate "1.5e400" to 1.
  const raw = searchParams.get("since");
  const since = raw === null ? Number.NaN : Number(raw);
  const cursor = Number.isSafeInteger(since) && since > 0 ? since : 0;

  const [rows, latest] = await Promise.all([listRevocationsSince(cursor), getLatestRevocationId()]);
  const entries: RevocationEntry[] = rows.map((row) => ({
    id: row.id,
    packageId: row.packageId,
    versionId: row.versionId,
    reason: row.reason,
    revokedAt: row.revokedAt.toISOString(),
  }));

  const response = NextResponse.json({
    cursor: entries[entries.length - 1]?.id ?? cursor,
    latest: Number(latest),
    entries,
  });
  scheduleAggregateMetricIncrement("revocation_list_fetch");
  return response;
}
