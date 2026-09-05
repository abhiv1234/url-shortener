import { Redis } from 'ioredis';
import { config } from '../config.js';

let client: Redis | undefined;

export function getRedisClient(): Redis {
  if (!client) {
    client = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
  }
  return client;
}

export async function connectRedis(): Promise<Redis> {
  const redis = getRedisClient();
  if (redis.status !== 'ready' && redis.status !== 'connecting') {
    await redis.connect();
  }
  return redis;
}

export async function disconnectRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = undefined;
  }
}
