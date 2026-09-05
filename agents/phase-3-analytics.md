# Phase 3 — Analytics Pipeline

> **Agent prompt:** Copy this entire file into a Cursor Agent chat to implement Phase 3.

## Prerequisites

Phases 1–2 complete. Redirect path uses Redis cache-aside.

## Context

Read `docs/data-model.md` (clicks table, Kafka) and `docs/api.md` (stats endpoint).

## Goals

1. Add Kafka (or Redpanda for lighter local dev) to Docker Compose.
2. On redirect, publish **async** click event (non-blocking).
3. Create `clicks` table with date partitioning (or simple table for MVP).
4. Implement click **consumer worker** that writes to Postgres.
5. Implement `GET /v1/urls/{id}/stats` (no auth yet — add in Phase 4).

## Click Event Payload

```json
{
  "urlId": 12345,
  "ts": "2026-09-05T08:00:00Z",
  "referrer": "https://google.com",
  "ipHash": "sha256..."
}
```

- Hash client IP with server salt before publishing.
- Capture `Referer` header on redirect.

## Worker

- Separate process: `src/workers/clickConsumer.ts`
- Consumer group: `click-writer`
- Batch insert clicks for efficiency.
- Add `make worker` target.

## Stats API

```
GET /v1/urls/{id}/stats
```

Return:
- `totalClicks`
- `clicksByDay` (last 30 days)
- `topReferrers` (top 10)

Use efficient SQL aggregation; consider daily rollup table if raw clicks are large.

## Docker Compose

```yaml
  redpanda:  # or kafka + zookeeper
    image: redpandadata/redpanda:latest
    command: ...
```

Topic: `click-events`, 6 partitions.

## Acceptance Criteria

- [ ] Redirect publishes click event without blocking response.
- [ ] Worker persists clicks to DB.
- [ ] Stats endpoint returns accurate counts after test redirects.
- [ ] `make worker` runs consumer alongside API.
- [ ] Tests cover event serialization and stats query.

## Out of Scope

- Geo IP, auth on stats, real-time dashboards

## When Done

Commit: `feat(phase-3): async click tracking and stats API`

Do **not** start Phase 4 in this session.
