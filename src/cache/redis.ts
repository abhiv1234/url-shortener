import { Redis } from 'ioredis';
import { config } from '../config.js';

let client: Redis | undefined;

export function createRedisClient(url: string = config.redisUrl): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
    // While disconnected, fail commands immediately instead of queueing them, so a Redis
    // outage costs redirects ~0ms before falling back to Postgres rather than retry delays.
    enableOfflineQueue: false,
    connectTimeout: 2_000,
  });
}

export function getRedisClient(): Redis {
  client ??= createRedisClient();
  return client;
}

export async function connectRedis(): Promise<Redis> {
  const redis = getRedisClient();
  if (redis.status === 'wait' || redis.status === 'end') {
    await redis.connect();
  }
  return redis;
}

export async function disconnectRedis(): Promise<void> {
  if (!client) {
    return;
  }
  const current = client;
  client = undefined;
  if (current.status === 'ready') {
    await current.quit();
  } else {
    current.disconnect();
  }
}
