import {
  packageWithinDomainScope,
  webMcpPackageSchema,
  type WebMcpPackage,
} from "@webmcp-today/schema";
import { installs, packages, packageVersions, user } from "@webmcp-today/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "./db";
import { packagePageByQuery } from "./package-query";
import { serializePackage } from "./serialize";

type PackageRow = typeof packages.$inferSelect;
type VersionRow = typeof packageVersions.$inferSelect;

/** Highest safe version row per packageId. */
function pickLatestVersions(
  packageRows: PackageRow[],
  versionRows: VersionRow[],
): Map<string, VersionRow> {
  const packageById = new Map(packageRows.map((pkg) => [pkg.id, pkg]));
  const latest = new Map<string, VersionRow>();
  for (const row of versionRows) {
    const pkg = packageById.get(row.packageId);
    if (
      !pkg ||
      !packageWithinDomainScope({ domain: pkg.domain, urlPatterns: row.urlPatterns, api: row.api })
    ) {
      continue;
    }
    const prev = latest.get(row.packageId);
    if (!prev || row.version > prev.version) latest.set(row.packageId, row);
  }
  return latest;
}

async function fetchContributorNames(contributorIds: string[]): Promise<Map<string, string>> {
  if (contributorIds.length === 0) return new Map();
  const rows = await db
    .select({ id: user.id, name: user.name })
    .from(user)
    .where(inArray(user.id, contributorIds));
  return new Map(rows.map((u) => [u.id, u.name]));
}

/** Hydrate packages with a caller-supplied version per packageId (latest, or pinned). */
async function hydrate(
  packageRows: PackageRow[],
  versionByPackage: Map<string, VersionRow>,
): Promise<WebMcpPackage[]> {
  if (packageRows.length === 0) return [];
  const names = await fetchContributorNames(packageRows.map((p) => p.contributorId));
  return packageRows.flatMap((pkg) => {
    const version = versionByPackage.get(pkg.id);
    if (!version) return [];
    const served = serializePackage(pkg, version, {
      contributorName: names.get(pkg.contributorId),
    });
    // Full structural + cross-field validation (the same contract a fresh
    // publish must satisfy) — a legacy row that predates a tightened check
    // fails closed here instead of being served as-is.
    const parsed = webMcpPackageSchema.safeParse(served);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Every currently servable package, after rejecting legacy out-of-scope rows. */
export async function listServablePackages(): Promise<WebMcpPackage[]> {
  return hydratePackages(await db.select().from(packages));
}

/** Hydrate packages at each one's globally-newest safe version. */
export async function hydratePackages(packageRows: PackageRow[]): Promise<WebMcpPackage[]> {
  const ids = packageRows.map((p) => p.id);
  if (ids.length === 0) return [];
  const versionRows = await db
    .select()
    .from(packageVersions)
    .where(inArray(packageVersions.packageId, ids));
  return hydrate(packageRows, pickLatestVersions(packageRows, versionRows));
}

export async function listPackages(opts: {
  domain?: string;
  q?: string;
  page: number;
  pageSize: number;
}): Promise<{ packages: WebMcpPackage[]; total: number }> {
  const where = opts.domain ? eq(packages.domain, opts.domain) : undefined;
  const rows = await db.select().from(packages).where(where).orderBy(desc(packages.updatedAt));
  const valid = await hydratePackages(rows);
  return packagePageByQuery(valid, opts.q, opts.page, opts.pageSize);
}

export async function getPackageById(id: string): Promise<WebMcpPackage | null> {
  const rows = await db.select().from(packages).where(eq(packages.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  const hydrated = await hydratePackages([row]);
  return hydrated[0] ?? null;
}

export async function getLatestVersion(packageId: string): Promise<VersionRow | null> {
  const [packageRows, versionRows] = await Promise.all([
    db.select().from(packages).where(eq(packages.id, packageId)).limit(1),
    db
      .select()
      .from(packageVersions)
      .where(eq(packageVersions.packageId, packageId))
      .orderBy(desc(packageVersions.version)),
  ]);
  const pkg = packageRows[0];
  if (!pkg) return null;
  return (
    versionRows.find((version) =>
      packageWithinDomainScope({
        domain: pkg.domain,
        urlPatterns: version.urlPatterns,
        api: version.api,
      }),
    ) ?? null
  );
}

export async function getVersionById(
  packageId: string,
  versionId: string,
): Promise<VersionRow | null> {
  const rows = await db
    .select()
    .from(packageVersions)
    .where(and(eq(packageVersions.packageId, packageId), eq(packageVersions.id, versionId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * One package at an exact version — the served document, not the bare row
 * `getVersionById` returns. This is what an install fetches and keeps, so it has
 * to be the same shape browse and lookup serve.
 */
export async function getPackageAtVersion(
  packageId: string,
  versionId: string,
): Promise<WebMcpPackage | null> {
  const [packageRows, version] = await Promise.all([
    db.select().from(packages).where(eq(packages.id, packageId)).limit(1),
    getVersionById(packageId, versionId),
  ]);
  const pkg = packageRows[0];
  if (!pkg || !version) return null;
  const hydrated = await hydrate([pkg], new Map([[pkg.id, version]]));
  return hydrated[0] ?? null;
}

export type VersionSummary = {
  versionId: string;
  version: number;
  changelog: string | null;
  createdAt: Date;
};

/** A package's safe versions, newest first — what update and rollback choose from. */
export async function listVersions(packageId: string): Promise<VersionSummary[]> {
  const [packageRows, versionRows] = await Promise.all([
    db.select().from(packages).where(eq(packages.id, packageId)).limit(1),
    db
      .select()
      .from(packageVersions)
      .where(eq(packageVersions.packageId, packageId))
      .orderBy(desc(packageVersions.version)),
  ]);
  const pkg = packageRows[0];
  if (!pkg) return [];
  return versionRows.flatMap((version) =>
    packageWithinDomainScope({
      domain: pkg.domain,
      urlPatterns: version.urlPatterns,
      api: version.api,
    })
      ? [
          {
            versionId: version.id,
            version: version.version,
            changelog: version.changelog,
            createdAt: version.createdAt,
          },
        ]
      : [],
  );
}

/** A user's installed packages, each pinned to `installs.versionId`. */
export async function getInstalledPackages(userId: string): Promise<WebMcpPackage[]> {
  const installRows = await db.select().from(installs).where(eq(installs.userId, userId));
  if (installRows.length === 0) return [];

  const packageIds = installRows.map((i) => i.packageId);
  const versionIds = installRows.map((i) => i.versionId);
  const [packageRows, versionRows] = await Promise.all([
    db.select().from(packages).where(inArray(packages.id, packageIds)),
    db.select().from(packageVersions).where(inArray(packageVersions.id, versionIds)),
  ]);

  const versionById = new Map(versionRows.map((v) => [v.id, v]));
  const pinnedByPackage = new Map<string, VersionRow>();
  for (const install of installRows) {
    const version = versionById.get(install.versionId);
    if (version) pinnedByPackage.set(install.packageId, version);
  }
  return hydrate(packageRows, pinnedByPackage);
}
