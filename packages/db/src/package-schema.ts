import type { ApiBlock, ToolDescriptor } from "@webmcp-today/schema";
import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

/**
 * Package-level metadata. No uniqueness on domain (or domain + pattern) by
 * design: rival packages may target the same site — local browser installs select
 * candidates and matching candidates rank by specificity instead of first-come registration.
 */
export const packages = pgTable(
  "packages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    domain: text("domain").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    contributorId: text("contributor_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_packages_domain").on(t.domain),
    index("idx_packages_updated_at").on(t.updatedAt),
  ],
);

/**
 * Append-only: publishing a new version never mutates an old one. Served
 * truth — there is no separate snapshot table. Browse/fresh lookups validate the
 * highest in-scope candidate and omit a package when it is invalid; installed users
 * stay pinned via `installs.versionId`.
 */
export const packageVersions = pgTable(
  "package_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    packageId: uuid("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    urlPatterns: jsonb("url_patterns").$type<string[]>().notNull(),
    tools: jsonb("tools").$type<ToolDescriptor[]>().notNull(),
    /** Required API execution surface for API-mode tools; DOM-only versions retain an inert block. */
    api: jsonb("api").$type<ApiBlock>().notNull(),
    /** Capability floor this version's content requires (see engineLevelSchema in packages/schema). Required. */
    minEngine: integer("min_engine").notNull(),
    changelog: text("changelog"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_package_versions_package_id").on(t.packageId),
    unique("uq_package_versions_package_version").on(t.packageId, t.version),
    check("chk_package_versions_version_positive", sql`"version" > 0`),
    check("chk_package_versions_min_engine_positive", sql`"min_engine" > 0`),
  ],
);

/**
 * Auth-only per-user install records pin a user to a version. Browse validates the
 * highest in-scope candidate; installed users stay pinned via `installs.versionId`.
 */
export const installs = pgTable(
  "installs",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    packageId: uuid("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => packageVersions.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.packageId] })],
);

/**
 * Append-only kill list, polled by clients with `id` as the cursor. Once
 * installed package bodies live in the extension's storage the registry is off
 * the read path, so this is the only lever it keeps after install
 * (docs/local-first-installs.md §5). Writes are hand-run SQL in v1 — there is
 * no admin role and no write endpoint.
 *
 * `id` is a bigserial rather than this schema's usual `uuid().defaultRandom()`
 * precisely because it is that cursor: a random uuid is not monotonic.
 */
export const revocations = pgTable("revocations", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  packageId: uuid("package_id")
    .notNull()
    .references(() => packages.id, { onDelete: "cascade" }),
  /** Null revokes the whole package; otherwise only this version. */
  versionId: uuid("version_id").references(() => packageVersions.id),
  /** Short, and shown to the user — a package never silently vanishes. */
  reason: text("reason").notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }).notNull().defaultNow(),
  revokedBy: text("revoked_by").references(() => user.id),
});
