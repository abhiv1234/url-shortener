# API Reference

Interactive OpenAPI docs are served at **`/docs`** (Swagger UI) and **`/docs/json`** when the server runs.

Base URL: `http://localhost:3000` (configure with `SHORT_URL_BASE`).

All errors share one shape:

```json
{ "error": "human readable message", "code": "MACHINE_READABLE_CODE" }
```

Ids are Postgres `BIGINT`s encoded as **strings** (they can exceed JavaScript's safe integer range).

## Authentication

### Register

```
POST /v1/auth/register
{ "email": "ada@example.com", "password": "correct horse battery" }
```

`201` → `{ "id": "<uuid>", "email": "ada@example.com", "createdAt": "..." }`

Errors: `400 INVALID_EMAIL | INVALID_PASSWORD` (8–72 bytes), `409 EMAIL_TAKEN`, `429 RATE_LIMITED`.

### Login

```
POST /v1/auth/login
{ "email": "ada@example.com", "password": "correct horse battery" }
```

`200` → `{ "token": "<jwt>", "tokenType": "Bearer", "expiresIn": 3600 }`

Errors: `401 INVALID_CREDENTIALS` (same error for unknown email and wrong password), `429 RATE_LIMITED`.

Send the token as `Authorization: Bearer <jwt>` (HS256, 1h by default).

## Links

### Create a short URL

```
POST /v1/urls
Authorization: Bearer <jwt>        (optional)
{ "longUrl": "https://example.com/very/long/path", "customAlias": "my-link", "ttl": 86400 }
```

| Field | Required | Rules |
|-------|----------|-------|
| `longUrl` | yes | `http`/`https`, ≤ 2048 chars, not on the shortener's own host |
| `customAlias` | no | 3–16 chars of `A-Z a-z 0-9 _ -` |
| `ttl` | no | integer seconds until expiry (≤ 10 years) |

`201`:

```json
{
  "id": "125",
  "shortCode": "my-link",
  "shortUrl": "http://localhost:3000/my-link",
  "longUrl": "https://example.com/very/long/path",
  "expiresAt": "2026-09-06T12:00:00.000Z",
  "createdAt": "2026-09-05T12:00:00.000Z"
}
```

Without an alias the code is the Base62 encoding of the id (`125` → `21`).
Anonymous links work but have no owner, so nobody can view their stats or delete them.

Errors: `400 VALIDATION_ERROR | INVALID_URL | INVALID_ALIAS | INVALID_TTL`, `401 INVALID_TOKEN` (a token was sent but
is invalid), `409 ALIAS_TAKEN`, `429 RATE_LIMITED` (100/hour/IP).

### List my links

```
GET /v1/urls?limit=20&cursor=<nextCursor>
Authorization: Bearer <jwt>
```

`200` → `{ "items": [<link>, ...], "nextCursor": "<opaque>" | null }` — newest first, keyset-paginated.

### Delete a link

```
DELETE /v1/urls/{id}
Authorization: Bearer <jwt>
```

`204` — removed from Postgres and evicted from Redis.

Errors: `401 UNAUTHORIZED`, `403 FORBIDDEN` (not the owner), `404 NOT_FOUND`.

### Link statistics

```
GET /v1/urls/{id}/stats
Authorization: Bearer <jwt>
```

`200`:

```json
{
  "urlId": "125",
  "totalClicks": 1523,
  "clicksByDay": [
    { "date": "2026-10-19", "count": 0 },
    { "date": "2026-11-17", "count": 120 }
  ],
  "topReferrers": [{ "referrer": "https://twitter.com", "count": 45 }]
}
```

`clicksByDay` always has 30 entries (UTC days, zero-filled, oldest first); `topReferrers` has up to 10.
Results are cached for 30 seconds. Clicks appear after the worker consumes them (normally well under a second).

Errors: `401`, `403 FORBIDDEN`, `404 NOT_FOUND`.

## Redirect

```
GET /{code}
```

`302 Found` with `Location: <longUrl>` and `Cache-Control: no-store` (so every click is counted;
set `REDIRECT_CACHE_MAX_AGE_SECONDS` to allow edge caching). `HEAD` works too and is not counted as a click.

Errors: `404 NOT_FOUND`, `410 GONE` (expired), `429 RATE_LIMITED` (1000/min/IP).

## Operations

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | `200` if Postgres **and** Redis are up, else `503`; body: `{ status, checks: { database, redis, kafka } }` |
| `GET /ready` | `200` while Postgres **or** Redis can serve redirects; `503` during shutdown |
| `GET /metrics` | Prometheus metrics |
| `GET /docs` | Swagger UI |

Every response includes an `x-request-id` header (a valid incoming one is echoed back).
