import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { parseBearer, TokenService } from '../src/auth/tokens.js';
import { UnauthorizedError } from '../src/errors.js';

describe('TokenService', () => {
  const tokens = new TokenService('test-secret', 3600);

  it('signs and verifies a token for a user', () => {
    const issued = tokens.sign('11111111-1111-1111-1111-111111111111');
    expect(issued.tokenType).toBe('Bearer');
    expect(issued.expiresIn).toBe(3600);
    expect(tokens.verify(issued.token)).toEqual({ id: '11111111-1111-1111-1111-111111111111' });
  });

  it('rejects tokens signed with another secret, expired, or using alg=none', () => {
    const foreign = new TokenService('other-secret', 3600).sign('u1').token;
    const expired = jwt.sign({}, 'test-secret', { subject: 'u1', issuer: 'url-shortener', expiresIn: -10 });
    const unsigned = jwt.sign({ sub: 'u1', iss: 'url-shortener' }, '', { algorithm: 'none' });

    for (const token of [foreign, expired, unsigned, 'garbage']) {
      expect(() => tokens.verify(token)).toThrow(UnauthorizedError);
    }
  });
});

describe('parseBearer', () => {
  it('extracts the token from a Bearer header', () => {
    expect(parseBearer('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(parseBearer('bearer   abc')).toBe('abc');
  });

  it('rejects other schemes and malformed headers', () => {
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer('Basic dXNlcjpwYXNz')).toBeNull();
    expect(parseBearer('Bearer')).toBeNull();
    expect(parseBearer('Bearer a b')).toBeNull();
  });
});
