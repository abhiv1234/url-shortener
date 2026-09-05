# Phase 2 — Redis Cache Layer

> **Agent prompt:** Copy this entire file into a Cursor Agent chat to implement Phase 2.

## Prerequisites

Phase 1 must be complete and working. Run `make test` before starting.

## Context

Read `docs/architecture.md` (caching strategy) and existing `src/` code from Phase 1.

## Goals

1. Add Redis to Docker Compose.
2. Implement **cache-aside** on the redirect read path.
3. Add **singleflight** (request coalescing) to prevent cache stampede.
4. Warm cache on URL creation (optional but recommended).
5. On Redis/DB failure: serve stale cache for redirects when possible.

## Implementation Details

### Redis client
- Use `ioredis` or `redis` npm package.
- Config via `REDIS_URL` env var (default `redis://localhost:6379`).

### Cache key format
```
url:{short_code} → JSON {"longUrl":"...","expiresAt":"..."|null}
```

### Redirect flow (updated)
1. `GET url:{code}` from Redis.
2. On hit → 302 immediately.
3. On miss → acquire singleflight lock `sf:{code}`.
4. Query Postgres, set Redis with TTL = `min(24h, expires_at - now)` or 24h default.
5. Release lock, return 302.

### Singleflight
- If lock held, wait briefly (poll or pub/sub) for cache populate.
- Timeout after 2s → fall through to DB directly.

### Stale-on-DB-down
- If Postgres errors on read but Redis has value → serve redirect anyway.
- Log warning; increment metric stub for later (Phase 5).

### Create path
- After insert, `SET url:{code}` in Redis.

## Docker Compose addition

```yaml
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
```

## Acceptance Criteria

- [ ] Second redirect for same code does not hit Postgres (verify via log or test mock).
- [ ] Concurrent misses for same code result in single DB query (singleflight test).
- [ ] Cache TTL is set correctly.
- [ ] Service starts with Redis in docker compose.
- [ ] Integration test: create URL → redirect works with cache.

## Out of Scope

- Kafka, auth, analytics, CDN

## When Done

Commit: `feat(phase-2): Redis cache-aside with singleflight on redirect path`

Do **not** start Phase 3 in this session.
