import type { WebMcpPackage } from "@webmcp-today/schema";

/** Text fields exposed by package search, after a package has passed served-truth validation. */
export function matchesPackageQuery(pkg: WebMcpPackage, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [
    pkg.title,
    pkg.description,
    pkg.domain,
    pkg.contributor,
    ...pkg.urlPatterns,
    ...pkg.tools.flatMap((tool) => [tool.name, tool.description]),
  ].some((value) => value.toLowerCase().includes(normalized));
}

/** Applies text search before callers apply their requested page window. */
export function filterPackagesByQuery(
  packageList: WebMcpPackage[],
  query: string | undefined,
): WebMcpPackage[] {
  return query ? packageList.filter((pkg) => matchesPackageQuery(pkg, query)) : packageList;
}

/** Filters the complete served set before applying the requested page window. */
export function packagePageByQuery(
  packageList: WebMcpPackage[],
  query: string | undefined,
  page: number,
  pageSize: number,
): { packages: WebMcpPackage[]; total: number } {
  const filtered = filterPackagesByQuery(packageList, query);
  const start = (page - 1) * pageSize;
  return { packages: filtered.slice(start, start + pageSize), total: filtered.length };
}
