# URL Shortener

A horizontally scalable URL shortener built in phases. Converts long URLs to short aliases with low-latency redirects, analytics, and authenticated link management.

## Problem Statement

**Category:** SDE2 System Design

| Metric | Target |
|--------|--------|
| Scale | 100M URLs, 10:1 read:write ratio |
| Throughput | ~400 writes/s, ~4K reads/s |
| Storage | ~500 bytes/URL → ~50 GB + indexes |
| Read latency | p99 < 50ms |
| Availability | 99.99% for redirects |
| Cache | Hot 20% URLs → 80% traffic |

## APIs

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/urls` | Create short URL `{longUrl, customAlias?, ttl?}` → `{shortUrl, id}` |
| `GET` | `/{code}` | 302 redirect to original URL |
| `GET` | `/v1/urls/{id}/stats` | Click analytics |
| `DELETE` | `/v1/urls/{id}` | Delete or expire link |

## Architecture

```
Client → API Gateway → Write Service (Postgres)
                    ↘ Read Path: CDN/Edge → Redis cache → Postgres fallback
Async worker: Kafka → analytics DB (click aggregation)
```

**Short code generation:**
- **(A)** DB auto-increment + Base62 — simple, no collisions
- **(B)** MD5/SHA prefix — distributed, retry on collision

**Read path:** Cache-aside on miss → DB → populate Redis with TTL. Use 301 for permanent, 302 for analytics flexibility.

## Data Model

```sql
-- urls(id PK, short_code UNIQUE, long_url, user_id, created_at, expires_at)
-- clicks(url_id, ts, referrer, ip_hash) — partitioned by date
-- Index: short_code (B-tree); user_id + created_at
```

## Implementation Phases

| Phase | Focus | Agent Prompt |
|-------|-------|--------------|
| 1 | Core API + Postgres + redirects | [agents/phase-1-core.md](agents/phase-1-core.md) |
| 2 | Redis cache + read optimization | [agents/phase-2-cache.md](agents/phase-2-cache.md) |
| 3 | Analytics pipeline (Kafka + clicks) | [agents/phase-3-analytics.md](agents/phase-3-analytics.md) |
| 4 | Auth, TTL, delete, rate limiting | [agents/phase-4-auth.md](agents/phase-4-auth.md) |
| 5 | Observability, load tests, hardening | [agents/phase-5-hardening.md](agents/phase-5-hardening.md) |

See [AGENTS.md](AGENTS.md) for orchestration instructions and [docs/](docs/) for detailed design.

## Quick Start

```bash
cp .env.example .env
npm install
make up
make migrate
make run
```

Create a short URL:

```bash
curl -s -X POST http://localhost:3000/v1/urls \
  -H 'Content-Type: application/json' \
  -d '{"longUrl":"https://example.com/very/long/path"}'
```

Follow the redirect:

```bash
curl -I http://localhost:3000/<shortCode>
```

Run tests:

```bash
make test
```

## Tech Stack

- **API:** Node.js + Fastify + TypeScript
- **Database:** PostgreSQL
- **Cache:** Redis
- **Queue:** Kafka (analytics)
- **Infra:** Docker Compose → Kubernetes

## License

MIT
