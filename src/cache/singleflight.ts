import { randomUUID } from 'node:crypto';
import { singleflightKey } from './urlCache.js';

const LOCK_TTL_SECONDS = 5;
const POLL_INTERVAL_MS = 50;
const WAIT_TIMEOUT_MS = 2000;

/** Delete the lock only if we still own it (another leader may hold it after our TTL lapsed). */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

export interface SingleflightRedis {
  set(key: string, value: string, ex: 'EX', seconds: number, nx: 'NX'): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Singleflight {
  constructor(
    private readonly redis: SingleflightRedis,
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
    const token = randomUUID();

    let acquired: string | null;
    try {
      acquired = await this.redis.set(lockKey, token, 'EX', LOCK_TTL_SECONDS, 'NX');
    } catch {
      // Redis unavailable: no coordination possible, go straight to the source.
      return onTimeout();
    }

    if (acquired === 'OK') {
      try {
        return await onLeader();
      } finally {
        await this.release(lockKey, token);
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

  private async release(lockKey: string, token: string): Promise<void> {
    try {
      await this.redis.eval(RELEASE_SCRIPT, 1, lockKey, token);
    } catch {
      // Lock expires on its own via TTL; never let release mask the leader's result.
    }
  }
}
