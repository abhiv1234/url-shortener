# Load testing

Two equivalent scripts drive a **10:1 read/write mix** (redirects : creates) at **100 concurrent
connections** and fail if p99 latency exceeds **50ms**:

| Script | Tool | Run |
|--------|------|-----|
| [`scripts/load-test.mjs`](../scripts/load-test.mjs) | [autocannon](https://github.com/mcollina/autocannon) (installed as a dev dependency) | `npm run load-test -- --url http://localhost:3000 --duration 30` |
| [`scripts/load-test.k6.js`](../scripts/load-test.k6.js) | [k6](https://k6.io) | `k6 run -e BASE_URL=http://localhost:3000 scripts/load-test.k6.js` |

Both seed 200 links first. Start the server with `RATE_LIMIT_ENABLED=false`, otherwise the single load-generator
IP is throttled at 1000 redirects/min (which is the point of the limiter).

## Results

Single API process (`node dist/index.js`, `NODE_ENV=production`), local Postgres 17 and Redis 7, load generator
on the same machine — Apple M1, 8 cores, 8 GB RAM. Kafka was deliberately unreachable to show redirects do not
depend on it.

```
$ npm run load-test -- --url http://localhost:3300 --connections 100 --duration 30
Running 30s with 100 connections (10:1 GET /{code} : POST /v1/urls)
┌───────┬────────┬────────┬────────┬────────┬──────────┬────────┐
│ req/s │ p50 ms │ p90 ms │ p99 ms │ max ms │ requests │ errors │
├───────┼────────┼────────┼────────┼────────┼──────────┼────────┤
│ 27103 │ 2      │ 6      │ 11     │ 78     │ 813079   │ 0      │
└───────┴────────┴────────┴────────┴────────┴──────────┴────────┘
status codes: { '201': 73870, '302': 739209 }
PASS: p99 11ms ≤ 50ms across the mixed workload
```

| Metric | Result | Target |
|--------|--------|--------|
| Throughput (mixed) | **~27,000 req/s** on one process | ~4,400 req/s (4K reads + 400 writes) |
| p99 latency, client-side, mixed | **11 ms** | < 50 ms |
| Redirect handling, server-side (`redirect_duration_seconds`) | **99.98% < 5 ms** of 1.36M redirects | — |
| Cache hit ratio (`cache_requests_total`) | **~100%** (1 miss, then hits) | hot set 80% |
| Errors | **0** | — |

A redirect-heavy run (90 redirect connections + 10 create connections running independently) reached
**31,000 redirects/s at p99 4 ms**.

### Reading the numbers honestly

- Everything ran on one laptop, so the load generator competed with the server for CPU; a real deployment
  would also add network latency between API, Redis and Postgres (typically ~0.5–1 ms per hop in one zone).
- 200 seeded links all fit in the cache, so this measures the hot path. Cold reads cost an extra Postgres
  lookup on the indexed `short_code` column.
- With Kafka down, the click publisher filled its 10,000-event buffer and then dropped events
  (`click_events_dropped_total{reason="buffer_full"}`) — the intended backpressure behaviour. With a broker up,
  events are batched (500 per send) off the request path.
