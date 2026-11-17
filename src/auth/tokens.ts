import jwt from 'jsonwebtoken';
import { UnauthorizedError } from '../errors.js';

export interface IssuedToken {
  token: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

export interface AuthUser {
  id: string;
}

const ISSUER = 'url-shortener';

export class TokenService {
  constructor(
    private readonly secret: string,
    private readonly expiresInSeconds: number,
  ) {}

  sign(userId: string): IssuedToken {
    const token = jwt.sign({}, this.secret, {
      algorithm: 'HS256',
      subject: userId,
      issuer: ISSUER,
      expiresIn: this.expiresInSeconds,
    });
    return { token, tokenType: 'Bearer', expiresIn: this.expiresInSeconds };
  }

  verify(token: string): AuthUser {
    try {
      const payload = jwt.verify(token, this.secret, { algorithms: ['HS256'], issuer: ISSUER });
      if (typeof payload === 'string' || typeof payload.sub !== 'string') {
        throw new Error('token has no subject');
      }
      return { id: payload.sub };
    } catch {
      throw new UnauthorizedError('invalid or expired token', 'INVALID_TOKEN');
    }
  }
}

/** Extracts the token from an `Authorization: Bearer <token>` header. */
export function parseBearer(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const [scheme, token, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer' || !token || rest.length > 0) {
    return null;
  }
  return token;
}
