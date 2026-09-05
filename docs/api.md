# API Specification

Base URL: `https://short.example.com`

## Create Short URL

```
POST /v1/urls
Content-Type: application/json
```

**Request:**
```json
{
  "longUrl": "https://example.com/very/long/path",
  "customAlias": "my-link",
  "ttl": 86400
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `longUrl` | yes | Valid http/https URL |
| `customAlias` | no | 3–16 alphanumeric + hyphen/underscore |
| `ttl` | no | Seconds until expiry |

**Response `201`:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "shortUrl": "https://short.example.com/my-link",
  "shortCode": "my-link",
  "expiresAt": "2026-09-06T12:00:00Z"
}
```

**Errors:**
- `400` — invalid URL or alias format
- `409` — custom alias already taken
- `429` — rate limited

---

## Redirect

```
GET /{code}
```

**Response `302`:**
```
Location: https://example.com/very/long/path
```

**Errors:**
- `404` — code not found
- `410` — link expired

---

## URL Statistics

```
GET /v1/urls/{id}/stats
Authorization: Bearer <token>
```

**Response `200`:**
```json
{
  "urlId": "550e8400-e29b-41d4-a716-446655440000",
  "totalClicks": 1523,
  "clicksByDay": [
    { "date": "2026-09-01", "count": 120 },
    { "date": "2026-09-02", "count": 98 }
  ],
  "topReferrers": [
    { "referrer": "https://twitter.com", "count": 45 }
  ]
}
```

---

## Delete URL

```
DELETE /v1/urls/{id}
Authorization: Bearer <token>
```

**Response `204`** — no content

**Errors:**
- `403` — not owner
- `404` — not found
