import type { FastifyReply, FastifyRequest } from 'fastify';
import { UnauthorizedError } from '../errors.js';
import { type AuthUser, parseBearer, type TokenService } from './tokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

export interface AuthHooks {
  /** 401 unless a valid bearer token is present. */
  requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  /** Anonymous is fine, but a token that is present must be valid. */
  optionalAuth(request: FastifyRequest, reply: FastifyReply): Promise<void>;
}

export function createAuthHooks(tokens: TokenService): AuthHooks {
  const authenticate = (request: FastifyRequest, required: boolean) => {
    const header = request.headers.authorization;
    if (!header) {
      if (required) {
        throw new UnauthorizedError('authentication required', 'UNAUTHORIZED');
      }
      request.user = null;
      return;
    }

    const token = parseBearer(header);
    if (!token) {
      throw new UnauthorizedError('authorization header must be "Bearer <token>"', 'INVALID_TOKEN');
    }
    request.user = tokens.verify(token);
  };

  return {
    async requireAuth(request) {
      authenticate(request, true);
    },
    async optionalAuth(request) {
      authenticate(request, false);
    },
  };
}

/** For handlers behind requireAuth. */
export function currentUser(request: FastifyRequest): AuthUser {
  if (!request.user) {
    throw new UnauthorizedError('authentication required', 'UNAUTHORIZED');
  }
  return request.user;
}
