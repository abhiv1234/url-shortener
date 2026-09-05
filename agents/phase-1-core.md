# Phase 1 — Core API & Database

> **Agent prompt:** Copy this entire file into a Cursor Agent chat to implement Phase 1.

## Context

You are implementing **Phase 1** of the URL Shortener project. Read `docs/architecture.md`, `docs/data-model.md`, and `docs/api.md` before coding.

**Stack choice:** Use **Node.js + Fastify + TypeScript** unless the repo already has a different stack. Keep the structure clean for later phases.

## Goals

1. Bootstrap the service with Docker Compose (Postgres only for now).
2. Implement database migrations for the `urls` table.
3. Implement `POST /v1/urls` and `GET /{code}` (302 redirect).
4. Short code generation via **auto-increment + Base62**.
5. Support optional `customAlias` with **409 on collision**.
6. Basic input validation and error responses per `docs/api.md`.

## Directory Structure (create)

```
url-shortener/
├── docker-compose.yml
├── Makefile
├── .env.example
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── app.ts
│   ├── config.ts
│   ├── db/
│   │   ├── pool.ts
│   │   └── migrations/
│   ├── routes/
│   │   ├── urls.ts
│   │   └── redirect.ts
│   ├── services/
│   │   └── urlService.ts
│   └── utils/
│       ├── base62.ts
│       └── validate.ts
└── tests/
    └── urlService.test.ts
```

## Implementation Details

### POST /v1/urls
- Validate `longUrl` is a valid http/https URL.
- If `customAlias` provided: validate format (3–16 chars, alphanumeric + `-` `_`), check uniqueness.
- Else: insert row, read `id`, encode with Base62 as `short_code`.
- Return `{ id, shortUrl, shortCode, expiresAt }` — `expiresAt` null if no ttl (ttl can be stored but not enforced until Phase 4).
- Use `SHORT_URL_BASE` env var for short URL prefix (default `http://localhost:3000`).

### GET /{code}
- Lookup by `short_code`.
- Return `302` with `Location` header.
- `404` if not found.

### Base62
- Charset: `0-9A-Za-z` (62 chars).
- Encode positive integers only.

## Docker Compose

```yaml
services:
  postgres:
    image: postgres:16-alpine
    ports: ["5432:5432"]
    environment:
      POSTGRES_USER: urlshort
      POSTGRES_PASSWORD: urlshort
      POSTGRES_DB: urlshort
```

## Makefile targets

- `make up` — docker compose up -d
- `make migrate` — run SQL migrations
- `make run` — start dev server
- `make test` — run tests

## Acceptance Criteria

- [ ] `docker compose up` starts Postgres
- [ ] `POST /v1/urls` with long URL returns short URL
- [ ] `POST /v1/urls` with duplicate customAlias returns 409
- [ ] `GET /{code}` returns 302 to original URL
- [ ] `GET /unknown` returns 404
- [ ] Unit tests for Base62 encode and URL validation pass
- [ ] README quick-start works

## Out of Scope (later phases)

- Redis, Kafka, auth, analytics, rate limiting, TTL enforcement

## When Done

Commit with message: `feat(phase-1): core URL create and redirect API`

Do **not** start Phase 2 in this session.
