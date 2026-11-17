import { describe, expect, it } from 'vitest';
import { ForbiddenError } from '../src/errors.js';
import { StatsService } from '../src/services/statsService.js';

function statsDb() {
  let queries = 0;
  const db = {
    query: async (sql: string) => {
      queries += 1;
      if (sql.includes('count(*) AS count FROM clicks')) return { rows: [{ count: '3' }] };
      if (sql.includes('generate_series')) return { rows: [{ date: '2026-11-16', count: 1 }, { date: '2026-11-17', count: 2 }] };
      return { rows: [{ referrer: 'https://t.co', count: 2 }] };
    },
  } as never;
  return { db, count: () => queries };
}

describe('StatsService', () => {
  it('returns totals, a daily series and top referrers for the owner', async () => {
    const { db } = statsDb();
    const service = new StatsService(db, { assertOwner: async (id) => ({ id, shortCode: 'abc' }) });

    await expect(service.getStats('5', 'u1')).resolves.toEqual({
      urlId: '5',
      totalClicks: 3,
      clicksByDay: [
        { date: '2026-11-16', count: 1 },
        { date: '2026-11-17', count: 2 },
      ],
      topReferrers: [{ referrer: 'https://t.co', count: 2 }],
    });
  });

  it('enforces ownership before running any query', async () => {
    const { db, count } = statsDb();
    const service = new StatsService(db, {
      assertOwner: async () => {
        throw new ForbiddenError('nope', 'FORBIDDEN');
      },
    });

    await expect(service.getStats('5', 'u2')).rejects.toBeInstanceOf(ForbiddenError);
    expect(count()).toBe(0);
  });

  it('serves repeat requests from the short-lived cache', async () => {
    const { db, count } = statsDb();
    const store = new Map<string, string>();
    const cache = {
      get: async (key: string) => store.get(key) ?? null,
      set: async (key: string, value: string) => {
        store.set(key, value);
      },
    };
    const service = new StatsService(db, { assertOwner: async (id) => ({ id, shortCode: 'abc' }) }, cache);

    const first = await service.getStats('5', 'u1');
    const second = await service.getStats('5', 'u1');
    expect(second).toEqual(first);
    expect(count()).toBe(3);
  });
});
