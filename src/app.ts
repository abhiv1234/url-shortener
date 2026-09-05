import Fastify from 'fastify';
import { config } from './config.js';
import { redirectRoutes } from './routes/redirect.js';
import { urlRoutes } from './routes/urls.js';
import { UrlService } from './services/urlService.js';

export async function buildApp() {
  const app = Fastify({
    logger: config.nodeEnv !== 'test',
  });

  const urlService = new UrlService(undefined, config.shortUrlBase);

  app.get('/health', async () => ({ status: 'ok' }));

  await urlRoutes(app, urlService);
  await redirectRoutes(app, urlService);

  return app;
}
