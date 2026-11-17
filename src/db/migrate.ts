import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { ensureClickPartitions } from './partitions.js';
import { createPool } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, 'migrations');

export async function migrate(pool: pg.Pool, log: (msg: string) => void = console.log): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();

  for (const version of files) {
    const { rows } = await pool.query('SELECT 1 FROM schema_migrations WHERE version = $1', [
      version,
    ]);

    if (rows.length > 0) {
      log(`Skipping ${version} (already applied)`);
      continue;
    }

    const sql = await readFile(path.join(migrationsDir, version), 'utf8');
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      await client.query('COMMIT');
      log(`Applied ${version}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  await ensureClickPartitions(pool);
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isEntrypoint) {
  const pool = createPool();
  migrate(pool)
    .then(async () => {
      console.log('Migrations complete');
      await pool.end();
    })
    .catch(async (error: unknown) => {
      console.error('Migration failed:', error);
      await pool.end();
      process.exit(1);
    });
}
