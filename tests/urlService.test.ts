import { describe, expect, it } from 'vitest';
import { ConflictError, UrlService, ValidationError } from '../src/services/urlService.js';

describe('UrlService validation', () => {
  const service = new UrlService(
    {
      query: async () => ({ rows: [] }),
      connect: async () => {
        throw new Error('not implemented in validation tests');
      },
    } as never,
    'http://localhost:3000',
  );

  it('rejects invalid long URLs', async () => {
    await expect(service.createUrl({ longUrl: 'not-a-url' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('rejects invalid custom aliases', async () => {
    await expect(
      service.createUrl({ longUrl: 'https://example.com', customAlias: '!!' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a missing request body', async () => {
    await expect(service.createUrl(undefined)).rejects.toBeInstanceOf(ValidationError);
    await expect(service.createUrl(null)).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects non-string longUrl and customAlias values', async () => {
    await expect(
      service.createUrl({ longUrl: 123 } as unknown as { longUrl: string }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.createUrl({
        longUrl: 'https://example.com',
        customAlias: 12345,
      } as unknown as { longUrl: string; customAlias: string }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects non-positive ttl values', async () => {
    await expect(
      service.createUrl({ longUrl: 'https://example.com', ttl: 0 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('UrlService custom alias conflicts', () => {
  it('maps unique violations to ConflictError', async () => {
    const service = new UrlService(
      {
        query: async () => {
          const error = new Error('duplicate key value violates unique constraint');
          (error as { code?: string }).code = '23505';
          throw error;
        },
        connect: async () => {
          throw new Error('not implemented');
        },
      } as never,
      'http://localhost:3000',
    );

    await expect(
      service.createUrl({ longUrl: 'https://example.com', customAlias: 'my-link' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
