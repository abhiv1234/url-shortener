import type { Redis } from 'ioredis';
import {
  BufferedClickPublisher,
  type ClickPublisher,
  NoopClickPublisher,
} from './analytics/clickPublisher.js';
import { createClickProducer, createKafka, ensureTopic } from './analytics/kafka.js';
import type { AppDeps } from './app.js';
import { TokenService } from './auth/tokens.js';
import { createRedisClient } from './cache/redis.js';
import { Singleflight } from './cache/singleflight.js';
import { UrlCache } from './cache/urlCache.js';
import type { AppConfig } from './config.js';
import { createPool } from './db/pool.js';
import { AuthService } from './services/authService.js';
import { StatsService } from './services/statsService.js';
import { type ServiceLogger, UrlService } from './services/urlService.js';

interface ContainerLogger extends ServiceLogger {
  info(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

export interface Container {
  deps: Omit<AppDeps, 'config'>;
  redis: Redis;
  close(): Promise<void>;
}

/** Wires real infrastructure (Postgres, Redis, Kafka) into the app's dependencies. */
export async function createContainer(config: AppConfig, logger: ContainerLogger): Promise<Container> {
  const db = createPool(config.databaseUrl, (error) => logger.error({ err: error }, 'postgres pool error'));

  const redis = createRedisClient(config.redisUrl);
  redis.on('error', (error) => logger.warn({ err: error }, 'redis error'));
  try {
    await redis.connect();
  } catch (error) {
    // Redirects fall back to Postgres; ioredis keeps reconnecting in the background.
    logger.warn({ err: error }, 'redis unavailable at startup; continuing without cache');
  }

  const cache = new UrlCache(redis);
  const singleflight = new Singleflight(redis);
  const urlService = new UrlService(db, config.shortUrlBase, cache, singleflight, logger);
  const tokens = new TokenService(config.auth.jwtSecret, config.auth.jwtExpiresInSeconds);
  const authService = new AuthService(db, tokens, config.auth.bcryptRounds);
  const statsService = new StatsService(db, urlService, redis);

  let clickPublisher: ClickPublisher = new NoopClickPublisher();
  if (config.kafka.enabled) {
    const kafka = createKafka(config.kafka, logger);
    clickPublisher = new BufferedClickPublisher(createClickProducer(kafka), {
      topic: config.kafka.clickTopic,
      prepare: () => ensureTopic(kafka, config.kafka.clickTopic, config.kafka.clickTopicPartitions),
      logger,
    });
  } else {
    logger.info({}, 'KAFKA_ENABLED=false; click tracking is disabled');
  }
  await clickPublisher.start();

  return {
    redis,
    deps: {
      urlService,
      authService,
      statsService,
      tokens,
      clickPublisher,
      rateLimitRedis: redis,
      healthChecks: {
        database: async () => {
          await db.query('SELECT 1');
        },
        redis: async () => {
          await redis.ping();
        },
        kafkaConnected: () => clickPublisher.isConnected(),
      },
    },
    async close() {
      await clickPublisher.close();
      await db.end();
      if (redis.status === 'ready') {
        await redis.quit();
      } else {
        redis.disconnect();
      }
    },
  };
}
