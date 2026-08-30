import { type AggregateMetric } from "@webmcp-today/db";

export type DateRange = { from: string; to: string };

type Fetch = (input: string) => Promise<Response>;

type CounterTotals = Partial<Record<AggregateMetric, number>>;

function option(args: string[], name: string): string {
  const value = args[args.indexOf(name) + 1];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function utcDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`Expected a UTC date (YYYY-MM-DD), received ${value}.`);
  }
  return value;
}

export function parseActivationReportRange(args: string[]): DateRange {
  const from = utcDate(option(args, "--from"));
  const to = utcDate(option(args, "--to"));
  if (from > to) throw new Error("--from must not be after --to.");
  return { from, to };
}

export type ActivationReport = {
  dateRange: DateRange;
  githubReleaseAssetDownloads: number;
  githubExtensionZipDownloads: number;
  npmBridgeDownloads: number;
  packageDefinitionGets: number;
  heartbeatFetches: number;
  heartbeatComponents: {
    revocationListFetches: number;
    knownDomainsFetches: number;
    releaseDocumentFetches: number;
  };
  packageDefinitionGetsPerExtensionZipDownload: number | null;
};

function property(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Unexpected public counter response.");
  }
  const entry = Object.entries(value).find(([key]) => key === name);
  if (!entry) throw new Error("Unexpected public counter response.");
  return entry[1];
}

function asNumber(value: unknown): number {
  if (typeof value !== "number") throw new Error("Unexpected public counter response.");
  return value;
}

function asString(value: unknown): string {
  if (typeof value !== "string") throw new Error("Unexpected public counter response.");
  return value;
}

async function json(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`Public counter request failed (${response.status}).`);
  return response.json();
}

function withinRange(date: string, range: DateRange): boolean {
  const utcDate = date.slice(0, 10);
  return utcDate >= range.from && utcDate <= range.to;
}

function githubDownloads(
  data: unknown,
  range: DateRange,
): { assets: number; extensionZips: number } {
  if (!Array.isArray(data)) throw new Error("Unexpected public counter response.");

  return data.reduce(
    (total, release) => {
      if (!withinRange(asString(property(release, "published_at")), range)) return total;
      const assets = property(release, "assets");
      if (!Array.isArray(assets)) throw new Error("Unexpected public counter response.");
      return assets.reduce((assetTotal, asset) => {
        const downloads = asNumber(property(asset, "download_count"));
        const name = asString(property(asset, "name"));
        return {
          assets: assetTotal.assets + downloads,
          extensionZips:
            assetTotal.extensionZips +
            (name.startsWith("webmcp-today-extension-") && name.endsWith(".zip") ? downloads : 0),
        };
      }, total);
    },
    { assets: 0, extensionZips: 0 },
  );
}

function npmDownloads(data: unknown): number {
  const downloads = property(data, "downloads");
  if (!Array.isArray(downloads)) throw new Error("Unexpected public counter response.");
  return downloads.reduce((total, day) => total + asNumber(property(day, "downloads")), 0);
}

export async function collectActivationReport(
  range: DateRange,
  dependencies: { fetch: Fetch; getCounterTotals: () => Promise<CounterTotals> },
): Promise<ActivationReport> {
  const [githubResponse, npmResponse, totals] = await Promise.all([
    dependencies.fetch(
      "https://api.github.com/repos/robertn702/webmcp-today/releases?per_page=100",
    ),
    dependencies.fetch(
      `https://api.npmjs.org/downloads/range/${range.from}:${range.to}/@webmcp-today/mcp-bridge`,
    ),
    dependencies.getCounterTotals(),
  ]);
  const github = githubDownloads(await json(githubResponse), range);
  const packageDefinitionGets = totals.package_definition_get ?? 0;
  const revocationListFetches = totals.revocation_list_fetch ?? 0;
  const knownDomainsFetches = totals.known_domains_fetch ?? 0;
  const releaseDocumentFetches = totals.release_document_fetch ?? 0;

  return {
    dateRange: range,
    githubReleaseAssetDownloads: github.assets,
    githubExtensionZipDownloads: github.extensionZips,
    npmBridgeDownloads: npmDownloads(await json(npmResponse)),
    packageDefinitionGets,
    heartbeatFetches: revocationListFetches + knownDomainsFetches + releaseDocumentFetches,
    heartbeatComponents: { revocationListFetches, knownDomainsFetches, releaseDocumentFetches },
    packageDefinitionGetsPerExtensionZipDownload:
      github.extensionZips === 0 ? null : packageDefinitionGets / github.extensionZips,
  };
}

export function formatActivationReport(report: ActivationReport): string {
  const ratio = report.packageDefinitionGetsPerExtensionZipDownload;
  return [
    `UTC range: ${report.dateRange.from} to ${report.dateRange.to}`,
    `GitHub release asset downloads (current cumulative assets for releases published in range; directional): ${report.githubReleaseAssetDownloads}`,
    `GitHub extension ZIP downloads (same mixed-window, directional filter): ${report.githubExtensionZipDownloads}`,
    `npm @webmcp-today/mcp-bridge downloads: ${report.npmBridgeDownloads}`,
    `Neon package-definition GETs: ${report.packageDefinitionGets}`,
    `Neon heartbeat fetch volume: ${report.heartbeatFetches}`,
    `  revocation-list: ${report.heartbeatComponents.revocationListFetches}`,
    `  known-domains: ${report.heartbeatComponents.knownDomainsFetches}`,
    `  release-document: ${report.heartbeatComponents.releaseDocumentFetches}`,
    `Package-definition GETs per extension ZIP download (mixed-window, directional): ${ratio === null ? "N/A" : ratio.toFixed(3)}`,
  ].join("\n");
}
