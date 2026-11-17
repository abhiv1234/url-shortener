import type { FastifyInstance } from 'fastify';
import { type AuthHooks, currentUser } from '../auth/hooks.js';
import type { RateLimitRule } from '../config.js';
import type { StatsService } from '../services/statsService.js';
import type { CreateUrlInput, UrlService } from '../services/urlService.js';
import { MAX_LONG_URL_LENGTH } from '../utils/validate.js';
import { bearerSecurity, errors, rateLimitConfig, urlRecordSchema } from './schemas.js';

const idParams = {
  type: 'object',
  properties: { id: { type: 'string', description: 'URL id returned on create' } },
  required: ['id'],
} as const;

export async function urlRoutes(
  app: FastifyInstance,
  deps: {
    urlService: UrlService;
    statsService: StatsService;
    auth: AuthHooks;
    createRateLimit: RateLimitRule;
  },
): Promise<void> {
  const { urlService, statsService, auth } = deps;

  app.post<{ Body: CreateUrlInput }>(
    '/v1/urls',
    {
      preHandler: auth.optionalAuth,
      config: rateLimitConfig(deps.createRateLimit),
      schema: {
        tags: ['urls'],
        summary: 'Create a short URL',
        description:
          'Public. When a bearer token is sent, the link is owned by that user (required for stats and delete).',
        security: [{}, ...bearerSecurity],
        body: {
          type: 'object',
          properties: {
            longUrl: {
              type: 'string',
              maxLength: MAX_LONG_URL_LENGTH,
              examples: ['https://example.com/very/long/path'],
            },
            customAlias: { type: 'string', examples: ['my-link'] },
            ttl: { type: 'integer', minimum: 1, description: 'Seconds until the link expires' },
          },
          required: ['longUrl'],
        },
        response: { 201: urlRecordSchema, ...errors(400, 401, 409, 429) },
      },
    },
    async (request, reply) => {
      const record = await urlService.createUrl(request.body, request.user?.id ?? null);
      return reply.status(201).send(record);
    },
  );

  app.get<{ Querystring: { limit?: number; cursor?: string } }>(
    '/v1/urls',
    {
      preHandler: auth.requireAuth,
      schema: {
        tags: ['urls'],
        summary: "List the caller's links, newest first",
        security: bearerSecurity,
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            cursor: { type: 'string', description: 'nextCursor from the previous page' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              items: { type: 'array', items: urlRecordSchema },
              nextCursor: { type: ['string', 'null'] },
            },
          },
          ...errors(400, 401),
        },
      },
    },
    async (request) => urlService.listUrls(currentUser(request).id, request.query),
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/urls/:id',
    {
      preHandler: auth.requireAuth,
      schema: {
        tags: ['urls'],
        summary: 'Delete a link you own',
        security: bearerSecurity,
        params: idParams,
        response: { 204: { type: 'null' }, ...errors(401, 403, 404) },
      },
    },
    async (request, reply) => {
      await urlService.deleteUrl(request.params.id, currentUser(request).id);
      return reply.status(204).send();
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/urls/:id/stats',
    {
      preHandler: auth.requireAuth,
      schema: {
        tags: ['urls'],
        summary: 'Click analytics for a link you own',
        security: bearerSecurity,
        params: idParams,
        response: {
          200: {
            type: 'object',
            properties: {
              urlId: { type: 'string' },
              totalClicks: { type: 'integer' },
              clicksByDay: {
                type: 'array',
                description: 'Last 30 UTC days, zero-filled',
                items: {
                  type: 'object',
                  properties: { date: { type: 'string' }, count: { type: 'integer' } },
                },
              },
              topReferrers: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { referrer: { type: 'string' }, count: { type: 'integer' } },
                },
              },
            },
          },
          ...errors(401, 403, 404),
        },
      },
    },
    async (request) => statsService.getStats(request.params.id, currentUser(request).id),
  );
}
