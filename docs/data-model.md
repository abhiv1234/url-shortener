# Data Model

## PostgreSQL Schema

### `urls`

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | BIGSERIAL | PRIMARY KEY |
| `short_code` | VARCHAR(16) | UNIQUE NOT NULL |
| `long_url` | TEXT | NOT NULL |
| `user_id` | UUID | NULL (Phase 4) |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT now() |
| `expires_at` | TIMESTAMPTZ | NULL |

**Indexes:**
- `UNIQUE (short_code)` — B-tree, primary lookup for redirects
- `(user_id, created_at DESC)` — list user's links

### `clicks` (partitioned by date)

| Column | Type | Constraints |
|--------|------|-------------|
| `url_id` | BIGINT | NOT NULL, FK → urls(id) |
| `ts` | TIMESTAMPTZ | NOT NULL |
| `referrer` | TEXT | NULL |
| `ip_hash` | VARCHAR(64) | NULL |

**Partitioning:** `PARTITION BY RANGE (ts)` — daily partitions.

**Indexes per partition:**
- `(url_id, ts)` — stats queries

## Redis Keys

| Key pattern | Value | TTL |
|-------------|-------|-----|
| `url:{short_code}` | `{long_url, expires_at}` JSON | dynamic |
| `sf:{short_code}` | singleflight lock | 5s |

## Kafka Topics

| Topic | Payload |
|-------|---------|
| `click-events` | `{url_id, ts, referrer, ip_hash}` |

## Analytics Aggregates (Phase 3)

Materialized or rolled up in worker:

```sql
-- url_stats_daily
url_id, date, click_count, top_referrers JSONB
```

## Sample Queries

### Redirect lookup
```sql
SELECT long_url, expires_at FROM urls WHERE short_code = $1;
```

### Stats (last 30 days)
```sql
SELECT date_trunc('day', ts) AS day, count(*)
FROM clicks
WHERE url_id = $1 AND ts > now() - interval '30 days'
GROUP BY 1 ORDER BY 1;
```

### Expired link cleanup (cron)
```sql
DELETE FROM urls WHERE expires_at IS NOT NULL AND expires_at < now();
```
