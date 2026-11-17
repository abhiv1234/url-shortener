import { describe, expect, it } from 'vitest';
import type { CachedUrlEntry, UrlCache } from '../src/cache/urlCache.js';
import { Singleflight } from '../src/cache/singleflight.js';
import { ForbiddenError, GoneError, NotFoundError, ValidationError } from '../src/errors.js';
import { parseUrlId, UrlService } from '../src/services/urlService.js';

function memoryCache(initial: Record<string, CachedUrlEntry> = {}) {
  const store = new Map(Object.entries(initial));
  const cache = {
    get: async (code: string) => store.get(code) ?? null,
    set: async (code: string, entry: CachedUrlEntry) => {
      store.set(code, entry);
    },
    delete: async (code: string) => {
      store.delete(code);
    },
  } as unknown as UrlCache;
  return { store, cache };
}

const lockRedis = { set: async () => 'OK', eval: async () => 1 };
const past = new Date(Date.now() - 60_000);
const future = new Date(Date.now() + 60_000);

describe('UrlService TTL enforcement', () => {
  it('returns GoneError for an expired link and evicts it from the cache', async () => {
    const { store, cache } = memoryCache({
      old: { id: '1', longUrl: 'https://example.com', expiresAt: past.toISOString() },
    });
    const service = new UrlService({ query: async () => ({ rows: [] }) } as never, 'http://s.test', cache, new Singleflight(lockRedis));

    await expect(service.resolve('old')).rejects.toBeInstanceOf(GoneError);
    expect(store.has('old')).toBe(false);
  });

  it('returns GoneError for an expired link found in the database and does not cache it', async () => {
    const { store, cache } = memoryCache();
    const db = { query: async () => ({ rows: [{ id: '1', long_url: 'https://example.com', expires_at: past }] }) } as never;
    const service = new UrlService(db, 'http://s.test', cache, new Singleflight(lockRedis));

    await expect(service.resolve('old')).rejects.toBeInstanceOf(GoneError);
    expect(store.size).toBe(0);
  });

  it('serves links that have not expired yet', async () => {
    const db = { query: async () => ({ rows: [{ id: '9', long_url: 'https://example.com', expires_at: future }] }) } as never;
    const service = new UrlService(db, 'http://s.test');

    await expect(service.resolve('fresh')).resolves.toMatchObject({ id: '9', longUrl: 'https://example.com' });
  });
});

describe('UrlService ownership', () => {
  const owner = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const other = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  function serviceWith(row: { id: string; short_code: string; user_id: string | null } | undefined) {
    const statements: string[] = [];
    const { store, cache } = memoryCache({ abc: { id: '5', longUrl: 'https://example.com', expiresAt: null } });
    const db = {
      query: async (sql: string) => {
        statements.push(sql);
        return { rows: sql.startsWith('SELECT') && row ? [row] : [] };
      },
    } as never;
    return { service: new UrlService(db, 'http://s.test', cache, new Singleflight(lockRedis)), statements, store };
  }

  it('lets the owner delete a link and evicts it from the cache', async () => {
    const { service, statements, store } = serviceWith({ id: '5', short_code: 'abc', user_id: owner });
    await service.deleteUrl('5', owner);
    expect(statements.some((sql) => sql.startsWith('DELETE FROM urls'))).toBe(true);
    expect(store.has('abc')).toBe(false);
  });

  it('forbids deleting someone else’s link or an anonymous link', async () => {
    await expect(serviceWith({ id: '5', short_code: 'abc', user_id: other }).service.deleteUrl('5', owner)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(serviceWith({ id: '5', short_code: 'abc', user_id: null }).service.deleteUrl('5', owner)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('returns NotFoundError for missing or malformed ids', async () => {
    await expect(serviceWith(undefined).service.deleteUrl('5', owner)).rejects.toBeInstanceOf(NotFoundError);
    expect(() => parseUrlId('abc')).toThrow(NotFoundError);
    expect(() => parseUrlId('0')).toThrow(NotFoundError);
    expect(() => parseUrlId('9223372036854775808')).toThrow(NotFoundError);
    expect(parseUrlId('9223372036854775807')).toBe('9223372036854775807');
  });
});

describe('UrlService create', () => {
  it('stores the owner when the caller is authenticated', async () => {
    let params: unknown[] = [];
    const db = {
      query: async (_sql: string, values: unknown[]) => {
        params = values;
        return { rows: [{ id: '1', short_code: 'mine', long_url: 'https://example.com', expires_at: null, created_at: new Date() }] };
      },
    } as never;

    const record = await new UrlService(db, 'http://s.test').createUrl({ longUrl: 'https://example.com', customAlias: 'mine' }, 'user-1');
    expect(params[3]).toBe('user-1');
    expect(record.createdAt).not.toBeNull();
  });

  it('refuses to shorten links to itself (redirect loops)', async () => {
    const service = new UrlService({ query: async () => ({ rows: [] }) } as never, 'https://sho.rt');
    await expect(service.createUrl({ longUrl: 'https://sho.rt/abc' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects absurdly long URLs and TTLs', async () => {
    const service = new UrlService({ query: async () => ({ rows: [] }) } as never, 'https://sho.rt');
    await expect(service.createUrl({ longUrl: `https://example.com/${'a'.repeat(2100)}` })).rejects.toMatchObject({ code: 'INVALID_URL' });
    await expect(service.createUrl({ longUrl: 'https://example.com', ttl: 10 ** 12 })).rejects.toMatchObject({ code: 'INVALID_TTL' });
  });
});

describe('UrlService list', () => {
  const rows = [3, 2, 1].map((n) => ({
    id: String(n),
    short_code: `c${n}`,
    long_url: 'https://example.com',
    expires_at: null,
    created_at: new Date(Date.UTC(2026, 0, n)),
  }));

  it('pages with an opaque cursor', async () => {
    const calls: unknown[][] = [];
    const db = {
      query: async (_sql: string, params: unknown[]) => {
        calls.push(params);
        const limit = params[3] as number;
        const start = params[2] ? rows.findIndex((row) => row.id === params[2]) + 1 : 0;
        return { rows: rows.slice(start, start + limit) };
      },
    } as never;
    const service = new UrlService(db, 'http://s.test');

    const first = await service.listUrls('u1', { limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual(['3', '2']);
    expect(first.nextCursor).not.toBeNull();

    const second = await service.listUrls('u1', { limit: 2, cursor: first.nextCursor! });
    expect(second.items.map((item) => item.id)).toEqual(['1']);
    expect(second.nextCursor).toBeNull();
    expect(calls[1][2]).toBe('2');
  });

  it('rejects a tampered cursor', async () => {
    const service = new UrlService({ query: async () => ({ rows: [] }) } as never, 'http://s.test');
    await expect(service.listUrls('u1', { cursor: 'not-a-cursor' })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });
});
