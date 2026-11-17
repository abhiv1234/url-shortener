import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { incrementStaleCacheServed } from '../cache/metrics.js';
import type { Singleflight } from '../cache/singleflight.js';
import type { CachedUrlEntry, UrlCache } from '../cache/urlCache.js';
import type { Queryable } from '../db/pool.js';
import {
  ConflictError,
  ForbiddenError,
  GoneError,
  NotFoundError,
  ValidationError,
} from '../errors.js';
import { cacheRequestsTotal, urlsCreatedTotal } from '../observability/metrics.js';
import { encodeBase62 } from '../utils/base62.js';
import { isValidCustomAlias, isValidLongUrl } from '../utils/validate.js';

// Re-exported so existing imports from this module keep working.
export { ConflictError, ForbiddenError, GoneError, NotFoundError, ValidationError };

export interface CreateUrlInput {
  longUrl: string;
  customAlias?: string;
  ttl?: number;
}

export interface UrlRecord {
  id: string;
  shortCode: string;
  shortUrl: string;
  longUrl: string;
  expiresAt: string | null;
  createdAt: string | null;
}

export type ResolvedUrl = CachedUrlEntry;

export interface UrlPage {
  items: UrlRecord[];
  nextCursor: string | null;
}

export interface ServiceLogger {
  warn(obj: unknown, msg?: string): void;
}

interface UrlRow {
  id: string;
  short_code: string;
  long_url: string;
  expires_at: Date | null;
  created_at?: Date | null;
}

const RETURNING = 'RETURNING id, short_code, long_url, expires_at, created_at';
const MAX_GENERATE_ATTEMPTS = 5;
const MAX_BIGINT = 9_223_372_036_854_775_807n;
const MAX_TTL_SECONDS = 10 * 365 * 24 * 60 * 60;

function buildShortUrl(shortUrlBase: string, shortCode: string): string {
  return `${shortUrlBase}/${shortCode}`;
}

function computeExpiresAt(ttl?: number): Date | null {
  if (ttl === undefined) {
    return null;
  }

  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_TTL_SECONDS) {
    throw new ValidationError(
      `ttl must be a positive integer number of seconds (max ${MAX_TTL_SECONDS})`,
      'INVALID_TTL',
    );
  }

  return new Date(Date.now() + ttl * 1000);
}

export function isExpired(expiresAt: string | null, now = Date.now()): boolean {
  return expiresAt !== null && new Date(expiresAt).getTime() <= now;
}

/** Path ids are BIGINT strings; anything else cannot exist, so it is a 404, not a 400. */
export function parseUrlId(id: string): string {
  if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > MAX_BIGINT) {
    throw new NotFoundError('url not found', 'NOT_FOUND');
  }
  return id;
}

function mapRow(row: UrlRow, shortUrlBase: string): UrlRecord {
  return {
    id: String(row.id),
    shortCode: row.short_code,
    shortUrl: buildShortUrl(shortUrlBase, row.short_code),
    longUrl: row.long_url,
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    createdAt: row.created_at ? row.created_at.toISOString() : null,
  };
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id])).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as unknown[];
    if (typeof createdAt === 'string' && typeof id === 'string' && !Number.isNaN(Date.parse(createdAt))) {
      return { createdAt, id: parseUrlId(id) };
    }
  } catch {
    // fall through
  }
  throw new ValidationError('cursor is invalid', 'INVALID_CURSOR');
}

async function insertWithGeneratedCode(
  client: pg.PoolClient,
  longUrl: string,
  expiresAt: Date | null,
  userId: string | null,
): Promise<UrlRow> {
  // Insert with a unique placeholder to obtain the id, then derive the Base62 code from it.
  const placeholder = `_${randomUUID().replace(/-/g, '').slice(0, 15)}`;

  const inserted = await client.query<UrlRow>(
    `INSERT INTO urls (short_code, long_url, expires_at, user_id) VALUES ($1, $2, $3, $4) ${RETURNING}`,
    [placeholder, longUrl, expiresAt, userId],
  );

  const id = inserted.rows[0].id;
  const updated = await client.query<UrlRow>(
    `UPDATE urls SET short_code = $1 WHERE id = $2 ${RETURNING}`,
    [encodeBase62(BigInt(id)), id],
  );

  return updated.rows[0];
}

function toCacheEntry(record: UrlRecord): CachedUrlEntry {
  return { id: record.id, longUrl: record.longUrl, expiresAt: record.expiresAt };
}

export class UrlService {
  private readonly ownHost: string | null;

  constructor(
    private readonly db: Pick<pg.Pool, 'query' | 'connect'>,
    private readonly shortUrlBase: string,
    private readonly cache?: UrlCache,
    private readonly singleflight?: Singleflight,
    private readonly logger: ServiceLogger = console,
  ) {
    try {
      this.ownHost = new URL(shortUrlBase).host.toLowerCase();
    } catch {
      this.ownHost = null;
    }
  }

  async createUrl(
    input: CreateUrlInput | null | undefined,
    userId: string | null = null,
  ): Promise<UrlRecord> {
    if (typeof input !== 'object' || input === null) {
      throw new ValidationError('request body must be a JSON object', 'INVALID_BODY');
    }

    const { longUrl, customAlias, ttl } = input;

    if (typeof longUrl !== 'string' || !isValidLongUrl(longUrl)) {
      throw new ValidationError(
        'longUrl must be a valid http or https URL (max 2048 characters)',
        'INVALID_URL',
      );
    }

    if (this.ownHost && new URL(longUrl).host.toLowerCase() === this.ownHost) {
      throw new ValidationError('longUrl cannot point at this shortener', 'INVALID_URL');
    }

    const expiresAt = computeExpiresAt(ttl);

    if (customAlias !== undefined) {
      if (typeof customAlias !== 'string' || !isValidCustomAlias(customAlias)) {
        throw new ValidationError(
          'customAlias must be 3-16 characters and contain only letters, numbers, hyphens, or underscores',
          'INVALID_ALIAS',
        );
      }
    }

    const record =
      customAlias !== undefined
        ? await this.insertWithAlias(customAlias, longUrl, expiresAt, userId)
        : await this.insertGenerated(longUrl, expiresAt, userId);

    urlsCreatedTotal.inc({ type: customAlias !== undefined ? 'custom' : 'generated' });
    await this.cacheSet(record.shortCode, toCacheEntry(record));
    return record;
  }

  /** Resolves a short code via cache-aside. Throws NotFoundError or GoneError. */
  async resolve(shortCode: string): Promise<ResolvedUrl> {
    const entry = await this.lookup(shortCode);

    if (isExpired(entry.expiresAt)) {
      await this.cacheDelete(shortCode);
      throw new GoneError('link has expired', 'GONE');
    }

    return entry;
  }

  async getLongUrlByCode(shortCode: string): Promise<string> {
    return (await this.resolve(shortCode)).longUrl;
  }

  /** Loads a URL and checks the caller owns it. Anonymous links have no owner. */
  async assertOwner(id: string, userId: string): Promise<{ id: string; shortCode: string }> {
    const urlId = parseUrlId(id);
    const result = await this.db.query<{ id: string; short_code: string; user_id: string | null }>(
      'SELECT id, short_code, user_id FROM urls WHERE id = $1',
      [urlId],
    );

    const row = result.rows[0];
    if (!row) {
      throw new NotFoundError('url not found', 'NOT_FOUND');
    }
    if (row.user_id !== userId) {
      throw new ForbiddenError('you do not own this url', 'FORBIDDEN');
    }

    return { id: String(row.id), shortCode: row.short_code };
  }

  async deleteUrl(id: string, userId: string): Promise<void> {
    const { id: urlId, shortCode } = await this.assertOwner(id, userId);
    // Guarding on user_id again keeps the delete correct even if ownership changed meanwhile.
    await this.db.query('DELETE FROM urls WHERE id = $1 AND user_id = $2', [urlId, userId]);
    await this.cacheDelete(shortCode);
  }

  async listUrls(userId: string, options: { limit?: number; cursor?: string } = {}): Promise<UrlPage> {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const after = options.cursor ? decodeCursor(options.cursor) : null;

    // Keyset pagination on (created_at, id) — served by idx_urls_user_created.
    const result = await this.db.query<UrlRow>(
      `SELECT id, short_code, long_url, expires_at, created_at
       FROM urls
       WHERE user_id = $1
         AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::bigint))
       ORDER BY created_at DESC, id DESC
       LIMIT $4`,
      [userId, after?.createdAt ?? null, after?.id ?? null, limit + 1],
    );

    const rows = result.rows.slice(0, limit);
    const items = rows.map((row) => mapRow(row, this.shortUrlBase));
    const last = items.at(-1);
    const nextCursor =
      result.rows.length > limit && last?.createdAt ? encodeCursor(last.createdAt, last.id) : null;

    return { items, nextCursor };
  }

  private async lookup(shortCode: string): Promise<CachedUrlEntry> {
    if (!this.cache || !this.singleflight) {
      return this.fetchUrlFromDb(shortCode);
    }

    const cached = await this.cacheGet(shortCode);
    if (cached) {
      cacheRequestsTotal.inc({ result: 'hit' });
      return cached;
    }
    cacheRequestsTotal.inc({ result: 'miss' });

    return this.singleflight.run(
      shortCode,
      async () => (await this.cacheGet(shortCode)) ?? this.loadAndCache(shortCode),
      async () => this.cacheGet(shortCode),
      async () => this.loadAndCache(shortCode),
    );
  }

  private async insertWithAlias(
    customAlias: string,
    longUrl: string,
    expiresAt: Date | null,
    userId: string | null,
  ): Promise<UrlRecord> {
    try {
      const result = await this.db.query<UrlRow>(
        `INSERT INTO urls (short_code, long_url, expires_at, user_id) VALUES ($1, $2, $3, $4) ${RETURNING}`,
        [customAlias, longUrl, expiresAt, userId],
      );

      return mapRow(result.rows[0], this.shortUrlBase);
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('custom alias is already taken', 'ALIAS_TAKEN');
      }
      throw error;
    }
  }

  /**
   * A generated Base62 code can collide with an existing custom alias. Each retry
   * draws a new id from the sequence (sequences ignore rollbacks), so it yields a new code.
   */
  private async insertGenerated(
    longUrl: string,
    expiresAt: Date | null,
    userId: string | null,
  ): Promise<UrlRecord> {
    for (let attempt = 1; ; attempt += 1) {
      const client = await this.db.connect();

      try {
        await client.query('BEGIN');
        const row = await insertWithGeneratedCode(client, longUrl, expiresAt, userId);
        await client.query('COMMIT');
        return mapRow(row, this.shortUrlBase);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (isUniqueViolation(error) && attempt < MAX_GENERATE_ATTEMPTS) {
          continue;
        }
        throw error;
      } finally {
        client.release();
      }
    }
  }

  /** Cache reads are best-effort: a Redis outage degrades to a DB lookup, not a 500. */
  private async cacheGet(shortCode: string): Promise<CachedUrlEntry | null> {
    try {
      return (await this.cache?.get(shortCode)) ?? null;
    } catch (error) {
      cacheRequestsTotal.inc({ result: 'error' });
      this.logger.warn({ err: error, shortCode }, 'cache read failed');
      return null;
    }
  }

  /** Cache writes are best-effort: the DB is the source of truth. */
  private async cacheSet(shortCode: string, entry: CachedUrlEntry): Promise<void> {
    if (isExpired(entry.expiresAt)) {
      return;
    }
    try {
      await this.cache?.set(shortCode, entry);
    } catch (error) {
      this.logger.warn({ err: error, shortCode }, 'cache write failed');
    }
  }

  private async cacheDelete(shortCode: string): Promise<void> {
    try {
      await this.cache?.delete(shortCode);
    } catch (error) {
      this.logger.warn({ err: error, shortCode }, 'cache delete failed');
    }
  }

  private async loadAndCache(shortCode: string): Promise<CachedUrlEntry> {
    let entry: CachedUrlEntry;
    try {
      entry = await this.fetchUrlFromDb(shortCode);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }

      const stale = await this.cacheGet(shortCode);
      if (stale) {
        this.logger.warn({ err: error, shortCode }, 'database read failed; serving stale cache');
        incrementStaleCacheServed();
        return stale;
      }

      throw error;
    }

    await this.cacheSet(shortCode, entry);
    return entry;
  }

  private async fetchUrlFromDb(shortCode: string): Promise<CachedUrlEntry> {
    const result = await (this.db as Queryable).query<{
      id: string;
      long_url: string;
      expires_at: Date | null;
    }>('SELECT id, long_url, expires_at FROM urls WHERE short_code = $1', [shortCode]);

    const row = result.rows[0];
    if (!row) {
      throw new NotFoundError('short code not found', 'NOT_FOUND');
    }

    return {
      id: String(row.id),
      longUrl: row.long_url,
      expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    };
  }
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  );
}
