# Data Model

Migrations live in [`src/db/migrations`](../src/db/migrations) and are applied in order by `npm run migrate`
(tracked in `schema_migrations`).

## PostgreSQL

### `urls`

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | BIGSERIAL | PRIMARY KEY |
| `short_code` | VARCHAR(16) | UNIQUE NOT NULL |
| `long_url` | TEXT | NOT NULL |
| `user_id` | UUID | NULL, FK → `users(id)` ON DELETE SET NULL |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT now() |
| `expires_at` | TIMESTAMPTZ | NULL |

Indexes:
- `UNIQUE (short_code)` — redirect lookups
- `(user_id, created_at DESC)` — "my links" keyset pagination
- `(expires_at) WHERE expires_at IS NOT NULL` — partial index for the expiry purge

Generated codes: the row is inserted with a unique placeholder code, then updated to `base62(id)` in the same
transaction. If that collides with an existing custom alias, the transaction is retried with a fresh id.

### `users`

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | UUID | PRIMARY KEY DEFAULT gen_random_uuid() |
| `email` | TEXT | UNIQUE NOT NULL (stored lower-cased) |
| `password_hash` | TEXT | NOT NULL (bcrypt, cost 12) |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT now() |

### `clicks` (partitioned by day)

| Column | Type | Constraints |
|--------|------|-------------|
| `event_id` | UUID | NOT NULL — generated per click at the edge |
| `url_id` | BIGINT | NOT NULL, FK → `urls(id)` ON DELETE CASCADE |
| `ts` | TIMESTAMPTZ | NOT NULL — partition key |
| `referrer` | TEXT | NULL (≤ 2048 chars) |
| `ip_hash` | VARCHAR(64) | NULL — `sha256(IP_HASH_SALT + ":" + ip)`, raw IPs are never stored |

- `PRIMARY KEY (event_id, ts)` — the partition key must be in the key; it also makes inserts idempotent,
  so Kafka redeliveries are absorbed with `ON CONFLICT DO NOTHING`.
- `PARTITION BY RANGE (ts)` with daily partitions `clicks_pYYYYMMDD` created ahead of time
  (yesterday … +7 days) by the worker, plus a `clicks_default` catch-all.
- Index `(url_id, ts)` on every partition — stats queries.

## Redis

| Key | Value | TTL |
|-----|-------|-----|
| `url:{short_code}` | `{"id","longUrl","expiresAt"}` JSON | `min(24h, expires_at − now)` |
| `sf:{short_code}` | singleflight lock token (UUID) | 5s |
| `stats:{url_id}` | stats response JSON | 30s |
| `rl:*` | rate-limit counters (`@fastify/rate-limit`) | window length |

## Kafka

| Topic | Partitions | Key | Payload |
|-------|-----------|-----|---------|
| `click-events` | 6 | `urlId` | `{"eventId","urlId","ts","referrer","ipHash"}` |

Keying by `urlId` keeps one link's clicks ordered on a single partition while spreading load across
partitions (keying by date would send a whole day's traffic to one partition). Consumer group: `click-writer`.

## Sample queries

```sql
-- Redirect lookup (cache miss)
SELECT id, long_url, expires_at FROM urls WHERE short_code = $1;

-- Batch insert from the worker (idempotent, skips links deleted meanwhile)
INSERT INTO clicks (event_id, url_id, ts, referrer, ip_hash)
SELECT e.* FROM unnest($1::uuid[], $2::bigint[], $3::timestamptz[], $4::text[], $5::text[])
  AS e(event_id, url_id, ts, referrer, ip_hash)
WHERE EXISTS (SELECT 1 FROM urls u WHERE u.id = e.url_id)
ON CONFLICT DO NOTHING;

-- Expired-link purge (batched, safe under concurrency)
DELETE FROM urls WHERE id IN (
  SELECT id FROM urls WHERE expires_at IS NOT NULL AND expires_at <= now()
  ORDER BY expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED
) RETURNING short_code;
```
