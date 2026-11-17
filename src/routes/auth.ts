import type { FastifyInstance } from 'fastify';
import type { RateLimitRule } from '../config.js';
import type { AuthService } from '../services/authService.js';
import { errors, rateLimitConfig } from './schemas.js';

const credentialsBody = {
  type: 'object',
  properties: {
    email: { type: 'string', examples: ['ada@example.com'] },
    password: { type: 'string', minLength: 8, examples: ['correct horse battery'] },
  },
  required: ['email', 'password'],
} as const;

export async function authRoutes(
  app: FastifyInstance,
  deps: { authService: AuthService; rateLimit: RateLimitRule },
): Promise<void> {
  app.post(
    '/v1/auth/register',
    {
      config: rateLimitConfig(deps.rateLimit),
      schema: {
        tags: ['auth'],
        summary: 'Create an account',
        body: credentialsBody,
        response: {
          201: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              email: { type: 'string' },
              createdAt: { type: 'string', format: 'date-time' },
            },
          },
          ...errors(400, 409, 429),
        },
      },
    },
    async (request, reply) => reply.status(201).send(await deps.authService.register(request.body)),
  );

  app.post(
    '/v1/auth/login',
    {
      config: rateLimitConfig(deps.rateLimit),
      schema: {
        tags: ['auth'],
        summary: 'Exchange credentials for a JWT',
        body: credentialsBody,
        response: {
          200: {
            type: 'object',
            properties: {
              token: { type: 'string' },
              tokenType: { type: 'string', examples: ['Bearer'] },
              expiresIn: { type: 'integer', description: 'seconds' },
            },
          },
          ...errors(400, 401, 429),
        },
      },
    },
    async (request) => deps.authService.login(request.body),
  );
}
