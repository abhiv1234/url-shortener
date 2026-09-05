import type { FastifyInstance } from 'fastify';
import {
  ConflictError,
  UrlService,
  ValidationError,
} from '../services/urlService.js';

interface CreateUrlBody {
  longUrl: string;
  customAlias?: string;
  ttl?: number;
}

export async function urlRoutes(app: FastifyInstance, urlService: UrlService): Promise<void> {
  app.post<{ Body: CreateUrlBody }>('/v1/urls', async (request, reply) => {
    try {
      const record = await urlService.createUrl(request.body);
      return reply.status(201).send(record);
    } catch (error) {
      if (error instanceof ValidationError) {
        return reply.status(400).send({ error: error.message, code: error.code });
      }

      if (error instanceof ConflictError) {
        return reply.status(409).send({ error: error.message, code: error.code });
      }

      request.log.error(error);
      return reply.status(500).send({ error: 'internal server error', code: 'INTERNAL_ERROR' });
    }
  });
}
