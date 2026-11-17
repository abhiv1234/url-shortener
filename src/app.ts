import { randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { ClickPublisher } from './analytics/clickPublisher.js';
import { createAuthHooks } from './auth/hooks.js';
import type { TokenService } from './auth/tokens.js';
import type { AppConfig } from './config.js';
import { AppError } from './errors.js';
import { loggerOptions } from './observability/logger.js';
import { httpRequestDuration, httpRequestsTotal, statusClass } from './observability/metrics.js';
import { authRoutes } from './routes/auth.js';
import { type HealthChecks, healthRoutes, type Lifecycle } from './routes/health.js';
import { redirectRoutes } from './routes/redirect.js';
import { urlRoutes } from './routes/urls.js';
import type { AuthService } from './services/authService.js';
import type { StatsService } from './services/statsService.js';
import type { UrlService } from './services/urlService.js';

export interface AppDeps {
  config: AppConfig;
  urlService: UrlService;
  authService: AuthService;
  statsService: StatsService;
  tokens: TokenService;
  clickPublisher: ClickPublisher;
  healthChecks: HealthChecks;
  lifecycle?: Lifecycle;
  /** Reuse an existing pino logger (so the API and its dependencies log through one instance). */
  logger?: FastifyBaseLogger;
  /** Shared rate-limit counters across instances; omit for per-process in-memory limits. */
  rateLimitRedis?: Redis;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const lifecycle = deps.lifecycle ?? { shuttingDown: false };

  const app = Fastify({
    ...(deps.logger ? { loggerInstance: deps.logger } : { logger: loggerOptions(config) }),
    trustProxy: config.trustProxy,
    bodyLimit: 16 * 1024,
    requestIdHeader: 'x-request-id',
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
    genReqId: () => randomUUID(),
  });

  // Never trust a malformed incoming request id (log injection); mint our own instead.
  app.addHook('onRequest', async (request, reply) => {
    if (!REQUEST_ID_PATTERN.test(request.id)) {
      request.id = randomUUID();
    }
    reply.header('x-request-id', request.id);
  });

  app.decorateRequest('user', null);

  app.addHook('onResponse', async (request, reply) => {
    const labels = {
      method: request.method,
      route: request.routeOptions.url ?? 'unmatched',
      status_class: statusClass(reply.statusCode),
    };
    httpRequestDuration.observe(labels, reply.elapsedTime / 1000);
    httpRequestsTotal.inc(labels);
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: error.message, code: error.code });
    }

    if (error.validation) {
      return reply.status(400).send({ error: error.message, code: 'VALIDATION_ERROR' });
    }

    const statusCode = error.statusCode ?? 500;
    if (statusCode === 429) {
      return reply.status(429).send({ error: error.message, code: 'RATE_LIMITED' });
    }
    if (statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send({ error: error.message, code: error.code ?? 'BAD_REQUEST' });
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({ error: 'internal server error', code: 'INTERNAL_ERROR' });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({ error: 'route not found', code: 'NOT_FOUND' }),
  );

  if (config.rateLimit.enabled) {
    await app.register(rateLimit, {
      global: false,
      redis: deps.rateLimitRedis,
      nameSpace: 'rl:',
      // If Redis is down, let requests through rather than failing closed.
      skipOnError: true,
      keyGenerator: (request) => request.ip,
      errorResponseBuilder: (_request, context) => ({
        statusCode: 429,
        code: 'RATE_LIMITED',
        error: 'Too Many Requests',
        message: `rate limit exceeded, retry in ${context.after}`,
      }),
    });
  }

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'URL Shortener API',
        description: 'Create short links, redirect with low latency, and track clicks.',
        version: '1.0.0',
      },
      servers: [{ url: config.shortUrlBase }],
      tags: [
        { name: 'urls', description: 'Create, list, delete and inspect links' },
        { name: 'auth', description: 'Accounts and JWTs' },
        { name: 'redirect', description: 'The hot read path' },
        { name: 'ops', description: 'Health, readiness and metrics' },
      ],
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  const auth = createAuthHooks(deps.tokens);

  await healthRoutes(app, { checks: deps.healthChecks, lifecycle });
  await authRoutes(app, { authService: deps.authService, rateLimit: config.rateLimit.auth });
  await urlRoutes(app, {
    urlService: deps.urlService,
    statsService: deps.statsService,
    auth,
    createRateLimit: config.rateLimit.create,
  });
  await redirectRoutes(app, {
    urlService: deps.urlService,
    clickPublisher: deps.clickPublisher,
    ipHashSalt: config.ipHashSalt,
    cacheMaxAgeSeconds: config.redirectCacheMaxAgeSeconds,
    rateLimit: config.rateLimit.redirect,
  });

  return app;
}
