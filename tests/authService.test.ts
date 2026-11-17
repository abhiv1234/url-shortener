import { describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/passwords.js';
import { TokenService } from '../src/auth/tokens.js';
import { ConflictError, UnauthorizedError, ValidationError } from '../src/errors.js';
import { AuthService } from '../src/services/authService.js';

const tokens = new TokenService('secret', 3600);

function serviceWithUsers(users: { id: string; email: string; password_hash: string }[]) {
  const inserted: unknown[][] = [];
  const db = {
    query: async (sql: string, params: unknown[]) => {
      if (sql.startsWith('INSERT')) {
        if (users.some((user) => user.email === params[0])) {
          throw Object.assign(new Error('duplicate'), { code: '23505' });
        }
        inserted.push(params);
        return { rows: [{ id: 'new-id', email: params[0], created_at: new Date('2026-01-01T00:00:00Z') }] };
      }
      return { rows: users.filter((user) => user.email === params[0]) };
    },
  } as never;
  return { service: new AuthService(db, tokens, 4), inserted };
}

describe('AuthService.register', () => {
  it('normalises the email and stores a bcrypt hash, never the password', async () => {
    const { service, inserted } = serviceWithUsers([]);
    const user = await service.register({ email: '  Ada@Example.COM ', password: 'correct horse' });

    expect(user).toEqual({ id: 'new-id', email: 'ada@example.com', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(inserted[0][0]).toBe('ada@example.com');
    expect(inserted[0][1]).toMatch(/^\$2[aby]\$04\$/);
    expect(inserted[0][1]).not.toContain('correct horse');
  });

  it('rejects invalid emails and passwords', async () => {
    const { service } = serviceWithUsers([]);
    await expect(service.register(undefined)).rejects.toBeInstanceOf(ValidationError);
    await expect(service.register({ email: 'nope', password: 'longenough' })).rejects.toMatchObject({ code: 'INVALID_EMAIL' });
    await expect(service.register({ email: 'a@b.co', password: 'short' })).rejects.toMatchObject({ code: 'INVALID_PASSWORD' });
    await expect(service.register({ email: 'a@b.co', password: 'x'.repeat(73) })).rejects.toMatchObject({ code: 'INVALID_PASSWORD' });
  });

  it('returns 409 for an email that is already registered', async () => {
    const { service } = serviceWithUsers([{ id: 'u1', email: 'ada@example.com', password_hash: 'x' }]);
    await expect(service.register({ email: 'ada@example.com', password: 'correct horse' })).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('AuthService.login', () => {
  it('issues a JWT for valid credentials', async () => {
    const hash = await hashPassword('correct horse', 4);
    const { service } = serviceWithUsers([{ id: 'u1', email: 'ada@example.com', password_hash: hash }]);

    const issued = await service.login({ email: 'ADA@example.com', password: 'correct horse' });
    expect(tokens.verify(issued.token)).toEqual({ id: 'u1' });
  });

  it('gives the same error for a wrong password and an unknown email', async () => {
    const hash = await hashPassword('correct horse', 4);
    const { service } = serviceWithUsers([{ id: 'u1', email: 'ada@example.com', password_hash: hash }]);

    const wrongPassword = service.login({ email: 'ada@example.com', password: 'wrong password' });
    const unknownEmail = service.login({ email: 'bob@example.com', password: 'correct horse' });

    await expect(wrongPassword).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(unknownEmail).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(wrongPassword).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    await expect(unknownEmail).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });
});
