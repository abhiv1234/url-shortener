import { describe, expect, it } from 'vitest';
import { resetMetrics, getStaleCacheServedCount } from '../src/cache/metrics.js';
import { Singleflight } from '../src/cache/singleflight.js';
import { UrlCache } from '../src/cache/urlCache.js';
import { ConflictError, NotFoundError, UrlService } from '../src/services/urlService.js';

function createMockRedis() {
  const store = new Map<string, string>();
  const locks = new Map<string, string>();

  return {
    store,
    redis: {
      async get(key: string) {
        return store.get(key) ?? null;
      },
      async set(key: string, value: string, _mode?: string, _ttl?: number) {
        if (key.startsWith('sf:')) {
          if (locks.has(key)) {
            return null;
          }
          locks.set(key, value);
          return 'OK';
        }

        store.set(key, value);
        return 'OK';
      },
      async del(key: string) {
        store.delete(key);
        return 1;
      },
      async eval(_script: string, _numKeys: number, key: string, token: string) {
        if (locks.get(key) === token) {
          locks.delete(key);
          return 1;
        }
        return 0;
      },
    },
  };
}

describe('UrlService cache integration', () => {
  it('serves redirects from cache without hitting Postgres on repeat reads', async () => {
    const { redis } = createMockRedis();
    const cache = new UrlCache(redis);
    const singleflight = new Singleflight(redis);
    let dbQueries = 0;

    const service = new UrlService(
      {
        query: async () => {
          dbQueries += 1;
          return {
            rows: [{ id: '1', long_url: 'https://example.com', expires_at: null }],
          };
        },
        connect: async () => {
          throw new Error('not implemented');
        },
      } as never,
      'http://localhost:3000',
      cache,
      singleflight,
    );

    const first = await service.getLongUrlByCode('abc');
    const second = await service.getLongUrlByCode('abc');

    expect(first).toBe('https://example.com');
    expect(second).toBe('https://example.com');
    expect(dbQueries).toBe(1);
  });

  it('coalesces concurrent cache misses into a single database query', async () => {
    const { redis } = createMockRedis();
    const cache = new UrlCache(redis);
    const singleflight = new Singleflight(redis, 5, 500);
    let dbQueries = 0;

    const service = new UrlService(
      {
        query: async () => {
          dbQueries += 1;
          await new Promise((resolve) => setTimeout(resolve, 50));
          return {
            rows: [{ id: '2', long_url: 'https://example.com/hot', expires_at: null }],
          };
        },
        connect: async () => {
          throw new Error('not implemented');
        },
      } as never,
      'http://localhost:3000',
      cache,
      singleflight,
    );

    const results = await Promise.all([
      service.getLongUrlByCode('hot'),
      service.getLongUrlByCode('hot'),
      service.getLongUrlByCode('hot'),
    ]);

    expect(results).toEqual([
      'https://example.com/hot',
      'https://example.com/hot',
      'https://example.com/hot',
    ]);
    expect(dbQueries).toBe(1);
  });

  it('warms cache after URL creation', async () => {
    const { redis, store } = createMockRedis();
    const cache = new UrlCache(redis);
    const singleflight = new Singleflight(redis);

    const service = new UrlService(
      {
        query: async () => ({
          rows: [
            {
              id: '1',
              short_code: 'my-link',
              long_url: 'https://example.com',
              expires_at: null,
            },
          ],
        }),
        connect: async () => {
          throw new Error('not implemented');
        },
      } as never,
      'http://localhost:3000',
      cache,
      singleflight,
    );

    await service.createUrl({
      longUrl: 'https://example.com',
      customAlias: 'my-link',
    });

    expect(store.has('url:my-link')).toBe(true);
    const cached = await cache.get('my-link');
    expect(cached?.longUrl).toBe('https://example.com');
  });

  it('serves stale cache when Postgres fails on read', async () => {
    resetMetrics();
    const { redis } = createMockRedis();
    const singleflight = new Singleflight(redis);

    let cacheReads = 0;
    const cacheWithMissThenHit = {
      async get(_shortCode: string) {
        cacheReads += 1;
        if (cacheReads <= 2) {
          return null;
        }
        return { id: '4', longUrl: 'https://cached.example.com', expiresAt: null };
      },
      async set() {},
      async delete() {},
    } as unknown as UrlCache;

    const service = new UrlService(
      {
        query: async () => {
          throw new Error('database unavailable');
        },
        connect: async () => {
          throw new Error('not implemented');
        },
      } as never,
      'http://localhost:3000',
      cacheWithMissThenHit,
      singleflight,
    );

    const longUrl = await service.getLongUrlByCode('stale');
    expect(longUrl).toBe('https://cached.example.com');
    expect(getStaleCacheServedCount()).toBe(1);
  });

  it('still throws NotFoundError when code is missing in cache and database', async () => {
    const { redis } = createMockRedis();
    const cache = new UrlCache(redis);
    const singleflight = new Singleflight(redis);

    const service = new UrlService(
      {
        query: async () => ({ rows: [] }),
        connect: async () => {
          throw new Error('not implemented');
        },
      } as never,
      'http://localhost:3000',
      cache,
      singleflight,
    );

    await expect(service.getLongUrlByCode('missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('falls back to Postgres when Redis is unavailable on redirect', async () => {
    const failing = async (): Promise<never> => {
      throw new Error('redis down');
    };
    const brokenRedis = { get: failing, set: failing, del: failing, eval: failing };
    const warnings: unknown[] = [];

    const service = new UrlService(
      {
        query: async () => ({
          rows: [{ id: '3', long_url: 'https://example.com/db', expires_at: null }],
        }),
        connect: async () => {
          throw new Error('not implemented');
        },
      } as never,
      'http://localhost:3000',
      new UrlCache(brokenRedis),
      new Singleflight(brokenRedis),
      { warn: (obj) => warnings.push(obj) },
    );

    await expect(service.getLongUrlByCode('abc')).resolves.toBe('https://example.com/db');
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('still returns the created URL when cache warming fails', async () => {
    const failing = async (): Promise<never> => {
      throw new Error('redis down');
    };
    const brokenRedis = { get: failing, set: failing, del: failing, eval: failing };
    const queries: string[] = [];

    const client = {
      async query(sql: string) {
        queries.push(sql.trim().split(/\s+/)[0]);
        if (sql.includes('INSERT')) {
          return { rows: [{ id: '125', short_code: '_tmp', long_url: 'https://example.com', expires_at: null }] };
        }
        if (sql.includes('UPDATE')) {
          return { rows: [{ id: '125', short_code: '21', long_url: 'https://example.com', expires_at: null }] };
        }
        return { rows: [] };
      },
      release() {},
    };

    const service = new UrlService(
      { query: async () => ({ rows: [] }), connect: async () => client } as never,
      'http://localhost:3000',
      new UrlCache(brokenRedis),
      new Singleflight(brokenRedis),
      { warn: () => undefined },
    );

    const record = await service.createUrl({ longUrl: 'https://example.com' });
    expect(record.shortUrl).toBe('http://localhost:3000/21');
    expect(queries).toEqual(['BEGIN', 'INSERT', 'UPDATE', 'COMMIT']);
  });

  it('retries when a generated code collides with an existing custom alias', async () => {
    let nextId = 100;
    let updates = 0;
    const client = {
      async query(sql: string) {
        if (sql.includes('INSERT')) {
          nextId += 1;
          return { rows: [{ id: String(nextId), short_code: '_tmp', long_url: 'https://example.com', expires_at: null }] };
        }
        if (sql.includes('UPDATE')) {
          updates += 1;
          if (updates === 1) {
            const error = new Error('duplicate key');
            (error as { code?: string }).code = '23505';
            throw error;
          }
          return { rows: [{ id: String(nextId), short_code: '1e', long_url: 'https://example.com', expires_at: null }] };
        }
        return { rows: [] };
      },
      release() {},
    };

    const service = new UrlService(
      { query: async () => ({ rows: [] }), connect: async () => client } as never,
      'http://localhost:3000',
    );

    const record = await service.createUrl({ longUrl: 'https://example.com' });
    expect(record.shortCode).toBe('1e');
    expect(updates).toBe(2);
  });

  it('keeps mapping custom alias collisions to ConflictError', async () => {
    const service = new UrlService(
      {
        query: async () => {
          const error = new Error('duplicate key');
          (error as { code?: string }).code = '23505';
          throw error;
        },
        connect: async () => {
          throw new Error('not implemented');
        },
      } as never,
      'http://localhost:3000',
    );

    await expect(
      service.createUrl({ longUrl: 'https://example.com', customAlias: 'taken' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
