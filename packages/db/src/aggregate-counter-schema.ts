import { date, integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

export const aggregateMetrics = [
  "package_definition_get",
  "revocation_list_fetch",
  "known_domains_fetch",
  "release_document_fetch",
] as const;

export type AggregateMetric = (typeof aggregateMetrics)[number];

/** Anonymous daily operational counters. This table intentionally has only these columns. */
export const aggregateCounters = pgTable(
  "aggregate_counters",
  {
    utcDate: date("utc_date", { mode: "string" }).notNull(),
    metric: text("metric").$type<AggregateMetric>().notNull(),
    count: integer("count").notNull(),
  },
  (t) => [primaryKey({ columns: [t.utcDate, t.metric] })],
);
