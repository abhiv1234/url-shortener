import type { FastifyInstance } from 'fastify';
import { NotFoundError, UrlService } from '../services/urlService.js';

const RESERVED_CODES = new Set(['v1', 'health']);

export async function redirectRoutes(
  app: FastifyInstance,
  urlService: UrlService,
): Promise<void> {
  app.get<{ Params: { code: string } }>('/:code', async (request, reply) => {
    const { code } = request.params;

    if (RESERVED_CODES.has(code)) {
      return reply.status(404).send({ error: 'short code not found', code: 'NOT_FOUND' });
    }

    try {
      const longUrl = await urlService.getLongUrlByCode(code);
      return reply.redirect(longUrl);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return reply.status(404).send({ error: error.message, code: error.code });
      }

      request.log.error(error);
      return reply.status(500).send({ error: 'internal server error', code: 'INTERNAL_ERROR' });
    }
  });
}
