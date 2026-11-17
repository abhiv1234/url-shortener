import { describe, expect, it } from 'vitest';
import { clickPartitionName, ensureClickPartitions, plannedClickPartitions } from '../src/db/partitions.js';

describe('click partitions', () => {
  it('names partitions by UTC day', () => {
    expect(clickPartitionName(new Date('2026-11-17T23:59:00Z'))).toBe('clicks_p20261117');
  });

  it('plans contiguous daily ranges around today, crossing month boundaries', () => {
    const specs = plannedClickPartitions(new Date('2026-11-30T15:00:00Z'), 1, 2);
    expect(specs).toEqual([
      { name: 'clicks_p20261129', from: '2026-11-29 00:00:00+00', to: '2026-11-30 00:00:00+00' },
      { name: 'clicks_p20261130', from: '2026-11-30 00:00:00+00', to: '2026-12-01 00:00:00+00' },
      { name: 'clicks_p20261201', from: '2026-12-01 00:00:00+00', to: '2026-12-02 00:00:00+00' },
      { name: 'clicks_p20261202', from: '2026-12-02 00:00:00+00', to: '2026-12-03 00:00:00+00' },
    ]);
  });

  it('keeps going when one partition cannot be created', async () => {
    const statements: string[] = [];
    const warnings: unknown[] = [];
    const db = {
      query: async (sql: string) => {
        statements.push(sql);
        if (statements.length === 1) throw new Error('default partition has rows');
        return { rows: [] };
      },
    } as never;

    await ensureClickPartitions(db, {
      now: new Date('2026-11-17T00:00:00Z'),
      daysBack: 0,
      daysAhead: 2,
      logger: { warn: (obj) => warnings.push(obj) },
    });

    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain('CREATE TABLE IF NOT EXISTS clicks_p20261117 PARTITION OF clicks');
    expect(warnings).toHaveLength(1);
  });
});
