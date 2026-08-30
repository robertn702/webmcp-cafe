import { NextResponse } from "next/server";
import { getLatestExtensionRelease } from "@/lib/extension-release";
import { scheduleAggregateMetricIncrement } from "@/lib/aggregate-counters";

// Next 15 GET handlers run per request by default; the GitHub fetch keeps its own data cache.
export const dynamic = "auto";

/** Public, inert metadata for the one official extension's self-hosted stable release. */
export async function GET(): Promise<NextResponse> {
  try {
    const release = await getLatestExtensionRelease();
    if (release === undefined) {
      return NextResponse.json(
        { error: "No valid extension release is available." },
        { status: 404 },
      );
    }
    const response = NextResponse.json(release, {
      headers: { "Cache-Control": "public, max-age=3600" },
    });
    scheduleAggregateMetricIncrement("release_document_fetch");
    return response;
  } catch {
    return NextResponse.json(
      { error: "Extension release metadata is unavailable." },
      { status: 503 },
    );
  }
}
