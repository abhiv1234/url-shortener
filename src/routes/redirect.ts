import type { FastifyInstance } from 'fastify';
import { buildClickEvent } from '../analytics/clickEvent.js';
import type { ClickPublisher } from '../analytics/clickPublisher.js';
import type { RateLimitRule } from '../config.js';
import { GoneError, NotFoundError } from '../errors.js';
import { redirectDuration } from '../observability/metrics.js';
import type { UrlService } from '../services/urlService.js';
import { isPlausibleShortCode } from '../utils/validate.js';
import { errors, rateLimitConfig } from './schemas.js';

const RESERVED_CODES = new Set(['v1', 'health', 'ready', 'metrics', 'docs', 'favicon.ico']);

export function cacheControlFor(expiresAt: string | null, maxAgeSeconds: number, now = Date.now()): string {
  if (maxAgeSeconds <= 0) {
    // Every click must reach us to be counted, so browsers and CDNs must not cache the 302.
    return 'no-store';
  }
  const remaining = expiresAt ? Math.floor((new Date(expiresAt).getTime() - now) / 1000) : maxAgeSeconds;
  return `public, max-age=${Math.max(0, Math.min(maxAgeSeconds, remaining))}`;
}

export async function redirectRoutes(
  app: FastifyInstance,
  deps: {
    urlService: UrlService;
    clickPublisher: ClickPublisher;
    ipHashSalt: string;
    cacheMaxAgeSeconds: number;
    rateLimit: RateLimitRule;
  },
): Promise<void> {
  app.get<{ Params: { code: string } }>(
    '/:code',
    {
      config: rateLimitConfig(deps.rateLimit),
      schema: {
        tags: ['redirect'],
        summary: 'Redirect to the original URL',
        params: {
          type: 'object',
          properties: { code: { type: 'string' } },
          required: ['code'],
        },
        response: {
          302: { description: 'Redirect; the target is in the Location header', type: 'null' },
          ...errors(404, 410, 429),
        },
      },
    },
    async (request, reply) => {
      const { code } = request.params;
      const endTimer = redirectDuration.startTimer();

      if (RESERVED_CODES.has(code) || !isPlausibleShortCode(code)) {
        endTimer({ outcome: 'not_found' });
        throw new NotFoundError('short code not found', 'NOT_FOUND');
      }

      try {
        const url = await deps.urlService.resolve(code);

        // HEAD requests (link previews, uptime checks) are not clicks.
        if (request.method === 'GET') {
          try {
            deps.clickPublisher.publish(
              buildClickEvent({
                urlId: url.id,
                ip: request.ip,
                referrer: request.headers.referer,
                salt: deps.ipHashSalt,
              }),
            );
          } catch (error) {
            request.log.warn({ err: error }, 'failed to enqueue click event');
          }
        }

        endTimer({ outcome: 'redirect' });
        return reply
          .header('cache-control', cacheControlFor(url.expiresAt, deps.cacheMaxAgeSeconds))
          .redirect(url.longUrl, 302);
      } catch (error) {
        const outcome =
          error instanceof NotFoundError ? 'not_found' : error instanceof GoneError ? 'gone' : 'error';
        endTimer({ outcome });
        throw error;
      }
    },
  );
}
