# Phase 4 — Auth, TTL & Lifecycle

> **Agent prompt:** Copy this entire file into a Cursor Agent chat to implement Phase 4.

## Prerequisites

Phases 1–3 complete.

## Context

Read `docs/api.md` for auth requirements on delete and stats.

## Goals

1. Add JWT-based authentication (register/login or API key — keep simple).
2. Associate `user_id` with URLs on create when authenticated.
3. Enforce **TTL** — reject redirects for expired links (`410 Gone`).
4. Implement `DELETE /v1/urls/{id}` — owner only.
5. Protect `GET /v1/urls/{id}/stats` — owner only.
6. Background job or cron to purge expired URLs from DB and Redis.

## Auth Design (MVP)

- `POST /v1/auth/register` `{email, password}`
- `POST /v1/auth/login` → `{token}`
- Bearer token on protected routes.
- Use `bcrypt` for passwords, `jsonwebtoken` for JWT.
- Add `users` table: `id UUID PK, email UNIQUE, password_hash, created_at`.

## Authorization Rules

| Action | Rule |
|--------|------|
| Create URL | Public; if authed, set `user_id` |
| Delete URL | Must own URL (`user_id` match) |
| View stats | Must own URL |
| Redirect | Public (no auth) |

## TTL Enforcement

- On create with `ttl`, set `expires_at = now() + ttl`.
- Redirect: if `expires_at < now()` → `410 Gone`, delete from Redis.
- Cleanup job: `DELETE FROM urls WHERE expires_at < now()` every hour.

## Delete Flow

1. Verify JWT and ownership.
2. Delete from Postgres.
3. Delete `url:{code}` from Redis.
4. Return `204`.

## Acceptance Criteria

- [ ] Unauthenticated delete returns 401.
- [ ] Wrong owner delete returns 403.
- [ ] Expired link redirect returns 410.
- [ ] Authenticated create sets `user_id`.
- [ ] Stats requires auth and ownership.
- [ ] Cleanup job removes expired rows.

## When Done

Commit: `feat(phase-4): JWT auth, TTL enforcement, and delete API`

Do **not** start Phase 5 in this session.
