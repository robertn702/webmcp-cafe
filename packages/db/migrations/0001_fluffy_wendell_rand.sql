CREATE TABLE "aggregate_counters" (
	"utc_date" date NOT NULL,
	"metric" text NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "aggregate_counters_utc_date_metric_pk" PRIMARY KEY("utc_date","metric")
);
