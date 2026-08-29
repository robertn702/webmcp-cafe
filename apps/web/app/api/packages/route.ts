import { createPackageSchema } from "@webmcp-today/schema";
import { NextResponse } from "next/server";
import { getAuthUserId } from "@/lib/api-auth";
import { listPackages } from "@/lib/packages-repo";
import {
  acceptedSubmission,
  jsonError,
  parseBody,
  requireSubmissionTerms,
  VersionConflictError,
  versionConflict,
  withLlmsLink,
} from "@/lib/http";
import { insertPackage } from "@/lib/mutations";

/** GET /api/packages?domain=&q=&page=&pageSize= — browse the registry (latest version of each). */
export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const page = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);
  const pageSize = Math.min(100, Math.max(1, Number(searchParams.get("pageSize") ?? "20") || 20));
  const domain = searchParams.get("domain") ?? undefined;
  const q = searchParams.get("q")?.trim();
  if (q && q.length > 200) return withLlmsLink(jsonError(400, "q must be at most 200 characters"));

  const { packages, total } = await listPackages({ domain, q, page, pageSize });
  return withLlmsLink(NextResponse.json({ packages, total, page, pageSize }));
}

/**
 * POST /api/packages — publish a new package + its version 1 (session cookie
 * or Bearer API key). Publishing here carries the same submission grant as the
 * form at /submit: a permanent license to host and redistribute the package,
 * offered onward under CC0. The 201 links back to /terms.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const termsResponse = requireSubmissionTerms(request);
  if (termsResponse) return withLlmsLink(termsResponse);

  const userId = await getAuthUserId(request);
  if (!userId) return withLlmsLink(jsonError(401, "Authentication required (session or API key)"));

  const body = await parseBody(request, createPackageSchema);
  if (!body.ok) return withLlmsLink(body.response);

  try {
    const { packageId } = await insertPackage(body.data, userId);
    return withLlmsLink(
      acceptedSubmission(request, { id: packageId }, `/api/packages/${packageId}`),
    );
  } catch (err) {
    if (err instanceof VersionConflictError) return withLlmsLink(versionConflict(err));
    throw err;
  }
}
