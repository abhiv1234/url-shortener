import pg from 'pg';
import { config } from '../config.js';

export type Queryable = Pick<pg.Pool, 'query'>;

export function createPool(
  connectionString: string = config.databaseUrl,
  onError: (error: Error) => void = (error) => console.error('Postgres pool error:', error),
): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: 20,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
  });
  // An idle client losing its connection emits 'error'; unhandled, it would crash the process.
  pool.on('error', onError);
  return pool;
}
