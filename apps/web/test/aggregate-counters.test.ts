import { aggregateCounters } from "@webmcp-today/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { getTableConfig } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  db: { insert: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: state.db }));

import {
  incrementAggregateMetric,
  isProductionCounterEnvironment,
  scheduleAggregateMetricIncrement,
} from "@/lib/aggregate-counters";

describe("aggregate counters", () => {
  beforeEach(() => {
    state.db.insert.mockReset();
  });

  it("has exactly the date, metric, and count columns keyed by date and metric", () => {
    const config = getTableConfig(aggregateCounters);
    expect(
      config.columns.map(({ name, columnType, notNull }) => ({ name, columnType, notNull })),
    ).toEqual([
      { name: "utc_date", columnType: "PgDateString", notNull: true },
      { name: "metric", columnType: "PgText", notNull: true },
      { name: "count", columnType: "PgInteger", notNull: true },
    ]);
    const primaryKeys = config.primaryKeys;
    expect(primaryKeys).toHaveLength(1);
    expect(primaryKeys[0]?.columns.map((column) => column.name)).toEqual(["utc_date", "metric"]);
  });

  it("upserts a production daily metric increment", async () => {
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    state.db.insert.mockReturnValue({ values });

    await incrementAggregateMetric("package_definition_get", "2026-08-19");

    expect(state.db.insert).toHaveBeenCalledWith(aggregateCounters);
    expect(values).toHaveBeenCalledWith({
      utcDate: "2026-08-19",
      metric: "package_definition_get",
      count: 1,
    });
    expect(onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: [aggregateCounters.utcDate, aggregateCounters.metric],
      }),
    );
    const update = onConflictDoUpdate.mock.calls[0]?.[0];
    expect(update).toBeDefined();
    expect(new PgDialect().sqlToQuery(update?.set.count).sql).toBe(
      '"aggregate_counters"."count" + 1',
    );
  });

  it.each([
    { VERCEL_ENV: undefined, NODE_ENV: "production" },
    { VERCEL_ENV: "development", NODE_ENV: "production" },
    { VERCEL_ENV: "preview", NODE_ENV: "production" },
    { VERCEL_ENV: "test", NODE_ENV: "production" },
    { VERCEL_ENV: "production", NODE_ENV: "test" },
  ])("excludes non-production environments (%o)", (environment) => {
    const after = vi.fn();
    const increment = vi.fn();

    scheduleAggregateMetricIncrement("known_domains_fetch", {
      after,
      increment,
      isProduction: () => isProductionCounterEnvironment(environment),
      utcDate: () => "2026-08-19",
    });

    expect(after).not.toHaveBeenCalled();
    expect(increment).not.toHaveBeenCalled();
  });

  it("schedules production writes after the response and awaits isolated write failures", async () => {
    let callback: (() => Promise<void>) | undefined;
    const after = vi.fn((scheduled: () => Promise<void>) => {
      callback = scheduled;
    });
    const increment = vi.fn(() => Promise.reject(new Error("Neon unavailable")));

    expect(() => {
      scheduleAggregateMetricIncrement("release_document_fetch", {
        after,
        increment,
        isProduction: () =>
          isProductionCounterEnvironment({
            VERCEL_ENV: "production",
            NODE_ENV: "production",
          }),
        utcDate: () => "2026-08-19",
      });
    }).not.toThrow();
    expect(after).toHaveBeenCalledOnce();
    await callback?.();
    expect(increment).toHaveBeenCalledWith("release_document_fetch", "2026-08-19");
  });

  it("keeps the request UTC date when the deferred callback runs after midnight", async () => {
    let callback: (() => Promise<void>) | undefined;
    const after = vi.fn((scheduled: () => Promise<void>) => {
      callback = scheduled;
    });
    const increment = vi.fn(() => Promise.resolve());
    const utcDate = vi.fn().mockReturnValueOnce("2026-08-19").mockReturnValue("2026-08-20");

    scheduleAggregateMetricIncrement("known_domains_fetch", {
      after,
      increment,
      isProduction: () => true,
      utcDate,
    });

    await callback?.();
    expect(utcDate).toHaveBeenCalledOnce();
    expect(increment).toHaveBeenCalledWith("known_domains_fetch", "2026-08-19");
  });

  it("isolates after scheduling failures", () => {
    expect(() => {
      scheduleAggregateMetricIncrement("revocation_list_fetch", {
        after: () => {
          throw new Error("after unavailable");
        },
        increment: () => Promise.resolve(),
        isProduction: () => true,
        utcDate: () => "2026-08-19",
      });
    }).not.toThrow();
  });
});
