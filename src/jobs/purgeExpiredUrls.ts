import type pg from 'pg';
import type { Queryable } from '../db/pool.js';
import { expiredUrlsPurgedTotal } from '../observability/metrics.js';

/** Arbitrary constant identifying the cleanup job's Postgres advisory lock. */
export const PURGE_LOCK_KEY = 728_190_001;

export interface PurgeOptions {
  batchSize?: number;
  maxBatches?: number;
}

/**
 * Deletes expired URLs in small batches (short transactions, no long table locks)
 * and evicts their cache entries. Returns the number of URLs removed.
 */
export async function purgeExpiredUrls(
  db: Queryable,
  cache: { delete(shortCode: string): Promise<void> } | undefined,
  { batchSize = 1000, maxBatches = 1000 }: PurgeOptions = {},
): Promise<number> {
  let total = 0;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await db.query<{ short_code: string }>(
      `DELETE FROM urls
       WHERE id IN (
         SELECT id FROM urls
         WHERE expires_at IS NOT NULL AND expires_at <= now()
         ORDER BY expires_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING short_code`,
      [batchSize],
    );

    for (const row of result.rows) {
      await cache?.delete(row.short_code).catch(() => undefined);
    }

    total += result.rows.length;
    if (result.rows.length < batchSize) {
      break;
    }
  }

  expiredUrlsPurgedTotal.inc(total);
  return total;
}

/**
 * Runs the purge only if no other replica is running it right now
 * (session-level advisory lock on a dedicated connection). Returns null if skipped.
 */
export async function purgeWithLock(
  pool: Pick<pg.Pool, 'connect'>,
  cache: { delete(shortCode: string): Promise<void> } | undefined,
  options?: PurgeOptions,
): Promise<number | null> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [PURGE_LOCK_KEY],
    );
    if (!rows[0]?.locked) {
      return null;
    }

    try {
      return await purgeExpiredUrls(client, cache, options);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [PURGE_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
