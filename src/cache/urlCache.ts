import type { Redis } from 'ioredis';

export const DEFAULT_CACHE_TTL_SECONDS = 86_400;

export interface CachedUrlEntry {
  longUrl: string;
  expiresAt: string | null;
}

export function cacheKey(shortCode: string): string {
  return `url:${shortCode}`;
}

export function singleflightKey(shortCode: string): string {
  return `sf:${shortCode}`;
}

export function computeCacheTtl(expiresAt: string | null, now = Date.now()): number {
  if (!expiresAt) {
    return DEFAULT_CACHE_TTL_SECONDS;
  }

  const remainingMs = new Date(expiresAt).getTime() - now;
  if (remainingMs <= 0) {
    return 1;
  }

  const remainingSeconds = Math.floor(remainingMs / 1000);
  return Math.min(DEFAULT_CACHE_TTL_SECONDS, remainingSeconds);
}

export class UrlCache {
  constructor(private readonly redis: Pick<Redis, 'get' | 'set' | 'del'>) {}

  async get(shortCode: string): Promise<CachedUrlEntry | null> {
    const raw = await this.redis.get(cacheKey(shortCode));
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as CachedUrlEntry;
      if (typeof parsed.longUrl !== 'string') {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  async set(shortCode: string, entry: CachedUrlEntry): Promise<void> {
    const ttl = computeCacheTtl(entry.expiresAt);
    await this.redis.set(cacheKey(shortCode), JSON.stringify(entry), 'EX', ttl);
  }

  async delete(shortCode: string): Promise<void> {
    await this.redis.del(cacheKey(shortCode));
  }
}
