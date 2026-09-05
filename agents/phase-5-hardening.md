# Phase 5 — Observability & Hardening

> **Agent prompt:** Copy this entire file into a Cursor Agent chat to implement Phase 5.

## Prerequisites

Phases 1–4 complete and all prior tests passing.

## Context

Read `docs/architecture.md` (failure modes, capacity). Review full codebase.

## Goals

1. **Structured logging** (pino or winston) with request IDs.
2. **Metrics** endpoint or Prometheus `/metrics`:
   - redirect latency histogram
   - cache hit/miss ratio
   - create rate, 4xx/5xx counts
   - Kafka consumer lag (if available)
3. **Rate limiting** on `POST /v1/urls` and `GET /{code}` (per IP).
4. **Health checks:** `GET /health` (DB + Redis), `GET /ready`.
5. **Load test** script (k6 or autocannon) validating:
   - redirect p99 < 50ms at 100 concurrent (local target)
   - 10:1 read/write mix
6. **Runbook** in `docs/runbook.md` covering failure modes.

## Rate Limiting

- Use `@fastify/rate-limit` or Redis sliding window.
- Suggested: 100 creates/hour/IP, 1000 redirects/min/IP.

## Failure Mode Tests

| Scenario | Expected behavior |
|----------|-------------------|
| Redis down | Fall back to Postgres on redirect |
| Postgres down | Serve from Redis only (stale OK) |
| Hot URL | Rate limit kicks in, no stampede |
| Kafka down | Redirect still works; clicks buffered or dropped with metric |

## Load Test

Create `scripts/load-test.js` (k6):

```javascript
// 90% GET /{code}, 10% POST /v1/urls
// thresholds: p(99) < 50 for redirects
```

Document how to run in README.

## Runbook (`docs/runbook.md`)

- Cache stampede → verify singleflight
- DB failover → read from cache
- Scaling reads → Redis replicas, CDN
- Monitoring alerts to configure

## Acceptance Criteria

- [ ] `/health` and `/ready` return correct status.
- [ ] `/metrics` exposes key counters.
- [ ] Rate limit returns 429 when exceeded.
- [ ] Load test script runs and documents results.
- [ ] `docs/runbook.md` complete.
- [ ] All previous phase tests still pass.

## When Done

Commit: `feat(phase-5): observability, rate limits, load tests, and runbook`

Project is **feature-complete** for the SDE2 design scope.
