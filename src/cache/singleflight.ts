import type { Redis } from 'ioredis';
import { singleflightKey } from './urlCache.js';

const LOCK_TTL_SECONDS = 5;
const POLL_INTERVAL_MS = 50;
const WAIT_TIMEOUT_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Singleflight {
  constructor(
    private readonly redis: Pick<Redis, 'set' | 'del'>,
    private readonly pollIntervalMs = POLL_INTERVAL_MS,
    private readonly waitTimeoutMs = WAIT_TIMEOUT_MS,
  ) {}

  async run<T>(
    key: string,
    onLeader: () => Promise<T>,
    onWait: () => Promise<T | null>,
    onTimeout: () => Promise<T>,
  ): Promise<T> {
    const lockKey = singleflightKey(key);
    const acquired = await this.redis.set(lockKey, '1', 'EX', LOCK_TTL_SECONDS, 'NX');

    if (acquired === 'OK') {
      try {
        return await onLeader();
      } finally {
        await this.redis.del(lockKey);
      }
    }

    const deadline = Date.now() + this.waitTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(this.pollIntervalMs);
      const result = await onWait();
      if (result !== null) {
        return result;
      }
    }

    return onTimeout();
  }
}
