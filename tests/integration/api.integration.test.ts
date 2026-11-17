/**
 * End-to-end tests against real Postgres and Redis.
 *
 *   INTEGRATION=1 DATABASE_URL=... REDIS_URL=... npm run test:integration
 *
 * WARNING: truncates the urls/users/clicks tables and deletes this app's Redis keys.
 * Point it at a disposable database only (docker compose or CI service containers).
 */
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { type AppConfig, loadConfig } from '../../src/config.js';
import { type Container, createContainer } from '../../src/container.js';
import { clickPartitionName } from '../../src/db/partitions.js';
import { migrate } from '../../src/db/migrate.js';
import { createPool } from '../../src/db/pool.js';
import { purgeWithLock } from '../../src/jobs/purgeExpiredUrls.js';
import { UrlCache } from '../../src/cache/urlCache.js';
import { ClickWriter } from '../../src/workers/clickWriter.js';
import { RecordingPublisher } from '../helpers/testApp.js';

const enabled = process.env.INTEGRATION === '1';

const silent = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

async function deleteAppKeys(redis: Redis): Promise<void> {
  for (const pattern of ['url:*', 'sf:*', 'stats:*', 'rl:*']) {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      if (keys.length > 0) await redis.del(...keys);
      cursor = next;
    } while (cursor !== '0');
  }
}

describe.skipIf(!enabled)('API against real Postgres + Redis', () => {
  let config: AppConfig;
  let pool: pg.Pool;
  let container: Container;
  let publisher: RecordingPublisher;
  let app: FastifyInstance;

  async function startApp(overrides: Partial<AppConfig> = {}) {
    return buildApp({
      ...container.deps,
      config: { ...config, ...overrides },
      clickPublisher: publisher,
      logger: undefined,
    });
  }

  async function signup(email: string): Promise<string> {
    const credentials = { email, password: 'correct horse battery' };
    expect((await app.inject({ method: 'POST', url: '/v1/auth/register', payload: credentials })).statusCode).toBe(201);
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: credentials });
    expect(login.statusCode).toBe(200);
    return `Bearer ${login.json().token}`;
  }

  async function create(payload: Record<string, unknown>, authorization?: string) {
    return app.inject({
      method: 'POST',
      url: '/v1/urls',
      headers: authorization ? { authorization } : {},
      payload,
    });
  }

  beforeAll(async () => {
    config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      KAFKA_ENABLED: 'false',
      RATE_LIMIT_ENABLED: 'false',
    });
    pool = createPool(config.databaseUrl);
    await migrate(pool, () => undefined);
    container = await createContainer(config, silent);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE clicks, urls, users RESTART IDENTITY CASCADE');
    await deleteAppKeys(container.redis);
    publisher = new RecordingPublisher();
    await app?.close();
    app = await startApp();
  });

  afterAll(async () => {
    await app?.close();
    await container?.close();
    await pool?.end();
  });

  it('creates a link, redirects through the cache, and survives the row vanishing from Postgres', async () => {
    const created = await create({ longUrl: 'https://example.com/a' });
    expect(created.statusCode).toBe(201);
    const { shortCode, id } = created.json();
    expect(shortCode).toBe('1');

    expect(await container.redis.exists(`url:${shortCode}`)).toBe(1);

    const first = await app.inject(`/${shortCode}`);
    expect(first.statusCode).toBe(302);
    expect(first.headers.location).toBe('https://example.com/a');

    // Bypass the app and remove the row: a cache hit must not need Postgres.
    await pool.query('DELETE FROM urls WHERE id = $1', [id]);
    expect((await app.inject(`/${shortCode}`)).statusCode).toBe(302);
  });

  it('returns 409 for a taken alias and retries when a generated code collides with an alias', async () => {
    expect((await create({ longUrl: 'https://example.com', customAlias: 'abc' })).statusCode).toBe(201);
    expect((await create({ longUrl: 'https://example.com', customAlias: 'abc' })).statusCode).toBe(409);

    // base62("abc") = 36*62^2 + 37*62 + 38 = 140716 → make that the next generated id.
    await pool.query("SELECT setval('urls_id_seq', 140715)");
    const generated = await create({ longUrl: 'https://example.com/generated' });

    expect(generated.statusCode).toBe(201);
    expect(generated.json().shortCode).not.toBe('abc');
    expect((await app.inject('/abc')).headers.location).toBe('https://example.com');
  });

  it('enforces TTL with 410 Gone', async () => {
    const { shortCode } = (await create({ longUrl: 'https://example.com/ttl', ttl: 1 })).json();
    expect((await app.inject(`/${shortCode}`)).statusCode).toBe(302);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const gone = await app.inject(`/${shortCode}`);
    expect(gone.statusCode).toBe(410);
    expect(gone.json().code).toBe('GONE');
  });

  it('only the owner can delete; deletion evicts the cache', async () => {
    const owner = await signup('owner@example.com');
    const stranger = await signup('stranger@example.com');
    const { id, shortCode } = (await create({ longUrl: 'https://example.com/mine' }, owner)).json();

    expect((await app.inject({ method: 'DELETE', url: `/v1/urls/${id}` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url: `/v1/urls/${id}`, headers: { authorization: stranger } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/v1/urls/${id}`, headers: { authorization: owner } })).statusCode).toBe(204);

    expect(await container.redis.exists(`url:${shortCode}`)).toBe(0);
    expect((await app.inject(`/${shortCode}`)).statusCode).toBe(404);
  });

  it('records clicks idempotently and reports accurate stats to the owner only', async () => {
    const owner = await signup('stats@example.com');
    const stranger = await signup('nosy@example.com');
    const { id, shortCode } = (await create({ longUrl: 'https://example.com/s' }, owner)).json();

    for (const referer of ['https://t.co', 'https://t.co', 'https://news.ycombinator.com']) {
      expect((await app.inject({ url: `/${shortCode}`, headers: { referer } })).statusCode).toBe(302);
    }
    expect(publisher.events).toHaveLength(3);

    const writer = new ClickWriter(pool);
    expect(await writer.write(publisher.events)).toBe(3);
    // A Kafka redelivery of the same events must not double-count.
    expect(await writer.write(publisher.events)).toBe(0);

    const { rows } = await pool.query<{ partition: string }>('SELECT DISTINCT tableoid::regclass::text AS partition FROM clicks');
    expect(rows.map((row) => row.partition)).toEqual([clickPartitionName(new Date())]);

    expect((await app.inject({ url: `/v1/urls/${id}/stats`, headers: { authorization: stranger } })).statusCode).toBe(403);
    const stats = await app.inject({ url: `/v1/urls/${id}/stats`, headers: { authorization: owner } });
    expect(stats.statusCode).toBe(200);

    const body = stats.json();
    expect(body.totalClicks).toBe(3);
    expect(body.clicksByDay).toHaveLength(30);
    expect(body.clicksByDay.at(-1)).toEqual({ date: new Date().toISOString().slice(0, 10), count: 3 });
    expect(body.topReferrers).toEqual([
      { referrer: 'https://t.co', count: 2 },
      { referrer: 'https://news.ycombinator.com', count: 1 },
    ]);
  });

  it('lists only the caller’s links with cursor pagination', async () => {
    const owner = await signup('list@example.com');
    for (let i = 0; i < 3; i += 1) await create({ longUrl: `https://example.com/${i}` }, owner);
    await create({ longUrl: 'https://example.com/anon' });

    const page1 = (await app.inject({ url: '/v1/urls?limit=2', headers: { authorization: owner } })).json();
    expect(page1.items).toHaveLength(2);
    const page2 = (
      await app.inject({ url: `/v1/urls?limit=2&cursor=${page1.nextCursor}`, headers: { authorization: owner } })
    ).json();
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    expect([...page1.items, ...page2.items].map((item: { longUrl: string }) => item.longUrl).sort()).toEqual([
      'https://example.com/0',
      'https://example.com/1',
      'https://example.com/2',
    ]);
  });

  it('purges expired links from Postgres and Redis, one replica at a time', async () => {
    const { shortCode } = (await create({ longUrl: 'https://example.com/old', ttl: 3600 })).json();
    await create({ longUrl: 'https://example.com/keep' });
    await pool.query("UPDATE urls SET expires_at = now() - interval '1 minute' WHERE short_code = $1", [shortCode]);

    expect(await purgeWithLock(pool, new UrlCache(container.redis))).toBe(1);
    expect(await container.redis.exists(`url:${shortCode}`)).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM urls')).rows[0].n).toBe(1);
  });

  it('rate limits per IP using shared Redis counters', async () => {
    await app.close();
    app = await startApp({ rateLimit: { ...config.rateLimit, enabled: true, redirect: { max: 2, timeWindowMs: 60_000 } } });
    const { shortCode } = (await create({ longUrl: 'https://example.com/rl' })).json();

    expect((await app.inject(`/${shortCode}`)).statusCode).toBe(302);
    expect((await app.inject(`/${shortCode}`)).statusCode).toBe(302);
    expect((await app.inject(`/${shortCode}`)).statusCode).toBe(429);
    expect((await container.redis.keys('rl:*')).length).toBeGreaterThan(0);
  });

  it('reports healthy dependencies', async () => {
    const res = await app.inject('/health');
    expect(res.statusCode).toBe(200);
    expect(res.json().checks).toMatchObject({ database: 'up', redis: 'up' });
  });

  describe('with Redis unavailable', () => {
    let degraded: Container;
    let degradedApp: FastifyInstance;

    beforeAll(async () => {
      const badConfig = { ...config, redisUrl: 'redis://127.0.0.1:1' };
      degraded = await createContainer(badConfig, silent);
      degradedApp = await buildApp({ ...degraded.deps, config: badConfig, clickPublisher: new RecordingPublisher() });
    });

    afterAll(async () => {
      await degradedApp?.close();
      await degraded?.close();
    });

    it('still creates and redirects via Postgres, quickly', async () => {
      const created = await degradedApp.inject({ method: 'POST', url: '/v1/urls', payload: { longUrl: 'https://example.com/no-redis' } });
      expect(created.statusCode).toBe(201);

      const started = Date.now();
      const res = await degradedApp.inject(`/${created.json().shortCode}`);
      expect(res.statusCode).toBe(302);
      expect(Date.now() - started).toBeLessThan(250);
    });

    it('fails /health but stays /ready', async () => {
      expect((await degradedApp.inject('/health')).statusCode).toBe(503);
      expect((await degradedApp.inject('/ready')).statusCode).toBe(200);
    });
  });
});
