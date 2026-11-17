-- Raw click events, range-partitioned by day on `ts` (daily partitions are created
-- ahead of time by `ensureClickPartitions`; the DEFAULT partition catches stragglers).
CREATE TABLE IF NOT EXISTS clicks (
  event_id UUID NOT NULL,
  url_id BIGINT NOT NULL REFERENCES urls (id) ON DELETE CASCADE,
  ts TIMESTAMPTZ NOT NULL,
  referrer TEXT NULL,
  ip_hash VARCHAR(64) NULL,
  -- The partition key must be part of the primary key. `event_id` makes the
  -- worker's inserts idempotent, so Kafka redeliveries never double-count.
  PRIMARY KEY (event_id, ts)
) PARTITION BY RANGE (ts);

CREATE TABLE IF NOT EXISTS clicks_default PARTITION OF clicks DEFAULT;

CREATE INDEX IF NOT EXISTS idx_clicks_url_ts ON clicks (url_id, ts);
