import { describe, expect, it } from 'vitest';
import { resetMetrics, getStaleCacheServedCount } from '../src/cache/metrics.js';
import { Singleflight } from '../src/cache/singleflight.js';
import { UrlCache } from '../src/cache/urlCache.js';
import { NotFoundError, UrlService } from '../src/services/urlService.js';

function createMockRedis() {
  const store = new Map<string, string>();
  const locks = new Set<string>();

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
          locks.add(key);
          return 'OK';
        }

        store.set(key, value);
        return 'OK';
      },
      async del(key: string) {
        locks.delete(key);
        store.delete(key);
        return 1;
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
            rows: [{ long_url: 'https://example.com', expires_at: null }],
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
            rows: [{ long_url: 'https://example.com/hot', expires_at: null }],
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
      async get(shortCode: string) {
        cacheReads += 1;
        if (cacheReads <= 2) {
          return null;
        }
        return { longUrl: 'https://cached.example.com', expiresAt: null };
      },
      async set() {},
      async delete() {},
    } as UrlCache;

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
});
