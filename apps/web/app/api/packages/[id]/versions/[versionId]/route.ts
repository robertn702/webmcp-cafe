import { NextResponse } from "next/server";
import { jsonError } from "@/lib/http";
import { getPackageAtVersion } from "@/lib/packages-repo";
import { scheduleAggregateMetricIncrement } from "@/lib/aggregate-counters";

/**
 * GET /api/packages/:id/versions/:versionId — the document served at that exact
 * version. Public and unauthenticated: nothing here is caller-specific, and a
 * pinned install has to be fetchable without an account.
 *
 * Every other read serves latest (`/api/packages`, `/api/packages/:id`) or the
 * caller's pins (`/api/installs`); this is the only version-addressed one.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; versionId: string }> },
): Promise<NextResponse> {
  const { id, versionId } = await context.params;
  const pkg = await getPackageAtVersion(id, versionId);
  if (!pkg) return jsonError(404, "Package version not found");
  const response = NextResponse.json(pkg);
  scheduleAggregateMetricIncrement("package_definition_get");
  return response;
}
