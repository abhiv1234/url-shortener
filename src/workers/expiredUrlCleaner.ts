import { connectRedis, disconnectRedis } from '../cache/redis.js';
import { UrlCache } from '../cache/urlCache.js';
import { config } from '../config.js';
import { createPool } from '../db/pool.js';
import { purgeWithLock } from '../jobs/purgeExpiredUrls.js';
import { createWorkerLogger, onShutdownSignal } from './runtime.js';

/**
 * Purges expired links from Postgres and Redis every CLEANUP_INTERVAL_MS (default 1h).
 * `--once` runs a single pass and exits (handy for cron / Kubernetes CronJob).
 */
async function main(): Promise<void> {
  const logger = createWorkerLogger('expired-url-cleaner');
  const once = process.argv.includes('--once');

  const db = createPool(config.databaseUrl, (error) => logger.error({ err: error }, 'postgres pool error'));
  const cache = await connectRedis()
    .then((redis) => new UrlCache(redis))
    .catch((error: unknown) => {
      logger.warn({ err: error }, 'redis unavailable; purging database only');
      return undefined;
    });

  const runPass = async () => {
    try {
      const purged = await purgeWithLock(db, cache);
      if (purged === null) {
        logger.info('another cleaner holds the lock; skipping this pass');
      } else {
        logger.info({ purged }, 'expired url purge complete');
      }
    } catch (error) {
      logger.error({ err: error }, 'expired url purge failed');
    }
  };

  const close = async () => {
    await db.end();
    await disconnectRedis().catch(() => undefined);
  };

  await runPass();
  if (once) {
    await close();
    return;
  }

  const timer = setInterval(() => void runPass(), config.worker.cleanupIntervalMs);
  const shutdown = async () => {
    clearInterval(timer);
    await close();
  };
  onShutdownSignal(shutdown, logger);
}

main().catch((error: unknown) => {
  console.error('expired url cleaner failed to start:', error);
  process.exit(1);
});
