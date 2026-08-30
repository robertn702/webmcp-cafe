import { aggregateCounters, type AggregateMetric } from "@webmcp-today/db";
import { and, gte, lte } from "drizzle-orm";
import {
  collectActivationReport,
  formatActivationReport,
  parseActivationReportRange,
  type DateRange,
} from "@/lib/activation-report";
import { db } from "@/lib/db";

async function getCounterTotals(
  range: DateRange,
): Promise<Partial<Record<AggregateMetric, number>>> {
  const rows = await db
    .select({ metric: aggregateCounters.metric, count: aggregateCounters.count })
    .from(aggregateCounters)
    .where(
      and(gte(aggregateCounters.utcDate, range.from), lte(aggregateCounters.utcDate, range.to)),
    );
  return rows.reduce<Partial<Record<AggregateMetric, number>>>(
    (totals, row) => ({ ...totals, [row.metric]: (totals[row.metric] ?? 0) + row.count }),
    {},
  );
}

async function main(): Promise<void> {
  const range = parseActivationReportRange(process.argv.slice(2));
  const report = await collectActivationReport(range, {
    fetch,
    getCounterTotals: () => getCounterTotals(range),
  });
  console.log(formatActivationReport(report));
}

if (import.meta.main) void main();
