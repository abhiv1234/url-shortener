import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import { encodeBase62 } from '../utils/base62.js';
import { isValidCustomAlias, isValidLongUrl } from '../utils/validate.js';

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
}

export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class ConflictError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class NotFoundError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'NotFoundError';
  }
}

function buildShortUrl(shortUrlBase: string, shortCode: string): string {
  return `${shortUrlBase}/${shortCode}`;
}

function computeExpiresAt(ttl?: number): Date | null {
  if (ttl === undefined) {
    return null;
  }

  if (!Number.isInteger(ttl) || ttl <= 0) {
    throw new ValidationError('ttl must be a positive integer', 'INVALID_TTL');
  }

  return new Date(Date.now() + ttl * 1000);
}

function mapRow(
  row: {
    id: string | number | bigint;
    short_code: string;
    long_url: string;
    expires_at: Date | null;
  },
  shortUrlBase: string,
): UrlRecord {
  return {
    id: String(row.id),
    shortCode: row.short_code,
    shortUrl: buildShortUrl(shortUrlBase, row.short_code),
    longUrl: row.long_url,
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
  };
}

async function insertWithGeneratedCode(
  client: PoolClient,
  longUrl: string,
  expiresAt: Date | null,
): Promise<UrlRecord> {
  const placeholder = `_${randomUUID().replace(/-/g, '').slice(0, 15)}`;

  const insertResult = await client.query<{
    id: string;
    short_code: string;
    long_url: string;
    expires_at: Date | null;
  }>(
    `INSERT INTO urls (short_code, long_url, expires_at)
     VALUES ($1, $2, $3)
     RETURNING id, short_code, long_url, expires_at`,
    [placeholder, longUrl, expiresAt],
  );

  const inserted = insertResult.rows[0];
  const shortCode = encodeBase62(BigInt(inserted.id));

  const updateResult = await client.query<{
    id: string;
    short_code: string;
    long_url: string;
    expires_at: Date | null;
  }>(
    `UPDATE urls
     SET short_code = $1
     WHERE id = $2
     RETURNING id, short_code, long_url, expires_at`,
    [shortCode, inserted.id],
  );

  return mapRow(updateResult.rows[0], '');
}

export class UrlService {
  constructor(
    private readonly db: Pool = pool,
    private readonly shortUrlBase: string,
  ) {}

  async createUrl(input: CreateUrlInput): Promise<UrlRecord> {
    const { longUrl, customAlias, ttl } = input;

    if (!isValidLongUrl(longUrl)) {
      throw new ValidationError('longUrl must be a valid http or https URL', 'INVALID_URL');
    }

    const expiresAt = computeExpiresAt(ttl);

    if (customAlias !== undefined) {
      if (!isValidCustomAlias(customAlias)) {
        throw new ValidationError(
          'customAlias must be 3-16 characters and contain only letters, numbers, hyphens, or underscores',
          'INVALID_ALIAS',
        );
      }

      try {
        const result = await this.db.query<{
          id: string;
          short_code: string;
          long_url: string;
          expires_at: Date | null;
        }>(
          `INSERT INTO urls (short_code, long_url, expires_at)
           VALUES ($1, $2, $3)
           RETURNING id, short_code, long_url, expires_at`,
          [customAlias, longUrl, expiresAt],
        );

        const record = mapRow(result.rows[0], this.shortUrlBase);
        return record;
      } catch (error: unknown) {
        if (isUniqueViolation(error)) {
          throw new ConflictError('custom alias is already taken', 'ALIAS_TAKEN');
        }
        throw error;
      }
    }

    const client = await this.db.connect();

    try {
      await client.query('BEGIN');
      const record = await insertWithGeneratedCode(client, longUrl, expiresAt);
      await client.query('COMMIT');
      record.shortUrl = buildShortUrl(this.shortUrlBase, record.shortCode);
      return record;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getLongUrlByCode(shortCode: string): Promise<string> {
    const result = await this.db.query<{ long_url: string }>(
      'SELECT long_url FROM urls WHERE short_code = $1',
      [shortCode],
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('short code not found', 'NOT_FOUND');
    }

    return result.rows[0].long_url;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  );
}
