import { describe, expect, it } from 'vitest';
import {
  computeCacheTtl,
  DEFAULT_CACHE_TTL_SECONDS,
  UrlCache,
} from '../src/cache/urlCache.js';

describe('computeCacheTtl', () => {
  const now = Date.parse('2026-09-05T12:00:00.000Z');

  it('returns 24h when no expiry is set', () => {
    expect(computeCacheTtl(null, now)).toBe(DEFAULT_CACHE_TTL_SECONDS);
  });

  it('caps TTL at 24h when link expires later', () => {
    const expiresAt = new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString();
    expect(computeCacheTtl(expiresAt, now)).toBe(DEFAULT_CACHE_TTL_SECONDS);
  });

  it('uses remaining link lifetime when shorter than 24h', () => {
    const expiresAt = new Date(now + 3600 * 1000).toISOString();
    expect(computeCacheTtl(expiresAt, now)).toBe(3600);
  });

  it('returns 1 second when link is already expired', () => {
    const expiresAt = new Date(now - 1000).toISOString();
    expect(computeCacheTtl(expiresAt, now)).toBe(1);
  });
});

describe('UrlCache', () => {
  it('stores and retrieves JSON entries with TTL', async () => {
    const store = new Map<string, { value: string; ttl?: number }>();
    const redis = {
      async get(key: string) {
        return store.get(key)?.value ?? null;
      },
      async set(key: string, value: string, _mode: string, ttl: number) {
        store.set(key, { value, ttl });
        return 'OK';
      },
      async del(key: string) {
        store.delete(key);
        return 1;
      },
    };

    const cache = new UrlCache(redis);
    await cache.set('abc', {
      id: '42',
      longUrl: 'https://example.com',
      expiresAt: null,
    });

    const entry = await cache.get('abc');
    expect(entry).toEqual({
      id: '42',
      longUrl: 'https://example.com',
      expiresAt: null,
    });
    expect(store.get('url:abc')?.ttl).toBe(DEFAULT_CACHE_TTL_SECONDS);
  });

  it('treats legacy entries without an id as a miss', async () => {
    const redis = {
      async get() {
        return JSON.stringify({ longUrl: 'https://example.com', expiresAt: null });
      },
      async set() {
        return 'OK';
      },
      async del() {
        return 1;
      },
    };

    expect(await new UrlCache(redis).get('abc')).toBeNull();
  });
});
