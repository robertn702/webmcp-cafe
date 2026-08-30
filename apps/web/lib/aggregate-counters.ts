import { aggregateCounters, type AggregateMetric } from "@webmcp-today/db";
import { sql } from "drizzle-orm";
import { after } from "next/server";
import { db } from "@/lib/db";

type Dependencies = {
  after: (callback: () => Promise<void>) => void;
  increment: (metric: AggregateMetric, utcDate: string) => Promise<void>;
  isProduction: () => boolean;
  utcDate: () => string;
};

type CounterEnvironment = { VERCEL_ENV?: string; NODE_ENV?: string };

function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function incrementAggregateMetric(
  metric: AggregateMetric,
  utcDate: string,
): Promise<void> {
  await db
    .insert(aggregateCounters)
    .values({ utcDate, metric, count: 1 })
    .onConflictDoUpdate({
      target: [aggregateCounters.utcDate, aggregateCounters.metric],
      set: { count: sql`${aggregateCounters.count} + 1` },
    });
}

export function isProductionCounterEnvironment(
  environment: CounterEnvironment = process.env,
): boolean {
  return environment.VERCEL_ENV === "production" && environment.NODE_ENV !== "test";
}

/** Schedules a production-only aggregate increment without observing request data. */
export function scheduleAggregateMetricIncrement(
  metric: AggregateMetric,
  dependencies: Dependencies = {
    after,
    increment: incrementAggregateMetric,
    isProduction: isProductionCounterEnvironment,
    utcDate,
  },
): void {
  if (!dependencies.isProduction()) return;
  const requestUtcDate = dependencies.utcDate();

  try {
    dependencies.after(() =>
      dependencies.increment(metric, requestUtcDate).catch(() => {
        // Aggregate counting must never affect the request that triggered it.
      }),
    );
  } catch {
    // Scheduling is best effort when no request lifecycle is available.
  }
}
