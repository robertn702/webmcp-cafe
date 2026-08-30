import type { DomainsResponse } from "@webmcp-today/schema";
import { NextResponse } from "next/server";
import { getDomainsVersion, listDistinctDomains } from "@/lib/domains-repo";
import { scheduleAggregateMetricIncrement } from "@/lib/aggregate-counters";

const CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=86400";

/**
 * GET /api/domains — every domain with a published package, for the
 * extension's local domain-match list. Public and cacheable: no URL or
 * identity is ever sent to get it. `version` is the epoch ms of the corpus's
 * latest change, folded into the `ETag` alongside the domain count so a
 * removal (same version, fewer domains) still busts the cache.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const [domains, version] = await Promise.all([listDistinctDomains(), getDomainsVersion()]);
  const etag = `W/"${version}-${domains.length}"`;

  if (request.headers.get("if-none-match") === etag) {
    scheduleAggregateMetricIncrement("known_domains_fetch");
    return new NextResponse(null, {
      status: 304,
      headers: { ETag: etag, "Cache-Control": CACHE_CONTROL },
    });
  }

  const body: DomainsResponse = { version, generatedAt: new Date().toISOString(), domains };
  scheduleAggregateMetricIncrement("known_domains_fetch");
  return NextResponse.json(body, { headers: { ETag: etag, "Cache-Control": CACHE_CONTROL } });
}
