import { describe, expect, it, vi } from "vitest";
import {
  collectActivationReport,
  formatActivationReport,
  parseActivationReportRange,
} from "@/lib/activation-report";

describe("activation report", () => {
  it("accepts inclusive UTC calendar dates and rejects impossible dates", () => {
    expect(parseActivationReportRange(["--from", "2026-02-01", "--to", "2026-02-28"])).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(() =>
      parseActivationReportRange(["--from", "2026-02-31", "--to", "2026-03-01"]),
    ).toThrow("Expected a UTC date");
  });

  it("combines mocked public counters and Neon totals for an inclusive UTC range", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              published_at: "2026-08-02T12:00:00Z",
              assets: [
                { name: "webmcp-today-extension-1.0.0.zip", download_count: 7 },
                { name: "SHA256SUMS", download_count: 2 },
              ],
            },
            {
              published_at: "2026-07-30T12:00:00Z",
              assets: [{ name: "webmcp-today-extension-0.9.0.zip", download_count: 99 }],
            },
          ]),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ downloads: [{ day: "2026-08-02", downloads: 4 }] })),
      );
    const getCounterTotals = vi.fn(() =>
      Promise.resolve({
        package_definition_get: 14,
        revocation_list_fetch: 3,
        known_domains_fetch: 5,
        release_document_fetch: 2,
      }),
    );

    const report = await collectActivationReport(
      { from: "2026-08-01", to: "2026-08-07" },
      { fetch, getCounterTotals },
    );

    expect(report).toMatchObject({
      githubReleaseAssetDownloads: 9,
      githubExtensionZipDownloads: 7,
      npmBridgeDownloads: 4,
      packageDefinitionGets: 14,
      heartbeatFetches: 10,
      packageDefinitionGetsPerExtensionZipDownload: 2,
    });
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://api.github.com/repos/robertn702/webmcp-today/releases?per_page=100",
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://api.npmjs.org/downloads/range/2026-08-01:2026-08-07/@webmcp-today/mcp-bridge",
    );
    expect(formatActivationReport(report)).toContain("UTC range: 2026-08-01 to 2026-08-07");
    expect(formatActivationReport(report)).toContain("mixed-window, directional");
  });

  it("reports no ratio when no extension ZIP downloads are available", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([])))
      .mockResolvedValueOnce(new Response(JSON.stringify({ downloads: [] })));

    const report = await collectActivationReport(
      { from: "2026-08-01", to: "2026-08-07" },
      { fetch, getCounterTotals: () => Promise.resolve({ package_definition_get: 14 }) },
    );

    expect(report.packageDefinitionGetsPerExtensionZipDownload).toBeNull();
    expect(formatActivationReport(report)).toContain("directional): N/A");
  });
});
