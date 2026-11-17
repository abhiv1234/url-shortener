# Runbook

Operational guide for the URL shortener: what each alert means, how to confirm it, and what to do.
Alert rules live in [`monitoring/alerts.yml`](../monitoring/alerts.yml); every metric named here is
exposed on `GET /metrics` (API) or `:9101/metrics` (click worker).

## Quick reference

| Symptom | Redirects | Creates | Analytics | First check |
|---------|-----------|---------|-----------|-------------|
| Redis down | ✅ via Postgres (slower) | ✅ | ✅ | `cache_requests_total{result="error"}` |
| Postgres down | ✅ cached links only (stale OK) | ❌ 500 | ⏸ worker retries | `stale_cache_served_total` |
| Kafka down | ✅ | ✅ | ⚠️ buffered + retried; overflow dropped | `click_publish_errors_total`, `click_events_dropped_total` |
| Worker down / slow | ✅ | ✅ | ⏸ lag grows, no data loss | `kafka_consumer_lag` |
| Hot URL / abusive client | ✅ (cache + singleflight) | ✅ | ✅ | 429s in `http_requests_total` |

Endpoints:

- `GET /health` — 200 only if **both** Postgres and Redis respond; body lists each dependency (Kafka is informational).
- `GET /ready` — 200 while **either** store can serve redirects; 503 as soon as shutdown starts (drain signal).
- `GET /metrics` — Prometheus exposition. Restrict to the internal network in production.

Every response carries `x-request-id`; logs are JSON (pino) and include the same `requestId`, so a user report
with that header leads straight to the log lines.

---

## Redirect latency high

**Alert:** `RedirectLatencyP99High` — p99 of `redirect_duration_seconds{outcome="redirect"}` > 50ms for 10m.

1. Check the cache hit ratio (next section). Misses cost a Postgres round trip.
2. Check `cache_requests_total{result="error"}` — Redis errors force every redirect to Postgres.
3. Check Postgres: connection saturation (pool max is 20 per instance), slow queries on `urls.short_code`.
4. Check event loop / CPU on API pods (`process_cpu_seconds_total`, `nodejs_eventloop_lag_seconds`).

**Scale reads:** add API replicas (stateless); add Redis read replicas; put a CDN in front with
`REDIRECT_CACHE_MAX_AGE_SECONDS>0` (trades click accuracy for edge offload — cached redirects are not counted).

## Cache hit ratio low

**Alert:** `CacheHitRatioLow` — hits / all lookups < 80% for 15m.

- Expected briefly after a Redis restart or flush (cold cache); it refills on read.
- Sustained: check Redis memory and evictions (`INFO stats` → `evicted_keys`). Set `maxmemory-policy allkeys-lru`
  and size memory for the hot set (≈20% of links serve ≈80% of traffic).
- A scan of random/unknown codes also shows as misses — look for 404 spikes from one IP (rate limit applies).

## Cache stampede

Symptom: a popular link's cache entry expires and Postgres sees a burst of identical
`SELECT ... WHERE short_code = $1`.

- **Mitigation built in:** singleflight. The first request takes a Redis lock `sf:{code}` (5s TTL) and loads
  from Postgres; concurrent requests poll the cache for up to 2s, then fall through.
- Verify: Postgres query count for that code should be ~1 per cache TTL, not per request.
  The `coalesces concurrent cache misses into a single database query` test covers this.
- Locks are released only by their owner (token + Lua compare-and-delete), so a slow leader cannot release a
  newer leader's lock.

## Redis down

**Alert:** `RedisErrors`; `/health` returns 503 with `"redis":"down"`; `/ready` stays 200.

Behaviour: the client fails commands immediately while disconnected (`enableOfflineQueue: false`), so redirects
fall back to Postgres without waiting on retries. Rate limiting fails **open** (`skipOnError`). The integration test
`with Redis unavailable` asserts redirects stay under 250ms.

Actions:
1. Restore Redis (or fail over to a replica). ioredis reconnects automatically; no API restart needed.
2. Watch Postgres load — it now takes 100% of reads. Scale API down / Postgres up if needed.
3. Cache refills on read; expect `CacheHitRatioLow` for a few minutes.

## Postgres down

**Alert:** `ServingStaleCache`; `/health` 503 with `"database":"down"`.

Behaviour: redirects for links already in Redis keep working (**stale OK** — up to 24h old). Unknown codes and
all writes (create, delete, register, login, stats) return 500. The click worker's inserts fail, so it stops
committing offsets; events wait in Kafka and are written once Postgres is back (no data loss).

Actions:
1. Fail over to the replica / restore the primary.
2. Expect `KafkaConsumerLagHigh` to fire and then drain on recovery.
3. Links that expire during the outage still return 410: expiry is checked against the cached `expiresAt`.

## Kafka down or clicks dropped

**Alert:** `ClickEventsDropped`; `/health` shows `"kafka":"down"`.

Behaviour: redirects never wait on Kafka. Each API instance buffers up to 10,000 events in memory
(`click_publisher_buffer_size`). A failed send (`click_publish_errors_total`) puts the batch back at the front of
the buffer and retries with exponential backoff (1 s, 2 s, 4 s … capped at 30 s); `/health` reports
`"kafka":"down"` until a send succeeds again. Events are dropped only when they no longer fit, counted by reason:

| `reason` | Meaning |
|----------|---------|
| `buffer_full` | Outage outlasted the 10k buffer; newest events were rejected |
| `shutdown` | Process exited with events still buffered or in flight (3 s flush deadline) |
| `closed` | Event arrived during shutdown |

Actions: restore the broker. The publisher retries on its own and drains the buffer (the log shows
`click publisher recovered`). Clicks dropped for `buffer_full` are not recoverable, so analytics for that window
are under-counted (redirects were unaffected). A retried batch can occasionally reach Kafka twice; the worker
ignores the duplicate `event_id`.

Verified live (Kafka 4.4): broker killed mid-traffic → 101 clicks buffered, `/health` showed Kafka down,
0 dropped → broker restarted → all 101 published within ~3 s and written to Postgres.

## Kafka consumer lag

**Alert:** `KafkaConsumerLagHigh` — total lag on `click-events` > 100k for 10m.

1. Is the worker running? `:9101/health` is 503 if it is not in the consumer group.
2. Is Postgres slow or down? Batch inserts failing → the worker retries the same batch.
3. Scale out: run more worker replicas (up to the 6 topic partitions). Increase partitions for more parallelism.
4. Inserts are idempotent (`ON CONFLICT DO NOTHING` on `event_id`), so redeliveries during recovery never
   double-count.

## Elevated 5xx

**Alert:** `High5xxRate` — > 1% of requests are 5xx.

- Search logs for `"msg":"unhandled error"` and group by `route`; each line has `requestId` and the stack.
- Most common causes: Postgres unavailable (see above), pool exhaustion under load, or a bad deploy (roll back).

## Hot URL / abusive client

- Per-IP rate limits (shared across instances via Redis): **100 creates/hour**, **1000 redirects/min**,
  **20 auth attempts/min**. Exceeding returns `429` with `retry-after`.
- Behind a load balancer set `TRUST_PROXY=true`, otherwise every client shares the balancer's IP.
- A viral link is served from Redis (one key) — singleflight prevents a stampede when it expires.

## Instance down

**Alert:** `InstanceDown`. Check container/pod status and logs. On SIGTERM the API flips `/ready` to 503, waits 5s
(production) for the load balancer to drain, then closes the server, flushes buffered click events and closes
connections.

## Expired links

The cleaner purges expired links hourly in batches of 1000 (`expired_urls_purged_total`). It takes a Postgres
advisory lock, so running several replicas is safe — only one purges at a time. Redirects to expired links
return **410** regardless of whether the purge has run. Manual run: `npm run cleanup -- --once`.

## Click table partitions

`clicks` is range-partitioned by day. The worker creates partitions for yesterday through 7 days ahead at
startup and hourly; rows outside that window land in `clicks_default`. To drop old analytics, detach and drop
whole daily partitions (`ALTER TABLE clicks DETACH PARTITION clicks_p20260101; DROP TABLE clicks_p20260101;`)
instead of running large `DELETE`s.

## Monitoring checklist

Configured in `monitoring/alerts.yml`: redirect p99, 5xx rate, cache hit ratio, Redis errors, stale-cache
serving, dropped clicks, consumer lag, instance down. Also worth dashboarding: `urls_created_total` rate,
`http_requests_total` by `status_class`, `click_publisher_buffer_size`, `clicks_written_total`, Node.js
heap and event loop lag (default process metrics).
