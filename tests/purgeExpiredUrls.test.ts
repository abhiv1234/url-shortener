import { describe, expect, it } from 'vitest';
import { purgeExpiredUrls, purgeWithLock } from '../src/jobs/purgeExpiredUrls.js';

describe('purgeExpiredUrls', () => {
  it('deletes in batches until a short batch and evicts cache entries', async () => {
    const batches = [[{ short_code: 'a' }, { short_code: 'b' }], [{ short_code: 'c' }]];
    const evicted: string[] = [];
    const db = { query: async () => ({ rows: batches.shift() ?? [] }) } as never;

    const purged = await purgeExpiredUrls(db, { delete: async (code) => void evicted.push(code) }, { batchSize: 2 });

    expect(purged).toBe(3);
    expect(evicted).toEqual(['a', 'b', 'c']);
  });

  it('keeps purging the database when the cache is down', async () => {
    const db = { query: async () => ({ rows: [{ short_code: 'a' }] }) } as never;
    const cache = { delete: async () => Promise.reject(new Error('redis down')) };
    await expect(purgeExpiredUrls(db, cache, { batchSize: 5 })).resolves.toBe(1);
  });
});

describe('purgeWithLock', () => {
  function pool(locked: boolean) {
    const statements: string[] = [];
    let released = false;
    const client = {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked }] };
        return { rows: [] };
      },
      release: () => {
        released = true;
      },
    };
    return { pool: { connect: async () => client } as never, statements, released: () => released };
  }

  it('skips the pass when another replica holds the lock', async () => {
    const { pool: p, statements, released } = pool(false);
    expect(await purgeWithLock(p, undefined)).toBeNull();
    expect(statements.some((sql) => sql.includes('DELETE'))).toBe(false);
    expect(released()).toBe(true);
  });

  it('purges and unlocks when it gets the lock', async () => {
    const { pool: p, statements, released } = pool(true);
    expect(await purgeWithLock(p, undefined)).toBe(0);
    expect(statements.at(-1)).toContain('pg_advisory_unlock');
    expect(released()).toBe(true);
  });
});
