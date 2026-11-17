# Agent Orchestration — URL Shortener

This repo was implemented in **5 phases** — all complete (see the status table below). Each phase has a dedicated agent prompt in `agents/`. Run phases sequentially; each phase builds on the previous.

## How to Run an Agent

In Cursor, open a new Agent chat and paste the contents of the phase file, or reference it:

```
@agents/phase-1-core.md Implement Phase 1 of the URL shortener.
```

After a phase completes, verify acceptance criteria in that phase file before starting the next.

## Status

| Phase | Status |
|-------|--------|
| 1 — Core API & Database | ✅ Done |
| 2 — Redis Cache Layer | ✅ Done |
| 3 — Analytics Pipeline | ✅ Done |
| 4 — Auth, TTL & Lifecycle | ✅ Done |
| 5 — Observability & Hardening | ✅ Done |

## Phase Overview

```
Phase 1: Core API ──► Phase 2: Cache ──► Phase 3: Analytics
                                              │
Phase 5: Hardening ◄── Phase 4: Auth ◄────────┘
```

### Phase 1 — Core API & Database
**Goal:** Working create + redirect with Postgres.  
**Deliverables:** `POST /v1/urls`, `GET /{code}`, migrations, Docker Compose, unit tests.  
**Prompt:** [agents/phase-1-core.md](agents/phase-1-core.md)

### Phase 2 — Redis Cache Layer
**Goal:** p99 read latency < 50ms via cache-aside.  
**Deliverables:** Redis integration, singleflight, cache TTL, stale-OK fallback.  
**Prompt:** [agents/phase-2-cache.md](agents/phase-2-cache.md)

### Phase 3 — Analytics Pipeline
**Goal:** Click tracking with async aggregation.  
**Deliverables:** Kafka producer, click worker, `GET /v1/urls/{id}/stats`.  
**Prompt:** [agents/phase-3-analytics.md](agents/phase-3-analytics.md)

### Phase 4 — Auth, TTL & Lifecycle
**Goal:** Authenticated users, link expiry, deletion.  
**Deliverables:** JWT auth, `DELETE /v1/urls/{id}`, TTL enforcement, 409 on alias collision.  
**Prompt:** [agents/phase-4-auth.md](agents/phase-4-auth.md)

### Phase 5 — Observability & Hardening
**Goal:** Production readiness.  
**Deliverables:** Metrics, structured logging, load tests, runbook, failure-mode tests.  
**Prompt:** [agents/phase-5-hardening.md](agents/phase-5-hardening.md)

## Conventions for All Agents

1. **Read first:** `docs/architecture.md`, `docs/data-model.md`, and the previous phase's code.
2. **Minimize scope:** Only implement what the current phase requires.
3. **Match style:** Follow existing patterns in the repo.
4. **Test:** Add tests for new behavior; run `make check` (and `make test-integration` for DB/cache changes) before finishing.
5. **Document:** Update README quick-start if setup changes.
6. **No secrets:** Use `.env.example`; never commit real credentials.

## Failure Modes to Handle (by phase)

| Failure | Phase | Mitigation |
|---------|-------|------------|
| Cache stampede | 2 | Singleflight / request coalescing |
| Hot URL overload | 2 | Edge cache headers + rate limit |
| DB down on read | 2 | Serve from cache (stale OK) |
| Custom alias collision | 1/4 | 409 Conflict |
| Kafka lag | 3 | Bounded producer buffer (backpressure), 6 partitions keyed by url id, daily-partitioned `clicks` table |

## Future Improvements (out of scope)

- Custom domains
- QR codes
- A/B redirect targets
- Geo routing
