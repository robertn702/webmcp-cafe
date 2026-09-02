import { z } from "zod";
import {
  applyDomEngineValidation,
  applyDomainCrossValidation,
  createPackageObjectSchema,
} from "./package.js";

// Shapes served by the registry API (superset of the submission format).

/**
 * The served envelope's shape, before the `.loose()` that lets an outer field
 * this build doesn't recognize yet through unvalidated (see webMcpPackageSchema).
 * Exported separately so producer code (`apps/web/lib/serialize.ts`) can type
 * its return value against this STRICT shape instead: TypeScript's excess-
 * property check only fires against a type without an index signature, so
 * typing the producer's return value as `WebMcpPackageStrict` (rather than the
 * loose `WebMcpPackage`) still catches a typo'd field there, while every
 * consumer keeps parsing/reading the forward-compatible loose type.
 */
const webMcpPackageObjectSchema = createPackageObjectSchema.extend({
  id: z.string().min(1),
  versionId: z.string().min(1),
  version: z.number().int().min(1),
  contributor: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/**
 * A package + one of its versions, as served by the registry. `id` is the
 * package id (stable identity); `versionId` + `version` identify which
 * version this document is.
 *
 * `.loose()`: unlike the strict author-submission contract, a served envelope
 * must tolerate a top-level field a newer registry added that this build
 * doesn't know about yet — clients persist the raw body verbatim, not the
 * parsed/stripped one, so an unrecognized field here must not be a hard
 * validation failure. The nested `tools`/`api`/`inputSchema` shapes stay
 * strict; only this outer envelope is loosened.
 *
 * The cross-field checks (`applyDomainCrossValidation`, shared with
 * `createPackageSchema`) run here too, so a row stored before one of those
 * checks existed fails closed instead of being served as-is — see
 * `apps/web/lib/packages-repo.ts`'s `hydrate`.
 */
export const webMcpPackageSchema = webMcpPackageObjectSchema.loose().superRefine((pkg, ctx) => {
  applyDomainCrossValidation(pkg, ctx);
  applyDomEngineValidation(pkg, ctx);
});

export const packageListResponseSchema = z.object({
  packages: z.array(webMcpPackageSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});

/** `GET /api/packages/lookup?url=` returns the packages matching one page URL. */
export const packageLookupResponseSchema = z.object({
  packages: z.array(webMcpPackageSchema),
});

export const statsResponseSchema = z.object({
  totalPackages: z.number().int().min(0),
  /** Domain coverage, not adoption — trust is derived from readable data, not counted. */
  totalDomains: z.number().int().min(0),
  topDomains: z.array(z.object({ domain: z.string(), count: z.number().int().min(0) })),
});

/**
 * `GET /api/domains` — every domain with a published package, for the
 * extension's local domain-match list (no URL ever leaves the client to get
 * this). `version` is the epoch ms of the corpus's latest change, used as an
 * `ETag` input by the client's poll.
 */
export const domainsResponseSchema = z.object({
  version: z.number().int().min(0),
  generatedAt: z.iso.datetime(),
  domains: z.array(z.string()),
});

/**
 * One entry in the revocation feed. Once installed package bodies live on the
 * client's disk the registry is off the read path, so this feed is the only
 * lever it keeps after install: a package pulled for malware otherwise runs
 * forever on every machine that has it.
 *
 * `id` is monotonic and doubles as the client's poll cursor — hence a number
 * rather than the uuid the registry's other ids use.
 */
export const revocationEntrySchema = z.object({
  id: z.number().int().positive(),
  packageId: z.string(),
  /** Null revokes the whole package; otherwise only this one version. */
  versionId: z.string().nullable(),
  reason: z.string(),
  revokedAt: z.iso.datetime(),
});

/**
 * `GET /api/revocations?since=<cursor>`. `cursor` is what the client sends next
 * time, and is echoed back unchanged when there is nothing new. `latest` is
 * the server's current max id (0 if the table is empty) — a client whose
 * stored cursor is ahead of it (e.g. after a DB wipe restarts the bigserial)
 * resets to 0 rather than silently never seeing another revocation.
 */
export const revocationsResponseSchema = z.object({
  cursor: z.number().int(),
  latest: z.number().int().min(0),
  entries: z.array(revocationEntrySchema),
});

export type WebMcpPackage = z.infer<typeof webMcpPackageSchema>;
/** See `webMcpPackageObjectSchema`'s doc comment: type a served-envelope
 * producer's return value against this instead of `WebMcpPackage`. */
export type WebMcpPackageStrict = z.infer<typeof webMcpPackageObjectSchema>;
export type PackageListResponse = z.infer<typeof packageListResponseSchema>;
export type StatsResponse = z.infer<typeof statsResponseSchema>;
export type DomainsResponse = z.infer<typeof domainsResponseSchema>;
export type RevocationEntry = z.infer<typeof revocationEntrySchema>;
export type RevocationsResponse = z.infer<typeof revocationsResponseSchema>;
