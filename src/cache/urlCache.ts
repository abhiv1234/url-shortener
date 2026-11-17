
export const DEFAULT_CACHE_TTL_SECONDS = 86_400;

export interface CachedUrlEntry {
  id: string;
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

/** The slice of an ioredis client the cache needs (keeps it easy to fake in tests). */
export interface UrlCacheRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export class UrlCache {
  constructor(private readonly redis: UrlCacheRedis) {}

  async get(shortCode: string): Promise<CachedUrlEntry | null> {
    const raw = await this.redis.get(cacheKey(shortCode));
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<CachedUrlEntry>;
      // Entries written by an older version (no id) are treated as misses and rewritten.
      if (typeof parsed.longUrl !== 'string' || typeof parsed.id !== 'string') {
        return null;
      }
      return {
        id: parsed.id,
        longUrl: parsed.longUrl,
        expiresAt: typeof parsed.expiresAt === 'string' ? parsed.expiresAt : null,
      };
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
