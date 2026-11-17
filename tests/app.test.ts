import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createTestApp, OWNER, STRANGER } from './helpers/testApp.js';

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
let current: TestApp | undefined;

async function setup(options?: Parameters<typeof createTestApp>[0]) {
  current = await createTestApp(options);
  return current;
}

afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

describe('POST /v1/urls', () => {
  it('creates an anonymous link', async () => {
    const { app, urlService } = await setup();
    const res = await app.inject({ method: 'POST', url: '/v1/urls', payload: { longUrl: 'https://example.com' } });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: '125', shortCode: '21', shortUrl: 'http://localhost:3000/21' });
    expect(urlService.created[0].userId).toBeNull();
  });

  it('records the owner when a valid token is sent', async () => {
    const { app, urlService, bearer } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/urls',
      headers: bearer(OWNER),
      payload: { longUrl: 'https://example.com', customAlias: 'mine' },
    });

    expect(res.statusCode).toBe(201);
    expect(urlService.created[0].userId).toBe(OWNER);
  });

  it('rejects an invalid token instead of silently creating an anonymous link', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/urls',
      headers: { authorization: 'Bearer nope' },
      payload: { longUrl: 'https://example.com' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid or expired token', code: 'INVALID_TOKEN' });
  });

  it('returns JSON 400s for schema violations and malformed bodies', async () => {
    const { app } = await setup();

    const missing = await app.inject({ method: 'POST', url: '/v1/urls', payload: {} });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe('VALIDATION_ERROR');

    const badJson = await app.inject({
      method: 'POST',
      url: '/v1/urls',
      headers: { 'content-type': 'application/json' },
      payload: '{"longUrl":',
    });
    expect(badJson.statusCode).toBe(400);
    expect(badJson.json()).toHaveProperty('code');
  });
});

describe('GET /:code', () => {
  it('302-redirects, disables caching and publishes a click event', async () => {
    const { app, publisher } = await setup();
    const res = await app.inject({
      method: 'GET',
      url: '/abc',
      headers: { referer: 'https://news.ycombinator.com', 'x-forwarded-for': '198.51.100.1' },
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://example.com/target');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(publisher.events).toHaveLength(1);
    expect(publisher.events[0]).toMatchObject({ urlId: '7', referrer: 'https://news.ycombinator.com' });
    expect(publisher.events[0].ipHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not count HEAD requests as clicks', async () => {
    const { app, publisher } = await setup();
    const res = await app.inject({ method: 'HEAD', url: '/abc' });
    expect(res.statusCode).toBe(302);
    expect(publisher.events).toHaveLength(0);
  });

  it('returns 410 for expired links and 404 for unknown or junk codes', async () => {
    const { app, publisher } = await setup();
    expect((await app.inject('/expired')).statusCode).toBe(410);
    expect((await app.inject('/expired')).json()).toEqual({ error: 'link has expired', code: 'GONE' });
    expect((await app.inject('/missing')).statusCode).toBe(404);
    expect((await app.inject('/has.dots')).statusCode).toBe(404);
    expect((await app.inject(`/${'a'.repeat(40)}`)).statusCode).toBe(404);
    expect(publisher.events).toHaveLength(0);
  });

  it('allows short-lived edge caching when configured', async () => {
    const { app } = await setup({ config: { redirectCacheMaxAgeSeconds: 60 } });
    const res = await app.inject('/abc');
    expect(res.headers['cache-control']).toBe('public, max-age=60');
  });
});

describe('authenticated routes', () => {
  it('DELETE returns 401 without a token, 403 for a stranger, 404 when missing, 204 for the owner', async () => {
    const { app, bearer } = await setup();
    expect((await app.inject({ method: 'DELETE', url: '/v1/urls/7' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url: '/v1/urls/7', headers: bearer(STRANGER) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: '/v1/urls/8', headers: bearer(OWNER) })).statusCode).toBe(404);

    const ok = await app.inject({ method: 'DELETE', url: '/v1/urls/7', headers: bearer(OWNER) });
    expect(ok.statusCode).toBe(204);
    expect(ok.body).toBe('');
  });

  it('stats require auth and ownership', async () => {
    const { app, bearer } = await setup();
    expect((await app.inject('/v1/urls/7/stats')).statusCode).toBe(401);
    expect((await app.inject({ url: '/v1/urls/7/stats', headers: bearer(STRANGER) })).statusCode).toBe(403);

    const ok = await app.inject({ url: '/v1/urls/7/stats', headers: bearer(OWNER) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ urlId: '7', totalClicks: 2 });
  });

  it('lists the caller’s links', async () => {
    const { app, bearer } = await setup();
    const res = await app.inject({ url: '/v1/urls?limit=5', headers: bearer(OWNER) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], nextCursor: null });
  });

  it('login returns a usable bearer token', async () => {
    const { app } = await setup();
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'ada@example.com', password: 'correct horse' },
    });
    expect(login.statusCode).toBe(200);
    const { token } = login.json();

    const res = await app.inject({ url: '/v1/urls/7/stats', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
  });
});

describe('rate limiting', () => {
  it('returns 429 with a JSON error once the per-IP limit is exceeded', async () => {
    const base = loadConfig({ NODE_ENV: 'test' });
    const { app } = await setup({
      config: { rateLimit: { ...base.rateLimit, enabled: true, redirect: { max: 2, timeWindowMs: 60_000 } } },
    });

    expect((await app.inject('/abc')).statusCode).toBe(302);
    expect((await app.inject('/abc')).statusCode).toBe(302);
    const limited = await app.inject('/abc');

    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();
  });

  it('limits creates separately from redirects', async () => {
    const base = loadConfig({ NODE_ENV: 'test' });
    const { app } = await setup({
      config: { rateLimit: { ...base.rateLimit, enabled: true, create: { max: 1, timeWindowMs: 60_000 } } },
    });
    const create = () => app.inject({ method: 'POST', url: '/v1/urls', payload: { longUrl: 'https://example.com' } });

    expect((await create()).statusCode).toBe(201);
    expect((await create()).statusCode).toBe(429);
    expect((await app.inject('/abc')).statusCode).toBe(302);
  });
});

describe('operations endpoints', () => {
  it('/health reports each dependency and is 503 when one is down', async () => {
    const healthy = await setup();
    const ok = await healthy.app.inject('/health');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ status: 'ok', checks: { database: 'up', redis: 'up', kafka: 'up' } });
    await healthy.app.close();

    const { app } = await setup({ healthy: { database: true, redis: false } });
    const degraded = await app.inject('/health');
    expect(degraded.statusCode).toBe(503);
    expect(degraded.json().checks.redis).toBe('down');
  });

  it('/ready stays up while either store can serve redirects, and drops during shutdown', async () => {
    const lifecycle = { shuttingDown: false };
    const { app } = await setup({ healthy: { database: false, redis: true }, lifecycle });
    expect((await app.inject('/ready')).statusCode).toBe(200);

    lifecycle.shuttingDown = true;
    expect((await app.inject('/ready')).statusCode).toBe(503);
  });

  it('/metrics exposes Prometheus metrics including redirect latency and cache counters', async () => {
    const { app } = await setup();
    await app.inject('/abc');
    const res = await app.inject('/metrics');

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    for (const name of ['redirect_duration_seconds', 'http_requests_total', 'cache_requests_total', 'click_events_dropped_total']) {
      expect(res.body).toContain(name);
    }
  });

  it('echoes a safe x-request-id and replaces an unsafe one', async () => {
    const { app } = await setup();
    const echoed = await app.inject({ url: '/health', headers: { 'x-request-id': 'req-123' } });
    expect(echoed.headers['x-request-id']).toBe('req-123');

    const replaced = await app.inject({ url: '/health', headers: { 'x-request-id': 'bad id\n{"x":1}' } });
    expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('serves OpenAPI docs and JSON 404s for unknown routes', async () => {
    const { app } = await setup();
    const spec = await app.inject('/docs/json');
    expect(spec.statusCode).toBe(200);
    expect(Object.keys(spec.json().paths)).toEqual(expect.arrayContaining(['/v1/urls', '/v1/urls/{id}/stats', '/{code}']));

    const missing = await app.inject({ method: 'POST', url: '/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'route not found', code: 'NOT_FOUND' });
  });
});
